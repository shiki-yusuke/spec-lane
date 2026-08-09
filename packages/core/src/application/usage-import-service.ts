import type { AgentCostMeasureResult, LedgerEntry, Phase } from "@lane/schemas";
import { computeLedgerEntryId, deriveConfidence } from "../ledger.js";
import { fallbackAgent, sourceForAgent, totalsByAgent } from "./calibrate-service.js";

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
      pricing_version: pricingVersion,
      pricing_as_of: input.measurement.generated_at,
      imported_at: input.importedAt,
      since: input.since ? input.since.toISOString() : null,
      until: input.until ? input.until.toISOString() : null,
      agents: [agent],
    };
  });
}
