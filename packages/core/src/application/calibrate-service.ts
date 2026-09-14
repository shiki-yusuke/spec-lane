import {
  type AgentCostMeasureResult,
  type AgentCostRow,
  CURRENT_ACCOUNTING_BASIS,
  type CalibrationObservation,
  CalibrationObservationSchema,
  type CalibrationPredictionEvaluation,
  ESTIMATE_V2_REASON_CODES,
  type EstimateRevision,
  type EstimateV2ReasonCode,
  type LedgerEntry,
  type MeasurementQuality,
  type Predictors,
} from "@lane/schemas";
import type { AttributionProjection } from "../attribution.js";
import { computeLaneScopeLedgerEntryId, deriveConfidence, normalizeEntryBasis } from "../ledger.js";

// I-2026-09-10-agent-cost-v2-basis-gate (D6/RULE-05..12/RULE-39) -- the closed set of
// data_quality dedup counters RULE-07 inspects, in the order RULE-39's Ordering rule 1
// requires (conflicting_duplicate_groups, then missing_dedup_identity_rows, then
// source_quality.identity_missing).
const DEDUP_COUNTERS = [
  "conflicting_duplicate_groups",
  "missing_dedup_identity_rows",
  "source_quality.identity_missing",
] as const;
type DedupCounterName = (typeof DEDUP_COUNTERS)[number];

interface DedupDataQuality {
  conflicting_duplicate_groups?: number;
  missing_dedup_identity_rows?: number;
  source_quality: Record<string, number>;
}

function readCounterValue(
  dataQuality: DedupDataQuality,
  counter: DedupCounterName,
): number | undefined {
  if (counter === "source_quality.identity_missing") {
    return dataQuality.source_quality.identity_missing;
  }
  return dataQuality[counter];
}

type CounterTemplate = "T-3" | "T-4" | "T-5";

/** RULE-07: clean only when present as a finite non-negative integer equal to 0. */
function classifyCounter(value: number | undefined): {
  clean: boolean;
  template?: CounterTemplate;
} {
  if (value === undefined) return { clean: false, template: "T-4" };
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return { clean: false, template: "T-5" };
  }
  if (value === 0) return { clean: true };
  return { clean: false, template: "T-3" };
}

export interface DeriveKnnIneligibilityInput {
  /** The raw measurement's basis/data_quality -- accounting_basis undefined means the
   * payload declared none (agent-cost 0.1.x). */
  measurement: {
    accounting_basis?: string;
    data_quality: DedupDataQuality;
  };
  /** The entry's own session_ids -- RULE-09. */
  sessionIds: readonly string[];
  /** An already-built attribution projection (D7/D9) -- never re-derived here. */
  attribution: AttributionProjection;
}

export interface KnnIneligibility {
  reasons: EstimateV2ReasonCode[];
  detail: string[];
}

/**
 * D6/RULE-05..12/RULE-39 -- the one predicate that decides why a measurement is (or is
 * not) fit for the k-NN population, and the matching human-readable detail strings.
 * Exported from this module for the same "one rule, reused, not reimplemented" reason as
 * totalsByAgent/fallbackAgent/sourceForAgent below (design.md §5.6);
 * usage-import-service.ts, buildObservationFromMeasurement below and both CLI commands
 * call it. Pure: no filesystem, no subprocess.
 */
export function deriveKnnIneligibility(input: DeriveKnnIneligibilityInput): KnnIneligibility {
  const reasons = new Set<EstimateV2ReasonCode>();
  const detail: string[] = [];

  // RULE-06/T-1/T-2 -- basis comparison first (matches RULE-20's basis-first ordering on
  // the estimate/v2 side of the same rule).
  const rawBasis = input.measurement.accounting_basis;
  if (rawBasis === undefined) {
    reasons.add("TOKEN_BASIS_MISMATCH");
    detail.push(
      `accounting basis is "unknown" (the measurement declared none); the current basis is "${CURRENT_ACCOUNTING_BASIS}"`,
    );
  } else if (rawBasis !== CURRENT_ACCOUNTING_BASIS) {
    reasons.add("TOKEN_BASIS_MISMATCH");
    detail.push(
      `accounting basis "${rawBasis}" is not the current basis "${CURRENT_ACCOUNTING_BASIS}"`,
    );
  }

  // RULE-07 / RULE-39 Ordering rule 1 -- counter templates first, closed-set order.
  const counterDetail: string[] = [];
  let anyDirtyCounter = false;
  for (const counter of DEDUP_COUNTERS) {
    const value = readCounterValue(input.measurement.data_quality, counter);
    const outcome = classifyCounter(value);
    if (outcome.clean) continue;
    anyDirtyCounter = true;
    if (outcome.template === "T-3") {
      counterDetail.push(`data_quality.${counter} is ${value}, expected 0`);
    } else if (outcome.template === "T-4") {
      counterDetail.push(`data_quality.${counter} is absent; an explicit 0 is required`);
    } else {
      counterDetail.push(`data_quality.${counter} is not a finite non-negative integer`);
    }
  }

  // RULE-09 / RULE-39 Ordering rule 2 -- session templates, sorted by session_id ascending.
  const sessionDetail: string[] = [];
  let anyNonExactSession = false;
  const sortedSessionIds = [...input.sessionIds].sort();
  for (const sessionId of sortedSessionIds) {
    const info = input.attribution.describe(sessionId);
    if (info.state === "exactly_attributed") continue;
    anyNonExactSession = true;
    if (info.state === "unbound") {
      sessionDetail.push(
        `session ${sessionId} is unbound (usage recorded, no session_bound event)`,
      );
    } else if (info.state === "mixed") {
      sessionDetail.push(`session ${sessionId} is bound to ${info.bindingCount ?? 0} task_runs`);
    } else if (info.state === "orphan_usage") {
      sessionDetail.push(`session ${sessionId} is orphan usage (in the ledger, never bound)`);
    } else if (info.state === "measurement_incomplete") {
      sessionDetail.push(
        `session ${sessionId} is measurement-incomplete for task_run ${info.taskRunId ?? ""}`,
      );
    } else {
      // "never_imported" -- T-10.
      sessionDetail.push(`session ${sessionId} has never been usage-imported`);
    }
  }

  if (anyDirtyCounter || anyNonExactSession) {
    reasons.add("MIXED_OR_UNATTRIBUTED_USAGE");
  }

  detail.push(...counterDetail, ...sessionDetail);

  // RULE-10 -- reasons ordered by ESTIMATE_V2_REASON_CODES declaration order.
  const orderedReasons = ESTIMATE_V2_REASON_CODES.filter((code) => reasons.has(code));

  return { reasons: orderedReasons, detail };
}

// design.md §2.7/§3.8/§5.1 — `lane calibrate` only ever reads the adopted baseline
// revision; it never rewrites it. It creates one observation record from measured actuals
// and, if a baseline exists, one prediction-evaluation record scoring that baseline
// against the observation. Both are pure functions here: the caller (CLI, M2) is
// responsible for sourcing `actual` from the Telemetry adapter and appending the returned
// records to the calibration store.

/**
 * MP-8 (2026-08-08, sol ruling point 7) — `predictedP50 === 0` with a nonzero `actual`
 * used to return `Number.POSITIVE_INFINITY`, which does not round-trip through JSON
 * (`JSON.stringify(Infinity)` -> `"null"`, which then fails `z.number()` on the next
 * read). Returns `null` + a machine-readable `reason` for that case instead, and the
 * real ratio (however large, e.g. 2096.03396) unclipped and unrounded in every other
 * case — never fabricating a cap that would misrepresent how wrong the prediction was.
 */
function relativeError(
  predictedP50: number,
  actual: number,
): { value: number | null; reason?: "predicted_p50_zero" } {
  if (predictedP50 === 0) {
    return actual === 0 ? { value: 0 } : { value: null, reason: "predicted_p50_zero" };
  }
  return { value: (actual - predictedP50) / predictedP50 };
}

export function evaluatePrediction(
  observation: CalibrationObservation,
  revision: EstimateRevision,
  recordId: string,
  evaluatedAt: string,
): CalibrationPredictionEvaluation {
  if (revision.predicted === undefined) {
    // Defensive: `revision` here is always a call's *baseline*, and `lane estimate
    // --adopt` refuses to adopt an abstained (predicted-less) revision as baseline
    // (AbstainedRevisionCannotBeBaselineError, estimate-service.ts) -- callers (CLI
    // calibrate.ts) are expected to check `baseline.predicted !== undefined` before ever
    // reaching this call, so hitting this in practice means that invariant broke.
    throw new Error(
      `evaluatePrediction: revision ${revision.revision_id} has no predicted value (estimate/v2 abstained) -- an abstained baseline must not be scored`,
    );
  }
  // I-2026-09-10-agent-cost-v2-basis-gate (D22/RULE-37) -- a prediction is never scored
  // across bases: absent or "unknown" on either side also counts as a mismatch, not just
  // two different known values.
  const baselineBasis = revision.token_basis;
  const observedBasis = observation.actual.token_basis;
  const isKnownBasis = (value: string | undefined) => value !== undefined && value !== "unknown";
  const basisMismatch =
    !isKnownBasis(baselineBasis) || !isKnownBasis(observedBasis) || baselineBasis !== observedBasis;

  const error: CalibrationPredictionEvaluation["error"] = {};
  const actualTokens = observation.actual.tokens;
  if (actualTokens != null) {
    if (basisMismatch) {
      error.tokens = {
        relative_error_p50: null,
        covered_by_p80: null,
        reason: "token_basis_mismatch",
      };
    } else {
      const tokensError = relativeError(revision.predicted.tokens.p50, actualTokens);
      error.tokens = {
        relative_error_p50: tokensError.value,
        covered_by_p80: actualTokens <= revision.predicted.tokens.p80,
        ...(tokensError.reason ? { reason: tokensError.reason } : {}),
      };
    }
  }
  const actualCost = observation.actual.estimated_cost_usd;
  if (actualCost != null) {
    if (basisMismatch) {
      error.cost_usd = {
        relative_error_p50: null,
        covered_by_p80: null,
        reason: "token_basis_mismatch",
      };
    } else {
      const costError = relativeError(revision.predicted.cost_usd.p50, actualCost);
      error.cost_usd = {
        relative_error_p50: costError.value,
        covered_by_p80: actualCost <= revision.predicted.cost_usd.p80,
        ...(costError.reason ? { reason: costError.reason } : {}),
      };
    }
  }
  return {
    schema_version: "1.0",
    record_id: recordId,
    kind: "prediction_evaluation",
    intent_id: observation.intent_id,
    estimate_revision_id: revision.revision_id,
    evaluated_at: evaluatedAt,
    predicted: revision.predicted,
    actual_record_id: observation.record_id,
    error,
  };
}

export interface BuildObservationFromMeasurementInput {
  recordId: string;
  intentId: string;
  recordedAt: string;
  predictors: Predictors;
  predictorQuality: MeasurementQuality;
  measurement: AgentCostMeasureResult;
  /** RULE-09/D6 -- the session_ids this observation's measurement covers. */
  sessionIds: readonly string[];
  /** D7/D9 -- an already-built attribution projection; never re-derived here. */
  attribution: AttributionProjection;
}

/**
 * Builds a CalibrationObservation (§2.7) from a real AgentCostTelemetryAdapter.measure()
 * result. `measurement.total` is agent-cost's own union-of-requested-sessions total
 * (design.md §4.1) — the right number to attribute to this one intent's measured window.
 *
 * pricing_status is "unpriced" whenever any of the measured tokens were unpriced (agent-
 * cost's data_quality.unpriced_tokens/session totals.unpriced_tokens > 0), not just when
 * *all* of them were — a partially-priced total is still not fully trustworthy.
 * eligible_for_knn mirrors that: a partially-unpriced or entirely-unmatched measurement
 * must not quietly pollute the k-NN population with an underestimated cost.
 */
export function buildObservationFromMeasurement(
  input: BuildObservationFromMeasurementInput,
): CalibrationObservation {
  const totals = input.measurement.total.totals;
  const fullyPriced = totals.unpriced_tokens === 0;
  const anyMatched = Object.values(input.measurement.sessions).some((s) => s.matched);

  // I-2026-09-10-agent-cost-v2-basis-gate (D6/D19/RULE-05/11/12/31) -- the one predicate,
  // reused: reasons/detail come from deriveKnnIneligibility, never reimplemented here.
  const ineligibility = deriveKnnIneligibility({
    measurement: {
      accounting_basis: input.measurement.accounting_basis,
      data_quality: input.measurement.data_quality,
    },
    sessionIds: input.sessionIds,
    attribution: input.attribution,
  });
  // RULE-31/D20/RULE-32: actual.token_basis is exactly the measurement's normalized
  // accounting_basis, through the same normalizeEntryBasis() ledger.ts entries use --
  // absent (agent-cost 0.1.x declared none) normalizes to "unknown", never guessed.
  const normalizedBasis = normalizeEntryBasis(input.measurement).accountingBasis;

  return CalibrationObservationSchema.parse({
    schema_version: "1.0",
    record_id: input.recordId,
    kind: "observation",
    intent_id: input.intentId,
    recorded_at: input.recordedAt,
    predictors: input.predictors,
    predictor_quality: input.predictorQuality,
    actual: {
      tokens: totals.tokens,
      estimated_cost_usd: totals.estimated_cost_usd,
      credits: totals.credits,
      pricing_catalog_version: input.measurement.rates.catalog_version,
      pricing_status: fullyPriced ? "priced" : "unpriced",
      token_basis: normalizedBasis,
    },
    measurement_quality: "observed",
    // RULE-11: the pre-existing matched-and-fully-priced condition keeps its independent
    // power to make an observation ineligible even with an empty reasons array.
    eligible_for_knn: ineligibility.reasons.length === 0 && anyMatched && fullyPriced,
    accounting_basis: normalizedBasis,
    knn_ineligibility_reasons: ineligibility.reasons,
    knn_ineligibility_detail: ineligibility.detail,
    provenance: "measured",
  });
}

export interface BuildLaneScopeLedgerEntryInput {
  laneId: string;
  measurement: AgentCostMeasureResult;
  since?: Date;
  until?: Date;
  importedAt: string;
  /** D7/D9 -- an already-built attribution projection; never re-derived here. */
  attribution: AttributionProjection;
}

// Exported (not module-private) as of M0 spec-lane 0.5.0: usage-import-service.ts's
// phase-scoped ledger-entry builder needs the exact same per-agent attribution rules this
// module's own lane-scope builder already uses -- one rule, reused, not reimplemented.
export type LaneScopeAgent = "claude" | "codex";

export function sourceForAgent(agent: LaneScopeAgent): "claude_jsonl_auto" | "codex_sqlite_auto" {
  return agent === "claude" ? "claude_jsonl_auto" : "codex_sqlite_auto";
}

export interface AgentTotals {
  tokens: number;
  estimatedCostUsd: number;
  credits: number;
}

/**
 * MP-8 must-1 fix (2026-08-08, Codex review round) — sums `measurement.total.rows`' own
 * per-row `agent` field into per-agent totals. This is the *observed* breakdown (which
 * agent's usage these tokens actually came from), not `measurement.agent` (which only
 * echoes back which agents the query was scoped to include — calibrate.ts never passes
 * an `--agent` filter to the adapter, so in real usage that field is close to
 * unconditionally `["claude","codex"]` and useless for attribution on its own).
 */
export function totalsByAgent(rows: readonly AgentCostRow[]): Map<LaneScopeAgent, AgentTotals> {
  const byAgent = new Map<LaneScopeAgent, AgentTotals>();
  for (const row of rows) {
    if (row.agent !== "claude" && row.agent !== "codex") continue;
    const cur = byAgent.get(row.agent) ?? { tokens: 0, estimatedCostUsd: 0, credits: 0 };
    cur.tokens += row.tokens;
    cur.estimatedCostUsd += row.estimated_cost_usd;
    cur.credits += row.credits;
    byAgent.set(row.agent, cur);
  }
  return byAgent;
}

/** Single-agent fallback when the rows carry no attributable agent breakdown at all. */
export function fallbackAgent(measurement: AgentCostMeasureResult): LaneScopeAgent {
  const [only, second] = measurement.agent;
  return only !== undefined && second === undefined ? only : "claude";
}

/**
 * Builds the `scope:"lane"` `LedgerEntry`(ies) spec.md Rule 1 requires alongside the
 * observation, from the exact same measurement.
 *
 * MP-8 must-1 fix (2026-08-08, Codex review round) — a measurement can span more than one
 * agent (agent-cost's own `--agent` filter accepts both, and calibrate.ts never passes
 * one at all, so a real measurement's rows can legitimately mix claude and codex usage).
 * The previous version hardcoded `source: "claude_jsonl_auto"` regardless, which silently
 * misattributed codex-only or mixed measurements as claude — corrupting the entry's
 * identity (computeLaneScopeLedgerEntryId keys off source) and defeating
 * deriveIncludedInKpi's codex-specific dedup rule (it only fires for
 * source==="codex_sqlite_auto"), opening the door to double-counting.
 *
 * Returns one entry per agent that actually contributed tokens (per totalsByAgent above),
 * each carrying only that agent's own totals — never a single entry blending two agents'
 * costs under one source. This mirrors how claude_jsonl_auto/codex_sqlite_auto already
 * behave as strictly single-agent sources everywhere else in this codebase; "mixed" was
 * never a concept the schema or the Python reference implementation supported, so a
 * genuinely mixed measurement is represented as two separately-attributed entries rather
 * than inventing a blended one. Any tokens/cost agent-cost couldn't attribute to either
 * agent (a null-agent row, or a rounding mismatch against `total.totals`) are folded into
 * a single fallback bucket (fallbackAgent above) so nothing is ever silently dropped from
 * the ledger. The common case — a single real agent, or no rows at all (data_state
 * no_data/zero_tokens, where misattribution can't corrupt any KPI-eligible cost number) —
 * still produces exactly one entry, matching this task's own acceptance criteria.
 *
 * `data_state` is derived the same way any other ledger entry's is (ledger.ts's
 * classifyDataState, called by the caller before this — see emit-metrics.ts's own
 * equivalent pattern) is deliberately *not* duplicated here; this function assumes a
 * successful measurement always reached this point (the caller already branched on
 * measurement failure) and only needs to decide has_usage vs. zero_tokens vs. no_data
 * from each agent's own totals.
 */
export function buildLaneScopeLedgerEntries(input: BuildLaneScopeLedgerEntryInput): LedgerEntry[] {
  const totals = input.measurement.total.totals;
  const anyMatched = Object.values(input.measurement.sessions).some((s) => s.matched);
  const byAgent = totalsByAgent(input.measurement.total.rows);

  const attributedTokens = [...byAgent.values()].reduce((sum, t) => sum + t.tokens, 0);
  const attributedCost = [...byAgent.values()].reduce((sum, t) => sum + t.estimatedCostUsd, 0);
  const attributedCredits = [...byAgent.values()].reduce((sum, t) => sum + t.credits, 0);
  const remainderTokens = totals.tokens - attributedTokens;
  if (byAgent.size === 0 || remainderTokens > 0) {
    const agent = fallbackAgent(input.measurement);
    const cur = byAgent.get(agent) ?? { tokens: 0, estimatedCostUsd: 0, credits: 0 };
    cur.tokens += Math.max(remainderTokens, 0);
    cur.estimatedCostUsd += Math.max(totals.estimated_cost_usd - attributedCost, 0);
    cur.credits += Math.max(totals.credits - attributedCredits, 0);
    byAgent.set(agent, cur);
  }

  const pricingVersion = input.measurement.rates.catalog_version;
  // I-2026-09-10-agent-cost-v2-basis-gate (D6/RULE-03/04/12) -- one reasons/detail
  // derivation for this whole measurement's session set, shared by every per-agent entry
  // below (they all cover the same session_ids -- see the callsite's own comment).
  const ineligibility = deriveKnnIneligibility({
    measurement: {
      accounting_basis: input.measurement.accounting_basis,
      data_quality: input.measurement.data_quality,
    },
    sessionIds: input.measurement.session_ids,
    attribution: input.attribution,
  });
  const normalizedBasis =
    input.measurement.accounting_basis !== undefined
      ? input.measurement.accounting_basis
      : "unknown";
  const producerVersion =
    input.measurement.producer_version !== undefined ? input.measurement.producer_version : null;

  return [...byAgent.entries()].map(([agent, agentTotals]) => {
    const source = sourceForAgent(agent);
    const dataState = !anyMatched
      ? "no_data"
      : agentTotals.tokens <= 0
        ? "zero_tokens"
        : "has_usage";
    return {
      ledger_entry_id: computeLaneScopeLedgerEntryId(input.laneId, source, pricingVersion),
      lane_id: input.laneId,
      scope: "lane",
      phase: null,
      source,
      session_ids: [...input.measurement.session_ids],
      data_state: dataState,
      confidence: deriveConfidence(source, "lane"),
      included_in_kpi: dataState === "has_usage" || dataState === "zero_tokens",
      tokens: agentTotals.tokens,
      turns: null,
      cost_usd: agentTotals.estimatedCostUsd,
      cost_credits: agentTotals.credits,
      accounting_basis: normalizedBasis,
      producer_version: producerVersion,
      knn_ineligibility_reasons: ineligibility.reasons,
      knn_ineligibility_detail: ineligibility.detail,
      pricing_version: pricingVersion,
      pricing_as_of: input.measurement.generated_at,
      imported_at: input.importedAt,
      since: input.since ? input.since.toISOString() : null,
      until: input.until ? input.until.toISOString() : null,
      agents: [agent],
    };
  });
}
