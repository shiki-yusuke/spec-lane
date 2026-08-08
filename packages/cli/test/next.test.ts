import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verification } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runConsensus } from "../src/commands/consensus.js";
import { runEstimate } from "../src/commands/estimate.js";
import { runNext } from "../src/commands/next.js";
import { runStart } from "../src/commands/start.js";
import { readIntent, writeIntent } from "../src/intent-store.js";
import { writeVerification } from "../src/verification-store.js";

// codexBudgetPath always points at a nonexistent file in these tests: CodexBudgetAdapter
// returns [] without ever spawning agent-cost when its config file is absent (see
// packages/adapters/test/codex-budget.test.ts for the real-subprocess coverage), which
// keeps these CLI-level tests fast and deterministic.
const NO_CODEX_CONFIG = "/nonexistent/codex.yaml";

function freshRateLimits(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "rate-limits.json");
  writeFileSync(
    path,
    JSON.stringify({
      five_hour: { used_percentage: 10, resets_at: null },
      seven_day: { used_percentage: 20, resets_at: null },
      written_at: new Date().toISOString(),
      ...overrides,
    }),
  );
  return path;
}

describe("runNext", () => {
  let specDir: string;
  let dataDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-next-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-next-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("reports no snapshots and no lanes when nothing exists yet", async () => {
    const result = await runNext({
      specDir,
      claudeRateLimitsPath: "/nonexistent/rate-limits.json",
      codexBudgetPath: NO_CODEX_CONFIG,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("no resource snapshot available yet");
    expect(result.message).toContain("no lanes with an adopted baseline");
  });

  it("shows fits when the adopted baseline's predicted cost_usd.p80 is within a same-unit budget constraint", async () => {
    const intentId = "I-2026-07-31-next-fits";
    runStart(intentId, { specDir });
    let intent = readIntent(specDir, intentId);
    intent = { ...intent, budget: [{ provider: "claude", unit: "usd", limit: 10 }] };
    writeIntent(specDir, intentId, intent);
    runEstimate(intentId, {
      specDir,
      adopt: true,
      referenceTokensP50: 1000,
      referenceTokensP80: 2000,
      referenceCostP50: 1,
      referenceCostP80: 2, // well within the 10 usd budget
    });

    const rateLimitsPath = freshRateLimits(mkdtempSync(join(tmpdir(), "lane-next-rl-")));
    const result = await runNext({
      specDir,
      claudeRateLimitsPath: rateLimitsPath,
      codexBudgetPath: NO_CODEX_CONFIG,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`[${intentId}] fits`);
    expect(result.message).toContain("claude rate_limit_5h=10%");
  });

  it("shows not_fit when the predicted cost exceeds a same-unit budget constraint", async () => {
    const intentId = "I-2026-07-31-next-not-fit";
    runStart(intentId, { specDir });
    let intent = readIntent(specDir, intentId);
    intent = { ...intent, budget: [{ provider: "claude", unit: "usd", limit: 1 }] };
    writeIntent(specDir, intentId, intent);
    runEstimate(intentId, {
      specDir,
      adopt: true,
      referenceTokensP50: 1000,
      referenceTokensP80: 2000,
      referenceCostP50: 5,
      referenceCostP80: 21, // exceeds the 1 usd budget
    });

    const rateLimitsPath = freshRateLimits(mkdtempSync(join(tmpdir(), "lane-next-rl-")));
    const result = await runNext({
      specDir,
      claudeRateLimitsPath: rateLimitsPath,
      codexBudgetPath: NO_CODEX_CONFIG,
    });
    expect(result.message).toContain(`[${intentId}] not_fit`);
  });

  it("shows advisory when the intent's only budget constraint is a different unit (no invented conversion)", async () => {
    const intentId = "I-2026-07-31-next-advisory";
    runStart(intentId, { specDir });
    let intent = readIntent(specDir, intentId);
    intent = { ...intent, budget: [{ provider: "codex", unit: "credits", limit: 500 }] };
    writeIntent(specDir, intentId, intent);
    runEstimate(intentId, {
      specDir,
      adopt: true,
      // MP-8: no silent reference_table default anymore.
      referenceTokensP50: 1000,
      referenceTokensP80: 2000,
      referenceCostP50: 1,
      referenceCostP80: 2,
    });

    const rateLimitsPath = freshRateLimits(mkdtempSync(join(tmpdir(), "lane-next-rl-")));
    const result = await runNext({
      specDir,
      claudeRateLimitsPath: rateLimitsPath,
      codexBudgetPath: NO_CODEX_CONFIG,
    });
    expect(result.message).toContain(`[${intentId}] advisory`);
  });

  it("must-1: excludes a lane with no adopted baseline from the decision table, counting it in a footer line instead", async () => {
    const intentId = "I-2026-07-31-next-no-baseline";
    runStart(intentId, { specDir });

    const rateLimitsPath = freshRateLimits(mkdtempSync(join(tmpdir(), "lane-next-rl-")));
    const result = await runNext({
      specDir,
      claudeRateLimitsPath: rateLimitsPath,
      codexBudgetPath: NO_CODEX_CONFIG,
    });
    expect(result.message).not.toContain(`[${intentId}]`);
    expect(result.message).toContain("no lanes with an adopted baseline");
    expect(result.message).toContain("1 lane(s) without an adopted baseline");
  });

  it("must-1: a lane without a baseline is counted in the footer alongside real decision-table rows for other lanes", async () => {
    const withBaselineId = "I-2026-07-31-next-with-baseline";
    runStart(withBaselineId, { specDir });
    let intent = readIntent(specDir, withBaselineId);
    intent = { ...intent, budget: [{ provider: "claude", unit: "usd", limit: 10 }] };
    writeIntent(specDir, withBaselineId, intent);
    runEstimate(withBaselineId, {
      specDir,
      adopt: true,
      // MP-8: all four --reference-* flags required together now, not just cost.
      referenceTokensP50: 1000,
      referenceTokensP80: 2000,
      referenceCostP50: 1,
      referenceCostP80: 2,
    });

    const noBaselineId = "I-2026-07-31-next-still-no-baseline";
    runStart(noBaselineId, { specDir });

    const rateLimitsPath = freshRateLimits(mkdtempSync(join(tmpdir(), "lane-next-rl-")));
    const result = await runNext({
      specDir,
      claudeRateLimitsPath: rateLimitsPath,
      codexBudgetPath: NO_CODEX_CONFIG,
    });
    expect(result.message).toContain(`[${withBaselineId}] fits`);
    expect(result.message).not.toContain(`[${noBaselineId}]`);
    expect(result.message).toContain("1 lane(s) without an adopted baseline");
  });

  it("M4 (team review): excludes a completed (5_done) lane from both the table and the no-baseline footer, even though it has an adopted baseline", async () => {
    const doneId = "I-2026-07-31-next-done";
    runStart(doneId, { specDir });
    let intent = readIntent(specDir, doneId);
    intent = { ...intent, budget: [{ provider: "claude", unit: "usd", limit: 10 }] };
    writeIntent(specDir, doneId, intent);
    runEstimate(doneId, {
      specDir,
      adopt: true,
      // MP-8: all four --reference-* flags required together now, not just cost.
      referenceTokensP50: 1000,
      referenceTokensP80: 2000,
      referenceCostP50: 1,
      referenceCostP80: 2,
    });

    // walk the lane all the way to 5_done via local overlay
    runAdvance(doneId, "2_spec", { specDir });
    runAdvance(doneId, "3_implement", { specDir });
    const verification: Verification = {
      schema_version: "1.0",
      intent_id: doneId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "existing" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
    };
    writeVerification(specDir, doneId, verification);
    runConsensus(doneId, { specDir, refresh: true, specSsotRef: "docs/spec-impact/specs/x.md" });
    runConsensus(doneId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } });
    runAdvance(doneId, "4_verify", { specDir });
    const doneResult = runAdvance(doneId, "5_done", {
      specDir,
      mergedAt: "2026-07-31T09:00:00Z",
      prUrl: "https://github.com/example/example/pull/1",
    });
    expect(doneResult.exitCode).toBe(0);

    const rateLimitsPath = freshRateLimits(mkdtempSync(join(tmpdir(), "lane-next-rl-")));
    const result = await runNext({
      specDir,
      claudeRateLimitsPath: rateLimitsPath,
      codexBudgetPath: NO_CODEX_CONFIG,
    });
    expect(result.message).not.toContain(`[${doneId}]`);
    expect(result.message).not.toContain("lane(s) without an adopted baseline");
    expect(result.message).toContain("no lanes with an adopted baseline");
  });

  it("suppresses every verdict (advisory only) when the Claude snapshot is stale, even for a lane that would otherwise fit", async () => {
    const intentId = "I-2026-07-31-next-suppressed";
    runStart(intentId, { specDir });
    let intent = readIntent(specDir, intentId);
    intent = { ...intent, budget: [{ provider: "claude", unit: "usd", limit: 10 }] };
    writeIntent(specDir, intentId, intent);
    runEstimate(intentId, {
      specDir,
      adopt: true,
      referenceTokensP50: 1000,
      referenceTokensP80: 2000,
      referenceCostP50: 1,
      referenceCostP80: 2,
    });

    const staleRateLimitsPath = freshRateLimits(mkdtempSync(join(tmpdir(), "lane-next-rl-")), {
      written_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago, well past TTL
    });
    const result = await runNext({
      specDir,
      claudeRateLimitsPath: staleRateLimitsPath,
      codexBudgetPath: NO_CODEX_CONFIG,
    });
    expect(result.message).toContain(`[${intentId}] advisory`);
    expect(result.message).toContain("stale");
    expect(result.message).not.toContain("fits");
  });
});
