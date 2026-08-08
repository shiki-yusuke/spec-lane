import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDoneOverlay } from "@lane/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listObservations } from "../src/calibration-store.js";
import { runAdvance } from "../src/commands/advance.js";
import { runCalibrate } from "../src/commands/calibrate.js";
import { runConsensus } from "../src/commands/consensus.js";
import { runEmitMetrics } from "../src/commands/emit-metrics.js";
import { runEstimate } from "../src/commands/estimate.js";
import { runStart } from "../src/commands/start.js";
import { readIntent, writeIntent } from "../src/intent-store.js";
import { readLaneState, writeLaneState } from "../src/state-store.js";
import { writeVerification } from "../src/verification-store.js";

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
function writeFakeAgentCost(dir: string, tokens: number, costUsd: number): string {
  const path = join(dir, "agent-cost");
  const script = `#!/usr/bin/env bash
cat <<'JSON'
{
  "protocol_version": "measure/v1",
  "generated_at": "2026-08-08T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": ["sess-mp8-1"],
  "sessions": {"sess-mp8-1": {"matched": true, "rows": [], "totals": {"tokens": ${tokens}, "priced_tokens": ${tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${costUsd}, "credits": 0}}},
  "total": {"rows": [{"month": null, "agent": "claude", "model": "claude-sonnet-5", "token_kind": "output", "tokens": ${tokens}, "priced_tokens": ${tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${costUsd}, "credits": 0, "pricing_status": "priced"}], "totals": {"tokens": ${tokens}, "priced_tokens": ${tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${costUsd}, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "source_quality": {}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
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

function decodeMarker(marker: string): {
  data: {
    records: { activity: { namespace: string; name: string } }[];
    coverage: { status: string };
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
