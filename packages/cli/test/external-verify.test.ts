import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTERNAL_VERIFY_ACTIVE_ENV,
  type ExternalVerifyOutcome,
  computeExternalVerifyDigest,
} from "@lane/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runStart } from "../src/commands/start.js";
import { runValidate } from "../src/commands/validate.js";
import type { ExternalVerifyRunner } from "../src/external-verify-runner.js";
import { readExternalVerifyStore } from "../src/external-verify-store.js";
import { readIntent, writeIntent } from "../src/intent-store.js";
import { laneStatePath, readLaneState } from "../src/state-store.js";

/**
 * I-2026-08-29-external-verify-gate — CLI-level tests.
 *
 * The failure-classification cases below spawn REAL child processes rather than using a fake
 * runner. That is deliberate: the whole classification order exists because of measured
 * `spawnSync` behaviour that contradicts the obvious reading of its docs (a child ignoring
 * SIGTERM returns `status: 0` with `error.code: "ETIMEDOUT"` -- i.e. a timeout that looks like
 * success). A fake runner asserting our own beliefs about spawnSync would have happily passed
 * while the real thing failed open. Fakes are used only where the assertion is about how many
 * times we invoke the runner, which a real process cannot report as directly.
 */

const NODE = process.execPath; // absolute, as the schema requires of argv[0]

/**
 * A real file on disk standing in for the operator's authorization store, created once per run.
 *
 * It has to be real rather than an invented path: the adapter resolves an EXISTING store with
 * realpath and refuses when that fails, so a fixture pointing at a path nobody created would
 * exercise the failure branch instead of the ordinary one. This was not hypothetical -- a
 * fixture path of "/home/dev/..." made eight subprocess tests refuse before they ever spawned.
 */
const FIXTURE_STORE_PATH = (() => {
  const dir = mkdtempSync(join(tmpdir(), "lane-extverify-store-"));
  const path = join(dir, "external-verify.yaml");
  writeFileSync(path, "allowed_command_digests: []\n", "utf-8");
  return path;
})();

/**
 * The operator's authorization store, standing in for lane's config directory. Note it is NOT a
 * profile: authorization deliberately cannot be selected per invocation, so tests inject the
 * store directly rather than pointing --profile at something.
 */
function authorizingStore(argv: string[], timeoutSeconds = 60) {
  return {
    path: FIXTURE_STORE_PATH,
    digests: [
      computeExternalVerifyDigest({ argv, timeout_seconds: timeoutSeconds }, process.cwd()),
    ],
  };
}

const emptyStore = { path: FIXTURE_STORE_PATH, digests: [] as string[] };

/**
 * Fresh lane sitting at 3_implement, optionally with an external_verify configured.
 *
 * `timeout_seconds` is optional to callers but filled in here before it reaches `writeIntent`:
 * the schema's `.default(60)` makes it optional on *input* and required on *output*, and
 * `writeIntent` takes the output type. Spreading a caller's partial value straight through
 * therefore does not typecheck.
 */
function laneAt3(
  specDir: string,
  intentId: string,
  externalVerify?: { argv: string[]; timeout_seconds?: number },
): void {
  expect(runStart(intentId, { specDir }).exitCode).toBe(0);
  const started = readIntent(specDir, intentId);
  writeIntent(specDir, intentId, {
    ...started,
    premise_evidence: {
      required: true,
      method: "live",
      reproduced: true,
      evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
    },
    ...(externalVerify === undefined
      ? {}
      : {
          external_verify: {
            argv: externalVerify.argv,
            timeout_seconds: externalVerify.timeout_seconds ?? 60,
          },
        }),
  });
  expect(runAdvance(intentId, "2_spec", { specDir }).exitCode).toBe(0);
  expect(runAdvance(intentId, "3_implement", { specDir }).exitCode).toBe(0);
}

describe("external verify gate: real subprocess behaviour", () => {
  let specDir: string;
  let dataDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-extverify-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-extverify-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` would stringify to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  it("TEST-04/TEST-21: an authorized command exiting 0 lets the transition through and is recorded", () => {
    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-pass";
    laneAt3(specDir, intentId, { argv });

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { store: authorizingStore(argv) },
    });
    expect(result.exitCode).toBe(0);

    const state = readLaneState(specDir, intentId);
    expect(state.current_phase).toBe("4_verify");
    const snapshot = state.gate_snapshots?.external_verify;
    expect(snapshot?.command_digest).toBe(
      computeExternalVerifyDigest({ argv, timeout_seconds: 60 }, process.cwd()),
    );
    expect(snapshot?.exit_status).toBe(0);
    expect(snapshot?.recorded_at).toBeTruthy();
  });

  it("TEST-05/TEST-41: a non-zero exit refuses the transition and leaves lane-state.json byte-identical", () => {
    const argv = [NODE, "-e", "process.exit(3)"];
    const intentId = "I-2026-08-29-ev-fail";
    laneAt3(specDir, intentId, { argv });

    const before = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { store: authorizingStore(argv) },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("nonzero_exit");
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(before);
  });

  it("TEST-06/TEST-20: a child that ignores SIGTERM is classified as timeout (never as success) and is actually killed at the deadline", () => {
    // This covers the DEADLINE half only: without killSignal SIGKILL the child would run its
    // full 30s. It does NOT cover the fail-open classification half -- because SIGKILL is
    // passed, the real spawnSync returns status null here, so the `status === 0` path this
    // ordering exists to defeat is never reached. That path has exactly one guard in the
    // repository: the "classifies ETIMEDOUT as timeout EVEN WHEN status is 0" case in
    // packages/core/test/external-verify.test.ts. Don't delete it as redundant with this one.
    const argv = [NODE, "-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>{},30000);"];
    const intentId = "I-2026-08-29-ev-timeout";
    laneAt3(specDir, intentId, { argv, timeout_seconds: 1 });

    const startedAt = Date.now();
    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { store: authorizingStore(argv, 1) },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("timeout");
    expect(result.message).not.toContain("nonzero_exit");
    // Generously bounded, but far below the child's own 30s: proves the deadline was enforced.
    expect(elapsedMs).toBeLessThan(15_000);
    expect(readLaneState(specDir, intentId).current_phase).toBe("3_implement");
  }, 40_000);

  it("TEST-07: a missing executable is spawn_failed with its errno, and no exception escapes", () => {
    const argv = ["/no/such/lane-external-verify-binary"];
    const intentId = "I-2026-08-29-ev-enoent";
    laneAt3(specDir, intentId, { argv });

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { store: authorizingStore(argv) },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("spawn_failed");
    expect(result.message).toContain("ENOENT");
  });

  it("TEST-19: a signal death reports killed_by_signal rather than a null exit code", () => {
    const argv = [NODE, "-e", "process.kill(process.pid,'SIGKILL')"];
    const intentId = "I-2026-08-29-ev-signal";
    laneAt3(specDir, intentId, { argv });

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { store: authorizingStore(argv) },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("killed_by_signal");
    expect(result.message).toContain("SIGKILL");
    expect(result.message).not.toContain("exit_status=null");
  });

  it("TEST-28: output past maxBuffer is output_limit_exceeded, not spawn_failed or killed_by_signal", () => {
    const argv = [NODE, "-e", "process.stdout.write('x'.repeat(3*1024*1024))"];
    const intentId = "I-2026-08-29-ev-enobufs";
    laneAt3(specDir, intentId, { argv });

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { store: authorizingStore(argv) },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("output_limit_exceeded");
    expect(result.message).not.toContain("spawn_failed");
    expect(result.message).not.toContain("killed_by_signal");
  });

  it("TEST-43: the verdict comes from the exit status alone -- output saying FAIL does not fail the gate, and output saying PASS does not rescue a non-zero exit", () => {
    // The negation test for "lane knows nothing about any particular tool's output format".
    // If anything ever started parsing stdout, one of these two halves breaks.
    const noisyPass = [NODE, "-e", "console.log('FAIL: 3 checks failed'); process.exit(0)"];
    const quietFail = [NODE, "-e", "console.log('PASS: all good'); process.exit(1)"];

    const passId = "I-2026-08-29-ev-noisy-pass";
    laneAt3(specDir, passId, { argv: noisyPass });
    expect(
      runAdvance(passId, "4_verify", {
        specDir,
        externalVerify: { store: authorizingStore(noisyPass) },
      }).exitCode,
    ).toBe(0);

    const failId = "I-2026-08-29-ev-quiet-fail";
    laneAt3(specDir, failId, { argv: quietFail });
    const failed = runAdvance(failId, "4_verify", {
      specDir,
      externalVerify: { store: authorizingStore(quietFail) },
    });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.message).toContain("nonzero_exit");
  });

  it("TEST-10: a shell metacharacter is one literal argument, never syntax", () => {
    const canary = join(dataDir, "pwned");
    // If this were run through a shell, the `;` would start a second command and create the
    // canary. Passed as argv it is simply a string the child receives and echoes.
    const argv = [NODE, "-e", "process.exit(process.argv[1]===';' ? 0 : 9)", `; touch ${canary}`];
    const intentId = "I-2026-08-29-ev-metachar";
    laneAt3(specDir, intentId, { argv });

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { store: authorizingStore(argv) },
    });
    // The child exits 9 (its argv[1] is the whole "; touch ..." string, not ";"), which is
    // enough to prove no shell split it; what matters is the canary never appears.
    expect(result.exitCode).not.toBe(0);
    expect(() => readFileSync(canary, "utf-8")).toThrow();
  });

  it("TEST-11/TEST-26/TEST-27: lane's own LANE_* values and cwd reach the child, overriding any inherited ones", () => {
    const dump = join(dataDir, "env.json");
    const argv = [
      NODE,
      "-e",
      `require('fs').writeFileSync(process.argv[1], JSON.stringify({intent: process.env.LANE_INTENT_ID, from: process.env.LANE_PHASE_FROM, to: process.env.LANE_PHASE_TO, spec: process.env.LANE_SPEC_DIR, active: process.env.${EXTERNAL_VERIFY_ACTIVE_ENV}, cwd: process.cwd()}))`,
      dump,
    ];
    const intentId = "I-2026-08-29-ev-env";
    laneAt3(specDir, intentId, { argv });

    process.env.LANE_INTENT_ID = "STALE-VALUE-FROM-PARENT";
    try {
      const result = runAdvance(intentId, "4_verify", {
        specDir,
        externalVerify: { store: authorizingStore(argv) },
      });
      expect(result.exitCode).toBe(0);
    } finally {
      // biome-ignore lint/performance/noDelete: `= undefined` would stringify to "undefined"
      delete process.env.LANE_INTENT_ID;
    }

    const seen = JSON.parse(readFileSync(dump, "utf-8"));
    expect(seen.intent).toBe(intentId); // overridden, not inherited
    expect(seen.from).toBe("3_implement");
    expect(seen.to).toBe("4_verify");
    expect(seen.spec).toBe(specDir);
    expect(seen.active).toBe("1");
    expect(seen.cwd).toBe(process.cwd());
  });
});

describe("external verify gate: authorization and recursion (no process is started)", () => {
  let specDir: string;
  let dataDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-extverify-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-extverify-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` would stringify to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  /** Fails the test if it is ever asked to run anything. */
  const neverRuns: ExternalVerifyRunner = {
    run() {
      throw new Error("the runner must not be invoked for a refused command");
    },
  };

  it("TEST-08: a configured but unauthorized command is refused WITHOUT being run, and names the digest to authorize", () => {
    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-unauth";
    laneAt3(specDir, intentId, { argv });

    const before = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { runner: neverRuns, store: emptyStore },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("unauthorized");
    expect(result.message).toContain(
      computeExternalVerifyDigest({ argv, timeout_seconds: 60 }, process.cwd()),
    );
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(before);
  });

  it("TEST-52: a store that SYMLINKS into the gated tree is refused -- the dotfiles case the workspace check exists for", () => {
    // The configuration that makes this check load-bearing rather than decorative: an operator
    // symlinks ~/.config into a dotfiles repository (stow, chezmoi). If the repository being
    // gated is that one, anything able to edit the worktree can append its own digest to the
    // store WITHOUT any access to the home directory -- exactly the adversary this feature is
    // built against. Detecting it depends on realpath()ing the store before comparing; the
    // symlink's own path is outside the tree and would pass.
    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-symlinked-store";
    laneAt3(specDir, intentId, { argv });

    // The store physically lives inside the tree being gated...
    const realStore = join(specDir, "dotfiles-config", "external-verify.yaml");
    mkdirSync(join(specDir, "dotfiles-config"), { recursive: true });
    writeFileSync(realStore, "allowed_command_digests: []\n", "utf-8");
    // ...and is reached through a symlink that sits outside it.
    const linkDir = mkdtempSync(join(tmpdir(), "lane-extverify-home-"));
    const linkedStore = join(linkDir, "external-verify.yaml");
    symlinkSync(realStore, linkedStore);

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: {
        runner: neverRuns,
        // cwd is the gated tree; the store's *link* is outside it, its target is not.
        cwd: specDir,
        store: {
          path: linkedStore,
          digests: [computeExternalVerifyDigest({ argv, timeout_seconds: 60 }, specDir)],
        },
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("authorization_store_inside_workspace");
  });

  it("TEST-18/TEST-29: the recursion sentinel blocks even an authorized command, on presence alone", () => {
    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-recursion";
    laneAt3(specDir, intentId, { argv });

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      // An empty string, not "1": presence is the signal, not truthiness.
      externalVerify: {
        runner: neverRuns,
        store: authorizingStore(argv),
        env: { [EXTERNAL_VERIFY_ACTIVE_ENV]: "" },
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("recursion_blocked");
  });

  it("TEST-51: a lane with nothing configured never even reads the authorization store", () => {
    // The store is read from the filesystem and a malformed one throws (verified: a
    // type-violating allowed_command_digests raises ZodError). Reading it unconditionally would
    // make one operator's typo crash every lane command, including lanes that never opted in --
    // which is the opposite of "configuring nothing changes nothing". The throwing store here
    // stands in for that file; if it is ever touched, this test fails loudly.
    const intentId = "I-2026-08-29-ev-store-untouched";
    laneAt3(specDir, intentId);

    const explodingStore = {
      get path(): string {
        throw new Error("the authorization store must not be read for an unconfigured lane");
      },
      get digests(): string[] {
        throw new Error("the authorization store must not be read for an unconfigured lane");
      },
    };

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { runner: neverRuns, store: explodingStore },
    });
    expect(result.exitCode).toBe(0);
    expect(readLaneState(specDir, intentId).gate_snapshots?.external_verify).toBeUndefined();
  });

  it("TEST-53: an unconfigured lane does not read the REAL store file (TEST-51 cannot show this)", () => {
    // TEST-51 injects a store, and injection makes readExternalVerifyStore() unreachable
    // (`options.store ?? readExternalVerifyStore()`), so what it actually pins is "the injected
    // object's getters are not touched" -- not "the filesystem is not read". Moving the early
    // return one line down, past the store read, keeps TEST-51 green. Verified: it does.
    //
    // So this one swaps $HOME instead and drives the real read path. A malformed store there
    // throws ZodError; an unconfigured lane must advance anyway.
    const fakeHome = mkdtempSync(join(tmpdir(), "lane-extverify-realhome-"));
    mkdirSync(join(fakeHome, ".config", "lane"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".config", "lane", "external-verify.yaml"),
      "allowed_command_digests: not-a-list\n",
      "utf-8",
    );

    const intentId = "I-2026-08-29-ev-real-store-untouched";
    laneAt3(specDir, intentId);

    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // No `store` key: the real readExternalVerifyStore() is what runs.
      const result = runAdvance(intentId, "4_verify", {
        specDir,
        externalVerify: { runner: neverRuns },
      });
      expect(result.exitCode).toBe(0);
    } finally {
      if (previousHome === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = previousHome;
    }
  });

  it("TEST-55: the gated tree is the git repository, not the directory lane was launched from", () => {
    // Reproduced end to end: with `workspaces` built from cwd itself, running `lane advance`
    // from a SUBDIRECTORY of the repository holding the store made the same store, in the same
    // repo, go from refused to executed -- only the launch directory differed. The launch
    // directory is the operator's choice; the tree an adversary can write is the repository.
    //
    // The layout matters, and a first version of this test got it wrong: the store must sit
    // outside BOTH the spec directory and the launch directory while still being inside the
    // repository. With spec-dir at the repo root instead, the store stays inside a workspace
    // either way and the test passes even with the fix removed. This one is verified to fail
    // without it.
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "lane-extverify-repo-")));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot, stdio: "ignore" });
    const repoSpecDir = join(repoRoot, "docs", "spec");
    const launchDir = join(repoRoot, "sub");
    const storeInRepo = join(repoRoot, "dotfiles", "external-verify.yaml");
    mkdirSync(repoSpecDir, { recursive: true });
    mkdirSync(launchDir, { recursive: true });
    mkdirSync(join(repoRoot, "dotfiles"), { recursive: true });
    writeFileSync(storeInRepo, "allowed_command_digests: []\n", "utf-8");

    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-subdir-launch";
    laneAt3(repoSpecDir, intentId, { argv });

    const result = runAdvance(intentId, "4_verify", {
      specDir: repoSpecDir,
      externalVerify: {
        runner: neverRuns,
        cwd: launchDir,
        // Authorized for this exact launch directory -- the attacker knows where lane is run
        // from, so an unauthorized digest would prove nothing about the workspace check.
        store: {
          path: storeInRepo,
          digests: [
            computeExternalVerifyDigest({ argv, timeout_seconds: 60 }, realpathSync(launchDir)),
          ],
        },
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("authorization_store_inside_workspace");
  });

  it("TEST-40: a runner that THROWS refuses the transition instead of escaping the CLI", () => {
    // EARS-12 promises fail-closed. verification.yaml claimed this was covered by
    // intent.test.ts, which only proves schema-invalid input is rejected before the runner is
    // ever reached -- a different statement. Nothing exercised a throwing runner, and
    // resolveExternalVerify called runner.run() bare, so the exception went past the gate, past
    // advance, and out of the process. "Crashes before deciding" is not fail-closed.
    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-runner-throws";
    laneAt3(specDir, intentId, { argv });
    const phaseBefore = readLaneState(specDir, intentId).current_phase;

    const throwingRunner: ExternalVerifyRunner = {
      run() {
        throw new Error("runner exploded");
      },
    };

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { runner: throwingRunner, store: authorizingStore(argv) },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("invalid_configuration");
    expect(result.message).toContain("runner exploded");
    // Fail-closed means the transition does not happen and nothing is recorded as verified.
    const after = readLaneState(specDir, intentId);
    expect(after.current_phase).toBe(phaseBefore);
    expect(after.gate_snapshots?.external_verify).toBeUndefined();
  });

  it("TEST-57: a typo'd key in the store is an error, not a silent empty allow-list", () => {
    // zod strips unknown keys by default, so `allowed_command_digest` (no trailing s) parsed
    // cleanly into an empty list and the operator was told their command was `unauthorized` --
    // sent to add a digest that was already sitting in the file under a key nothing reads.
    // The store throws on malformed input precisely so a typo is not hidden behind the wrong
    // diagnosis; key-stripping was doing exactly that.
    const fakeHome = mkdtempSync(join(tmpdir(), "lane-extverify-typo-"));
    mkdirSync(join(fakeHome, ".config", "lane"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".config", "lane", "external-verify.yaml"),
      "allowed_command_digest:\n  - sha256:whatever\n",
      "utf-8",
    );
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(() => readExternalVerifyStore()).toThrow();
    } finally {
      if (previousHome === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = previousHome;
    }
  });

  it("TEST-58: an existing store whose real path cannot be resolved refuses, rather than being compared unresolved", () => {
    // core refuses when authorizationStorePath is undefined -- "I cannot tell where this file
    // is, so I will not reason about where it sits". That branch was unreachable in production:
    // the adapter resolved this path through a helper that returns the unresolved string on
    // failure, so the overlap check silently compared a path realpath had rejected. A store
    // that does not exist is a different case and must keep reporting `unauthorized` (TEST-59),
    // and this is NOT the overlap case either: an earlier revision of this test asserted
    // `authorization_store_inside_workspace` here, which pinned a misdiagnosis -- it would have
    // told an operator with a dangling symlink that their dotfiles setup overlaps the gated
    // repository and to move a store that is not misplaced.
    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-unresolvable-store";
    laneAt3(specDir, intentId, { argv });

    // A dangling symlink: present enough for the caller to have read it, unresolvable now.
    const dir = mkdtempSync(join(tmpdir(), "lane-extverify-dangling-"));
    const dangling = join(dir, "external-verify.yaml");
    symlinkSync(join(dir, "no-such-target.yaml"), dangling);

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: {
        runner: neverRuns,
        store: {
          path: dangling,
          exists: true,
          digests: [computeExternalVerifyDigest({ argv, timeout_seconds: 60 }, process.cwd())],
        },
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("authorization_store_unresolvable");
    expect(result.message).not.toContain("authorization_store_inside_workspace");
  });

  it("TEST-59: a store that does not exist still reports unauthorized, naming the digest to add", () => {
    // The ordinary state for anyone who has not enabled the feature. Refusing here instead
    // would replace the one message that tells an operator what to do with a complaint about a
    // file they have not created.
    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-absent-store";
    laneAt3(specDir, intentId, { argv });

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: {
        runner: neverRuns,
        store: {
          path: join(tmpdir(), "definitely-not-created", "external-verify.yaml"),
          exists: false,
          digests: [],
        },
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("unauthorized");
    expect(result.message).toContain("sha256:");
  });

  it("TEST-60: a malformed store refuses with a diagnostic, instead of crashing out of the CLI", () => {
    // TEST-57 asserts readExternalVerifyStore() throws. That is the right behaviour, but on its
    // own it pinned only half the story: nothing on the call path caught the throw, so in a real
    // `lane advance` it flew past the gate, past advance, and out of main as a raw ZodError dump
    // with exit 2. The operator saw a JSON issues array, never the gate's diagnostic.
    //
    // That is the same "crash before deciding" shape the throwing-runner fix (TEST-40) closed,
    // and the strict() change had just widened it -- in the same commit that declared the shape
    // unacceptable. This test drives the real read path so the two cannot drift apart again.
    const fakeHome = mkdtempSync(join(tmpdir(), "lane-extverify-malformed-"));
    mkdirSync(join(fakeHome, ".config", "lane"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".config", "lane", "external-verify.yaml"),
      "allowed_command_digest:\n  - sha256:whatever\n",
      "utf-8",
    );

    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-malformed-store";
    laneAt3(specDir, intentId, { argv });
    const phaseBefore = readLaneState(specDir, intentId).current_phase;

    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let result: ReturnType<typeof runAdvance>;
    try {
      // No injected store: the real readExternalVerifyStore() is what throws here.
      result = runAdvance(intentId, "4_verify", { specDir, externalVerify: { runner: neverRuns } });
    } finally {
      if (previousHome === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = previousHome;
    }

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("authorization_store_unreadable");
    // The point of refusing instead of reading it as empty: say which key is wrong.
    expect(result.message).toContain("allowed_command_digests");
    expect(readLaneState(specDir, intentId).current_phase).toBe(phaseBefore);
  });

  it("TEST-62: a store that exists but cannot be read is refused, not treated as authorizing nothing", () => {
    // The catch around readFileSync was blanket, so EACCES/EISDIR and every other read failure
    // came back as `{ digests: [], exists: false }` -- indistinguishable from "no store yet".
    // An operator whose store is present and full of valid digests, but unreadable, was told
    // their command was `unauthorized` and would go add a digest already in the file. Only
    // ENOENT means absent.
    const fakeHome = mkdtempSync(join(tmpdir(), "lane-extverify-unreadable-"));
    mkdirSync(join(fakeHome, ".config", "lane"), { recursive: true });
    // A directory where the file should be: EISDIR on read, and it cannot be chmod-ed away by
    // the owner the way a 000 file can on some platforms.
    mkdirSync(join(fakeHome, ".config", "lane", "external-verify.yaml"));

    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-unreadable-store";
    laneAt3(specDir, intentId, { argv });
    const phaseBefore = readLaneState(specDir, intentId).current_phase;

    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let result: ReturnType<typeof runAdvance>;
    try {
      result = runAdvance(intentId, "4_verify", { specDir, externalVerify: { runner: neverRuns } });
    } finally {
      if (previousHome === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = previousHome;
    }

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("authorization_store_unreadable");
    // The refusal code, not the digest-mismatch one. Asserted on the code rather than on the
    // absence of the word "unauthorized", which appears legitimately inside this diagnostic's
    // own explanation of why it is not that.
    expect(result.message).not.toContain("(unauthorized)");
    expect(result.message).toContain("EISDIR");
    expect(readLaneState(specDir, intentId).current_phase).toBe(phaseBefore);
  });

  it("TEST-63: a DANGLING store symlink is unresolvable, not absent -- through the real read path", () => {
    // readFileSync reports ENOENT for a dangling symlink exactly as it does for a pathname that
    // does not exist, so keying "absent" off ENOENT alone reported a broken link as "no store"
    // and the operator got an `unauthorized` message about a digest. lstat is what separates
    // them: it succeeds on the link itself.
    //
    // TEST-58 cannot show this. It injects `exists: true`, which is the decision under test --
    // so it exercises core's handling and never touches the production read that has to make
    // that call. This one swaps $HOME and lets the real readExternalVerifyStore decide.
    const fakeHome = mkdtempSync(join(tmpdir(), "lane-extverify-dangling-home-"));
    mkdirSync(join(fakeHome, ".config", "lane"), { recursive: true });
    symlinkSync(
      join(fakeHome, ".config", "lane", "no-such-target.yaml"),
      join(fakeHome, ".config", "lane", "external-verify.yaml"),
    );

    const argv = [NODE, "-e", "process.exit(0)"];
    const intentId = "I-2026-08-29-ev-dangling-real";
    laneAt3(specDir, intentId, { argv });

    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let result: ReturnType<typeof runAdvance>;
    try {
      result = runAdvance(intentId, "4_verify", { specDir, externalVerify: { runner: neverRuns } });
    } finally {
      if (previousHome === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = previousHome;
    }

    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("authorization_store_unresolvable");
  });

  it("TEST-01/TEST-23: a lane with nothing configured never invokes the runner and records no snapshot", () => {
    const intentId = "I-2026-08-29-ev-unconfigured";
    laneAt3(specDir, intentId);

    const result = runAdvance(intentId, "4_verify", {
      specDir,
      externalVerify: { runner: neverRuns, store: emptyStore },
    });

    expect(result.exitCode).toBe(0);
    expect(result.message).not.toContain("external_verify");
    expect(readLaneState(specDir, intentId).gate_snapshots?.external_verify).toBeUndefined();
  });
});

describe("external verify gate: scaffolded intent.yaml guide comment", () => {
  let specDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-extverify-spec-"));
  });

  it("TEST-17: `lane start` scaffolds a commented external_verify example that still parses", () => {
    // The guide exists because an absent key is exactly what "not configured" looks like, so
    // without an inline example the feature is undiscoverable. The risk it introduces is a
    // malformed YAML comment block -- this repo has already shipped a guide comment whose
    // `RESOLVED (date):` colon made YAML read it as a mapping key and stop parsing.
    const intentId = "I-2026-08-29-ev-template";
    expect(runStart(intentId, { specDir }).exitCode).toBe(0);

    const raw = readFileSync(join(specDir, intentId, "intent.yaml"), "utf-8");
    expect(raw).toContain("# external_verify:");
    expect(raw).toContain("allowed_command_digests");

    // Parses, and the commented block is genuinely inert (not accidentally real config).
    const parsed = readIntent(specDir, intentId);
    expect(parsed.external_verify).toBeUndefined();
  });

  it("drops the guide once the field is actually configured", () => {
    const intentId = "I-2026-08-29-ev-template-configured";
    expect(runStart(intentId, { specDir }).exitCode).toBe(0);
    const started = readIntent(specDir, intentId);
    writeIntent(specDir, intentId, {
      ...started,
      external_verify: { argv: [NODE, "-e", "process.exit(0)"], timeout_seconds: 60 },
    });

    const raw = readFileSync(join(specDir, intentId, "intent.yaml"), "utf-8");
    expect(raw).not.toContain("# external_verify:");
    expect(readIntent(specDir, intentId).external_verify?.argv[0]).toBe(NODE);
  });
});

describe("external verify gate: invocation count and snapshot lifecycle", () => {
  let specDir: string;
  let dataDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-extverify-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-extverify-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` would stringify to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  function countingRunner(): { runner: ExternalVerifyRunner; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      runner: {
        run(plan): ExternalVerifyOutcome {
          calls += 1;
          return {
            kind: "passed",
            commandDigest: plan.commandDigest,
            exitStatus: 0,
            finishedAt: "2026-08-29T12:34:56.000Z",
          };
        },
      },
    };
  }

  const argv = [NODE, "-e", "process.exit(0)"];

  it("TEST-24/TEST-31: one `lane validate` runs the command exactly once and writes no snapshot", () => {
    const intentId = "I-2026-08-29-ev-validate-once";
    laneAt3(specDir, intentId, { argv });
    const { runner, calls } = countingRunner();

    const phaseBefore = readLaneState(specDir, intentId).current_phase;
    runValidate(intentId, {
      specDir,
      externalVerify: { runner, store: authorizingStore(argv) },
    });

    // `validate` evaluates two triggers (phase_advance 3->4 and before_pr_publish@3_implement)
    // in a single call; matching both would spawn the command twice.
    expect(calls()).toBe(1);

    // NOT a byte-for-byte assertion: validate deliberately appends one effective_risk_log entry
    // per call (see its own "persisted unconditionally" note), so the file always changes. What
    // must not happen is validate recording a *gate snapshot* -- only a real transition does.
    const after = readLaneState(specDir, intentId);
    expect(after.gate_snapshots?.external_verify).toBeUndefined();
    expect(after.current_phase).toBe(phaseBefore);
  });

  it("TEST-56: `lane validate` reads the authorization store once, not once per trigger", () => {
    // The adapter guard is two conditions (`!external_verify || !isExternalVerifyTrigger`), and
    // only the first was pinned: dropping the trigger half left every test green, because core
    // still returns "skip" for the other trigger and the spawn count is unchanged. What does
    // change is that the store gets read for a trigger that can never use it -- so counting
    // reads is what distinguishes them. Verified to fail with the trigger half removed.
    const intentId = "I-2026-08-29-ev-store-read-once";
    laneAt3(specDir, intentId, { argv });
    const { runner } = countingRunner();

    let reads = 0;
    const authorized = authorizingStore(argv);
    const countingStore = {
      path: authorized.path,
      get digests(): readonly string[] {
        reads += 1;
        return authorized.digests;
      },
    };

    runValidate(intentId, { specDir, externalVerify: { runner, store: countingStore } });
    expect(reads).toBe(1);
  });

  it("TEST-42: the snapshot records the runner's own completion time, not the timestamp taken before the gates ran", () => {
    const intentId = "I-2026-08-29-ev-snapshot-time";
    laneAt3(specDir, intentId, { argv });
    const { runner } = countingRunner();

    expect(
      runAdvance(intentId, "4_verify", {
        specDir,
        externalVerify: { runner, store: authorizingStore(argv) },
      }).exitCode,
    ).toBe(0);

    const state = readLaneState(specDir, intentId);
    expect(state.gate_snapshots?.external_verify?.recorded_at).toBe("2026-08-29T12:34:56.000Z");
    // Distinct from the transition's own timestamp, which is taken before the gates run.
    expect(state.gate_snapshots?.external_verify?.recorded_at).not.toBe(state.updated_at);
  });

  it("TEST-30: reworking back to 3_implement and dropping the configuration deletes the stale record", () => {
    const intentId = "I-2026-08-29-ev-rework";
    laneAt3(specDir, intentId, { argv });
    const { runner } = countingRunner();
    const authorizing = { store: authorizingStore(argv) };

    expect(
      runAdvance(intentId, "4_verify", {
        specDir,
        externalVerify: { runner, ...authorizing },
      }).exitCode,
    ).toBe(0);
    expect(readLaneState(specDir, intentId).gate_snapshots?.external_verify).toBeDefined();

    // Rework, then remove the external verification entirely.
    expect(
      runAdvance(intentId, "3_implement", { specDir, externalVerify: authorizing }).exitCode,
    ).toBe(0);
    const withCommand = readIntent(specDir, intentId);
    const { external_verify: _removed, ...withoutCommand } = withCommand;
    writeIntent(specDir, intentId, withoutCommand);

    expect(
      runAdvance(intentId, "4_verify", { specDir, externalVerify: authorizing }).exitCode,
    ).toBe(0);

    // Left in place, this stale record would make "not verified this time" look like "verified".
    expect(readLaneState(specDir, intentId).gate_snapshots?.external_verify).toBeUndefined();
  });
});
