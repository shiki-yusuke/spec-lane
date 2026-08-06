import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// M4 (team review, 2026-07-31): the `lane` subprocess below inherited this process's real
// environment with no override, so a successful run of the "unblocked once spec_consensus
// ..." test (which genuinely reaches `advance --phase 5_done`) wrote a real done-overlay
// entry into this dev machine's actual $LANE_DATA_DIR (~/.local/share/lane/done/) on every
// single test run -- not a one-off mistake, an ongoing leak every time this file ran.
// LANE_DATA_DIR (and LANE_CONFIG_DIR, for symmetry even though nothing here currently
// writes there) are pinned to a fresh temp dir for every `lane` subprocess call instead.

// design.md §9 checkpoint 2 (M1 Go/No-Go): "pnpm pack した CLI を空の temp repo に導入し、
// --profile 指定込みで start -> advance(Phase1〜4) -> 差し戻し -> 再突入 -> status/validate
// が通る (e2e)". Runs for real: packs all 4 workspace packages (a plain `pnpm pack` of just
// @lane/cli isn't installable standalone — its package.json depends on
// @lane/{schemas,core,adapters} by exact version, which don't exist on the npm registry),
// installs the tarballs into a genuinely separate npm project with plain `npm install`, and
// drives the installed `lane` binary as a subprocess — no workspace shortcuts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

let workDir: string;
let tarballDir: string;
let projectDir: string;
let laneBin: string;
let laneDataDir: string;
let laneConfigDir: string;

function pnpm(args: string[], cwd: string): string {
  return execFileSync("pnpm", args, { cwd, encoding: "utf-8" });
}

function lane(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const env = { ...process.env, LANE_DATA_DIR: laneDataDir, LANE_CONFIG_DIR: laneConfigDir };
  try {
    const stdout = execFileSync(laneBin, args, { cwd, encoding: "utf-8", env });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "lane-e2e-"));
  tarballDir = join(workDir, "tarballs");
  projectDir = join(workDir, "project");
  laneDataDir = join(workDir, "lane-data");
  laneConfigDir = join(workDir, "lane-config");
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(laneDataDir, { recursive: true });
  mkdirSync(laneConfigDir, { recursive: true });

  for (const pkg of ["schemas", "core", "adapters", "cli"]) {
    pnpm(["--filter", `@lane/${pkg}`, "pack", "--pack-destination", tarballDir], repoRoot);
  }
  const tarballs = ["lane-schemas", "lane-core", "lane-adapters", "lane-cli"].map((name) => {
    const files = readdirSync(tarballDir).filter((f: string) => f.startsWith(name));
    const file = files[0];
    if (files.length !== 1 || file === undefined) {
      throw new Error(`expected exactly 1 tarball for ${name}, found ${files.length}`);
    }
    return join(tarballDir, file);
  });

  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "lane-e2e-project", version: "0.0.0", private: true }),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", ...tarballs], {
    cwd: projectDir,
    encoding: "utf-8",
  });

  laneBin = join(projectDir, "node_modules", ".bin", "lane");
  if (!existsSync(laneBin))
    throw new Error(`lane binary not found at ${laneBin} after npm install`);

  mkdirSync(join(projectDir, "profiles-local"), { recursive: true });
  const genericProfile = readFileSync(join(repoRoot, "profiles", "generic.profile.yaml"), "utf-8");
  writeFileSync(
    join(projectDir, "profiles-local", "example.profile.yaml"),
    genericProfile.replace('profile_id: "generic"', 'profile_id: "example"'),
  );
}, 120_000);

afterAll(() => {
  // workDir is under the OS tmpdir; left in place for post-mortem inspection rather than
  // cleaned up eagerly (this is a test fixture directory, not user data).
});

describe("packed CLI installed into an empty project (e2e)", () => {
  const intentId = "I-2026-07-31-e2e-flow";

  it("start creates the lane at 1_intent", () => {
    const result = lane(["start", intentId], projectDir);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(projectDir, "docs", "spec", intentId, "intent.yaml"))).toBe(true);
    expect(existsSync(join(projectDir, "docs", "spec", intentId, "lane-state.json"))).toBe(true);
  });

  it("advances forward through 1_intent -> 2_spec -> 3_implement -> 4_verify", () => {
    for (const phase of ["2_spec", "3_implement", "4_verify"] as const) {
      const result = lane(["advance", intentId, "--phase", phase], projectDir);
      expect(result.exitCode, `advance to ${phase}: ${result.stderr}`).toBe(0);
    }
    const status = lane(["status", intentId], projectDir);
    expect(status.stdout).toContain("current_phase: 4_verify");
  });

  it("reworks back to 3_implement and re-enters 4_verify", () => {
    const rework = lane(["advance", intentId, "--phase", "3_implement"], projectDir);
    expect(rework.exitCode, rework.stderr).toBe(0);
    const reentry = lane(["advance", intentId, "--phase", "4_verify"], projectDir);
    expect(reentry.exitCode, reentry.stderr).toBe(0);

    const status = lane(["status", intentId], projectDir);
    expect(status.exitCode).toBe(0);
    // two separate 4_verify occurrences should both be recorded (design.md §3.6 window union)
    const occurrences = status.stdout.split("\n").filter((l) => l.trim().startsWith("- 4_verify:"));
    expect(occurrences.length).toBe(2);
    expect(status.stdout).toContain("current_phase: 4_verify");
  });

  it("rejects an invalid transition (e.g. skipping back to 1_intent from 4_verify)", () => {
    const result = lane(["advance", intentId, "--phase", "1_intent"], projectDir);
    expect(result.exitCode).toBe(2);
  });

  // Codex M1 review, must-1: advance --phase 5_done used to call createDoneOverlay
  // directly with no gate check at all. These three steps drive the *packed, installed*
  // CLI binary through the same "blocked -> still blocked -> unblocked" sequence to prove
  // the fix holds end to end, not just against the in-process command functions.
  const specDir = () => join(projectDir, "docs", "spec", intentId);

  it("must-1 (e2e): advance --phase 5_done is blocked when verification.yaml does not exist yet", () => {
    const result = lane(
      ["advance", intentId, "--phase", "5_done", "--merged-at", "2026-07-31T10:30:00+09:00"],
      projectDir,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/Gate failed/);
  });

  it("must-1 (e2e): still blocked once verification.yaml exists but has an unresolved deviation", async () => {
    // spec_digest/verification_digest must genuinely match the on-disk content — the gate
    // checks digest agreement *before* checking for pending deviations (gate.ts), so a
    // deliberately-wrong digest here would report "digest mismatch" and never exercise
    // the deviation check this test is actually about.
    const coreModuleUrl = pathToFileURL(
      join(projectDir, "node_modules", "@lane", "core", "dist", "index.js"),
    ).href;
    const { computeDigest, canonicalVerificationContent } = await import(coreModuleUrl);
    const specContent = "# Spec\n\nRule 1: does the thing.\n";
    writeFileSync(join(specDir(), "spec.md"), specContent);
    const verificationWithoutConsensus = {
      schema_version: "1.0",
      intent_id: intentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
    };
    writeFileSync(
      join(specDir(), "verification.yaml"),
      JSON.stringify({
        ...verificationWithoutConsensus,
        spec_consensus: {
          spec_ssot_ref: "spec.md",
          spec_digest: computeDigest(specContent),
          verification_digest: computeDigest(
            canonicalVerificationContent(verificationWithoutConsensus),
          ),
          deviations: [
            { spec_ref: "spec.md#1", actual: "differs", action: "fix", status: "pending" },
          ],
          reviewer_ack: null,
        },
      }),
    );
    const result = lane(
      ["advance", intentId, "--phase", "5_done", "--merged-at", "2026-07-31T10:30:00+09:00"],
      projectDir,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/unresolved deviation/);
  });

  it("must-1 (e2e): unblocked once spec_consensus has no pending deviations and a valid ack", async () => {
    // Reuse the installed CLI's own dependency (@lane/core) to compute genuinely correct
    // digests, the same way the real authoring flow (a future lane-spec skill) would.
    const coreModuleUrl = pathToFileURL(
      join(projectDir, "node_modules", "@lane", "core", "dist", "index.js"),
    ).href;
    const { computeDigest, canonicalVerificationContent } = await import(coreModuleUrl);
    const specContent = "# Spec\n\nRule 1: does the thing.\n";
    writeFileSync(join(specDir(), "spec.md"), specContent);
    const verificationWithoutConsensus = {
      schema_version: "1.0",
      intent_id: intentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
    };
    const specDigest = computeDigest(specContent);
    const verificationDigest = computeDigest(
      canonicalVerificationContent(verificationWithoutConsensus),
    );
    writeFileSync(
      join(specDir(), "verification.yaml"),
      JSON.stringify({
        ...verificationWithoutConsensus,
        spec_consensus: {
          spec_ssot_ref: "spec.md",
          spec_digest: specDigest,
          verification_digest: verificationDigest,
          deviations: [],
          reviewer_ack: {
            reviewer_kind: "self",
            reviewer_id: "tester",
            acked_at: "2026-07-31T09:00:00+09:00",
            spec_sha256: specDigest,
            verification_sha256: verificationDigest,
          },
        },
      }),
    );

    const result = lane(
      ["advance", intentId, "--phase", "5_done", "--merged-at", "2026-07-31T10:30:00+09:00"],
      projectDir,
    );
    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("validate passes with an explicit --profile, now that spec_consensus is satisfied", () => {
    const result = lane(["validate", intentId, "--profile", "example"], projectDir);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("valid");
  });

  it("start refuses to recreate an already-started lane", () => {
    const result = lane(["start", intentId], projectDir);
    expect(result.exitCode).toBe(2);
  });
});

// Gate-port review (2026-08-06), item 6 required acceptance test 5: both newly-ported
// gates (premise_evidence, success_criteria) actually fire through the packed, installed
// CLI binary, not just the in-process command functions (packages/cli/test/
// gate-port-acceptance.test.ts covers the same two gates in-process). Separate intent ids
// and their own describe block so this doesn't interleave with the sequential flow above.
describe("packed CLI: premise_evidence and success_criteria gates fire for real (e2e)", () => {
  function intentPath(intentId: string): string {
    return join(projectDir, "docs", "spec", intentId, "intent.yaml");
  }
  function verificationPath(intentId: string): string {
    return join(projectDir, "docs", "spec", intentId, "verification.yaml");
  }

  it("premise_evidence required:true + reproduced:false blocks 1_intent -> 2_spec", () => {
    const intentId = "I-2026-08-06-e2e-premise-evidence";
    expect(lane(["start", intentId], projectDir).exitCode).toBe(0);

    const intent = parseYaml(readFileSync(intentPath(intentId), "utf-8"));
    intent.premise_evidence = {
      required: true,
      method: "live",
      reproduced: false,
      evidence: "Attempted to reproduce locally but could not observe the reported behavior.",
    };
    writeFileSync(intentPath(intentId), stringifyYaml(intent));

    const result = lane(["advance", intentId, "--phase", "2_spec"], projectDir);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/Gate failed/);
    expect(result.stderr).toMatch(/premise_evidence/);

    const status = lane(["status", intentId], projectDir);
    expect(status.stdout).toContain("current_phase: 1_intent"); // blocked: never advanced
  });

  it("premise_evidence unrecorded is only a warning: the same lane advances once reproduced:true is recorded", () => {
    const intentId = "I-2026-08-06-e2e-premise-evidence-2";
    expect(lane(["start", intentId], projectDir).exitCode).toBe(0);

    // Unrecorded case: advances anyway (warning, not error).
    const withoutRecord = lane(["advance", intentId, "--phase", "2_spec"], projectDir);
    expect(withoutRecord.exitCode, withoutRecord.stderr).toBe(0);
    expect(withoutRecord.stdout).toMatch(/premise_evidence/);

    const status = lane(["status", intentId], projectDir);
    expect(status.stdout).toContain("current_phase: 2_spec");
  });

  it("success_criteria covered_by:none blocks 3_implement -> 4_verify, then a covered matrix unblocks it", () => {
    const intentId = "I-2026-08-06-e2e-success-criteria";
    expect(lane(["start", intentId], projectDir).exitCode).toBe(0);
    for (const phase of ["2_spec", "3_implement"] as const) {
      expect(lane(["advance", intentId, "--phase", phase], projectDir).exitCode).toBe(0);
    }

    const intent = parseYaml(readFileSync(intentPath(intentId), "utf-8"));
    const successLine = intent.intent.success[0] as string;

    writeFileSync(
      verificationPath(intentId),
      stringifyYaml({
        schema_version: "1.0",
        intent_id: intentId,
        test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
        success_criteria_matrix: [{ criterion: successLine, covered_by: "none", evidence: "n/a" }],
      }),
    );
    const blocked = lane(["advance", intentId, "--phase", "4_verify"], projectDir);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.stderr).toMatch(/Gate failed/);
    expect(blocked.stderr).toMatch(/covered_by=none/);

    writeFileSync(
      verificationPath(intentId),
      stringifyYaml({
        schema_version: "1.0",
        intent_id: intentId,
        test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
        success_criteria_matrix: [
          {
            criterion: successLine,
            covered_by: "test",
            evidence: "test.ts::covers-it",
            negation_test: "test.ts::negative-case",
          },
        ],
        cross_check_intent_vs_spec: {
          performed_at: "2026-08-06 (Phase 4)",
          finding: "No differences.",
        },
      }),
    );
    const unblocked = lane(["advance", intentId, "--phase", "4_verify"], projectDir);
    expect(unblocked.exitCode, unblocked.stderr).toBe(0);

    const status = lane(["status", intentId], projectDir);
    expect(status.stdout).toContain("current_phase: 4_verify");
  });
});

// design.md §5.5 verification table — "e2e: packed CLI, `lane emit-metrics --help`
// reachable, a real snapshot printed for a fixture lane."
describe("packed CLI: lane emit-metrics (e2e)", () => {
  it("--help is reachable through the packed binary", () => {
    const result = lane(["emit-metrics", "--help"], projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("emit-metrics");
  });

  it("prints a well-formed agent-metrics:v1 marker for a freshly-started lane (honest no_data snapshot)", () => {
    const intentId = "I-2026-08-07-e2e-emit-metrics";
    expect(lane(["start", intentId], projectDir).exitCode).toBe(0);

    const result = lane(
      ["emit-metrics", intentId, "--repository", "octo-org/spec-lane-demo"],
      projectDir,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/<!-- agent-metrics:v1 payload_b64=\S+ sha256=[0-9a-f]{64} -->/);

    const decoded = JSON.parse(
      Buffer.from((result.stdout.match(/payload_b64=(\S+)/)?.[1] ?? "").trim(), "base64").toString(
        "utf-8",
      ),
    );
    expect(decoded.protocol_version).toBe("agent-metrics/v1");
    expect(decoded.schema).toBe("token-usage/v1");
    expect(decoded.data.coverage.status).toBe("no_data");
  });
});
