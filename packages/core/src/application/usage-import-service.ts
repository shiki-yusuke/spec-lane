import type { AgentCostMeasureResult, LedgerEntry, Phase } from "@lane/schemas";
import type { AttributionProjection } from "../attribution.js";
import { computeLedgerEntryId, deriveConfidence } from "../ledger.js";
import {
  deriveKnnIneligibility,
  fallbackAgent,
  sourceForAgent,
  totalsByAgent,
} from "./calibrate-service.js";

// M0 spec-lane 0.5.0 — `lane usage-import`'s phase-scoped counterpart to
// calibrate-service.ts's buildLaneScopeLedgerEntries: same per-agent attribution rules
// (never a blended/misattributed entry for a measurement spanning more than one agent),
// but scope:"phase" (one task_run's own measured window) instead of scope:"lane" (the
// whole delivery). Reuses that module's totalsByAgent/fallbackAgent/sourceForAgent rather
// than re-deriving the same attribution rule a second time.

export interface BuildPhaseScopedLedgerEntriesInput {
  laneId: string;
  phase: Phase;
  measurement: AgentCostMeasureResult;
  since?: Date;
  until?: Date;
  importedAt: string;
  /** D7/D9/DEP-05 -- an already-built attribution projection; never re-derived here.
   * RULE-15: the caller derives this once, after this run's trace events are appended and
   * before any ledger write. */
  attribution: AttributionProjection;
}

/**
 * Builds the `scope:"phase"` `LedgerEntry`(ies) for one task_run's measured window.
 * Returns one entry per agent that actually contributed tokens (mirroring
 * buildLaneScopeLedgerEntries' own "never blend two agents' costs into one entry" rule);
 * any tokens agent-cost couldn't attribute to either agent fold into a single fallback
 * bucket so nothing is silently dropped.
 */
export function buildPhaseScopedLedgerEntries(
  input: BuildPhaseScopedLedgerEntriesInput,
): LedgerEntry[] {
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
  // derivation for this measurement's session set, shared by every per-agent entry below
  // (they all cover the same session_ids -- see buildLaneScopeLedgerEntries' own comment
  // for why one measurement can still produce more than one entry).
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
      ledger_entry_id: computeLedgerEntryId(input.laneId, input.phase, source, pricingVersion),
      lane_id: input.laneId,
      scope: "phase",
      phase: input.phase,
      source,
      session_ids: [...input.measurement.session_ids],
      data_state: dataState,
      confidence: deriveConfidence(source, "phase"),
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
