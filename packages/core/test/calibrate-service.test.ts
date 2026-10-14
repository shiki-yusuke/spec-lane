import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentCostMeasureResult,
  type AgentCostRow,
  CURRENT_ACCOUNTING_BASIS,
  type Predictors,
} from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  buildLaneScopeLedgerEntries,
  buildObservationFromMeasurement,
  evaluatePrediction,
} from "../src/application/calibrate-service.js";
import { type AttributionProjection, buildAttributionProjection } from "../src/attribution.js";
import { MEASURE_CONTRACT_VERSION } from "../src/estimator-v2.js";
import { loadProfile } from "../src/profile.js";
import { buildTraceEvent } from "../src/trace.js";

// I-2026-09-10-agent-cost-v2-basis-gate (RULE-12/RULE-15) -- buildObservationFromMeasurement
// and buildLaneScopeLedgerEntries now require `sessionIds`/`attribution` (an already-built
// AttributionProjection, D7/D9). This helper builds the minimal session_bound +
// matched:true usage_imported trace-event pair per session_id that makes
// buildAttributionProjection classify every given session as "exactly_attributed"
// (attribution.ts describe()), so these fixtures' knn eligibility keeps depending only on
// what each test itself varies (pricing/matched/basis), not on attribution state.
function exactlyAttributedProjection(sessionIds: readonly string[]): AttributionProjection {
  const sessionBoundEvents = sessionIds.map((sessionId, i) =>
    buildTraceEvent({
      relation: "session_bound",
      fromRef: { logical_id: `task_run:t-${i}` },
      toRef: { logical_id: `session:${sessionId}` },
      occurredAt: "2026-07-31T08:00:00Z",
      actor: { kind: "cli", id: "lane" },
      taskRunId: `t-${i}`,
      sessionId,
      payload: { binding_method: "pre_assigned_session_id", agent: "claude" },
    }),
  );
  const usageImportedEvents = sessionIds.map((sessionId, i) =>
    buildTraceEvent({
      relation: "usage_imported",
      fromRef: { logical_id: `session:${sessionId}` },
      toRef: { logical_id: `task_run:t-${i}` },
      occurredAt: "2026-07-31T08:30:00Z",
      actor: { kind: "cli", id: "lane" },
      taskRunId: `t-${i}`,
      sessionId,
      payload: {
        window: { since: "2026-07-31T00:00:00Z", until: "2026-07-31T08:30:00Z" },
        tokens: 0,
        matched: true,
      },
    }),
  );
  return buildAttributionProjection({ usageImportedEvents, sessionBoundEvents });
}

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
  // I-2026-10-15-cohort-producer (TEST-14) -- omitted rows default to one known
  // (claude, claude-sonnet-5-5) row carrying the whole total, so the cohort identity
  // resolves and the pre-existing eligibility assertions keep their meaning (an empty
  // rows array with tokens > 0 is now "cohort_identity: no priced rows").
  rows?: AgentCostRow[],
  agent: ("claude" | "codex")[] = ["claude"],
  // I-2026-09-10-agent-cost-v2-basis-gate (RULE-30/31) -- defaults to the current basis so
  // every pre-existing test in this file (none of which is about basis mismatch) keeps its
  // original knn-eligibility outcome; pass `undefined` explicitly to simulate a payload
  // that declared no basis at all.
  accountingBasis: string | undefined = CURRENT_ACCOUNTING_BASIS,
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
    total: { rows: rows ?? (totals.tokens > 0 ? [knownRow(totals)] : []), totals },
    ...(accountingBasis !== undefined ? { accounting_basis: accountingBasis } : {}),
    // I-2026-09-10-agent-cost-v2-basis-gate (RULE-07) -- a dedup counter that is *absent*
    // is dirty (template T-4: "an explicit 0 is required"), not clean-by-default. Only a
    // 0.2.0-shaped payload that explicitly zeroes all three counters
    // (conflicting_duplicate_groups/missing_dedup_identity_rows/
    // source_quality.identity_missing) is basis-clean enough to leave
    // knn_ineligibility_reasons empty; this fixture must declare them explicitly so the
    // pre-existing (non-basis, non-dedup) tests in this file keep testing only what they
    // say they test, without incidentally tripping RULE-07's own MIXED_OR_UNATTRIBUTED_USAGE.
    data_quality: {
      malformed_events: 0,
      skipped_files: 0,
      negative_deltas: 0,
      unpriced_tokens: totals.unpriced_tokens,
      conflicting_duplicate_groups: 0,
      missing_dedup_identity_rows: 0,
      source_quality: { ok: 1, identity_missing: 0 },
    },
  };
}

function knownRow(totals: AgentCostMeasureResult["total"]["totals"]): AgentCostRow {
  return {
    month: null,
    agent: "claude",
    model: "claude-sonnet-5-5",
    token_kind: "output",
    tokens: totals.tokens,
    priced_tokens: totals.priced_tokens,
    unpriced_tokens: totals.unpriced_tokens,
    estimated_cost_usd: totals.estimated_cost_usd,
    credits: totals.credits,
    pricing_status: "priced",
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
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
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
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
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
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
    });
    expect(obs.eligible_for_knn).toBe(false);
  });

  // MP-8 (2026-08-08, sol ruling point 7); expected value updated for
  // I-2026-09-10-agent-cost-v2-basis-gate RULE-31/D3 -- `actual.token_basis` is now the
  // measurement's own normalized `accounting_basis` (this fixture declares the current
  // basis by default), not an unconditional stamp of the pre-basis-gate v1 literal. The
  // "declares no basis at all -> unknown" half of RULE-31 is covered by
  // basis-gate-services.test.ts.
  it("records token_basis on every observation", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0005",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement(),
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
    });
    expect(obs.actual.token_basis).toBe(CURRENT_ACCOUNTING_BASIS);
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
      attribution: exactlyAttributedProjection(m.session_ids),
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
      attribution: exactlyAttributedProjection(m.session_ids),
    });
    const [b] = buildLaneScopeLedgerEntries({
      laneId: "I-2026-08-08-example",
      measurement: { ...m, session_ids: ["sess-1", "sess-2"] }, // a later, broader re-run
      importedAt: "2026-08-08T10:00:00Z",
      attribution: exactlyAttributedProjection(["sess-1", "sess-2"]),
    });
    expect(a?.ledger_entry_id).toBe(b?.ledger_entry_id);
  });

  it("records no_data (not zero_tokens) when no session matched at all", () => {
    const m = measurement({ tokens: 0, estimated_cost_usd: 0 }, false);
    const [entry] = buildLaneScopeLedgerEntries({
      laneId: "I-2026-08-08-example",
      measurement: m,
      importedAt: "2026-08-08T09:05:00Z",
      attribution: exactlyAttributedProjection(m.session_ids),
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
      attribution: exactlyAttributedProjection(m.session_ids),
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
      attribution: exactlyAttributedProjection(m.session_ids),
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
      attribution: exactlyAttributedProjection(m.session_ids),
    });
    expect(entries).toHaveLength(1);
    // the whole total.totals.tokens, not just the (zero) attributed portion, ends up on
    // the single fallback entry -- nothing silently missing from the ledger.
    expect(entries[0]?.tokens).toBe(10_000);
    expect(entries[0]?.cost_usd).toBe(0.5);
  });
});

// I-2026-09-10-agent-cost-v2-basis-gate (RULE-37/D22) -- evaluatePrediction now treats an
// absent/mismatched token_basis on either side as a mismatch, so every revision literal
// below that expects a real (non-null) score must declare `token_basis:
// CURRENT_ACCOUNTING_BASIS` to match the observation's own (now-required) basis; this is
// an intentional test-value change, not a relaxation of intent (basis-mismatch scoring
// itself is covered by basis-gate-services.test.ts, TEST-60/61).
describe("evaluatePrediction", () => {
  it("computes relative error and p80 coverage for tokens and cost_usd", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-0004",
      intentId: "I-2026-07-31-example-feature",
      recordedAt: "2026-07-31T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement(),
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
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
        token_basis: CURRENT_ACCOUNTING_BASIS,
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
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
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
        token_basis: CURRENT_ACCOUNTING_BASIS,
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
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
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
        token_basis: CURRENT_ACCOUNTING_BASIS,
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
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
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
        token_basis: CURRENT_ACCOUNTING_BASIS,
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

// ---------------------------------------------------------------------------
// I-2026-10-15-cohort-producer -- spec.md D1-D5/D10, TEST-01..06, TEST-10, TEST-11, TEST-14.
// ---------------------------------------------------------------------------

const cohortConfig = {
  agent_type: "claude",
  model_provider: "anthropic",
  model_generation: "claude-5",
  model_id: "claude-sonnet-5-5",
  routing_policy_digest: "a".repeat(64),
  prompt_policy_digest: "b".repeat(64),
  execution_profile_digest: "c".repeat(64),
};

function modelRow(
  agent: "claude" | "codex" | null,
  model: string | null,
  tokens: number,
): AgentCostRow {
  return { ...agentRow("claude", tokens, tokens / 100_000), agent, model };
}

/** A basis-clean, matched, fully-priced measurement whose only variable is total.rows. */
function rowsMeasurement(rows: AgentCostRow[]): AgentCostMeasureResult {
  const tokens = rows.reduce((sum, r) => sum + r.tokens, 0);
  const cost = rows.reduce((sum, r) => sum + r.estimated_cost_usd, 0);
  return measurement({ tokens, priced_tokens: tokens, estimated_cost_usd: cost }, true, rows, [
    "claude",
    "codex",
  ]);
}

function observe(m: AgentCostMeasureResult, withCohortConfig: boolean) {
  return buildObservationFromMeasurement({
    recordId: "cal-cohort",
    intentId: "I-2026-10-15-cohort-producer",
    recordedAt: "2026-10-15T09:00:00Z",
    predictors,
    predictorQuality: "observed",
    measurement: m,
    sessionIds: ["sess-1"],
    attribution: exactlyAttributedProjection(["sess-1"]),
    ...(withCohortConfig ? { cohortConfig } : {}),
  });
}

describe("buildObservationFromMeasurement -- cohort producer (I-2026-10-15-cohort-producer)", () => {
  it("TEST-01: a single known model with cohortConfig writes the derived cohort plus the profile digests", () => {
    const obs = observe(
      rowsMeasurement([
        modelRow("claude", "claude-sonnet-5-5", 70_000),
        modelRow("claude", "claude-sonnet-5-5", 30_000),
      ]),
      true,
    );
    expect(obs.cohort).toEqual({
      agent_type: "claude",
      model_provider: "anthropic",
      model_generation: "claude-5",
      model_id: "claude-sonnet-5-5",
      routing_policy_digest: "a".repeat(64),
      prompt_policy_digest: "b".repeat(64),
      execution_profile_digest: "c".repeat(64),
      measure_contract_version: "measure/v1",
    });
    expect(obs.cohort?.measure_contract_version).toBe(MEASURE_CONTRACT_VERSION);
    expect(obs.knn_ineligibility_reasons).toEqual([]);
    expect(obs.knn_ineligibility_detail).toEqual([]);
    expect(obs.eligible_for_knn).toBe(true);
  });

  it("TEST-01: the identity fields are the derived ones, never copied from cohortConfig", () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-cohort",
      intentId: "I-2026-10-15-cohort-producer",
      recordedAt: "2026-10-15T09:00:00Z",
      predictors,
      predictorQuality: "observed",
      measurement: rowsMeasurement([modelRow("codex", "gpt-5.6-terra", 10_000)]),
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
      cohortConfig: { ...cohortConfig, agent_type: "claude-code", model_generation: "sonnet-5" },
    });
    expect(obs.cohort).toMatchObject({
      agent_type: "codex",
      model_provider: "openai",
      model_generation: "gpt-5",
      model_id: "gpt-5.6-terra",
    });
  });

  it("TEST-02: mixed known models -> ineligible, sorted detail, no cohort, no dominant-model rounding", () => {
    // 99% Sonnet, 1% Opus: a dominant-model rule would pick Sonnet; D-S2a forbids it.
    for (const withCohortConfig of [true, false]) {
      const obs = observe(
        rowsMeasurement([
          modelRow("claude", "claude-sonnet-5-5", 99_000),
          modelRow("claude", "claude-opus-5-5", 1_000),
        ]),
        withCohortConfig,
      );
      expect(obs.cohort).toBeUndefined();
      expect(obs.knn_ineligibility_reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
      expect(obs.knn_ineligibility_detail).toEqual([
        "cohort_identity: mixed rows: claude/claude-opus-5-5, claude/claude-sonnet-5-5",
      ]);
      expect(obs.eligible_for_knn).toBe(false);
      // one observation for the whole measurement, never a per-model split
      expect(obs.actual.tokens).toBe(100_000);
    }
  });

  it("TEST-02: the identity reason is appended once, after the shared predicate's own lines", () => {
    const base = rowsMeasurement([
      modelRow("claude", "claude-sonnet-5-5", 50_000),
      modelRow("codex", "gpt-5.6-terra", 50_000),
    ]);
    const dirty: AgentCostMeasureResult = {
      ...base,
      data_quality: { ...base.data_quality, conflicting_duplicate_groups: 2 },
    };
    const obs = observe(dirty, true);
    expect(obs.knn_ineligibility_reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(obs.knn_ineligibility_detail).toEqual([
      "data_quality.conflicting_duplicate_groups is 2, expected 0",
      "cohort_identity: mixed rows: claude/claude-sonnet-5-5, codex/gpt-5.6-terra",
    ]);
    expect(obs.eligible_for_knn).toBe(false);
  });

  it("TEST-02: a basis mismatch and the identity reason merge in ESTIMATE_V2_REASON_CODES order, each once", () => {
    const base = rowsMeasurement([
      modelRow("claude", "claude-sonnet-5-5", 50_000),
      modelRow("codex", "gpt-5.6-terra", 50_000),
    ]);
    // a payload that declared no accounting basis trips the shared predicate's
    // TOKEN_BASIS_MISMATCH (RULE-06 of I-2026-09-10); the identity predicate then adds
    // MIXED_OR_UNATTRIBUTED_USAGE and the producer re-sorts into the closed-set order.
    const { accounting_basis: _declaredBasis, ...noBasis } = base;
    const obs = observe(noBasis as AgentCostMeasureResult, true);
    expect(obs.knn_ineligibility_reasons).toEqual([
      "TOKEN_BASIS_MISMATCH",
      "MIXED_OR_UNATTRIBUTED_USAGE",
    ]);
    expect(obs.knn_ineligibility_detail).toEqual([
      `accounting basis is "unknown" (the measurement declared none); the current basis is "${CURRENT_ACCOUNTING_BASIS}"`,
      "cohort_identity: mixed rows: claude/claude-sonnet-5-5, codex/gpt-5.6-terra",
    ]);
    expect(obs.eligible_for_knn).toBe(false);
    expect(obs.cohort).toBeUndefined();
  });

  it("TEST-02: mixed known + unknown counts the unknown pair", () => {
    const obs = observe(
      rowsMeasurement([
        modelRow("claude", "claude-sonnet-5-5", 90_000),
        modelRow("claude", "llama-3-70b", 10_000),
      ]),
      true,
    );
    expect(obs.cohort).toBeUndefined();
    expect(obs.knn_ineligibility_detail).toEqual([
      "cohort_identity: mixed rows: claude/claude-sonnet-5-5, +1 unknown",
    ]);
    expect(obs.eligible_for_knn).toBe(false);
  });

  it.each([
    ["null model", "claude", null, "cohort_identity: unknown model (agent claude)"],
    [
      "family mismatch",
      "codex",
      "claude-sonnet-5-5",
      "cohort_identity: unknown model (agent codex)",
    ],
    ["unknown id", "claude", "llama-3-70b", "cohort_identity: unknown model (agent claude)"],
    ["null agent", null, "claude-sonnet-5-5", "cohort_identity: unknown model (agent null)"],
  ] as const)(
    "TEST-03: %s -> ineligible with the unknown-model detail",
    (_label, agent, model, detail) => {
      for (const withCohortConfig of [true, false]) {
        const obs = observe(rowsMeasurement([modelRow(agent, model, 100_000)]), withCohortConfig);
        expect(obs.cohort).toBeUndefined();
        expect(obs.knn_ineligibility_reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
        expect(obs.knn_ineligibility_detail).toEqual([detail]);
        expect(obs.eligible_for_knn).toBe(false);
      }
    },
  );

  it("TEST-04: a zero-token foreign row does not count toward the identity", () => {
    const obs = observe(
      rowsMeasurement([
        modelRow("claude", "claude-sonnet-5-5", 100),
        modelRow("codex", "gpt-5.6", 0),
      ]),
      true,
    );
    expect(obs.cohort?.model_id).toBe("claude-sonnet-5-5");
    expect(obs.knn_ineligibility_detail).toEqual([]);
    expect(obs.eligible_for_knn).toBe(true);
  });

  it("TEST-05: no row with tokens -> 'no priced rows', no cohort", () => {
    const obs = observe(
      measurement({ tokens: 0, priced_tokens: 0, estimated_cost_usd: 0 }, true, [
        modelRow("claude", "claude-sonnet-5-5", 0),
      ]),
      true,
    );
    expect(obs.cohort).toBeUndefined();
    expect(obs.knn_ineligibility_reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(obs.knn_ineligibility_detail).toEqual(["cohort_identity: no priced rows"]);
    expect(obs.eligible_for_knn).toBe(false);
  });

  it("TEST-06: cohortConfig undefined + resolved identity -> no cohort, the pre-change observation field for field", () => {
    const obs = observe(rowsMeasurement([modelRow("claude", "claude-sonnet-5-5", 100_000)]), false);
    expect(Object.hasOwn(obs, "cohort")).toBe(false);
    expect(obs).toEqual({
      schema_version: "1.0",
      record_id: "cal-cohort",
      kind: "observation",
      intent_id: "I-2026-10-15-cohort-producer",
      recorded_at: "2026-10-15T09:00:00Z",
      predictors,
      predictor_quality: "observed",
      actual: {
        tokens: 100_000,
        estimated_cost_usd: 1,
        credits: 0,
        pricing_catalog_version: "2026-07-29",
        pricing_status: "priced",
        token_basis: CURRENT_ACCOUNTING_BASIS,
      },
      measurement_quality: "observed",
      eligible_for_knn: true,
      accounting_basis: CURRENT_ACCOUNTING_BASIS,
      knn_ineligibility_reasons: [],
      knn_ineligibility_detail: [],
      provenance: "measured",
    });
    // and it differs from the configured variant only by the cohort key
    const { cohort, ...withoutCohort } = observe(
      rowsMeasurement([modelRow("claude", "claude-sonnet-5-5", 100_000)]),
      true,
    );
    expect(cohort).toBeDefined();
    expect(withoutCohort).toEqual(obs);
  });

  it("TEST-14: the old fixture shape (rows = [] with tokens > 0) now yields 'no priced rows'", () => {
    const obs = observe(measurement({}, true, []), true);
    expect(obs.cohort).toBeUndefined();
    expect(obs.knn_ineligibility_reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(obs.knn_ineligibility_detail).toEqual(["cohort_identity: no priced rows"]);
    expect(obs.eligible_for_knn).toBe(false);
  });

  it("TEST-10: ledger entries from the same mixed measurement keep the per-agent split and carry no identity reason", () => {
    const m = rowsMeasurement([
      modelRow("claude", "claude-sonnet-5-5", 60_000),
      modelRow("claude", "claude-opus-5-5", 20_000),
      modelRow("codex", "gpt-5.6-terra", 20_000),
    ]);
    const obs = observe(m, true);
    expect(obs.knn_ineligibility_reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);

    const entries = buildLaneScopeLedgerEntries({
      laneId: "I-2026-10-15-cohort-producer",
      measurement: m,
      importedAt: "2026-10-15T09:05:00Z",
      attribution: exactlyAttributedProjection(m.session_ids),
    });
    expect(entries).toHaveLength(2);
    const claudeEntry = entries.find((e) => e.source === "claude_jsonl_auto");
    const codexEntry = entries.find((e) => e.source === "codex_sqlite_auto");
    expect(claudeEntry).toMatchObject({
      tokens: 80_000,
      cost_usd: 0.8,
      agents: ["claude"],
      knn_ineligibility_reasons: [],
      knn_ineligibility_detail: [],
    });
    expect(codexEntry).toMatchObject({
      tokens: 20_000,
      cost_usd: 0.2,
      agents: ["codex"],
      knn_ineligibility_reasons: [],
      knn_ineligibility_detail: [],
    });
    for (const entry of entries) expect(Object.hasOwn(entry, "cohort")).toBe(false);
  });
});

describe("profiles/generic.profile.yaml stays without a cohort (TEST-11, RULE-12)", () => {
  it("loads with estimate.cohort undefined", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const profile = loadProfile(join(repoRoot, "profiles", "generic.profile.yaml"));
    expect(profile.estimate?.cohort).toBeUndefined();
  });
});
