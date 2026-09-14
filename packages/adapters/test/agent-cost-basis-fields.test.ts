import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCostTelemetryAdapter, TelemetryImportFailed } from "../src/telemetry/agent-cost.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// I-2026-09-10-agent-cost-v2-basis-gate -- RULE-28 (spec.md "Requirements (EARS)"): if
// `producer_version` or `accounting_basis` is present and exceeds 256 characters or
// contains a control character, the telemetry adapter shall reject the payload rather
// than persist the value; both fields stay optional (RULE-02/D1), so this constrains only
// a present value, never an absent one. TEST-41 pins the `producer_version` half, TEST-57
// the `accounting_basis` half (spec.md "Tests").
//
// Uses the same fake-cli-recorder.mjs test double telemetry-agent-cost.test.ts's own
// "production personal-dimension fail-closed check" describe block already uses (a real
// agent-cost binary would never legitimately emit a hostile value here) -- FAKE_CLI_STDOUT
// lets this test control agent-cost's stdout directly, without spawning a real subprocess.
describe("AgentCostTelemetryAdapter -- RULE-28 basis field bounds (TEST-41/TEST-57)", () => {
  const fakeAgentCostBin = join(__dirname, "fixtures", "fake-cli-recorder.mjs");
  const baseFixtureRaw = readFileSync(
    join(__dirname, "fixtures", "measure", "v1", "fixtures", "accept-matched-normal.json"),
    "utf-8",
  );
  const baseFixture = JSON.parse(baseFixtureRaw) as Record<string, unknown>;
  const CONTROL_CHAR = String.fromCharCode(7); // BEL -- any of \x00-\x1f/\x7f would do
  // sol implementation review (RULE-28 clarification): "control character" is all of
  // Unicode Cc -- C0 (\x00-\x1f), DEL (\x7f), and C1 (U+0080-U+009F) -- not just the
  // C0/DEL range. U+0085 NEL is a C1 control character distinct from both.
  const C1_CONTROL_CHAR = String.fromCharCode(0x85); // NEL (U+0085)

  // process.env.X = undefined would coerce to the string "undefined" (truthy, and read
  // back by the adapter as a real value), not actual unsetting -- rest-destructuring the
  // key out and reassigning process.env is what actually clears it.
  afterEach(() => {
    const { FAKE_CLI_STDOUT: _fakeCliStdout, ...rest } = process.env;
    process.env = rest;
  });

  function withFields(fields: Record<string, unknown>): string {
    return JSON.stringify({ ...baseFixture, ...fields });
  }

  // RULE-28's own wording is "exceeds 256 characters" -- 257 is the smallest violating
  // length; 256 itself must stay accepted (exercised by the "normal value" case below).
  it("TEST-41: rejects a producer_version over 256 characters", async () => {
    process.env.FAKE_CLI_STDOUT = withFields({ producer_version: "0".repeat(257) });
    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    await expect(adapter.measure(["session-a"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["session-a"])).rejects.toThrow(/producer_version/);
  });

  it("TEST-41: rejects a producer_version containing a control character", async () => {
    process.env.FAKE_CLI_STDOUT = withFields({ producer_version: `0.2.0${CONTROL_CHAR}evil` });
    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    await expect(adapter.measure(["session-a"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["session-a"])).rejects.toThrow(/producer_version/);
  });

  it("TEST-57: rejects an accounting_basis over 256 characters", async () => {
    process.env.FAKE_CLI_STDOUT = withFields({ accounting_basis: "a".repeat(257) });
    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    await expect(adapter.measure(["session-a"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["session-a"])).rejects.toThrow(/accounting_basis/);
  });

  it("TEST-57: rejects an accounting_basis containing a control character", async () => {
    process.env.FAKE_CLI_STDOUT = withFields({
      accounting_basis: `agent-cost-raw-total/v2${CONTROL_CHAR}`,
    });
    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    await expect(adapter.measure(["session-a"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["session-a"])).rejects.toThrow(/accounting_basis/);
  });

  // RULE-28's "control character" covers Unicode Cc in full, not just C0/DEL -- a C1
  // control character (U+0080-U+009F) must be rejected too.
  it("TEST-41: rejects a producer_version containing a C1 control character (U+0085 NEL)", async () => {
    process.env.FAKE_CLI_STDOUT = withFields({
      producer_version: `0.2.0${C1_CONTROL_CHAR}evil`,
    });
    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    await expect(adapter.measure(["session-a"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["session-a"])).rejects.toThrow(/producer_version/);
  });

  it("TEST-57: rejects an accounting_basis containing a C1 control character (U+0085 NEL)", async () => {
    process.env.FAKE_CLI_STDOUT = withFields({
      accounting_basis: `agent-cost-raw-total/v2${C1_CONTROL_CHAR}`,
    });
    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    await expect(adapter.measure(["session-a"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["session-a"])).rejects.toThrow(/accounting_basis/);
  });

  // RULE-01/RULE-02/D1: a present, well-formed value (well within the 256-char bound, no
  // control character) is declared and must survive parsing unchanged -- RULE-28 bounds a
  // present value, it does not narrow what a compliant one may say.
  it("a normal producer_version and accounting_basis both pass through unchanged", async () => {
    process.env.FAKE_CLI_STDOUT = withFields({
      producer_version: "0.2.0",
      accounting_basis: "agent-cost-raw-total/v2",
    });
    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    const result = await adapter.measure(["session-a"]);
    expect(result.producer_version).toBe("0.2.0");
    expect(result.accounting_basis).toBe("agent-cost-raw-total/v2");
  });

  // RULE-02/RULE-28: both fields stay optional -- a 0.1.x-shaped payload carrying neither
  // must still validate and pass through, read back as undefined (matches TEST-02's own
  // claim for the schema layer; this pins the same claim at the adapter/subprocess
  // boundary that RULE-28's rejection also lives at).
  it("both fields absent still passes through (read back as undefined, never rejected)", async () => {
    process.env.FAKE_CLI_STDOUT = baseFixtureRaw; // the base fixture itself carries neither field
    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    const result = await adapter.measure(["session-a"]);
    expect(result.producer_version).toBeUndefined();
    expect(result.accounting_basis).toBeUndefined();
  });
});
