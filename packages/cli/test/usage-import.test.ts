import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTraceEvents } from "@lane/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStart } from "../src/commands/start.js";
import { runUsageImport } from "../src/commands/usage-import.js";
import { runWorkBind, runWorkStart } from "../src/commands/work.js";
import { readLaneState } from "../src/state-store.js";

// M0 spec-lane 0.5.0 — `lane usage-import`, direct (no subprocess) CLI-command tests
// against a fake agent-cost binary (execFile-compatible), matching calibrate.test.ts's
// own fixture-generation convention for this exact subprocess boundary.

function writeFakeAgentCost(
  dir: string,
  sessions: Record<string, { matched: boolean; tokens: number; costUsd: number }>,
): string {
  const path = join(dir, "agent-cost");
  const sessionIds = Object.keys(sessions);
  const totalTokens = Object.values(sessions).reduce((s, v) => s + v.tokens, 0);
  const totalCost = Object.values(sessions).reduce((s, v) => s + v.costUsd, 0);
  const sessionsJson = sessionIds
    .map(
      (id) =>
        `"${id}": {"matched": ${sessions[id]?.matched}, "rows": [], "totals": {"tokens": ${sessions[id]?.tokens}, "priced_tokens": ${sessions[id]?.tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${sessions[id]?.costUsd}, "credits": 0}}`,
    )
    .join(",");
  const script = `#!/usr/bin/env bash
cat <<'JSON'
{
  "protocol_version": "measure/v1",
  "generated_at": "2026-08-09T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": [${sessionIds.map((s) => `"${s}"`).join(",")}],
  "sessions": {${sessionsJson}},
  "total": {"rows": [{"month": null, "agent": "claude", "model": "claude-sonnet-5", "token_kind": "output", "tokens": ${totalTokens}, "priced_tokens": ${totalTokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${totalCost}, "credits": 0, "pricing_status": "priced"}], "totals": {"tokens": ${totalTokens}, "priced_tokens": ${totalTokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${totalCost}, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "source_quality": {}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function writeFailingAgentCost(dir: string): string {
  const path = join(dir, "agent-cost");
  writeFileSync(path, "#!/usr/bin/env bash\necho 'boom' >&2\nexit 1\n");
  chmodSync(path, 0o755);
  return path;
}

describe("runUsageImport", () => {
  let specDir: string;
  let dataDir: string;
  let repoDir: string;
  let binDir: string;
  const intentId = "I-2026-08-09-usage-import";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-usage-import-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-usage-import-data-"));
    repoDir = mkdtempSync(join(tmpdir(), "lane-usage-import-repo-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-usage-import-bin-"));
    process.env.LANE_DATA_DIR = dataDir;
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("fails closed when there is no active task_run for this intent", async () => {
    const result = await runUsageImport(intentId, { specDir, cwd: repoDir });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/lane work start/);
  });

  it("imports one bound session, upserts a scope:phase ledger entry, records usage_imported+attributed_to", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });
    const bin = writeFakeAgentCost(binDir, { s1: { matched: true, tokens: 1000, costUsd: 0.5 } });

    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    expect(result.exitCode, result.message).toBe(0);

    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(1);
    expect(state.cost_ledger[0]).toMatchObject({
      scope: "phase",
      phase: "3_implement",
      tokens: 1000,
      included_in_kpi: true,
    });

    const events = readTraceEvents();
    expect(events.some((e) => e.relation === "usage_imported" && e.session_id === "s1")).toBe(true);
    expect(events.some((e) => e.relation === "attributed_to" && e.task_run_id)).toBe(true);
  });

  it("re-running usage-import upserts the same ledger entry rather than duplicating it", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });
    const bin = writeFakeAgentCost(binDir, { s1: { matched: true, tokens: 1000, costUsd: 0.5 } });

    await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });

    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(1);
  });

  it("agent-cost failure never zero-fills the ledger; sessions are recorded as measurement-incomplete", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });
    const bin = writeFailingAgentCost(binDir);

    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/FAILED/);

    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(0);

    const events = readTraceEvents();
    const usageImported = events.find(
      (e) => e.relation === "usage_imported" && e.session_id === "s1",
    );
    expect(usageImported?.payload?.matched).toBe(false);
  });

  it("a session agent-cost can't match (matched:false) is not silently treated as zero usage", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s-unmatched", agent: "claude", cwd: repoDir });
    const bin = writeFakeAgentCost(binDir, {
      "s-unmatched": { matched: false, tokens: 0, costUsd: 0 },
    });

    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    expect(result.exitCode, result.message).toBe(0);

    const events = readTraceEvents();
    const usageImported = events.find((e) => e.relation === "usage_imported");
    expect(usageImported?.payload?.matched).toBe(false);
  });
});
