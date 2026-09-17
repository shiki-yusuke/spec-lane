import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCalibrate } from "../src/commands/calibrate.js";
import { runStart } from "../src/commands/start.js";
import { runWorkBind, runWorkStart } from "../src/commands/work.js";

// issue #42 / spec I-2026-09-17-calibrate-agent-cost-timeout -- TEST-04/05/06/07 (spec.md
// "Tests" table, "Scenarios" Gherkin). Expected values below are taken from spec.md's
// RULE-02/03/06/09 and the Examples tables, never from the CLI's own source. Follows
// cli-argv-basis-flags.test.ts's own subprocess-against-dist/main.js convention.

const __dirname = dirname(fileURLToPath(import.meta.url));
const distMainPath = join(__dirname, "..", "dist", "main.js");
const describeOrSkip = existsSync(distMainPath) ? describe : describe.skip;

function writeSleepingFake(dir: string, name = "sleeping"): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexec sleep 5\n");
  chmodSync(path, 0o755);
  return path;
}

// spec.md "Test doubles and setup" TEST-05/TEST-06: ignores its args, touches a marker
// file, then emits a normal measure/v1 JSON payload -- lets the test tell "was agent-cost
// ever spawned" apart from "did it succeed".
function writeMarkingFake(dir: string, markerPath: string, name = "marking"): string {
  const path = join(dir, name);
  const script = `#!/bin/sh
touch "${markerPath}"
cat <<'JSON'
{
  "protocol_version": "measure/v1",
  "generated_at": "2026-09-17T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": ["s1"],
  "sessions": {"s1": {"matched": true, "rows": [], "totals": {"tokens": 100, "priced_tokens": 100, "unpriced_tokens": 0, "estimated_cost_usd": 0.1, "credits": 0}}},
  "total": {"rows": [{"month": null, "agent": "claude", "model": "claude-sonnet-5", "token_kind": "output", "tokens": 100, "priced_tokens": 100, "unpriced_tokens": 0, "estimated_cost_usd": 0.1, "credits": 0, "pricing_status": "priced"}], "totals": {"tokens": 100, "priced_tokens": 100, "unpriced_tokens": 0, "estimated_cost_usd": 0.1, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "conflicting_duplicate_groups": 0, "missing_dedup_identity_rows": 0, "source_quality": {"identity_missing": 0}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

// Same shape as cli-argv-basis-flags.test.ts's own writeFakeAgentCost -- a fast, valid
// measure/v1 fake, used only to create a scope:"lane" ledger entry in-process before the
// sleeping fake takes over the subprocess call under test (spec.md "Test doubles and
// setup", the emit-metrics bullet).
function writeFastFakeAgentCost(dir: string, sessionId: string): string {
  const path = join(dir, "agent-cost-fast");
  const script = `#!/bin/sh
cat <<'JSON'
{
  "protocol_version": "measure/v1",
  "generated_at": "2026-09-17T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": ["${sessionId}"],
  "sessions": {"${sessionId}": {"matched": true, "rows": [], "totals": {"tokens": 100, "priced_tokens": 100, "unpriced_tokens": 0, "estimated_cost_usd": 0.1, "credits": 0}}},
  "total": {"rows": [{"month": null, "agent": "claude", "model": "claude-sonnet-5", "token_kind": "output", "tokens": 100, "priced_tokens": 100, "unpriced_tokens": 0, "estimated_cost_usd": 0.1, "credits": 0, "pricing_status": "priced"}], "totals": {"tokens": 100, "priced_tokens": 100, "unpriced_tokens": 0, "estimated_cost_usd": 0.1, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "conflicting_duplicate_groups": 0, "missing_dedup_identity_rows": 0, "source_quality": {"identity_missing": 0}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

// codex-budget.test.ts's own writeConfig precedent: period-consistent, reset_rule=weekly
// codex.yaml so `lane next` actually spawns agent-cost (codex-budget.ts only returns early
// when the config file is absent -- spec.md "Falsification conditions").
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

function lane(
  args: string[],
  opts: { cwd: string; dataDir: string },
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [distMainPath, ...args], {
      cwd: opts.cwd,
      encoding: "utf-8",
      env: { ...process.env, LANE_DATA_DIR: opts.dataDir },
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describeOrSkip("issue #42: --agent-cost-timeout-ms reaches every command (dist subprocess)", () => {
  let specDir: string;
  let dataDir: string;
  let repoDir: string;
  let binDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-to-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-to-data-"));
    repoDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-to-repo-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-to-bin-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to "undefined"
    delete process.env.LANE_DATA_DIR;
    // sol impl review 1 (should-3): don't let every run leave four temp dirs behind.
    for (const dir of [specDir, dataDir, repoDir, binDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // TEST-04 (spec.md Scenario Outline "the flag reaches the adapter through main.ts, each
  // command keeps its contract"): RULE-02 (flag reaches the adapter) + RULE-09 (each
  // command's existing exit-state contract is unchanged).
  it("TEST-04 calibrate: exit 2, 'telemetry measurement failed', 'timed out after 200 ms'", () => {
    const intentId = "I-2026-09-17-agent-cost-to-calibrate";
    runStart(intentId, { specDir });
    const sleeping = writeSleepingFake(binDir);

    const result = lane(
      [
        "calibrate",
        intentId,
        "--spec-dir",
        specDir,
        "--session-id",
        "s1",
        "--agent-cost-bin",
        sleeping,
        "--agent-cost-timeout-ms",
        "200",
      ],
      { cwd: repoDir, dataDir },
    );

    expect(result.exitCode).toBe(2);
    const output = result.stdout + result.stderr;
    expect(output).toContain("timed out after 200 ms");
    expect(output).toContain("telemetry measurement failed");
  }, 20_000);

  it("TEST-04 usage-import: exit 0, 'recorded as measurement-incomplete', 'timed out after 200 ms'", () => {
    const intentId = "I-2026-09-17-agent-cost-to-usage-import";
    runStart(intentId, { specDir });
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });
    const sleeping = writeSleepingFake(binDir);

    const result = lane(
      [
        "usage-import",
        "--intent",
        intentId,
        "--spec-dir",
        specDir,
        "--agent-cost-bin",
        sleeping,
        "--agent-cost-timeout-ms",
        "200",
      ],
      { cwd: repoDir, dataDir },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("timed out after 200 ms");
    expect(output).toContain("recorded as measurement-incomplete");
  }, 20_000);

  it("TEST-04 emit-metrics: exit 2, 'telemetry measurement failed', 'timed out after 200 ms'", async () => {
    const intentId = "I-2026-09-17-agent-cost-to-emit-metrics";
    runStart(intentId, { specDir });
    // spec.md "Test doubles and setup" (emit-metrics bullet): emit-metrics only spawns
    // agent-cost for ledger entries that exist -- create one in-process with a fast fake
    // first, then run the subprocess under test with the sleeping fake.
    const fastBin = writeFastFakeAgentCost(binDir, "s1");
    const calibrateResult = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["s1"],
      agentCostBin: fastBin,
    });
    expect(calibrateResult.exitCode, calibrateResult.message).toBe(0);

    const sleeping = writeSleepingFake(binDir);
    const result = lane(
      [
        "emit-metrics",
        intentId,
        "--spec-dir",
        specDir,
        "--agent-cost-bin",
        sleeping,
        "--agent-cost-timeout-ms",
        "200",
      ],
      { cwd: repoDir, dataDir },
    );

    expect(result.exitCode).toBe(2);
    const output = result.stdout + result.stderr;
    expect(output).toContain("timed out after 200 ms");
    expect(output).toContain("telemetry measurement failed");
  }, 20_000);

  it("TEST-04 next: exit 2, 'codex budget:', 'timed out after 200 ms'", () => {
    const configDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-to-config-"));
    const codexBudgetPath = writeCodexConfig(configDir);
    const nonexistentRateLimits = join(configDir, "does-not-exist-rate-limits.json");
    const sleeping = writeSleepingFake(binDir);

    const result = lane(
      [
        "next",
        "--spec-dir",
        specDir,
        "--config-dir",
        configDir,
        "--codex-budget-path",
        codexBudgetPath,
        "--claude-rate-limits-path",
        nonexistentRateLimits,
        "--agent-cost-bin",
        sleeping,
        "--agent-cost-timeout-ms",
        "200",
      ],
      { cwd: repoDir, dataDir },
    );

    expect(result.exitCode).toBe(2);
    const output = result.stdout + result.stderr;
    expect(output).toContain("timed out after 200 ms");
    expect(output).toContain("codex budget:");
  }, 20_000);

  // TEST-05 (spec.md Scenario Outline "an invalid timeout is a usage error and never
  // spawns agent-cost"): RULE-03 -- five invalid values, all must be rejected before
  // agent-cost is ever spawned (marker file never created).
  it.each(["0", "-5", "1.5", "abc", "3600001"])(
    "TEST-05: --agent-cost-timeout-ms %s is a usage error, agent-cost is never spawned",
    (value) => {
      const intentId = `I-2026-09-17-agent-cost-to-invalid-${value.replace(/[^a-z0-9]/gi, "")}`;
      runStart(intentId, { specDir });
      const markerDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-to-marker-"));
      const markerPath = join(markerDir, "marker");
      const marking = writeMarkingFake(
        binDir,
        markerPath,
        `marking-${value.replace(/[^a-z0-9]/gi, "")}`,
      );

      const result = lane(
        [
          "calibrate",
          intentId,
          "--spec-dir",
          specDir,
          "--session-id",
          "s1",
          "--agent-cost-bin",
          marking,
          "--agent-cost-timeout-ms",
          value,
        ],
        { cwd: repoDir, dataDir },
      );

      expect(result.exitCode).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain("--agent-cost-timeout-ms");
      expect(existsSync(markerPath)).toBe(false);
    },
  );

  // TEST-06 (spec.md Scenario "the boundary values are accepted"): RULE-03's boundary --
  // 1 and 3600000 are both valid, so agent-cost must actually be spawned. `parseAgentCostTimeoutMs`
  // is a non-exported function in main.ts (spec.md D2), so this is driven through the real
  // CLI subprocess rather than a direct unit call (recorded as a spec_consensus deviation
  // by the parent per the task brief).
  it("TEST-06: --agent-cost-timeout-ms 1 is accepted and spawns agent-cost (times out immediately)", () => {
    const intentId = "I-2026-09-17-agent-cost-to-boundary-min";
    runStart(intentId, { specDir });
    const sleeping = writeSleepingFake(binDir, "sleeping-boundary-min");

    const result = lane(
      [
        "calibrate",
        intentId,
        "--spec-dir",
        specDir,
        "--session-id",
        "s1",
        "--agent-cost-bin",
        sleeping,
        "--agent-cost-timeout-ms",
        "1",
      ],
      { cwd: repoDir, dataDir },
    );

    const output = result.stdout + result.stderr;
    expect(output).toContain("timed out after 1 ms");
  }, 20_000);

  it("TEST-06: --agent-cost-timeout-ms 3600000 is accepted and spawns agent-cost (marker written)", () => {
    const intentId = "I-2026-09-17-agent-cost-to-boundary-max";
    runStart(intentId, { specDir });
    const markerDir = mkdtempSync(join(tmpdir(), "lane-agent-cost-to-marker-max-"));
    const markerPath = join(markerDir, "marker");
    const marking = writeMarkingFake(binDir, markerPath, "marking-boundary-max");

    const result = lane(
      [
        "calibrate",
        intentId,
        "--spec-dir",
        specDir,
        "--session-id",
        "s1",
        "--agent-cost-bin",
        marking,
        "--agent-cost-timeout-ms",
        "3600000",
      ],
      { cwd: repoDir, dataDir },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
  }, 20_000);
});

// TEST-07 (spec.md Scenario "the option is defined once"): RULE-06 -- the option name is
// defined exactly once in main.ts, and each of the four commands attaches it through
// withAgentCostOptions.
describe("TEST-07: --agent-cost-timeout-ms is defined once in main.ts (RULE-06)", () => {
  const mainTsPath = join(__dirname, "..", "src", "main.ts");
  const mainTsText = readFileSync(mainTsPath, "utf-8");

  it("the literal '--agent-cost-timeout-ms' occurs exactly once", () => {
    const occurrences = mainTsText.split("--agent-cost-timeout-ms").length - 1;
    expect(occurrences).toBe(1);
  });

  it("withAgentCostOptions( is called at least 5 times (its own definition + 4 commands)", () => {
    const occurrences = mainTsText.split("withAgentCostOptions(").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(5);
  });
});
