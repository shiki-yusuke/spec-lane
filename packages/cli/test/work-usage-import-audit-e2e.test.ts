import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAttributionAudit } from "../src/commands/attribution.js";
import { runStart } from "../src/commands/start.js";
import { runUsageImport } from "../src/commands/usage-import.js";
import { runWorkBind, runWorkStart } from "../src/commands/work.js";
import { readLaneState } from "../src/state-store.js";

// M0 spec-lane 0.5.0 — full-pipeline e2e (M0 spec §7): temp repo + temp
// LANE_DATA_DIR/LANE_CONFIG_DIR, `lane work start` -> (a simulated agent session) ->
// `lane work bind` -> `lane usage-import` -> `lane attribution audit --require-coverage
// 1.0` (the R-pilot research gate). agent-cost is replaced with a small fake, execFile-
// compatible binary (same convention as usage-import.test.ts/calibrate.test.ts), never
// the real agent-cost subprocess -- this test asserts the pipeline's own wiring, not
// agent-cost's real output.
//
// Deliberately at the direct-command-function level (like commands.test.ts,
// usage-import.test.ts, attribution.test.ts), not a packed-tarball subprocess spawn
// (e2e.test.ts's own, much heavier tier for proving the *published package* installs and
// runs standalone) -- this test's job is proving the five commands' *data actually flows
// end to end* through real files on disk, which does not require re-proving the package
// boundary a second time.

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
  "generated_at": "2026-08-09T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": ["${sessionId}"],
  "sessions": {"${sessionId}": {"matched": true, "rows": [], "totals": {"tokens": ${tokens}, "priced_tokens": ${tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${costUsd}, "credits": 0}}},
  "total": {"rows": [{"month": null, "agent": "claude", "model": "claude-sonnet-5", "token_kind": "output", "tokens": ${tokens}, "priced_tokens": ${tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${costUsd}, "credits": 0, "pricing_status": "priced"}], "totals": {"tokens": ${tokens}, "priced_tokens": ${tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${costUsd}, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "source_quality": {}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

describe("full pipeline e2e: work start -> work bind -> usage-import -> attribution audit", () => {
  let specDir: string;
  let dataDir: string;
  let configDir: string;
  let repoDir: string;
  let binDir: string;
  const intentId = "I-2026-08-09-full-pipeline-e2e";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-e2e-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-e2e-data-"));
    configDir = mkdtempSync(join(tmpdir(), "lane-e2e-config-"));
    repoDir = mkdtempSync(join(tmpdir(), "lane-e2e-repo-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-e2e-bin-"));
    process.env.LANE_DATA_DIR = dataDir;
    process.env.LANE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_CONFIG_DIR;
  });

  it("runs the whole G1 pilot pipeline and clears the --require-coverage 1.0 research gate", async () => {
    // 1. lane start
    const startResult = runStart(intentId, { specDir });
    expect(startResult.exitCode, startResult.message).toBe(0);

    // 2. lane work start
    const workStartResult = runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    expect(workStartResult.exitCode, workStartResult.message).toBe(0);
    const taskRunId = workStartResult.message.match(/twr-[0-9a-f-]+/)?.[0];
    expect(taskRunId).toBeDefined();

    // 3. (a simulated agent session happened elsewhere) -> lane work bind
    const sessionId = "sess-e2e-pipeline-1";
    const bindResult = runWorkBind(intentId, {
      specDir,
      sessionId,
      agent: "claude",
      cwd: repoDir,
    });
    expect(bindResult.exitCode, bindResult.message).toBe(0);
    expect(bindResult.message).not.toContain("MULTI_TASK_BINDING");

    // 4. lane usage-import (fake agent-cost)
    const agentCostBin = writeFakeAgentCost(binDir, sessionId, 12_345, 3.21);
    const usageImportResult = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin,
    });
    expect(usageImportResult.exitCode, usageImportResult.message).toBe(0);
    expect(usageImportResult.message).toContain("tokens=12345");

    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(1);
    expect(state.cost_ledger[0]).toMatchObject({
      scope: "phase",
      phase: "3_implement",
      tokens: 12_345,
      included_in_kpi: true,
    });

    // 5. lane attribution audit --require-coverage 1.0 (the R-pilot research gate)
    const auditResult = runAttributionAudit({ specDir, requireCoverage: 1.0 });
    expect(auditResult.exitCode, auditResult.message).toBe(0);
    const audit = JSON.parse(auditResult.message);
    expect(audit.research_eligible).toBe(true);
    expect(audit.violations).toEqual([]);
    expect(audit.sessions.exactly_attributed).toEqual([{ session_id: sessionId, tokens: 12_345 }]);
    expect(audit.tokens.exact_attributed).toBe(12_345);
  });

  it("a MULTI_TASK_BINDING session fails the research gate (exit 3) but still prints the full audit JSON", async () => {
    runStart(intentId, { specDir });
    const first = runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const firstTaskRunId = first.message.match(/twr-[0-9a-f-]+/)?.[0] as string;
    const second = runWorkStart(intentId, "4_verify", { specDir, cwd: repoDir });
    const secondTaskRunId = second.message.match(/twr-[0-9a-f-]+/)?.[0] as string;

    const sessionId = "sess-e2e-mixed-1";
    runWorkBind(intentId, {
      specDir,
      sessionId,
      agent: "claude",
      taskRunId: firstTaskRunId,
      cwd: repoDir,
    });
    runWorkBind(intentId, {
      specDir,
      sessionId,
      agent: "claude",
      taskRunId: secondTaskRunId,
      cwd: repoDir,
    });

    // usage-import has no --task-run scoping in v1 -- it imports every active task_run
    // for this intent, so both task_runs' bound sessions (both are `sessionId` here) get
    // measured in the same call.
    const agentCostBin = writeFakeAgentCost(binDir, sessionId, 500, 0.1);
    await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin });

    const auditResult = runAttributionAudit({ specDir, requireCoverage: 1.0 });
    expect(auditResult.exitCode).toBe(3);
    const audit = JSON.parse(auditResult.message);
    expect(audit.research_eligible).toBe(false);
    expect(audit.sessions.mixed).toContain(sessionId);
    expect(
      audit.violations.some(
        (v: { reason_code: string; session_id: string }) =>
          v.reason_code === "MULTI_TASK_BINDING" && v.session_id === sessionId,
      ),
    ).toBe(true);
  });
});
