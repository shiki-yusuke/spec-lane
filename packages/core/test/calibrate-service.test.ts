import {
  type AgentCostMeasureResult,
  type AgentCostRow,
  type Predictors,
  TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
} from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  buildLaneScopeLedgerEntries,
  buildObservationFromMeasurement,
  evaluatePrediction,
} from "../src/application/calibrate-service.js";

const predictors: Predictors = {
  files_touched_estimate: 3,
  files_touched_observed: 4,
  layers_crossed: 1,
  risk_class: "low",
  spec_rule_count: 2,
  novel_surface: "false",
};

function measurement(
  overrides: Partial<AgentCostMeasureResult["total"]["totals"]> = {},
  matched = true,
  rows: AgentCostRow[] = [],
  agent: ("claude" | "codex")[] = ["claude"],
): AgentCostMeasureResult {
  const totals = {
    tokens: 120_000,
    priced_tokens: 120_000,
    unpriced_tokens: 0,
    estimated_cost_usd: 3.1,
    credits: 0,
    ...overrides,
  };
  return {
    protocol_version: "measure/v1",
    generated_at: "2026-07-31T09:00:00Z",
    window: { since: null, until: null },
    timezone: "UTC",
    agent,
    rates: { catalog_version: "2026-07-29", sha256: "abc" },
    session_ids: ["sess-1"],
    sessions: { "sess-1": { matched, rows: [], totals } },
    total: { rows, totals },
    data_quality: {
      malformed_events: 0,
      skipped_files: 0,
      negative_deltas: 0,
      unpriced_tokens: totals.unpriced_tokens,
      source_quality: { ok: 1 },
    },
  };
}

function agentRow(
  agent: "claude" | "codex",
  tokens: number,
  estimatedCostUsd: number,
): AgentCostRow {
  return {
    month: null,
    agent,
    model: "m",
    token_kind: "output",
    tokens,
    priced_tokens: tokens,
    unpriced_tokens: 0,
    estimated_cost_usd: estimatedCostUsd,
    credits: 0,
    pricing_status: "priced",
  };
}

describe("buildObservationFromMeasurement", () => {
  it("builds a fully-priced, knn-eligible observation from a matched measurement", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0001",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement(),
    });
    expect(obs.actual.tokens).toBe(120_000);
    expect(obs.actual.pricing_status).toBe("priced");
    expect(obs.eligible_for_knn).toBe(true);
    expect(obs.provenance).toBe("measured");
  });

  it("marks pricing_status=unpriced and excludes from knn when any tokens are unpriced", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0002",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement({ unpriced_tokens: 500 }),
    });
    expect(obs.actual.pricing_status).toBe("unpriced");
    expect(obs.eligible_for_knn).toBe(false);
  });

  it("excludes from knn when no session actually matched", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0003",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement({ tokens: 0, estimated_cost_usd: 0 }, false),
    });
    expect(obs.eligible_for_knn).toBe(false);
  });

  // MP-8 (2026-08-08, sol ruling point 7)
  it("records token_basis on every observation", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0005",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement(),
    });
    expect(obs.actual.token_basis).toBe(TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1);
  });
});

// MP-8 (2026-08-08, sol ruling point 1) — this task's own acceptance-criteria numbers
// (104.8M tokens / $28.34), matching the live reproduction recorded in this lane's own
// intent.yaml premise_evidence.
describe("buildLaneScopeLedgerEntries", () => {
  it("builds a scope=lane entry from a real measurement, matching this task's own repro numbers", () => {
    const m = measurement({ tokens: 104_800_000, estimated_cost_usd: 28.34 });
    const entries = buildLaneScopeLedgerEntries({
      laneId: "I-2026-08-08-example",
      measurement: m,
      since: new Date("2026-08-08T00:00:00Z"),
      until: new Date("2026-08-08T09:00:00Z"),
      importedAt: "2026-08-08T09:05:00Z",
    });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.scope).toBe("lane");
    expect(entry?.phase).toBeNull();
    expect(entry?.source).toBe("claude_jsonl_auto");
    expect(entry?.confidence).toBe("imported_lane");
    expect(entry?.data_state).toBe("has_usage");
    expect(entry?.included_in_kpi).toBe(true);
    expect(entry?.tokens).toBe(104_800_000);
    expect(entry?.cost_usd).toBe(28.34);
    expect(entry?.session_ids).toEqual(["sess-1"]);
    expect(entry?.since).toBe("2026-08-08T00:00:00.000Z");
    expect(entry?.until).toBe("2026-08-08T09:00:00.000Z");
    expect(entry?.agents).toEqual(["claude"]);
  });

  it("is deterministic: the same (laneId, source, pricing_version) always yields the same ledger_entry_id (upsert, never a duplicate)", () => {
    const m = measurement();
    const [a] = buildLaneScopeLedgerEntries({
      laneId: "I-2026-08-08-example",
      measurement: m,
      importedAt: "2026-08-08T09:05:00Z",
    });
    const [b] = buildLaneScopeLedgerEntries({
      laneId: "I-2026-08-08-example",
      measurement: { ...m, session_ids: ["sess-1", "sess-2"] }, // a later, broader re-run
      importedAt: "2026-08-08T10:00:00Z",
    });
    expect(a?.ledger_entry_id).toBe(b?.ledger_entry_id);
  });

  it("records no_data (not zero_tokens) when no session matched at all", () => {
    const m = measurement({ tokens: 0, estimated_cost_usd: 0 }, false);
    const [entry] = buildLaneScopeLedgerEntries({
      laneId: "I-2026-08-08-example",
      measurement: m,
      importedAt: "2026-08-08T09:05:00Z",
    });
    expect(entry?.data_state).toBe("no_data");
  });

  // MP-8 must-1 fix (2026-08-08, Codex review round): agent-cost's own per-row `agent`
  // field (not the --agent selector) determines source/confidence -- a codex-only
  // measurement must never be recorded as claude_jsonl_auto.
  it("must-1: attributes source/confidence from the real row breakdown, not the agent selector, for a codex-only measurement", () => {
    const m = measurement(
      { tokens: 50_000, estimated_cost_usd: 2 },
      true,
      [agentRow("codex", 50_000, 2)],
      ["claude", "codex"], // selector allowed both; only codex actually contributed
    );
    const [entry] = buildLaneScopeLedgerEntries({
      laneId: "I-2026-08-08-example",
      measurement: m,
      importedAt: "2026-08-08T09:05:00Z",
    });
    expect(entry?.source).toBe("codex_sqlite_auto");
    expect(entry?.confidence).toBe("estimated");
    expect(entry?.tokens).toBe(50_000);
    expect(entry?.cost_usd).toBe(2);
    expect(entry?.agents).toEqual(["codex"]);
  });

  // MP-8 must-1 fix (2026-08-08, Codex review round): a genuinely mixed measurement
  // splits into two correctly-attributed entries rather than blending both agents' cost
  // under one (wrong, for at least one of them) source.
  it("must-1: splits a mixed claude+codex measurement into two separately-attributed entries, summing back to the real totals", () => {
    const m = measurement(
      { tokens: 100_000, estimated_cost_usd: 4 },
      true,
      [agentRow("claude", 80_000, 3), agentRow("codex", 20_000, 1)],
      ["claude", "codex"],
    );
    const entries = buildLaneScopeLedgerEntries({
      laneId: "I-2026-08-08-example",
      measurement: m,
      importedAt: "2026-08-08T09:05:00Z",
    });
    expect(entries).toHaveLength(2);
    const claudeEntry = entries.find((e) => e.source === "claude_jsonl_auto");
    const codexEntry = entries.find((e) => e.source === "codex_sqlite_auto");
    expect(claudeEntry).toMatchObject({ tokens: 80_000, cost_usd: 3, agents: ["claude"] });
    expect(codexEntry).toMatchObject({ tokens: 20_000, cost_usd: 1, agents: ["codex"] });
    expect((claudeEntry?.tokens ?? 0) + (codexEntry?.tokens ?? 0)).toBe(100_000);
    expect((claudeEntry?.cost_usd ?? 0) + (codexEntry?.cost_usd ?? 0)).toBe(4);
    // each entry keys its own distinct ledger_entry_id off its own source.
    expect(claudeEntry?.ledger_entry_id).not.toBe(codexEntry?.ledger_entry_id);
  });

  it("must-1: folds an unattributable (null-agent) row's tokens into the fallback bucket rather than dropping them", () => {
    const m = measurement(
      { tokens: 10_000, estimated_cost_usd: 0.5 },
      true,
      [{ ...agentRow("claude", 4_000, 0.2), agent: null }],
      ["claude"],
    );
    const entries = buildLaneScopeLedgerEntries({
      laneId: "I-2026-08-08-example",
      measurement: m,
      importedAt: "2026-08-08T09:05:00Z",
    });
    expect(entries).toHaveLength(1);
    // the whole total.totals.tokens, not just the (zero) attributed portion, ends up on
    // the single fallback entry -- nothing silently missing from the ledger.
    expect(entries[0]?.tokens).toBe(10_000);
    expect(entries[0]?.cost_usd).toBe(0.5);
  });
});

describe("evaluatePrediction", () => {
  it("computes relative error and p80 coverage for tokens and cost_usd", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0004",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement(),
    });
    const evaluation = evaluatePrediction(
      obs,
      {
        revision_id: "r1",
        estimated_at: "2026-07-31T08:00:00+09:00",
        as_of_phase: "1_intent",
        repo_commit: "abc",
        estimator_version: "0.1.0",
        predictors,
        predicted: { tokens: { p50: 100_000, p80: 150_000 }, cost_usd: { p50: 3, p80: 5 } },
        neighbors: [],
        population_condition: { population_size: 0, method: "reference_table", experimental: true },
      },
      "eval-0001",
      "2026-07-31T09:05:00+09:00",
    );
    expect(evaluation.error.tokens?.relative_error_p50).toBeCloseTo(0.2, 5);
    expect(evaluation.error.tokens?.covered_by_p80).toBe(true);
    expect(evaluation.error.cost_usd?.covered_by_p80).toBe(true);
  });

  // MP-8 (2026-08-08, sol ruling point 7) — this task's own acceptance-criteria ratio,
  // preserved exactly: predicted p50=1000, actual=2097033.96 -> (2097033.96-1000)/1000.
  it("preserves a real large error ratio exactly, unclipped (2096.03396x)", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0006",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement({ tokens: 2_097_033.96, estimated_cost_usd: 3.1 }),
    });
    const evaluation = evaluatePrediction(
      obs,
      {
        revision_id: "r2",
        estimated_at: "2026-07-31T08:00:00+09:00",
        as_of_phase: "1_intent",
        repo_commit: "abc",
        estimator_version: "0.1.0",
        predictors,
        predicted: { tokens: { p50: 1000, p80: 1500 }, cost_usd: { p50: 3, p80: 5 } },
        neighbors: [],
        population_condition: { population_size: 0, method: "reference_table", experimental: true },
      },
      "eval-0002",
      "2026-07-31T09:05:00+09:00",
    );
    expect(evaluation.error.tokens?.relative_error_p50).toBeCloseTo(2096.03396, 5);
    expect(evaluation.error.tokens?.reason).toBeUndefined();
  });

  // MP-8 (2026-08-08, sol ruling point 7) — predicted.p50=0 with a nonzero actual must
  // never produce a raw Infinity (JSON.stringify(Infinity) -> "null", which then fails
  // z.number() on the next read).
  it("records relative_error_p50=null with a reason when predicted p50=0 and actual is nonzero, never Infinity", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0007",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement({ estimated_cost_usd: 3.1 }),
    });
    const evaluation = evaluatePrediction(
      obs,
      {
        revision_id: "r3",
        estimated_at: "2026-07-31T08:00:00+09:00",
        as_of_phase: "1_intent",
        repo_commit: "abc",
        estimator_version: "0.1.0",
        predictors,
        predicted: { tokens: { p50: 100_000, p80: 150_000 }, cost_usd: { p50: 0, p80: 5 } },
        neighbors: [],
        population_condition: { population_size: 0, method: "reference_table", experimental: true },
      },
      "eval-0003",
      "2026-07-31T09:05:00+09:00",
    );
    expect(evaluation.error.cost_usd?.relative_error_p50).toBeNull();
    expect(evaluation.error.cost_usd?.reason).toBe("predicted_p50_zero");
    // the whole record must still round-trip through JSON without becoming invalid
    expect(() => JSON.parse(JSON.stringify(evaluation))).not.toThrow();
    expect(JSON.parse(JSON.stringify(evaluation)).error.cost_usd.relative_error_p50).toBeNull();
  });

  it("records relative_error_p50=0 (not null) when both predicted p50 and actual are 0", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0008",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement({ tokens: 0, estimated_cost_usd: 0 }),
    });
    const evaluation = evaluatePrediction(
      obs,
      {
        revision_id: "r4",
        estimated_at: "2026-07-31T08:00:00+09:00",
        as_of_phase: "1_intent",
        repo_commit: "abc",
        estimator_version: "0.1.0",
        predictors,
        predicted: { tokens: { p50: 0, p80: 5 }, cost_usd: { p50: 100, p80: 150 } },
        neighbors: [],
        population_condition: { population_size: 0, method: "reference_table", experimental: true },
      },
      "eval-0004",
      "2026-07-31T09:05:00+09:00",
    );
    expect(evaluation.error.tokens?.relative_error_p50).toBe(0);
    expect(evaluation.error.tokens?.reason).toBeUndefined();
  });
});
