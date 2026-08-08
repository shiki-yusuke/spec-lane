import {
  type AgentCostMeasureResult,
  type AgentCostRow,
  type CalibrationObservation,
  CalibrationObservationSchema,
  type CalibrationPredictionEvaluation,
  type EstimateRevision,
  type LedgerEntry,
  type MeasurementQuality,
  type Predictors,
  TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
} from "@lane/schemas";
import { computeLaneScopeLedgerEntryId, deriveConfidence } from "../ledger.js";

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
  const error: CalibrationPredictionEvaluation["error"] = {};
  const actualTokens = observation.actual.tokens;
  if (actualTokens != null) {
    const tokensError = relativeError(revision.predicted.tokens.p50, actualTokens);
    error.tokens = {
      relative_error_p50: tokensError.value,
      covered_by_p80: actualTokens <= revision.predicted.tokens.p80,
      ...(tokensError.reason ? { reason: tokensError.reason } : {}),
    };
  }
  const actualCost = observation.actual.estimated_cost_usd;
  if (actualCost != null) {
    const costError = relativeError(revision.predicted.cost_usd.p50, actualCost);
    error.cost_usd = {
      relative_error_p50: costError.value,
      covered_by_p80: actualCost <= revision.predicted.cost_usd.p80,
      ...(costError.reason ? { reason: costError.reason } : {}),
    };
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
      // MP-8 (2026-08-08, sol ruling point 7) — agent-cost's own raw total (cache tokens
      // included), the one basis this codebase currently knows how to produce.
      token_basis: TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
    },
    measurement_quality: "observed",
    eligible_for_knn: anyMatched && fullyPriced,
    provenance: "measured",
  });
}

export interface BuildLaneScopeLedgerEntryInput {
  laneId: string;
  measurement: AgentCostMeasureResult;
  since?: Date;
  until?: Date;
  importedAt: string;
}

type LaneScopeAgent = "claude" | "codex";

function sourceForAgent(agent: LaneScopeAgent): "claude_jsonl_auto" | "codex_sqlite_auto" {
  return agent === "claude" ? "claude_jsonl_auto" : "codex_sqlite_auto";
}

interface AgentTotals {
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
function totalsByAgent(rows: readonly AgentCostRow[]): Map<LaneScopeAgent, AgentTotals> {
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
function fallbackAgent(measurement: AgentCostMeasureResult): LaneScopeAgent {
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
      pricing_version: pricingVersion,
      pricing_as_of: input.measurement.generated_at,
      imported_at: input.importedAt,
      since: input.since ? input.since.toISOString() : null,
      until: input.until ? input.until.toISOString() : null,
      agents: [agent],
    };
  });
}
