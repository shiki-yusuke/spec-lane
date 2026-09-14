import {
  type CalibrationObservation,
  CalibrationObservationSchema,
  type MeasurementQuality,
  type RiskLevel,
} from "@lane/schemas";
import { z } from "zod";

// design.md §7.1/M2 item 5 — one-time importer, ledger side. Built against the *real*
// field shapes found in the salvaged archive's docs/spec/<intent-id>/{lane-state.json,
// intent.yaml} pairs (inspected during M2 implementation), not against design.md's
// original hypothetical `--input .../ledgers/*.json` shape, which doesn't correspond to
// any file that actually exists in the archive. Two generations of ledger entry shape
// were found in the same archive: the Python reference implementation's current
// (build_ledger_entry, orchestrator.py 769-835) shape — ledger_entry_id/data_state/
// confidence/included_in_kpi present — and an older, pre-rename generation lacking those
// fields entirely. Only the current shape is imported; older entries are rejected with a
// clear reason (never silently skipped, never guessed) rather than reverse-engineering
// every historical ledger format from the reference implementation's own history.

const LegacyLedgerUsageSchema = z
  .object({
    claude_input_tokens: z.number().optional(),
    claude_output_tokens: z.number().optional(),
    codex_input_tokens: z.number().optional(),
    codex_output_tokens: z.number().optional(),
  })
  .passthrough();

const LegacyLedgerEntrySchema = z
  .object({
    ledger_entry_id: z.string(),
    lane_id: z.string().nullable().optional(),
    data_state: z.string(),
    included_in_kpi: z.boolean(),
    usage: LegacyLedgerUsageSchema.optional(),
    cost_usd_estimate: z.number().optional(),
    pricing_version: z.string().optional(),
  })
  .passthrough();

const LegacyLaneStateSchema = z
  .object({
    intent_id: z.string(),
    cost_ledger: z.array(z.unknown()).default([]),
  })
  .passthrough();

const LegacyIntentSchema = z
  .object({
    intent: z
      .object({
        risk_level: z.string().optional(),
        declared_risk: z.string().optional(),
      })
      .optional(),
    ai_inferred_scope: z
      .object({
        affected_layers: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

const USABLE_DATA_STATES = new Set(["has_usage", "zero_tokens"]);
const KNOWN_RISK = new Set<string>(["low", "medium", "high"]);

export interface MigrateLedgerSuccess {
  observation: CalibrationObservation;
  /**
   * Reasons why individual `cost_ledger[]` entries in this same lane-state.json were
   * excluded for failing to match the current entry shape (e.g. the older pre-rename
   * generation) — empty when every entry parsed cleanly. The lane's own import still
   * succeeds as long as at least one entry is usable, but these exclusions must still be
   * visible to the caller (must-4, M2 review, 2026-07-31: "per-entry reject" — never a
   * silent drop just because the surrounding file happened to succeed overall).
   */
  entryRejects: string[];
}
export interface MigrateLedgerReject {
  reject: string;
}

/**
 * `rawLaneState` is a parsed lane-state.json; `rawIntent` (optional) is the parsed
 * sibling intent.yaml, used only to improve predictor quality (risk_class,
 * layers_crossed) — its absence downgrades predictor_quality but is not itself a reject
 * reason. `recordId` should be caller-assigned and stable (e.g. derived from intent_id) so
 * re-running the importer is idempotent, matching calibrate's own convention.
 */
export function buildObservationFromLegacyLaneState(
  rawLaneState: unknown,
  rawIntent: unknown | undefined,
  recordId: string,
  recordedAt: string,
): MigrateLedgerSuccess | MigrateLedgerReject {
  const laneStateResult = LegacyLaneStateSchema.safeParse(rawLaneState);
  if (!laneStateResult.success) {
    return {
      reject: `lane-state.json does not match the expected shape: ${laneStateResult.error.message}`,
    };
  }
  const laneState = laneStateResult.data;

  const usableEntries: z.infer<typeof LegacyLedgerEntrySchema>[] = [];
  const entryRejects: string[] = [];
  laneState.cost_ledger.forEach((rawEntry, index) => {
    const entryResult = LegacyLedgerEntrySchema.safeParse(rawEntry);
    if (!entryResult.success) {
      // e.g. the older pre-rename generation lacking ledger_entry_id/data_state/
      // included_in_kpi entirely, or otherwise malformed — excluded from this lane's usable
      // set (not fatal to the whole lane), but recorded here so it's never a silent drop.
      entryRejects.push(
        `cost_ledger[${index}]: does not match the current ledger entry shape: ${entryResult.error.message}`,
      );
      return;
    }
    if (entryResult.data.included_in_kpi && USABLE_DATA_STATES.has(entryResult.data.data_state)) {
      usableEntries.push(entryResult.data);
    }
  });
  if (usableEntries.length === 0) {
    return {
      reject:
        "no cost_ledger entry with included_in_kpi=true and a usable data_state (has_usage/zero_tokens)",
    };
  }

  let tokens = 0;
  let costUsd = 0;
  for (const entry of usableEntries) {
    const u = entry.usage ?? {};
    tokens +=
      (u.claude_input_tokens ?? 0) +
      (u.claude_output_tokens ?? 0) +
      (u.codex_input_tokens ?? 0) +
      (u.codex_output_tokens ?? 0);
    costUsd += entry.cost_usd_estimate ?? 0;
  }

  let riskClass: RiskLevel = "low";
  let predictorQuality: MeasurementQuality = "imputed";
  let layersCrossed: number | null = null;
  if (rawIntent !== undefined) {
    const intentResult = LegacyIntentSchema.safeParse(rawIntent);
    if (intentResult.success) {
      // legacy intent.yaml predates the declared_risk rename (design.md §2.2); risk_level
      // is the pre-rev2 field name.
      const declared =
        intentResult.data.intent?.declared_risk ?? intentResult.data.intent?.risk_level;
      if (declared && KNOWN_RISK.has(declared)) {
        riskClass = declared as RiskLevel;
        predictorQuality = "reconstructed";
      }
      const layers = intentResult.data.ai_inferred_scope?.affected_layers;
      if (layers) layersCrossed = layers.length;
    }
  }

  const observation = CalibrationObservationSchema.parse({
    schema_version: "1.0",
    record_id: recordId,
    kind: "observation",
    intent_id: laneState.intent_id,
    recorded_at: recordedAt,
    predictors: {
      // files_touched_estimate is deliberately left null: design.md §2.6 explicitly
      // rejects "count of allowed_paths globs" as a files_touched proxy (that measures
      // permission width, not predicted file count), and no real impact-scan snapshot
      // exists for these salvaged legacy lanes.
      files_touched_estimate: null,
      files_touched_observed: null,
      layers_crossed: layersCrossed,
      risk_class: riskClass,
      spec_rule_count: null,
      novel_surface: "unknown",
    },
    predictor_quality: predictorQuality,
    actual: {
      tokens,
      estimated_cost_usd: costUsd,
      pricing_catalog_version: usableEntries[0]?.pricing_version,
      // I-2026-09-10-agent-cost-v2-basis-gate (D28/RULE-42) -- a legacy ledger entry
      // carries no accounting basis at all; "unknown" is the same normalization RULE-32
      // uses for a genuinely missing value, never a guess.
      token_basis: "unknown",
    },
    measurement_quality: "reconstructed",
    // I-2026-09-10-agent-cost-v2-basis-gate (D28/RULE-42) -- this writer now obeys
    // RULE-12 too: `eligible_for_knn: true` with no basis (the pre-lane behavior) would
    // have put every salvaged legacy observation straight into the k-NN population. The
    // salvaged tokens/cost above are unchanged; only their honest labelling is added.
    eligible_for_knn: false,
    accounting_basis: "unknown",
    knn_ineligibility_reasons: ["TOKEN_BASIS_MISMATCH"],
    knn_ineligibility_detail: [
      'observation reconstructed from a legacy ledger; accounting basis is "unknown"',
    ],
    provenance: "imported_legacy_ledger",
  });

  return { observation, entryRejects };
}
