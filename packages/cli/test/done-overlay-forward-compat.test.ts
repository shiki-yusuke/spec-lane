import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { doneOverlayPath, readDoneOverlay, readTraceEvents } from "@lane/core";
import type { Verification } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCalibrationRecords } from "../src/calibration-store.js";
import { runAdvance } from "../src/commands/advance.js";
import { runCalibrate } from "../src/commands/calibrate.js";
import { runConsensus } from "../src/commands/consensus.js";
import { runStart } from "../src/commands/start.js";
import { runUsageImport } from "../src/commands/usage-import.js";
import { runValidate } from "../src/commands/validate.js";
import { runWorkBind, runWorkStart } from "../src/commands/work.js";
import { readIntent, writeIntent } from "../src/intent-store.js";
import { writeSpecMd } from "../src/spec-store.js";
import { laneStatePath } from "../src/state-store.js";
import { writeVerification } from "../src/verification-store.js";

// issue #50 — CLI-level acceptance tests for the done-overlay forward-compat guard
// (issue50-spec.md, A1/A2/A4). Fixture setup (advanceToVerify, fake agent-cost) mirrors
// packages/cli/test/done-overlay-no-in-repo-write.test.ts and calibrate.test.ts/
// usage-import.test.ts's own conventions -- copied, not imported, since those files don't
// export their helpers.

const specMdContent = "# Spec\n\nRule 1: does the thing.\n";

function buildVerification(): Verification {
  return {
    schema_version: "1.0",
    intent_id: "placeholder",
    test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
    test_gaps: [],
    manual_verification: [],
    goal_stopping_condition: [],
    success_criteria_matrix: [
      {
        criterion: "Describe at least one success criterion.",
        covered_by: "test",
        evidence: "Rule 1 unit test covers this.",
      },
    ],
  };
}

/** Drives a fresh lane from 1_intent to a clean 4_verify (every gate genuinely satisfied). */
function advanceToVerify(specDir: string, intentId: string): void {
  expect(runStart(intentId, { specDir }).exitCode).toBe(0);

  const started = readIntent(specDir, intentId);
  writeIntent(specDir, intentId, {
    ...started,
    intent: { ...started.intent, success: [started.intent.success[0] ?? "ok"] },
    premise_evidence: {
      required: true,
      method: "live",
      reproduced: true,
      evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
    },
  });
  expect(runAdvance(intentId, "2_spec", { specDir }).exitCode).toBe(0);
  expect(runAdvance(intentId, "3_implement", { specDir }).exitCode).toBe(0);

  writeVerification(specDir, intentId, { ...buildVerification(), intent_id: intentId });
  expect(runAdvance(intentId, "4_verify", { specDir }).exitCode).toBe(0);

  writeSpecMd(specDir, intentId, specMdContent);
  expect(
    runConsensus(intentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" }).exitCode,
  ).toBe(0);
  expect(
    runConsensus(intentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } }).exitCode,
  ).toBe(0);
}

/** A minimal, single-session measure/v1 payload -- matching calibrate.test.ts's own
 * "fake agent-cost" convention for this exact subprocess boundary. */
function writeFakeAgentCost(
  dir: string,
  sessionId: string,
  tokens: number,
  costUsd: number,
): string {
  const path = join(dir, "agent-cost");
  const script = `#!/usr/bin/env bash
cat <<'JSON'
{
  "protocol_version": "measure/v1",
  "generated_at": "2026-09-25T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": ["${sessionId}"],
  "sessions": {"${sessionId}": {"matched": true, "rows": [], "totals": {"tokens": ${tokens}, "priced_tokens": ${tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${costUsd}, "credits": 0}}},
  "total": {"rows": [{"month": null, "agent": "claude", "model": "claude-sonnet-5", "token_kind": "output", "tokens": ${tokens}, "priced_tokens": ${tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${costUsd}, "credits": 0, "pricing_status": "priced"}], "totals": {"tokens": ${tokens}, "priced_tokens": ${tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${costUsd}, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "conflicting_duplicate_groups": 0, "missing_dedup_identity_rows": 0, "source_quality": {"identity_missing": 0}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/** Overwrites the on-disk overlay with schema_version "9.9" -- one of A4's three
 * explicitly-named unreadable shapes (the other two, invalid JSON and intent_id mismatch,
 * are covered directly against inspectDoneOverlay in packages/core/test/done-overlay.test.ts). */
function corruptOverlaySchemaVersion(specDir: string, intentId: string): void {
  const path = doneOverlayPath(specDir, intentId);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  writeFileSync(path, JSON.stringify({ ...raw, schema_version: "9.9" }, null, 2));
}

describe("issue #50 A1: unknown overlay keys survive a CLI rewrite", () => {
  let specDir: string;
  let dataDir: string;
  let binDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-fc-a1-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-fc-a1-data-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-fc-a1-bin-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` stringifies to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  function injectUnknownKeys(specDirLocal: string, intentId: string): void {
    const path = doneOverlayPath(specDirLocal, intentId);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.future_top_level_field = "unicorn";
    raw.state_delta = { ...raw.state_delta, future_state_delta_field: "sparkle" };
    writeFileSync(path, JSON.stringify(raw, null, 2));
  }

  it("calibrate: unknown top-level and state_delta keys are preserved after a post-done calibrate rewrite", async () => {
    const intentId = "I-2026-09-25-a1-calibrate";
    advanceToVerify(specDir, intentId);
    expect(
      runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: "2026-09-25T10:00:00+09:00",
        toolVersion: "0.11.0",
      }).exitCode,
    ).toBe(0);
    injectUnknownKeys(specDir, intentId);

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a1", 1000, 0.5);
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-a1"],
      agentCostBin,
      toolVersion: "0.11.0",
    });
    expect(result.exitCode, result.message).toBe(0);

    const overlay = readDoneOverlay(specDir, intentId);
    expect((overlay as unknown as Record<string, unknown>).future_top_level_field).toBe("unicorn");
    expect(
      (overlay?.state_delta as unknown as Record<string, unknown>).future_state_delta_field,
    ).toBe("sparkle");
  });

  it("usage-import: unknown top-level and state_delta keys are preserved after a post-done usage-import rewrite", async () => {
    const intentId = "I-2026-09-25-a1-usage-import";
    const repoDir = mkdtempSync(join(tmpdir(), "lane-fc-a1-repo-"));
    advanceToVerify(specDir, intentId);
    expect(
      runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: "2026-09-25T10:00:00+09:00",
        toolVersion: "0.11.0",
      }).exitCode,
    ).toBe(0);
    injectUnknownKeys(specDir, intentId);

    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "sess-a1-ui", agent: "claude", cwd: repoDir });
    const agentCostBin = writeFakeAgentCost(binDir, "sess-a1-ui", 1000, 0.5);

    const result = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin,
      toolVersion: "0.11.0",
    });
    expect(result.exitCode, result.message).toBe(0);

    const overlay = readDoneOverlay(specDir, intentId);
    expect((overlay as unknown as Record<string, unknown>).future_top_level_field).toBe("unicorn");
    expect(
      (overlay?.state_delta as unknown as Record<string, unknown>).future_state_delta_field,
    ).toBe("sparkle");
  });
});

describe("issue #50 A2: version guard (calibrate)", () => {
  let specDir: string;
  let dataDir: string;
  let binDir: string;
  const intentId = "I-2026-09-25-a2-calibrate";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-fc-a2-cal-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-fc-a2-cal-data-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-fc-a2-cal-bin-"));
    process.env.LANE_DATA_DIR = dataDir;
    advanceToVerify(specDir, intentId);
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` stringifies to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  // A2 (issue50-spec.md line 26): overlay tool_version newer than the running binary ->
  // exit 2, and overlay/lane-state/calibration records are byte-for-byte unchanged.
  it("newer overlay tool_version: exit 2, nothing written (overlay/lane-state/calibration byte-identical)", async () => {
    expect(
      runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: "2026-09-25T10:00:00+09:00",
        toolVersion: "5.0.0",
      }).exitCode,
    ).toBe(0);

    const overlayBefore = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    const recordsBefore = listCalibrationRecords();

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a2-newer", 1000, 0.5);
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-a2-newer"],
      agentCostBin,
      toolVersion: "1.0.0",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("nothing was recorded");

    expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(overlayBefore);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(listCalibrationRecords()).toEqual(recordsBefore);
  });

  // A2 (sol impl review): the guard compares the newest of tool_version and
  // last_writer_tool_version, and an unparseable overlay version fails closed -- both
  // through the CLI, not only against assertDoneOverlayWritable directly.
  it.each([
    [
      "a newer last_writer_tool_version (tool_version older)",
      { last_writer_tool_version: "5.0.0" },
    ],
    ["a tool_version that is not valid SemVer", { tool_version: "dev" }],
  ])("overlay with %s: exit 2, nothing written", async (_label, patch) => {
    expect(
      runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: "2026-09-25T10:00:00+09:00",
        toolVersion: "0.9.0",
      }).exitCode,
    ).toBe(0);
    const path = doneOverlayPath(specDir, intentId);
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, "utf-8")), ...patch }, null, 2),
    );

    const overlayBefore = readFileSync(path, "utf-8");
    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    const recordsBefore = listCalibrationRecords();

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a2-lw", 1000, 0.5);
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-a2-lw"],
      agentCostBin,
      toolVersion: "1.0.0",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("nothing was recorded");
    expect(readFileSync(path, "utf-8")).toBe(overlayBefore);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(listCalibrationRecords()).toEqual(recordsBefore);
  });

  // A2: equal running version succeeds; last_writer_tool_version updates to the running
  // version, tool_version (the creating binary's own version) is unchanged.
  it("equal overlay tool_version: succeeds, last_writer_tool_version updates, tool_version unchanged", async () => {
    expect(
      runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: "2026-09-25T10:00:00+09:00",
        toolVersion: "0.11.0",
      }).exitCode,
    ).toBe(0);

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a2-equal", 1000, 0.5);
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-a2-equal"],
      agentCostBin,
      toolVersion: "0.11.0",
    });
    expect(result.exitCode, result.message).toBe(0);

    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.tool_version).toBe("0.11.0");
    expect(overlay?.last_writer_tool_version).toBe("0.11.0");
  });

  // A2: an older overlay tool_version (running is newer) also succeeds; tool_version stays
  // whichever binary created the overlay, only last_writer_tool_version moves.
  it("older overlay tool_version: succeeds, last_writer_tool_version updates to the newer running version, tool_version unchanged", async () => {
    expect(
      runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: "2026-09-25T10:00:00+09:00",
        toolVersion: "0.9.0",
      }).exitCode,
    ).toBe(0);

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a2-older", 1000, 0.5);
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-a2-older"],
      agentCostBin,
      toolVersion: "0.11.0",
    });
    expect(result.exitCode, result.message).toBe(0);

    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.tool_version).toBe("0.9.0");
    expect(overlay?.last_writer_tool_version).toBe("0.11.0");
  });
});

describe("issue #50 A2: version guard (usage-import)", () => {
  let specDir: string;
  let dataDir: string;
  let binDir: string;
  let repoDir: string;
  const intentId = "I-2026-09-25-a2-usage-import";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-fc-a2-ui-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-fc-a2-ui-data-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-fc-a2-ui-bin-"));
    repoDir = mkdtempSync(join(tmpdir(), "lane-fc-a2-ui-repo-"));
    process.env.LANE_DATA_DIR = dataDir;
    advanceToVerify(specDir, intentId);
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` stringifies to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  it("newer overlay tool_version: exit 2, nothing written (overlay/lane-state/trace byte-identical)", async () => {
    expect(
      runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: "2026-09-25T10:00:00+09:00",
        toolVersion: "5.0.0",
      }).exitCode,
    ).toBe(0);

    runWorkBind(intentId, {
      specDir,
      sessionId: "sess-a2-ui-newer",
      agent: "claude",
      cwd: repoDir,
    });

    const overlayBefore = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    const traceBefore = readTraceEvents();

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a2-ui-newer", 1000, 0.5);
    const result = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin,
      toolVersion: "1.0.0",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("nothing was recorded");

    expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(overlayBefore);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(readTraceEvents()).toEqual(traceBefore);
  });

  it("equal overlay tool_version: succeeds, last_writer_tool_version updates, tool_version unchanged", async () => {
    expect(
      runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: "2026-09-25T10:00:00+09:00",
        toolVersion: "0.11.0",
      }).exitCode,
    ).toBe(0);
    runWorkBind(intentId, {
      specDir,
      sessionId: "sess-a2-ui-equal",
      agent: "claude",
      cwd: repoDir,
    });

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a2-ui-equal", 1000, 0.5);
    const result = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin,
      toolVersion: "0.11.0",
    });
    expect(result.exitCode, result.message).toBe(0);

    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.tool_version).toBe("0.11.0");
    expect(overlay?.last_writer_tool_version).toBe("0.11.0");
  });

  it("older overlay tool_version: succeeds, last_writer_tool_version updates to the newer running version, tool_version unchanged", async () => {
    expect(
      runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: "2026-09-25T10:00:00+09:00",
        toolVersion: "0.9.0",
      }).exitCode,
    ).toBe(0);
    runWorkBind(intentId, {
      specDir,
      sessionId: "sess-a2-ui-older",
      agent: "claude",
      cwd: repoDir,
    });

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a2-ui-older", 1000, 0.5);
    const result = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin,
      toolVersion: "0.11.0",
    });
    expect(result.exitCode, result.message).toBe(0);

    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.tool_version).toBe("0.9.0");
    expect(overlay?.last_writer_tool_version).toBe("0.11.0");
  });
});

describe("issue #50 A4: unreadable overlay at 4_verify fails closed (all four mutating commands)", () => {
  let specDir: string;
  let dataDir: string;
  let binDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-fc-a4-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-fc-a4-data-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-fc-a4-bin-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` stringifies to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  it("calibrate: exit 2, lane-state and overlay byte-identical, readDoneOverlay stays null", async () => {
    const intentId = "I-2026-09-25-a4-calibrate";
    advanceToVerify(specDir, intentId);
    expect(
      runAdvance(intentId, "5_done", { specDir, mergedAt: "2026-09-25T10:00:00+09:00" }).exitCode,
    ).toBe(0);
    corruptOverlaySchemaVersion(specDir, intentId);

    const overlayBefore = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a4-cal", 1000, 0.5);
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-a4-cal"],
      agentCostBin,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("nothing was recorded");

    expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(overlayBefore);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(readDoneOverlay(specDir, intentId)).toBeNull();
  });

  it("usage-import: exit 2, lane-state and overlay byte-identical, readDoneOverlay stays null", async () => {
    const intentId = "I-2026-09-25-a4-usage-import";
    const repoDir = mkdtempSync(join(tmpdir(), "lane-fc-a4-repo-"));
    advanceToVerify(specDir, intentId);
    expect(
      runAdvance(intentId, "5_done", { specDir, mergedAt: "2026-09-25T10:00:00+09:00" }).exitCode,
    ).toBe(0);
    corruptOverlaySchemaVersion(specDir, intentId);

    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "sess-a4-ui", agent: "claude", cwd: repoDir });

    const overlayBefore = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");

    const agentCostBin = writeFakeAgentCost(binDir, "sess-a4-ui", 1000, 0.5);
    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("nothing was recorded");

    expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(overlayBefore);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(readDoneOverlay(specDir, intentId)).toBeNull();
  });

  it("advance: exit 2, lane-state and overlay byte-identical, readDoneOverlay stays null", () => {
    const intentId = "I-2026-09-25-a4-advance";
    advanceToVerify(specDir, intentId);
    expect(
      runAdvance(intentId, "5_done", { specDir, mergedAt: "2026-09-25T10:00:00+09:00" }).exitCode,
    ).toBe(0);
    corruptOverlaySchemaVersion(specDir, intentId);

    const overlayBefore = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");

    const result = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-25T11:00:00+09:00",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("nothing was recorded");

    expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(overlayBefore);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(readDoneOverlay(specDir, intentId)).toBeNull();
  });

  it("validate: exit 2, lane-state and overlay byte-identical, readDoneOverlay stays null", () => {
    const intentId = "I-2026-09-25-a4-validate";
    advanceToVerify(specDir, intentId);
    expect(
      runAdvance(intentId, "5_done", { specDir, mergedAt: "2026-09-25T10:00:00+09:00" }).exitCode,
    ).toBe(0);
    corruptOverlaySchemaVersion(specDir, intentId);

    const overlayBefore = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");

    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("nothing was recorded");

    expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(overlayBefore);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(readDoneOverlay(specDir, intentId)).toBeNull();
  });
});

// A4's other side (sol impl review): the unreadable check only applies to a lane in
// 4_verify -- the only phase a done overlay is ever consulted for -- so a stray unreadable
// file next to an earlier-phase lane must not block that lane's own transitions.
describe("issue #50 A4: an unreadable overlay file does not block a lane before 4_verify", () => {
  let specDir: string;
  let dataDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-fc-a4n-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-fc-a4n-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` stringifies to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  it("advance 1_intent -> 2_spec succeeds with an invalid-JSON overlay file present", () => {
    const intentId = "I-2026-09-25-a4-not-verify";
    expect(runStart(intentId, { specDir }).exitCode).toBe(0);
    const started = readIntent(specDir, intentId);
    writeIntent(specDir, intentId, {
      ...started,
      intent: { ...started.intent, success: [started.intent.success[0] ?? "ok"] },
      premise_evidence: {
        required: true,
        method: "live",
        reproduced: true,
        evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
      },
    });
    const path = doneOverlayPath(specDir, intentId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");

    expect(runAdvance(intentId, "2_spec", { specDir }).exitCode).toBe(0);
    // validate may still refuse a 2_spec lane on its own gates; it must not be this guard.
    expect(runValidate(intentId, { specDir }).message).not.toContain("unreadable");
  });
});
