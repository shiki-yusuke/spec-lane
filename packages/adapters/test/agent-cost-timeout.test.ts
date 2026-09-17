import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentCostTelemetryAdapter,
  CodexBudgetAdapter,
  CodexBudgetConfigError,
  DEFAULT_AGENT_COST_TIMEOUT_MS,
  TelemetryImportFailed,
  describeAgentCostFailure,
} from "../src/index.js";

// issue #42 / spec I-2026-09-17-calibrate-agent-cost-timeout -- TEST-01/02/03 (spec.md
// "Tests" table, "Scenarios" Background + the three Scenario(s) so tagged). Expected
// values below are taken from spec.md's RULE-01/04/05 and the Gherkin Examples tables,
// never from the adapters' own source.

// spec.md "Test doubles and setup" + Background: "exec sleep 5" (not a bare "sleep 5")
// so SIGTERM reaches the sleeper process itself, not a still-alive `/bin/sh` wrapper.
function writeSleepingFake(dir: string): string {
  const path = join(dir, "sleeping");
  writeFileSync(path, "#!/bin/sh\nexec sleep 5\n");
  chmodSync(path, 0o755);
  return path;
}

// Background: fake agent-cost executable "failing".
function writeFailingFake(dir: string): string {
  const path = join(dir, "failing");
  writeFileSync(path, "#!/bin/sh\necho boom >&2\nexit 3\n");
  chmodSync(path, 0o755);
  return path;
}

// codex-budget.test.ts's own `writeConfig` precedent: a period-consistent, reset_rule=weekly
// codex.yaml so CodexBudgetAdapter.snapshot() actually reaches the agent-cost subprocess
// call instead of failing earlier at config parsing (parseCodexBudgetConfig).
function writeCodexConfig(dir: string): string {
  const path = join(dir, "codex.yaml");
  writeFileSync(
    path,
    [
      "weekly_limit_credits: 15000",
      'period_start: "2020-01-01"',
      'period_end: "2020-01-08"',
      'reset_rule: "weekly"',
      'timezone: "Asia/Tokyo"',
      "",
    ].join("\n"),
  );
  return path;
}

describe("agent-cost subprocess timeout (issue #42)", () => {
  // TEST-01 (spec.md Scenario "default timeout is the shared constant"): both adapters
  // expose timeoutMs===DEFAULT_AGENT_COST_TIMEOUT_MS when constructed without timeoutMs,
  // and the constant itself is 180000 (RULE-01).
  it("TEST-01: both adapters default timeoutMs to DEFAULT_AGENT_COST_TIMEOUT_MS, which is 180000", () => {
    expect(DEFAULT_AGENT_COST_TIMEOUT_MS).toBe(180_000);

    const telemetry = new AgentCostTelemetryAdapter();
    expect(telemetry.timeoutMs).toBe(DEFAULT_AGENT_COST_TIMEOUT_MS);

    const configDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-timeout-cfg-"));
    const configPath = writeCodexConfig(configDir);
    const budget = new CodexBudgetAdapter({ configPath });
    expect(budget.timeoutMs).toBe(DEFAULT_AGENT_COST_TIMEOUT_MS);
  });

  // TEST-02 (spec.md Scenario Outline "a timeout kill is named", both Examples rows):
  // RULE-04 -- the sleeping fake never returns within timeoutMs 200, so execFile kills it
  // with SIGTERM and the adapter must name the timeout, the signal and the bin explicitly.
  it("TEST-02: AgentCostTelemetryAdapter.measure names a killed timeout (RULE-04)", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-timeout-bin-"));
    const bin = writeSleepingFake(binDir);
    const adapter = new AgentCostTelemetryAdapter({ bin, timeoutMs: 200 });

    await expect(adapter.measure(["s1"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["s1"])).rejects.toThrow(
      /agent-cost measure timed out after 200 ms/,
    );
    await expect(adapter.measure(["s1"])).rejects.toThrow(/killed with SIGTERM/);
    await expect(adapter.measure(["s1"])).rejects.toThrow(/bin=/);
  }, 20_000);

  it("TEST-02: CodexBudgetAdapter.snapshot names a killed timeout (RULE-04)", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-timeout-bin-"));
    const bin = writeSleepingFake(binDir);
    const configDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-timeout-cfg-"));
    const configPath = writeCodexConfig(configDir);
    const adapter = new CodexBudgetAdapter({ configPath, agentCostBin: bin, timeoutMs: 200 });

    await expect(adapter.snapshot()).rejects.toThrow(CodexBudgetConfigError);
    await expect(adapter.snapshot()).rejects.toThrow(/agent-cost report timed out after 200 ms/);
    await expect(adapter.snapshot()).rejects.toThrow(/killed with SIGTERM/);
    await expect(adapter.snapshot()).rejects.toThrow(/bin=/);
  }, 20_000);

  // TEST-03 (spec.md Scenario Outline "a non-timeout failure keeps the pre-change
  // message", all four Examples rows): RULE-05 -- a non-zero exit and a missing binary
  // must both keep the pre-change "agent-cost <verb> failed (bin=...)" message and must
  // never contain "timed out".
  it("TEST-03: AgentCostTelemetryAdapter.measure -- failing fake keeps the pre-change message (RULE-05)", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-timeout-bin-"));
    const bin = writeFailingFake(binDir);
    const adapter = new AgentCostTelemetryAdapter({ bin, timeoutMs: 5000 });

    await expect(adapter.measure(["s1"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["s1"])).rejects.toThrow(/agent-cost measure failed \(bin=/);
    await expect(adapter.measure(["s1"])).rejects.not.toThrow(/timed out/);
  });

  it("TEST-03: AgentCostTelemetryAdapter.measure -- missing binary keeps the pre-change message (RULE-05)", async () => {
    const adapter = new AgentCostTelemetryAdapter({
      bin: "lane-nonexistent-binary-xyz",
      timeoutMs: 5000,
    });

    await expect(adapter.measure(["s1"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["s1"])).rejects.toThrow(/agent-cost measure failed \(bin=/);
    await expect(adapter.measure(["s1"])).rejects.not.toThrow(/timed out/);
  });

  it("TEST-03: CodexBudgetAdapter.snapshot -- failing fake keeps the pre-change message (RULE-05)", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-timeout-bin-"));
    const bin = writeFailingFake(binDir);
    const configDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-timeout-cfg-"));
    const configPath = writeCodexConfig(configDir);
    const adapter = new CodexBudgetAdapter({ configPath, agentCostBin: bin, timeoutMs: 5000 });

    await expect(adapter.snapshot()).rejects.toThrow(CodexBudgetConfigError);
    await expect(adapter.snapshot()).rejects.toThrow(/agent-cost report failed \(bin=/);
    await expect(adapter.snapshot()).rejects.not.toThrow(/timed out/);
  });

  it("TEST-03: CodexBudgetAdapter.snapshot -- missing binary keeps the pre-change message (RULE-05)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-timeout-cfg-"));
    const configPath = writeCodexConfig(configDir);
    const adapter = new CodexBudgetAdapter({
      configPath,
      agentCostBin: "lane-nonexistent-binary-xyz",
      timeoutMs: 5000,
    });

    await expect(adapter.snapshot()).rejects.toThrow(CodexBudgetConfigError);
    await expect(adapter.snapshot()).rejects.toThrow(/agent-cost report failed \(bin=/);
    await expect(adapter.snapshot()).rejects.not.toThrow(/timed out/);
  });
});

// sol impl review 1 (should-2): RULE-04's `unknown signal` fallback and RULE-05's
// "<original message>" preservation are contracts of the shared classifier itself, so they
// are asserted directly here rather than only through a real subprocess (which always
// carries a signal and always produces execFile's own "Command failed" text).
describe("describeAgentCostFailure (shared classifier, RULE-04/RULE-05)", () => {
  it("RULE-04: killed:true without a signal falls back to 'unknown signal'", () => {
    const message = describeAgentCostFailure("measure", "agent-cost", 200, { killed: true });
    expect(message).toBe(
      "agent-cost measure timed out after 200 ms (killed with unknown signal) (bin=agent-cost)",
    );
  });

  it("RULE-04: killed:true with a signal names it", () => {
    const message = describeAgentCostFailure("report", "/x/agent-cost", 180_000, {
      killed: true,
      signal: "SIGTERM",
    });
    expect(message).toBe(
      "agent-cost report timed out after 180000 ms (killed with SIGTERM) (bin=/x/agent-cost)",
    );
  });

  it("RULE-05: a non-killed Error keeps the pre-change prefix and the original message verbatim", () => {
    const message = describeAgentCostFailure("measure", "agent-cost", 200, new Error("boom"));
    expect(message).toBe("agent-cost measure failed (bin=agent-cost): boom");
    expect(message).not.toMatch(/timed out/);
  });

  it("RULE-05: killed:false (a child that exited on its own) is not a timeout", () => {
    const err = Object.assign(new Error("Command failed: agent-cost measure"), {
      killed: false,
      code: 3,
      signal: null,
    });
    const message = describeAgentCostFailure("measure", "agent-cost", 200, err);
    expect(message).toBe(
      "agent-cost measure failed (bin=agent-cost): Command failed: agent-cost measure",
    );
  });
});
