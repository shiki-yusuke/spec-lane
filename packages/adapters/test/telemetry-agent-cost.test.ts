import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCostTelemetryAdapter, TelemetryImportFailed } from "../src/telemetry/agent-cost.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Real integration test against the actual agent-cost binary (matching this repo's own
// convention — e.g. packages/core/test/differential — of preferring "run the real thing"
// over mocking a subprocess boundary). agent-cost is not yet published anywhere pip can
// resolve it from a bare `pip install agent-cost` (it's a sibling local repo), so CI does
// not yet have it on PATH; this is a known gap, not addressed here. Locally, it's resolved
// via LANE_TEST_AGENT_COST_BIN (point it at your own local install to run these), else
// PATH, and the whole suite is skipped if neither resolves.
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

describeOrSkip("AgentCostTelemetryAdapter (real agent-cost subprocess)", () => {
  // agent-cost scans real local log files (~/.claude/projects, ~/.codex's state db) on
  // every call — observed anywhere from ~4s to ~25s across repeated runs on this dev
  // machine's accumulated history, bounded by --since/--until or not; the variance didn't
  // reliably correlate with bounding, so both tests below get generous headroom rather
  // than assuming a bounded call is fast.
  it("returns a matched:false session with zero totals for a session id that has no usage", async () => {
    const adapter = new AgentCostTelemetryAdapter({ bin: bin ?? undefined, timeoutMs: 90_000 });
    const result = await adapter.measure(["lane-test-nonexistent-session-id"]);
    expect(result.protocol_version).toBe("measure/v1");
    expect(result.session_ids).toEqual(["lane-test-nonexistent-session-id"]);
    expect(result.sessions["lane-test-nonexistent-session-id"]?.matched).toBe(false);
    expect(result.total.totals.tokens).toBe(0);
  }, 100_000);

  it("passes --since/--until/--agent through and still returns a well-formed response", async () => {
    const adapter = new AgentCostTelemetryAdapter({ bin: bin ?? undefined, timeoutMs: 60_000 });
    const result = await adapter.measure(["lane-test-nonexistent-session-id"], {
      since: new Date("2020-01-01T00:00:00Z"),
      until: new Date("2020-01-02T00:00:00Z"),
      agents: ["claude"],
    });
    expect(result.window.since).toContain("2020-01-01");
    expect(result.agent).toEqual(["claude"]);
  }, 70_000);

  it("rejects an empty session id list without ever spawning the subprocess", async () => {
    const adapter = new AgentCostTelemetryAdapter({ bin: bin ?? undefined });
    await expect(adapter.measure([])).rejects.toThrow(TelemetryImportFailed);
  });

  it("throws TelemetryImportFailed for a nonexistent binary", async () => {
    const adapter = new AgentCostTelemetryAdapter({ bin: "lane-nonexistent-binary-xyz" });
    await expect(adapter.measure(["s1"])).rejects.toThrow(TelemetryImportFailed);
  });
});

// sol review must3 (#51): proves the personal-dimension scan added to
// AgentCostTelemetryAdapter.measure() itself actually runs in the production code path,
// not only in the differential fixture-replay test (measure-fixtures.test.ts) that never
// invokes this class. Uses the fake-cli-recorder test double (same one
// tracker-github.test.ts/vcs-github.test.ts already use) since a real, un-modified
// agent-cost binary would never legitimately emit a personal-dimension key — this fixture
// simulates a hypothetical contaminated/future producer, or a bug elsewhere in the chain,
// which is exactly the scenario measure/v1's open schema (no additionalProperties:false)
// cannot catch on its own.
describe("AgentCostTelemetryAdapter (production personal-dimension fail-closed check)", () => {
  const fakeAgentCostBin = join(__dirname, "fixtures", "fake-cli-recorder.mjs");
  const contaminatedFixture = join(
    __dirname,
    "fixtures",
    "measure",
    "v1",
    "fixtures",
    "invalid-personal-dimension.json",
  );

  // process.env.X = undefined would coerce to the string "undefined" (truthy, and printed
  // verbatim by fake-cli-recorder.mjs) rather than actually unsetting the key -- delete is the
  // only correct way to clear it here, same as vcs-github.test.ts's existing cleanup.
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: see comment above -- an undefined assignment is not equivalent here
    delete process.env.FAKE_CLI_STDOUT;
  });

  it("rejects a measure/v1 payload containing forbidden personal-dimension keys, even though schema validation alone would accept it", async () => {
    const contaminated = readFileSync(contaminatedFixture, "utf-8");
    process.env.FAKE_CLI_STDOUT = contaminated;

    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    await expect(adapter.measure(["session-a"])).rejects.toThrow(TelemetryImportFailed);
    await expect(adapter.measure(["session-a"])).rejects.toThrow(/personal-dimension/);
  });

  it("still accepts a clean measure/v1 payload through the same fake binary (sanity check that the fixture, not the harness, is what's rejected above)", async () => {
    const clean = readFileSync(
      join(__dirname, "fixtures", "measure", "v1", "fixtures", "accept-matched-normal.json"),
      "utf-8",
    );
    process.env.FAKE_CLI_STDOUT = clean;

    const adapter = new AgentCostTelemetryAdapter({ bin: fakeAgentCostBin });
    const result = await adapter.measure(["session-a"]);
    expect(result.protocol_version).toBe("measure/v1");
  });
});
