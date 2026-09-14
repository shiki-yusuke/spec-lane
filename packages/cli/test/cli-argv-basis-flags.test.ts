import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { runStart } from "../src/commands/start.js";
import { runWorkBind, runWorkStart } from "../src/commands/work.js";
import { readEstimateIfExists } from "../src/estimate-store.js";
import { readLaneState } from "../src/state-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// I-2026-09-10-agent-cost-v2-basis-gate -- TEST-34: `--supersede-basis` (usage-import /
// calibrate) and `--reference-token-basis <basis>` (estimate) must actually reach the
// commands' `opts` object *through main.ts's real commander definitions*, not only
// through the run* functions' own TypeScript option shape (which every other test in this
// suite calls directly, bypassing argv parsing entirely). Runs the built `dist/main.js` as
// a real subprocess (same convention as e2e.test.ts's `lane(...)` helper, without the
// pnpm-pack/npm-install overhead that test's own scope specifically needs) -- skipped
// entirely when the workspace hasn't been built yet (dist/main.js absent), since a fresh
// checkout's `pnpm install` does not itself run `tsc -b`.
const distMainPath = join(__dirname, "..", "dist", "main.js");
const describeOrSkip = existsSync(distMainPath) ? describe : describe.skip;

// I-2026-09-10-agent-cost-v2-basis-gate (D2/RULE-30) -- the current basis literal, as
// declared in spec.md.
const CURRENT_BASIS = "agent-cost-raw-total/v2";

function writeFakeAgentCost(
  dir: string,
  sessions: Record<string, { matched: boolean; tokens: number; costUsd: number }>,
  opts: { accountingBasis?: string; producerVersion?: string } = {},
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
  const basisFields = [
    opts.accountingBasis !== undefined
      ? `"accounting_basis": ${JSON.stringify(opts.accountingBasis)},`
      : "",
    opts.producerVersion !== undefined
      ? `"producer_version": ${JSON.stringify(opts.producerVersion)},`
      : "",
  ].join("\n  ");
  const script = `#!/usr/bin/env bash
cat <<'JSON'
{
  ${basisFields}
  "protocol_version": "measure/v1",
  "generated_at": "2026-09-14T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": [${sessionIds.map((s) => `"${s}"`).join(",")}],
  "sessions": {${sessionsJson}},
  "total": {"rows": [{"month": null, "agent": "claude", "model": "claude-sonnet-5", "token_kind": "output", "tokens": ${totalTokens}, "priced_tokens": ${totalTokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${totalCost}, "credits": 0, "pricing_status": "priced"}], "totals": {"tokens": ${totalTokens}, "priced_tokens": ${totalTokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${totalCost}, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "conflicting_duplicate_groups": 0, "missing_dedup_identity_rows": 0, "source_quality": {"identity_missing": 0}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
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

describeOrSkip(
  "TEST-34: basis-gate flags reach opts through main.ts's real commander definitions",
  () => {
    let specDir: string;
    let dataDir: string;
    let repoDir: string;
    let binDir: string;

    beforeEach(() => {
      specDir = mkdtempSync(join(tmpdir(), "lane-cli-argv-spec-"));
      dataDir = mkdtempSync(join(tmpdir(), "lane-cli-argv-data-"));
      repoDir = mkdtempSync(join(tmpdir(), "lane-cli-argv-repo-"));
      binDir = mkdtempSync(join(tmpdir(), "lane-cli-argv-bin-"));
      // Setup (start/work start/work bind) is done in-process, exactly as every other test
      // in this suite does -- only the flag under test is driven through the real CLI
      // subprocess below. Both share the same LANE_DATA_DIR/specDir/repoDir, so file state is
      // consistent across the in-process and subprocess calls.
      process.env.LANE_DATA_DIR = dataDir;
    });

    afterEach(() => {
      // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
      delete process.env.LANE_DATA_DIR;
    });

    it("usage-import --supersede-basis: absent refuses, present writes (opts.supersedeBasis)", () => {
      const intentId = "I-2026-09-14-cli-argv-usage-import";
      runStart(intentId, { specDir });
      runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
      runWorkBind(intentId, { specDir, sessionId: "s-cli", agent: "claude", cwd: repoDir });

      const binV2 = writeFakeAgentCost(
        binDir,
        { "s-cli": { matched: true, tokens: 1000, costUsd: 0.5 } },
        { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" },
      );
      const baseline = lane(
        ["usage-import", "--intent", intentId, "--spec-dir", specDir, "--agent-cost-bin", binV2],
        { cwd: repoDir, dataDir },
      );
      expect(baseline.exitCode, baseline.stderr).toBe(0);

      const binUnknownDir = mkdtempSync(join(tmpdir(), "lane-cli-argv-bin2-"));
      const binUnknown = writeFakeAgentCost(binUnknownDir, {
        "s-cli": { matched: true, tokens: 1200, costUsd: 0.6 },
      });
      // No --supersede-basis: commander leaves opts.supersedeBasis undefined -> refused.
      const withoutFlag = lane(
        [
          "usage-import",
          "--intent",
          intentId,
          "--spec-dir",
          specDir,
          "--agent-cost-bin",
          binUnknown,
        ],
        { cwd: repoDir, dataDir },
      );
      expect(withoutFlag.exitCode).not.toBe(0);

      // With --supersede-basis: commander sets opts.supersedeBasis = true -> written.
      const withFlag = lane(
        [
          "usage-import",
          "--intent",
          intentId,
          "--spec-dir",
          specDir,
          "--agent-cost-bin",
          binUnknown,
          "--supersede-basis",
        ],
        { cwd: repoDir, dataDir },
      );
      expect(withFlag.exitCode, withFlag.stderr).toBe(0);

      const state = readLaneState(specDir, intentId);
      expect(state.cost_ledger[0]?.accounting_basis).toBe("unknown");
      expect(state.cost_ledger[0]?.basis_history).toHaveLength(1);
    });

    it("calibrate --supersede-basis: absent refuses, present writes (opts.supersedeBasis)", () => {
      const intentId = "I-2026-09-14-cli-argv-calibrate";
      runStart(intentId, { specDir });

      const binV2 = writeFakeAgentCost(
        binDir,
        { "s-cli": { matched: true, tokens: 1000, costUsd: 0.5 } },
        { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" },
      );
      const baseline = lane(
        [
          "calibrate",
          intentId,
          "--session-id",
          "s-cli",
          "--spec-dir",
          specDir,
          "--agent-cost-bin",
          binV2,
        ],
        { cwd: repoDir, dataDir },
      );
      expect(baseline.exitCode, baseline.stderr).toBe(0);

      const binUnknownDir = mkdtempSync(join(tmpdir(), "lane-cli-argv-calibrate-bin2-"));
      const binUnknown = writeFakeAgentCost(binUnknownDir, {
        "s-cli": { matched: true, tokens: 1200, costUsd: 0.6 },
      });
      const withoutFlag = lane(
        [
          "calibrate",
          intentId,
          "--session-id",
          "s-cli",
          "--spec-dir",
          specDir,
          "--agent-cost-bin",
          binUnknown,
        ],
        { cwd: repoDir, dataDir },
      );
      expect(withoutFlag.exitCode).not.toBe(0);

      const withFlag = lane(
        [
          "calibrate",
          intentId,
          "--session-id",
          "s-cli",
          "--spec-dir",
          specDir,
          "--agent-cost-bin",
          binUnknown,
          "--supersede-basis",
        ],
        { cwd: repoDir, dataDir },
      );
      expect(withFlag.exitCode, withFlag.stderr).toBe(0);

      const state = readLaneState(specDir, intentId);
      const laneEntry = state.cost_ledger.find((e) => e.scope === "lane");
      expect(laneEntry?.accounting_basis).toBe("unknown");
      expect(laneEntry?.basis_history).toHaveLength(1);
    });

    it("estimate --reference-token-basis <basis>: absent records 'unknown', present records the declared value (opts.referenceTokenBasis)", () => {
      const intentId = "I-2026-09-14-cli-argv-estimate";
      runStart(intentId, { specDir });
      const profilePath = join(specDir, "test.profile.yaml");
      writeFileSync(
        profilePath,
        stringifyYaml({
          schema_version: "1.0",
          profile_id: "test",
          estimate: {
            cohort: {
              agent_type: "claude",
              model_provider: "anthropic",
              model_generation: "claude-5",
              model_id: "claude-sonnet-5",
              routing_policy_digest: "a".repeat(64),
              prompt_policy_digest: "b".repeat(64),
              execution_profile_digest: "c".repeat(64),
            },
          },
        }),
      );
      const referenceFlags = [
        "--reference-tokens-p50",
        "50000",
        "--reference-tokens-p80",
        "150000",
        "--reference-cost-p50",
        "1",
        "--reference-cost-p80",
        "4",
      ];

      const withoutFlag = lane(
        ["estimate", intentId, "--spec-dir", specDir, "--profile", profilePath, ...referenceFlags],
        { cwd: repoDir, dataDir },
      );
      expect(withoutFlag.exitCode, withoutFlag.stderr).toBe(0);

      const withFlag = lane(
        [
          "estimate",
          intentId,
          "--spec-dir",
          specDir,
          "--profile",
          profilePath,
          ...referenceFlags,
          "--reference-token-basis",
          CURRENT_BASIS,
        ],
        { cwd: repoDir, dataDir },
      );
      expect(withFlag.exitCode, withFlag.stderr).toBe(0);

      const estimate = readEstimateIfExists(specDir, intentId);
      expect(estimate?.revisions[0]?.token_basis).toBe("unknown");
      expect(estimate?.revisions[1]?.token_basis).toBe(CURRENT_BASIS);
    });
  },
);
