import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doneOverlayPath, readDoneOverlay } from "@lane/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { listObservations } from "../src/calibration-store.js";
import { runAdvance } from "../src/commands/advance.js";
import { runCalibrate } from "../src/commands/calibrate.js";
import { runConsensus } from "../src/commands/consensus.js";
import { runEmitMetrics } from "../src/commands/emit-metrics.js";
import { runEstimate } from "../src/commands/estimate.js";
import { runStart } from "../src/commands/start.js";
import { runUsageImport } from "../src/commands/usage-import.js";
import { runWorkBind, runWorkStart } from "../src/commands/work.js";
import { readIntent, writeIntent } from "../src/intent-store.js";
import { readLaneState, writeLaneState } from "../src/state-store.js";
import { writeVerification } from "../src/verification-store.js";
import { emptyAgentCostHome } from "./helpers/agent-cost-home.js";

// M0 spec-lane 0.5.0: estimate/v2 requires profile.estimate.cohort to be configured
// before runEstimate will produce any revision at all -- shared across every runEstimate
// call below (content doesn't depend on any per-test state, so it's written once).
const TEST_PROFILE_PATH = join(
  mkdtempSync(join(tmpdir(), "lane-calibrate-profile-")),
  "test.profile.yaml",
);
writeFileSync(
  TEST_PROFILE_PATH,
  stringifyYaml({
    schema_version: "1.0",
    profile_id: "test",
    estimate: {
      cohort: {
        agent_type: "claude",
        model_provider: "anthropic",
        model_generation: "claude-5",
        model_id: "claude-sonnet-5",
        routing_policy_digest: "a".repeat(64),
        prompt_policy_digest: "b".repeat(64),
        execution_profile_digest: "c".repeat(64),
      },
    },
  }),
);

// Real integration test against the actual agent-cost binary — same convention as
// packages/adapters/test/telemetry-agent-cost.test.ts (and the same "not on PATH yet"
// caveat: agent-cost isn't published anywhere pip can install it from yet, only from an
// editable local checkout). Skipped entirely if agent-cost can't be resolved via PATH or
// LANE_TEST_AGENT_COST_BIN (point that env var at your own local install to run these).
function resolveAgentCostBin(): string | null {
  if (process.env.LANE_TEST_AGENT_COST_BIN) return process.env.LANE_TEST_AGENT_COST_BIN;
  try {
    execFileSync("agent-cost", ["--version"], { stdio: "ignore" });
    return "agent-cost";
  } catch {
    // not on PATH
  }
  return null;
}

const bin = resolveAgentCostBin();
const describeOrSkip = bin ? describe : describe.skip;

// A narrow, arbitrary historical window. Bounding with --since/--until didn't reliably cut
// scan time on this dev machine on repeated measurement (unlike the single fast run
// telemetry-agent-cost.test.ts happened to observe) — agent-cost's own read cost seems to
// dominate regardless. Kept anyway to exercise the --since/--until plumbing (real usage
// always bounds this to a phase's actual window); test timeouts below are sized for the
// slow case, not for an assumed speedup.
const FAST_WINDOW = { since: "2020-01-01T00:00:00Z", until: "2020-01-02T00:00:00Z" };

describeOrSkip("runCalibrate (real agent-cost subprocess)", () => {
  let specDir: string;
  let dataDir: string;
  const intentId = "I-2026-07-31-calibrate-flow";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-calibrate-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-calibrate-data-"));
    process.env.LANE_DATA_DIR = dataDir;
    // Keep the real agent-cost subprocess hermetic -- see helpers/agent-cost-home.ts for
    // the measured reason (26s over the developer's real logs vs 0s over an empty root).
    const agentCostHome = emptyAgentCostHome();
    process.env.CLAUDE_HOME = agentCostHome.CLAUDE_HOME;
    process.env.CODEX_HOME = agentCostHome.CODEX_HOME;
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("requires at least one --session-id", async () => {
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: [],
      agentCostBin: bin ?? undefined,
    });
    expect(result.exitCode).toBe(1);
  });

  it("records a CalibrationObservation for a session id with no matched usage, and no prediction_evaluation without a baseline", async () => {
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["lane-test-nonexistent-session-id"],
      agentCostBin: bin ?? undefined,
      ...FAST_WINDOW,
    });
    expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain("tokens=0");
    expect(result.message).toContain("no baseline_estimate_revision_id");

    const observations = listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.intent_id).toBe(intentId);
    // must-1 (M2 review, 2026-07-31): with no baseline adopted, predictors fall back to a
    // freshly-built (necessarily impact-scan-less) set, and predictor_quality must say so
    // explicitly rather than implying "observed" the way the old hardcoded value did.
    expect(observations[0]?.predictors.files_touched_estimate).toBeNull();
    expect(observations[0]?.predictor_quality).toBe("imputed");
    // agent-cost's own scan cost dominates regardless of --since/--until bounding on this
    // dev machine (observed ~20-25s either way) — headroom over that, not over a "fast
    // bounded scan" assumption that didn't hold up under repeated measurement.
  }, 45_000);

  it("must-1: when a baseline with a real impact-scan snapshot is adopted, its predictors (not nulled-out ones) carry over into the observation", async () => {
    const impactScanPath = join(specDir, "impact-scan-report.md");
    writeFileSync(
      impactScanPath,
      [
        "# Impact Scan",
        "```impact-scan:v1",
        JSON.stringify({
          scan_version: "1.0",
          repo_commit: "abc1234",
          candidate_paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
          candidate_layers: ["ui", "domain"],
        }),
        "```",
      ].join("\n"),
    );
    runEstimate(intentId, {
      profile: TEST_PROFILE_PATH,
      specDir,
      impactScanFile: impactScanPath,
      adopt: true,
      // MP-8: no silent reference_table default anymore -- this lane has no
      // calibration population, so all four must be given explicitly.
      referenceTokensP50: 50_000,
      referenceTokensP80: 150_000,
      referenceCostP50: 1,
      referenceCostP80: 4,
    });

    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["lane-test-nonexistent-session-id"],
      agentCostBin: bin ?? undefined,
      ...FAST_WINDOW,
    });
    expect(result.exitCode, result.message).toBe(0);

    const observations = listObservations();
    expect(observations).toHaveLength(1);
    // the values captured in the adopted baseline's own predictors, not null
    expect(observations[0]?.predictors.files_touched_estimate).toBe(3);
    expect(observations[0]?.predictors.layers_crossed).toBe(2);
    expect(observations[0]?.predictor_quality).toBe("observed");
  }, 45_000);

  it("should-5: rejects an invalid --since with a clear message instead of a raw RangeError", async () => {
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["lane-test-nonexistent-session-id"],
      agentCostBin: bin ?? undefined,
      since: "not-a-real-timestamp",
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/--since/);
    expect(result.message).toMatch(/invalid ISO 8601 timestamp/);
  });

  it("re-running with the same session ids overwrites the same observation record (idempotent)", async () => {
    await runCalibrate(intentId, {
      specDir,
      sessionIds: ["lane-test-nonexistent-session-id"],
      agentCostBin: bin ?? undefined,
      ...FAST_WINDOW,
    });
    await runCalibrate(intentId, {
      specDir,
      sessionIds: ["lane-test-nonexistent-session-id"],
      agentCostBin: bin ?? undefined,
      ...FAST_WINDOW,
    });
    expect(listObservations()).toHaveLength(1);
  }, 90_000);

  it("records a prediction_evaluation once a baseline estimate revision is adopted", async () => {
    runEstimate(intentId, {
      profile: TEST_PROFILE_PATH,
      specDir,
      adopt: true,
      // MP-8: no silent reference_table default anymore.
      referenceTokensP50: 50_000,
      referenceTokensP80: 150_000,
      referenceCostP50: 1,
      referenceCostP80: 4,
    });
    const intent = readIntent(specDir, intentId);
    expect(intent.baseline_estimate_revision_id).toBe("r1");
    writeIntent(specDir, intentId, intent); // no-op write, just exercising the store round-trip

    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["lane-test-nonexistent-session-id"],
      agentCostBin: bin ?? undefined,
      ...FAST_WINDOW,
    });
    expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain("prediction_evaluation");
    expect(result.message).toContain("vs baseline r1");
  }, 45_000);

  it("fails when the lane was never started", async () => {
    const result = await runCalibrate("I-2026-07-31-never-started", {
      specDir,
      sessionIds: ["s1"],
      agentCostBin: bin ?? undefined,
    });
    expect(result.exitCode).toBe(2);
  });
});

// MP-8 (2026-08-08) — a fake agent-cost, unconditional (always runs, no real-binary
// dependency) so the new lane-scope-ledger-entry behavior (spec.md Rules 1/2/4/6/7/8b)
// has fast, deterministic coverage independent of whether a real agent-cost is
// installed in this environment.
//
// Codex review round (2026-08-08, must-1/must-2): generalized into
// writeFakeAgentCostMulti to also cover a real per-agent row breakdown (mixed/codex-only
// measurements) and a caller-controlled catalog_version/generated_at (re-calibrate with a
// new pricing_version, superseding an older lane entry).
interface FakeAgentCostRow {
  agent: "claude" | "codex" | null;
  tokens: number;
  costUsd: number;
}

function writeFakeAgentCostMulti(
  dir: string,
  opts: {
    sessionId?: string;
    catalogVersion?: string;
    generatedAt?: string;
    rows: FakeAgentCostRow[];
    // I-2026-09-10-agent-cost-v2-basis-gate -- omitted by default (0.1.x shape, D20);
    // pass explicitly to simulate a 0.2.0 payload.
    accountingBasis?: string;
    producerVersion?: string;
  },
): string {
  const sessionId = opts.sessionId ?? "sess-mp8-1";
  const catalogVersion = opts.catalogVersion ?? "v1";
  const generatedAt = opts.generatedAt ?? "2026-08-08T00:00:00Z";
  const totalTokens = opts.rows.reduce((sum, r) => sum + r.tokens, 0);
  const totalCost = opts.rows.reduce((sum, r) => sum + r.costUsd, 0);
  const totalRowsJson = opts.rows
    .map(
      (r) =>
        `{"month": null, "agent": ${r.agent ? `"${r.agent}"` : "null"}, "model": "claude-sonnet-5", "token_kind": "output", "tokens": ${r.tokens}, "priced_tokens": ${r.tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${r.costUsd}, "credits": 0, "pricing_status": "priced"}`,
    )
    .join(",");
  const distinctAgents = [
    ...new Set(opts.rows.map((r) => r.agent).filter((a): a is "claude" | "codex" => a !== null)),
  ];
  const agentListJson = JSON.stringify(distinctAgents.length > 0 ? distinctAgents : ["claude"]);
  const basisFields = [
    opts.accountingBasis !== undefined
      ? `"accounting_basis": ${JSON.stringify(opts.accountingBasis)},`
      : "",
    opts.producerVersion !== undefined
      ? `"producer_version": ${JSON.stringify(opts.producerVersion)},`
      : "",
  ].join("\n  ");
  const path = join(dir, "agent-cost");
  const script = `#!/usr/bin/env bash
cat <<'JSON'
{
  ${basisFields}
  "protocol_version": "measure/v1",
  "generated_at": "${generatedAt}",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ${agentListJson},
  "rates": {"catalog_version": "${catalogVersion}", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": ["${sessionId}"],
  "sessions": {"${sessionId}": {"matched": true, "rows": [], "totals": {"tokens": ${totalTokens}, "priced_tokens": ${totalTokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${totalCost}, "credits": 0}}},
  "total": {"rows": [${totalRowsJson}], "totals": {"tokens": ${totalTokens}, "priced_tokens": ${totalTokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${totalCost}, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "conflicting_duplicate_groups": 0, "missing_dedup_identity_rows": 0, "source_quality": {"identity_missing": 0}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function writeFakeAgentCost(dir: string, tokens: number, costUsd: number): string {
  return writeFakeAgentCostMulti(dir, { rows: [{ agent: "claude", tokens, costUsd }] });
}

describe("runCalibrate (fake agent-cost, MP-8 lane-scope ledger entry)", () => {
  let specDir: string;
  let fakeBinDir: string;
  const intentId = "I-2026-08-08-calibrate-ledger-flow";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-calibrate-mp8-spec-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "lane-calibrate-mp8-bin-"));
    process.env.LANE_DATA_DIR = mkdtempSync(join(tmpdir(), "lane-calibrate-mp8-data-"));
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  // spec.md Gherkin: "calibrate creates both records from one real measurement" --
  // this task's own acceptance-criteria numbers (104.8M tokens / $28.34).
  it("records exactly one observation and one scope=lane cost_ledger entry from a single call", async () => {
    const agentCostBin = writeFakeAgentCost(fakeBinDir, 104_800_000, 28.34);
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin,
    });
    expect(result.exitCode, result.message).toBe(0);
    expect(listObservations()).toHaveLength(1);

    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(1);
    const entry = state.cost_ledger[0];
    expect(entry).toMatchObject({
      scope: "lane",
      phase: null,
      source: "claude_jsonl_auto",
      confidence: "imported_lane",
      included_in_kpi: true,
      tokens: 104_800_000,
      cost_usd: 28.34,
      session_ids: ["sess-mp8-1"],
    });

    // Rule 3: no fabricated per-phase entries alongside the lane-scope one.
    expect(state.cost_ledger.filter((e) => e.scope === "phase")).toHaveLength(0);
  });

  it("re-running the identical call is idempotent (upserts both records, never duplicates)", async () => {
    const agentCostBin = writeFakeAgentCost(fakeBinDir, 104_800_000, 28.34);
    await runCalibrate(intentId, { specDir, sessionIds: ["sess-mp8-1"], agentCostBin });
    await runCalibrate(intentId, { specDir, sessionIds: ["sess-mp8-1"], agentCostBin });

    expect(listObservations()).toHaveLength(1);
    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(1);
  });

  // Codex review round (2026-08-08, must-1) — the fix must be exercised through the real
  // CLI command path, not just the pure buildLaneScopeLedgerEntries function.
  it("must-1: attributes a codex-only measurement as codex_sqlite_auto, not the previous hardcoded claude_jsonl_auto", async () => {
    const agentCostBin = writeFakeAgentCostMulti(fakeBinDir, {
      rows: [{ agent: "codex", tokens: 50_000, costUsd: 2 }],
    });
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin,
    });
    expect(result.exitCode, result.message).toBe(0);
    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(1);
    expect(state.cost_ledger[0]).toMatchObject({
      source: "codex_sqlite_auto",
      confidence: "estimated",
      tokens: 50_000,
      cost_usd: 2,
      agents: ["codex"],
    });
  });

  it("must-1: a mixed claude+codex measurement splits into two correctly-attributed lane-scope entries, both summing back to the real totals", async () => {
    const agentCostBin = writeFakeAgentCostMulti(fakeBinDir, {
      rows: [
        { agent: "claude", tokens: 80_000, costUsd: 3 },
        { agent: "codex", tokens: 20_000, costUsd: 1 },
      ],
    });
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin,
    });
    expect(result.exitCode, result.message).toBe(0);
    const state = readLaneState(specDir, intentId);
    const laneEntries = state.cost_ledger.filter((e) => e.scope === "lane");
    expect(laneEntries).toHaveLength(2);
    const claudeEntry = laneEntries.find((e) => e.source === "claude_jsonl_auto");
    const codexEntry = laneEntries.find((e) => e.source === "codex_sqlite_auto");
    expect(claudeEntry).toMatchObject({ tokens: 80_000, cost_usd: 3, agents: ["claude"] });
    expect(codexEntry).toMatchObject({ tokens: 20_000, cost_usd: 1, agents: ["codex"] });
    expect((claudeEntry?.tokens ?? 0) + (codexEntry?.tokens ?? 0)).toBe(100_000);
  });

  it("emit-metrics reports a mixed claude+codex calibration as one whole-delivery activity with a unioned selector, never ambiguous_lane_selector", async () => {
    const agentCostBin = writeFakeAgentCostMulti(fakeBinDir, {
      rows: [
        { agent: "claude", tokens: 80_000, costUsd: 3 },
        { agent: "codex", tokens: 20_000, costUsd: 1 },
      ],
    });
    await runCalibrate(intentId, { specDir, sessionIds: ["sess-mp8-1"], agentCostBin });

    const result = await runEmitMetrics(intentId, {
      specDir,
      agentCostBin,
      repository: "octo-org/spec-lane-demo",
      emitterVersion: "0.4.0",
    });
    expect(result.exitCode, result.message).toBe(0);
    const decoded = decodeMarker(result.message);
    expect(decoded.data.coverage.status).toBe("complete");
    expect(decoded.data.records.every((r) => r.activity.name === "whole-delivery")).toBe(true);
  });

  // Codex review round (2026-08-08, must-2) — a re-calibrate with a new pricing_version
  // must not leave the superseded lane entry's included_in_kpi stale, or the coverage
  // accounting double-counts the same underlying measurement.
  it("must-2: a re-calibrate with a new pricing_version does not leave the superseded lane entry KPI-eligible (no double count)", async () => {
    runAdvance(intentId, "2_spec", { specDir });
    runAdvance(intentId, "3_implement", { specDir });
    writeVerification(specDir, intentId, {
      schema_version: "1.0",
      intent_id: intentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "existing" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
    });
    runConsensus(intentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" });
    runConsensus(intentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } });
    runAdvance(intentId, "4_verify", { specDir });
    runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-08-08T09:00:00Z",
      prUrl: "https://github.com/octo-org/spec-lane-demo/pull/1",
    });

    const agentCostBinV1 = writeFakeAgentCostMulti(fakeBinDir, {
      catalogVersion: "v1",
      generatedAt: "2026-08-08T09:10:00Z",
      rows: [{ agent: "claude", tokens: 100_000, costUsd: 4 }],
    });
    const firstResult = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: agentCostBinV1,
    });
    expect(firstResult.exitCode, firstResult.message).toBe(0);

    const v2BinDir = mkdtempSync(join(tmpdir(), "lane-calibrate-mp8-bin-v2-"));
    const agentCostBinV2 = writeFakeAgentCostMulti(v2BinDir, {
      catalogVersion: "v2",
      generatedAt: "2026-08-08T10:00:00Z", // later than v1's -- v2 supersedes v1
      rows: [{ agent: "claude", tokens: 120_000, costUsd: 5 }],
    });
    const secondResult = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: agentCostBinV2,
    });
    expect(secondResult.exitCode, secondResult.message).toBe(0);

    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.ledger_delta).toHaveLength(2); // both entries persisted (upsert, not overwrite)

    const emitResult = await runEmitMetrics(intentId, {
      specDir,
      agentCostBin: agentCostBinV2,
      repository: "octo-org/spec-lane-demo",
      emitterVersion: "0.4.0",
    });
    expect(emitResult.exitCode, emitResult.message).toBe(0);
    const decoded = decodeMarker(emitResult.message);
    // only the superseding (v2) entry counts -- not both, which would double-count the
    // same underlying calibrate measurement toward the KPI population.
    expect(decoded.data.coverage.eligible_entries).toBe(1);
    expect(decoded.data.coverage.measured_entries).toBe(1);
  });

  // spec.md Rule 4/Gherkin: emit-metrics reports the calibrated measurement as one
  // whole-delivery record, coverage.status=complete, no fabricated per-phase records.
  it("lane emit-metrics reports the calibrated measurement as complete + whole-delivery", async () => {
    const agentCostBin = writeFakeAgentCost(fakeBinDir, 104_800_000, 28.34);
    await runCalibrate(intentId, { specDir, sessionIds: ["sess-mp8-1"], agentCostBin });

    const result = await runEmitMetrics(intentId, {
      specDir,
      agentCostBin,
      repository: "octo-org/spec-lane-demo",
      emitterVersion: "0.4.0",
    });
    expect(result.exitCode, result.message).toBe(0);
    const decoded = decodeMarker(result.message);
    expect(decoded.data.coverage.status).toBe("complete");
    expect(decoded.data.records).toHaveLength(1);
    expect(decoded.data.records[0]?.activity).toEqual({
      namespace: "spec-lane",
      name: "whole-delivery",
    });
    for (const phase of ["1_intent", "2_spec", "3_implement", "4_verify", "5_done"]) {
      expect(decoded.data.records.some((r) => r.activity.name === phase)).toBe(false);
    }
  });

  // spec.md Rule 7/Gherkin: post-done calibrate never touches in-repo lane-state.json;
  // emit-metrics still reports it, read from the overlay-composed effective ledger.
  it("routes a post-done calibrate's ledger entry to the done overlay, never rewriting in-repo lane-state.json", async () => {
    runAdvance(intentId, "2_spec", { specDir });
    runAdvance(intentId, "3_implement", { specDir });
    writeVerification(specDir, intentId, {
      schema_version: "1.0",
      intent_id: intentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "existing" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
    });
    runConsensus(intentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" });
    runConsensus(intentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } });
    runAdvance(intentId, "4_verify", { specDir });
    const doneResult = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-08-08T09:00:00Z",
      prUrl: "https://github.com/octo-org/spec-lane-demo/pull/1",
    });
    expect(doneResult.exitCode, doneResult.message).toBe(0);

    const inRepoBefore = readLaneState(specDir, intentId);
    expect(inRepoBefore.cost_ledger).toHaveLength(0);

    const agentCostBin = writeFakeAgentCost(fakeBinDir, 104_800_000, 28.34);
    const calResult = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin,
    });
    expect(calResult.exitCode, calResult.message).toBe(0);

    // in-repo state.json's cost_ledger must be byte-for-byte unchanged.
    const inRepoAfter = readLaneState(specDir, intentId);
    expect(inRepoAfter.cost_ledger).toEqual(inRepoBefore.cost_ledger);
    expect(inRepoAfter.cost_ledger).toHaveLength(0);

    // but the overlay itself now carries the entry.
    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.ledger_delta).toHaveLength(1);
    expect(overlay?.ledger_delta[0]?.tokens).toBe(104_800_000);

    // and emit-metrics still reports it, reading the overlay-composed effective ledger.
    const emitResult = await runEmitMetrics(intentId, {
      specDir,
      agentCostBin,
      repository: "octo-org/spec-lane-demo",
      emitterVersion: "0.4.0",
    });
    expect(emitResult.exitCode, emitResult.message).toBe(0);
    const decoded = decodeMarker(emitResult.message);
    expect(decoded.data.coverage.status).toBe("complete");
    expect(decoded.data.records).toHaveLength(1);
  });
});

// MP-8 Rule 8b / TEST-02c: a real, already-existing v2 lane-state.json (non-empty
// scope="phase" ledger entry) must keep working transparently through calibrate,
// with no explicit migrate step -- not just at the parseLaneState unit level
// (packages/schemas/test/lane-state.test.ts already covers that), but through the
// actual CLI command path.
describe("runCalibrate against a real-shaped v2 lane-state.json (MP-8 Rule 8b)", () => {
  it("upgrades transparently on read/write, preserving the pre-existing phase-scoped entry", async () => {
    const specDir = mkdtempSync(join(tmpdir(), "lane-calibrate-v2-spec-"));
    const fakeBinDir = mkdtempSync(join(tmpdir(), "lane-calibrate-v2-bin-"));
    process.env.LANE_DATA_DIR = mkdtempSync(join(tmpdir(), "lane-calibrate-v2-data-"));
    const intentId = "I-2026-08-08-v2-real-shaped";
    try {
      runStart(intentId, { specDir });
      // Overwrite with a v2-shaped file carrying a real, non-empty phase-scoped entry
      // (no since/until/agents at all -- the pre-MP-8 shape).
      const state = readLaneState(specDir, intentId);
      writeLaneState(specDir, intentId, state); // establish the file first
      const v2Raw = {
        ...JSON.parse(JSON.stringify(state)),
        schema_version: "2.0",
        cost_ledger: [
          {
            ledger_entry_id: "lc_realv2entry01",
            lane_id: intentId,
            phase: "1_intent",
            source: "claude_jsonl_auto",
            scope: "phase",
            session_ids: ["sess-legacy-1"],
            data_state: "has_usage",
            confidence: "imported_windowed",
            included_in_kpi: true,
            tokens: 5000,
            turns: 2,
            cost_usd: 0.4,
            cost_credits: null,
            pricing_version: "v1",
            pricing_as_of: "2026-08-08T00:00:00Z",
            imported_at: "2026-08-08T00:05:00Z",
          },
        ],
      };
      writeFileSync(join(specDir, intentId, "lane-state.json"), JSON.stringify(v2Raw, null, 2));

      const agentCostBin = writeFakeAgentCost(fakeBinDir, 200_000, 5);
      const result = await runCalibrate(intentId, {
        specDir,
        sessionIds: ["sess-mp8-1"],
        agentCostBin,
      });
      expect(result.exitCode, result.message).toBe(0);

      const upgraded = readLaneState(specDir, intentId);
      expect(upgraded.schema_version).toBe("3.0");
      const legacyEntry = upgraded.cost_ledger.find(
        (e) => e.ledger_entry_id === "lc_realv2entry01",
      );
      expect(legacyEntry).toMatchObject({
        tokens: 5000,
        session_ids: ["sess-legacy-1"],
        since: null,
        until: null,
        agents: null,
      });
      const laneEntry = upgraded.cost_ledger.find((e) => e.scope === "lane");
      expect(laneEntry?.tokens).toBe(200_000);
    } finally {
      // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
      delete process.env.LANE_DATA_DIR;
    }
  });
});

// I-2026-09-10-agent-cost-v2-basis-gate -- `lane calibrate`'s basis gate (D9/D11/RULE-25).
// RULE-25: refusal happens before writeCalibrationRecord, so a refused call writes neither
// the observation nor the ledger entry.
const CURRENT_BASIS = "agent-cost-raw-total/v2";

describe("runCalibrate -- I-2026-09-10-agent-cost-v2-basis-gate basis gate", () => {
  let specDir: string;
  let fakeBinDir: string;
  const intentId = "I-2026-09-14-calibrate-basis-gate";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-calibrate-basis-spec-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "lane-calibrate-basis-bin-"));
    process.env.LANE_DATA_DIR = mkdtempSync(join(tmpdir(), "lane-calibrate-basis-data-"));
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  // TEST-28 (sol consensus review, S1 evidence gap): calibrate persists accounting_basis
  // and producer_version on BOTH the lane-scope ledger entry (RULE-03/04) AND the
  // observation (RULE-12), from the one 0.2.0 measurement -- distinct assertions from
  // TEST-19b/--supersede-basis below, which only ever checked exitCode/observation count,
  // never the persisted field values themselves.
  it("TEST-28: a 0.2.0 measurement persists accounting_basis and producer_version on both the lane-scope entry and the observation", async () => {
    const bin = writeFakeAgentCostMulti(fakeBinDir, {
      rows: [{ agent: "claude", tokens: 100_000, costUsd: 4 }],
      accountingBasis: CURRENT_BASIS,
      producerVersion: "0.2.0",
    });
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: bin,
    });
    expect(result.exitCode, result.message).toBe(0);

    const state = readLaneState(specDir, intentId);
    const entry = state.cost_ledger.find((e) => e.scope === "lane");
    expect(entry?.accounting_basis).toBe(CURRENT_BASIS); // RULE-03
    expect(entry?.producer_version).toBe("0.2.0"); // RULE-04

    const observations = listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.accounting_basis).toBe(CURRENT_BASIS); // RULE-12
  });

  // TEST-16 (calibrate path, D20/RULE-03/04): a 0.1.x-shaped measurement (no basis fields
  // at all) normalizes to "unknown" -- written as an explicit key, not merely absent -- and
  // producer_version null, on both the entry and the observation.
  it("TEST-16 (calibrate path): a 0.1.x measurement (no basis fields) persists accounting_basis 'unknown' (explicit key) and producer_version null on the entry, and 'unknown' on the observation", async () => {
    const bin = writeFakeAgentCostMulti(fakeBinDir, {
      rows: [{ agent: "claude", tokens: 100_000, costUsd: 4 }],
      // no basis fields -> normalizes to "unknown" / null
    });
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: bin,
    });
    expect(result.exitCode, result.message).toBe(0);

    const state = readLaneState(specDir, intentId);
    const entry = state.cost_ledger.find((e) => e.scope === "lane");
    expect(entry).toHaveProperty("accounting_basis"); // written explicitly, not merely absent
    expect(entry?.accounting_basis).toBe("unknown");
    expect(entry?.producer_version).toBeNull();

    const observations = listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.accounting_basis).toBe("unknown");
  });

  // Copilot review (PR #41): calibrate derived the observation's eligibility from
  // `opts.sessionIds` (the requested --session-id values) while the lane-scope ledger
  // entry builder derived it from the measure/v1 payload's own `session_ids` -- schema-
  // legal for those two to differ (a fake, or a real agent-cost, is not required to echo
  // back exactly the ids it was asked about). If they disagree, the requested session
  // being genuinely exactly-attributed while the payload's own session is not (or vice
  // versa) makes the observation and the entry score differently from the same call. Both
  // must be derived from the SAME session_ids (RULE-05: "one function, reused").
  it("Copilot review: the observation's and lane-scope entry's reasons agree even when the payload's own session_ids differ from --session-id requested", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "lane-calibrate-basis-mismatch-repo-"));
    // sess-exact is genuinely exactly-attributed (bound + usage-imported matched:true) --
    // if the observation were (wrongly) evaluated against the *requested* --session-id
    // instead of the payload's own session_ids, it would score eligible (empty reasons)
    // here, disagreeing with the entry.
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "sess-exact", agent: "claude", cwd: repoDir });
    const usageImportBin = writeFakeAgentCostMulti(fakeBinDir, {
      sessionId: "sess-exact",
      rows: [{ agent: "claude", tokens: 500, costUsd: 0.25 }],
    });
    const usageImportResult = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: usageImportBin,
    });
    expect(usageImportResult.exitCode, usageImportResult.message).toBe(0);

    // The fake agent-cost's OWN payload reports a different, never-bound session id --
    // this is what both the observation and the entry must actually be evaluated against.
    const calibrateBinDir = mkdtempSync(join(tmpdir(), "lane-calibrate-basis-mismatch-bin-"));
    const bin = writeFakeAgentCostMulti(calibrateBinDir, {
      sessionId: "sess-payload-only",
      rows: [{ agent: "claude", tokens: 100_000, costUsd: 4 }],
      accountingBasis: CURRENT_BASIS,
      producerVersion: "0.2.0",
    });
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-exact"], // requested -- exactly-attributed if wrongly evaluated on its own
      agentCostBin: bin,
    });
    expect(result.exitCode, result.message).toBe(0);

    const observations = listObservations();
    const observation = observations[observations.length - 1];
    const state = readLaneState(specDir, intentId);
    const entry = state.cost_ledger.find((e) => e.scope === "lane");

    expect(entry?.knn_ineligibility_reasons).toContain("MIXED_OR_UNATTRIBUTED_USAGE");
    expect(observation?.knn_ineligibility_reasons).toEqual(entry?.knn_ineligibility_reasons);
    expect(observation?.eligible_for_knn).toBe(false);
  });

  // Spec.md's Tests section names this scenario TEST-19b ("the same refusal in calibrate
  // happens before writeCalibrationRecord") -- the RULE-25 text this test pins matches
  // TEST-19b's description exactly, not TEST-23 (which is the unrelated lane-state
  // schema-migration test).
  it("TEST-19b (RULE-25): a basis conflict without --supersede-basis refuses before writeCalibrationRecord -- neither the observation nor the ledger entry is written", async () => {
    const binV2 = writeFakeAgentCostMulti(fakeBinDir, {
      rows: [{ agent: "claude", tokens: 100_000, costUsd: 4 }],
      accountingBasis: CURRENT_BASIS,
      producerVersion: "0.2.0",
    });
    const first = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: binV2,
    });
    expect(first.exitCode, first.message).toBe(0);
    expect(listObservations()).toHaveLength(1);
    const stateBefore = readLaneState(specDir, intentId);
    expect(stateBefore.cost_ledger).toHaveLength(1);

    const conflictBinDir = mkdtempSync(join(tmpdir(), "lane-calibrate-basis-bin2-"));
    const binConflict = writeFakeAgentCostMulti(conflictBinDir, {
      rows: [{ agent: "claude", tokens: 120_000, costUsd: 5 }],
      // no basis fields -> normalizes to "unknown", conflicting with the existing v2 entry
    });
    const second = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: binConflict,
    });
    expect(second.exitCode).not.toBe(0);
    // RULE-16 (shared diagnostic shape): both normalized bases and both producer_versions.
    expect(second.message).toContain(CURRENT_BASIS);
    expect(second.message).toContain("unknown");
    expect(second.message).toContain("0.2.0");

    // RULE-25: refused before writeCalibrationRecord -- still exactly the one prior
    // observation, never a second one for the refused call.
    expect(listObservations()).toHaveLength(1);
    // D11: the ledger entry is untouched too.
    const stateAfter = readLaneState(specDir, intentId);
    expect(stateAfter.cost_ledger).toEqual(stateBefore.cost_ledger);
  });

  // TEST-20 (calibrate path): --supersede-basis writes both the observation and the
  // lane-scope ledger entry, recording the replaced entry's normalized values in
  // basis_history under the unchanged ledger_entry_id.
  it("--supersede-basis writes the observation and the entry, recording the replaced basis in basis_history", async () => {
    const binV2 = writeFakeAgentCostMulti(fakeBinDir, {
      rows: [{ agent: "claude", tokens: 100_000, costUsd: 4 }],
      accountingBasis: CURRENT_BASIS,
      producerVersion: "0.2.0",
    });
    const first = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: binV2,
    });
    expect(first.exitCode, first.message).toBe(0);
    const beforeEntry = readLaneState(specDir, intentId).cost_ledger[0];
    const entryId = beforeEntry?.ledger_entry_id;

    const unknownBinDir = mkdtempSync(join(tmpdir(), "lane-calibrate-basis-bin-unknown-"));
    const binUnknown = writeFakeAgentCostMulti(unknownBinDir, {
      rows: [{ agent: "claude", tokens: 110_000, costUsd: 4.5 }],
    });
    const second = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: binUnknown,
      supersedeBasis: true,
    });
    expect(second.exitCode, second.message).toBe(0);
    expect(listObservations()).toHaveLength(1); // same record_id -- upserted, not duplicated

    const afterEntry = readLaneState(specDir, intentId).cost_ledger.find(
      (e) => e.ledger_entry_id === entryId,
    );
    expect(afterEntry?.ledger_entry_id).toBe(entryId); // RULE-17: unchanged id
    expect(afterEntry?.accounting_basis).toBe("unknown");
    expect(afterEntry?.basis_history).toEqual([
      {
        accounting_basis: CURRENT_BASIS,
        producer_version: "0.2.0",
        tokens: 100_000,
        cost_usd: 4,
        cost_credits: beforeEntry?.cost_credits ?? null,
        recorded_at: beforeEntry?.imported_at,
      },
    ]);
  });

  // sol round 2 (2026-09-15): D8's staged-preflight-before-any-persistence ordering must
  // hold identically when the conflicting entry lives only in the done overlay's own
  // ledger_delta (post-done, D9's own path) -- not just in-repo lane-state.json. Same
  // post-done setup convention as the "routes a post-done calibrate's ledger entry to the
  // done overlay" test above.
  it("post-done: a basis conflict against the overlay's own ledger_delta entry refuses, writing no observation, byte-identical overlay/lane-state (RULE-25 overlay path)", async () => {
    runAdvance(intentId, "2_spec", { specDir });
    runAdvance(intentId, "3_implement", { specDir });
    writeVerification(specDir, intentId, {
      schema_version: "1.0",
      intent_id: intentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "existing" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
    });
    runConsensus(intentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" });
    runConsensus(intentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } });
    runAdvance(intentId, "4_verify", { specDir });
    const doneResult = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-15T09:00:00Z",
      prUrl: "https://github.com/octo-org/spec-lane-demo/pull/1",
    });
    expect(doneResult.exitCode, doneResult.message).toBe(0);

    const binV2 = writeFakeAgentCostMulti(fakeBinDir, {
      rows: [{ agent: "claude", tokens: 100_000, costUsd: 4 }],
      accountingBasis: CURRENT_BASIS,
      producerVersion: "0.2.0",
    });
    const baseline = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: binV2,
    });
    expect(baseline.exitCode, baseline.message).toBe(0);

    // D9/known-affected-behavior: the baseline lands in the overlay's own ledger_delta,
    // never in-repo lane-state.json.
    const inRepoAfterBaseline = readLaneState(specDir, intentId);
    expect(inRepoAfterBaseline.cost_ledger).toHaveLength(0);
    const overlayAfterBaseline = readDoneOverlay(specDir, intentId);
    expect(overlayAfterBaseline?.ledger_delta).toHaveLength(1);
    const observationCountAfterBaseline = listObservations().length;

    const beforeOverlayRaw = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
    const beforeStateRaw = readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8");

    const conflictBinDir = mkdtempSync(join(tmpdir(), "lane-calibrate-basis-overlay-bin-"));
    const binConflict = writeFakeAgentCostMulti(conflictBinDir, {
      rows: [{ agent: "claude", tokens: 120_000, costUsd: 5 }],
      // no basis fields -> "unknown", conflicting with the overlay's existing v2 entry
    });
    const conflict = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-mp8-1"],
      agentCostBin: binConflict,
    });
    expect(conflict.exitCode).not.toBe(0);
    // RULE-16 (shared diagnostic shape): both normalized bases and both producer_versions.
    expect(conflict.message).toContain(CURRENT_BASIS);
    expect(conflict.message).toContain("unknown");
    expect(conflict.message).toContain("0.2.0");

    // RULE-25: refused before writeCalibrationRecord -- no new observation.
    expect(listObservations()).toHaveLength(observationCountAfterBaseline);
    // D11/RULE-38 applies to the overlay path too: overlay and lane-state.json untouched.
    expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(beforeOverlayRaw);
    expect(readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8")).toBe(beforeStateRaw);
  });
});

function decodeMarker(marker: string): {
  data: {
    records: { activity: { namespace: string; name: string } }[];
    coverage: { status: string; eligible_entries: number; measured_entries: number };
  };
} {
  const m = marker.match(/<!--\s*agent-metrics:v1\s+([\s\S]*?)\s*-->/);
  const body = m?.[1] ?? "";
  const fields = Object.fromEntries(
    [...body.matchAll(/([a-z_][a-z0-9_]*)=(\S+)/g)].map(([, k, v]) => [k, v]),
  );
  const bytes = Buffer.from(fields.payload_b64 as string, "base64");
  return JSON.parse(bytes.toString("utf-8"));
}
