import { execFileSync } from "node:child_process";
import { emptyAgentCostHome } from "./helpers/agent-cost-home.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexBudgetAdapter, CodexBudgetConfigError } from "../src/budget/codex-budget.js";

// Same real-binary resolution convention as telemetry-agent-cost.test.ts.
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

// Hermetic for every describeOrSkip block in this file, set once at module scope rather than
// inside one of them: agent-cost inherits process.env, and which describe body happens to run
// first is not something a reader should have to reason about. See helpers/agent-cost-home.ts
// for the measured reason (26s over the developer's real logs vs 0s over an empty root).
const agentCostHome = emptyAgentCostHome();
process.env.CLAUDE_HOME = agentCostHome.CLAUDE_HOME;
process.env.CODEX_HOME = agentCostHome.CODEX_HOME;

function writeConfig(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "codex.yaml");
  const config = {
    weekly_limit_credits: 15000,
    period_start: "2020-01-01",
    period_end: "2020-01-08", // exactly 7 days, satisfying reset_rule=weekly's period check
    reset_rule: "weekly",
    timezone: "Asia/Tokyo",
    ...overrides,
  };
  writeFileSync(
    path,
    Object.entries(config)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : v}`)
      .join("\n"),
  );
  return path;
}

describe("CodexBudgetAdapter (config validation, no subprocess call)", () => {
  it("returns [] when codex.yaml doesn't exist (never fabricates a limit)", async () => {
    const adapter = new CodexBudgetAdapter({ configPath: "/nonexistent/codex.yaml" });
    expect(await adapter.snapshot()).toEqual([]);
  });

  it("throws CodexBudgetConfigError for an unsupported timezone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-codex-budget-"));
    const path = writeConfig(dir, { timezone: "America/Los_Angeles" });
    const adapter = new CodexBudgetAdapter({ configPath: path, agentCostBin: bin ?? "agent-cost" });
    await expect(adapter.snapshot()).rejects.toThrow(CodexBudgetConfigError);
  });

  it("throws CodexBudgetConfigError when weekly_limit_credits is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-codex-budget-"));
    const path = join(dir, "codex.yaml");
    writeFileSync(
      path,
      [
        'period_start: "2020-01-01"',
        'period_end: "2020-01-02"',
        'reset_rule: "weekly"',
        'timezone: "Asia/Tokyo"',
      ].join("\n"),
    );
    const adapter = new CodexBudgetAdapter({ configPath: path, agentCostBin: bin ?? "agent-cost" });
    await expect(adapter.snapshot()).rejects.toThrow(CodexBudgetConfigError);
  });

  it("throws CodexBudgetConfigError when weekly_limit_credits is not a positive number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-codex-budget-"));
    const path = writeConfig(dir, { weekly_limit_credits: -5 });
    const adapter = new CodexBudgetAdapter({ configPath: path, agentCostBin: bin ?? "agent-cost" });
    await expect(adapter.snapshot()).rejects.toThrow(CodexBudgetConfigError);
  });
});

describeOrSkip("CodexBudgetAdapter (real agent-cost subprocess)", () => {
  it("subtracts a narrow historical period's measured consumption (likely 0) from the configured limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-codex-budget-"));
    const path = writeConfig(dir); // 2020-01-01..2020-01-08, long before this dev machine's logs
    const adapter = new CodexBudgetAdapter({
      configPath: path,
      agentCostBin: bin ?? undefined,
      timeoutMs: 90_000,
    });
    const snapshots = await adapter.snapshot();
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0];
    expect(snapshot?.provider).toBe("codex");
    expect(snapshot?.metric).toBe("credit_balance");
    expect(snapshot?.unit).toBe("credits");
    // no real usage should exist in this 2020 window, so remaining == the full limit
    expect(snapshot?.value).toBe(15000);
    expect(snapshot?.quality).toBe("computed_low_confidence");
    expect(snapshot?.expiresAt?.toISOString()).toBe("2020-01-07T15:00:00.000Z"); // 2020-01-08 00:00 JST
  }, 100_000);
});

describe("CodexBudgetAdapter (should-4: period integrity validation)", () => {
  it("rejects period_end <= period_start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-codex-budget-"));
    const path = writeConfig(dir, { period_start: "2020-01-08", period_end: "2020-01-01" });
    const adapter = new CodexBudgetAdapter({ configPath: path, agentCostBin: bin ?? "agent-cost" });
    await expect(adapter.snapshot()).rejects.toThrow(CodexBudgetConfigError);
  });

  it("rejects a reset_rule=weekly period that isn't exactly 7 days", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-codex-budget-"));
    const path = writeConfig(dir, { period_start: "2020-01-01", period_end: "2020-01-05" });
    const adapter = new CodexBudgetAdapter({ configPath: path, agentCostBin: bin ?? "agent-cost" });
    await expect(adapter.snapshot()).rejects.toThrow(CodexBudgetConfigError);
  });
});

describeOrSkip(
  "CodexBudgetAdapter (should-4: non-weekly reset_rule bypasses the 7-day check)",
  () => {
    it("does not apply the 7-day check to a non-weekly reset_rule", async () => {
      const dir = mkdtempSync(join(tmpdir(), "lane-codex-budget-"));
      const path = writeConfig(dir, {
        period_start: "2020-01-01",
        period_end: "2020-01-05", // 4 days -- would fail the weekly check, but reset_rule isn't weekly
        reset_rule: "manual",
      });
      const adapter = new CodexBudgetAdapter({
        configPath: path,
        agentCostBin: bin ?? undefined,
        timeoutMs: 90_000,
      });
      // reaching a resolved snapshot (rather than throwing) proves period-length wasn't
      // rejected -- this requires the real subprocess to actually run, hence describeOrSkip.
      await expect(adapter.snapshot()).resolves.toBeDefined();
    }, 100_000);
  },
);

describe("CodexBudgetAdapter (should-5: normalized error handling)", () => {
  it("throws CodexBudgetConfigError for malformed YAML syntax, not a raw parser exception", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-codex-budget-"));
    const path = join(dir, "codex.yaml");
    writeFileSync(path, "weekly_limit_credits: [unterminated\n  - broken");
    const adapter = new CodexBudgetAdapter({ configPath: path, agentCostBin: bin ?? "agent-cost" });
    await expect(adapter.snapshot()).rejects.toThrow(CodexBudgetConfigError);
  });
});
