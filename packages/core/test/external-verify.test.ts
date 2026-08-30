import { type Intent, IntentSchema, type Profile, ProfileSchema } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  EXTERNAL_VERIFY_ACTIVE_ENV,
  EXTERNAL_VERIFY_OUTPUT_MAX_CHARS,
  EXTERNAL_VERIFY_OUTPUT_MAX_LINES,
  classifyExternalVerifyResult,
  computeExternalVerifyDigest,
  isExternalVerifyTrigger,
  isPathInside,
  planExternalVerify,
  truncateExternalVerifyOutput,
} from "../src/external-verify.js";
import { externalVerifyGate } from "../src/gate.js";
import type { GateTrigger } from "../src/gate.js";

// I-2026-08-29-external-verify-gate — the pure half. Nothing here spawns anything.

const ARGV: [string, ...string[]] = ["/usr/local/bin/verify", "--session-from-env"];
const CWD = "/repo/trusted";
// lane's own config dir: outside every workspace used below.
const STORE_PATH = "/home/dev/.config/lane/external-verify.yaml";

function intentWith(external_verify?: unknown): Intent {
  return IntentSchema.parse({
    schema_version: "1.0",
    intent_id: "I-2026-08-29-external-verify",
    intent: {
      business_goal: "Reduce onboarding time by clarifying setup docs.",
      user_visible_intent: "New users see setup steps in order.",
      success: ["ok"],
      primary_user: "new_developer",
      declared_risk: "low",
    },
    ai_inferred_scope: {
      affected_layers: ["docs"],
      confidence: "medium",
      allowed_paths: ["docs/**"],
    },
    ...(external_verify === undefined ? {} : { external_verify }),
  });
}

function profileWith(digests?: string[]): Profile {
  return ProfileSchema.parse({
    schema_version: "1.0",
    profile_id: "generic",
    ...(digests === undefined ? {} : { external_verify: { allowed_command_digests: digests } }),
  });
}

const ADVANCE_3_TO_4: GateTrigger = { type: "phase_advance", from: "3_implement", to: "4_verify" };

describe("isExternalVerifyTrigger: the 3_implement -> 4_verify edge only", () => {
  it("matches the 3_implement -> 4_verify phase_advance", () => {
    expect(isExternalVerifyTrigger(ADVANCE_3_TO_4)).toBe(true);
  });

  it("does not match before_pr_publish (TEST-25) -- validate evaluates two triggers per run, and matching both would spawn the command twice", () => {
    expect(isExternalVerifyTrigger({ type: "before_pr_publish", phase: "3_implement" })).toBe(
      false,
    );
  });

  it("does not match promotion (TEST-03) -- advance --phase 5_done re-runs nothing", () => {
    expect(isExternalVerifyTrigger({ type: "promotion" })).toBe(false);
  });

  it("does not match any other phase_advance edge", () => {
    expect(isExternalVerifyTrigger({ type: "phase_advance", from: "1_intent", to: "2_spec" })).toBe(
      false,
    );
    expect(isExternalVerifyTrigger({ type: "phase_advance", from: "4_verify", to: "5_done" })).toBe(
      false,
    );
  });
});

describe("planExternalVerify: opt-in", () => {
  it("skips entirely when the lane configured nothing (TEST-01)", () => {
    const plan = planExternalVerify({
      intent: intentWith(),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan).toEqual({ kind: "skip" });
  });

  it("skips on a non-matching trigger even when configured", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: profileWith(),
      trigger: { type: "promotion" },
      env: {},
      cwd: CWD,
      authorizedDigests: [],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("skip");
  });
});

describe("planExternalVerify: authorization is over the whole command, not the executable", () => {
  const authorizedDigest = computeExternalVerifyDigest({ argv: ARGV, timeout_seconds: 60 }, CWD);

  it("runs when the command's digest is authorized", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan).toEqual({
      kind: "run",
      argv: ARGV,
      timeoutMs: 60_000,
      commandDigest: authorizedDigest,
      cwd: CWD,
    });
  });

  it("refuses when nothing is authorized (TEST-08), and does not produce a run plan", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.code).toBe("unauthorized");
  });

  it("refuses when a single argument differs from the authorized command (TEST-09)", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: [...ARGV, "--extra"] }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("refuse");
  });

  it("refuses when only the timeout differs -- the deadline is part of what was authorized", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV, timeout_seconds: 600 }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("refuse");
  });

  it("TEST-44: refuses the same command in a different working directory -- an authorization is for a command IN A DIRECTORY, not a string", () => {
    // Regression for a reproduced authorization-reuse bug. Only argv[0] must be absolute, so a
    // later argument like "scripts/verify.js" resolves against the child's cwd. Before cwd was
    // part of the digest, an authorization granted in a profile outside any one checkout --
    // the very arrangement the docs recommend, and what user-level profiles make normal --
    // matched in ANY repository declaring the same strings, and ran that repository's own
    // script. Verified live at the time: a second repo's script executed and its lane advanced.
    const relative: [string, ...string[]] = ["/usr/bin/node", "scripts/verify.js"];
    const relativeDigests = [
      computeExternalVerifyDigest({ argv: relative, timeout_seconds: 60 }, "/repo/trusted"),
    ];

    const inAuthorizedDir = planExternalVerify({
      intent: intentWith({ argv: relative }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: "/repo/trusted",
      authorizedDigests: relativeDigests,
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(inAuthorizedDir.kind).toBe("run");

    const inAnotherCheckout = planExternalVerify({
      intent: intentWith({ argv: relative }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: "/repo/someone-elses",
      authorizedDigests: relativeDigests,
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(inAnotherCheckout.kind).toBe("refuse");
    if (inAnotherCheckout.kind === "refuse") expect(inAnotherCheckout.code).toBe("unauthorized");
  });

  it("TEST-46: a profile still carrying the old authorization field is refused, and says why", () => {
    // Authorization used to live in the profile. Leaving it there must not silently degrade to
    // a plain "unauthorized" that sends the operator to edit the wrong file.
    const legacyProfile = ProfileSchema.parse({
      schema_version: "1.0",
      profile_id: "generic",
      external_verify: { allowed_command_digests: [authorizedDigest] },
    });
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: legacyProfile,
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.code).toBe("authorization_in_profile");
  });

  it("TEST-47: the authorization store must not sit inside the tree the command runs in", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: `${CWD}/.config/lane/external-verify.yaml`,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.code).toBe("authorization_store_inside_workspace");
  });

  it("TEST-49: the store must not sit inside the SPEC DIRECTORY's tree either -- --spec-dir makes that a different place", () => {
    // This is the exploit the previous design missed. `--spec-dir` lets the intent come from
    // checkout A while the process runs somewhere else entirely, so checking only the process's
    // own working directory left A -- which the attacker controls -- unguarded. Reproduced end
    // to end at the time: an attacker-controlled command ran and the lane advanced.
    const attackerCheckout = "/repo/attacker";
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: `${attackerCheckout}/evil-store.yaml`,
      workspaces: [CWD, attackerCheckout],
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.code).toBe("authorization_store_inside_workspace");
  });

  it("TEST-50: refuses when the store path cannot be determined -- 'cannot tell' is not 'safe'", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: undefined,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("refuse");
    // Its own code, not the overlap one: "I cannot tell where this file is" and "this file is
    // inside the gated tree" need different actions, and the overlap message names a cause (a
    // dotfiles symlink) that is simply wrong here.
    if (plan.kind === "refuse") expect(plan.code).toBe("authorization_store_unresolvable");
  });

  it("TEST-48: isPathInside treats the directory itself and any depth beneath it as inside", () => {
    expect(isPathInside("/repo/trusted", "/repo/trusted")).toBe(true);
    expect(isPathInside("/repo/trusted", "/repo/trusted/a/b/c.yaml")).toBe(true);
    expect(isPathInside("/repo/trusted", "/repo/trusted-sibling/c.yaml")).toBe(false);
    expect(isPathInside("/repo/trusted", "/opt/profiles/c.yaml")).toBe(false);
    expect(isPathInside("/repo/trusted", "/repo/trusted/../escaped.yaml")).toBe(false);
  });

  it("TEST-45: the plan carries the cwd it was authorized for, so the runner cannot execute it somewhere else", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("run");
    if (plan.kind === "run") expect(plan.cwd).toBe(CWD);
  });

  it("does not let an authorized interpreter run arbitrary code (TEST-35)", () => {
    // The whole reason authorization is not an argv[0] allow-list: authorizing
    // `node verify.js` once must not authorize `node -e <anything>` forever.
    const authorizedScript: [string, ...string[]] = ["/usr/bin/node", "/repo/scripts/verify.js"];
    const scriptDigests = [
      computeExternalVerifyDigest({ argv: authorizedScript, timeout_seconds: 60 }, CWD),
    ];
    const plan = planExternalVerify({
      intent: intentWith({
        argv: ["/usr/bin/node", "-e", "require('child_process').exec('curl evil')"],
      }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: {},
      cwd: CWD,
      authorizedDigests: scriptDigests,
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.code).toBe("unauthorized");
  });
});

describe("planExternalVerify: recursion sentinel", () => {
  const authorizedDigest = computeExternalVerifyDigest({ argv: ARGV, timeout_seconds: 60 }, CWD);

  it("refuses when the sentinel is present, even for an authorized command (TEST-18)", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: { [EXTERNAL_VERIFY_ACTIVE_ENV]: "1" },
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.code).toBe("recursion_blocked");
  });

  it('keys on PRESENCE, not truthiness -- an empty value or "0" still means an ancestor set it (TEST-29)', () => {
    for (const value of ["", "0", "false"]) {
      const plan = planExternalVerify({
        intent: intentWith({ argv: ARGV }),
        profile: profileWith(),
        trigger: ADVANCE_3_TO_4,
        env: { [EXTERNAL_VERIFY_ACTIVE_ENV]: value },
        cwd: CWD,
        authorizedDigests: [authorizedDigest],
        authorizationStorePath: STORE_PATH,
        workspaces: [CWD],
      });
      expect(plan.kind, `value=${JSON.stringify(value)} must still block`).toBe("refuse");
      if (plan.kind === "refuse") expect(plan.code).toBe("recursion_blocked");
    }
  });

  it("reports recursion rather than authorization when both would apply", () => {
    const plan = planExternalVerify({
      intent: intentWith({ argv: ARGV }),
      profile: profileWith(),
      trigger: ADVANCE_3_TO_4,
      env: { [EXTERNAL_VERIFY_ACTIVE_ENV]: "1" },
      cwd: CWD,
      authorizedDigests: [authorizedDigest],
      authorizationStorePath: STORE_PATH,
      workspaces: [CWD],
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.code).toBe("recursion_blocked");
  });
});

describe("classifyExternalVerifyResult: the ORDER is the contract", () => {
  it("classifies a clean zero exit as success", () => {
    expect(classifyExternalVerifyResult({ status: 0, signal: null })).toEqual({
      ok: true,
      exitStatus: 0,
    });
  });

  it("classifies ETIMEDOUT as timeout EVEN WHEN status is 0 (TEST-20)", () => {
    // Measured on Node v22.23.2: with the default killSignal, a child that ignores SIGTERM
    // returns status 0 / signal null / error ETIMEDOUT after running to completion. Reading
    // `status` before `error` would report this timeout as SUCCESS -- the fail-open case this
    // ordering exists to prevent.
    expect(
      classifyExternalVerifyResult({ status: 0, signal: null, error: { code: "ETIMEDOUT" } }),
    ).toEqual({ ok: false, code: "timeout", errno: "ETIMEDOUT" });
  });

  it("classifies ETIMEDOUT as timeout, not killed_by_signal, when the child was SIGKILLed at the deadline", () => {
    expect(
      classifyExternalVerifyResult({
        status: null,
        signal: "SIGKILL",
        error: { code: "ETIMEDOUT" },
      }),
    ).toEqual({ ok: false, code: "timeout", errno: "ETIMEDOUT" });
  });

  it("classifies ENOBUFS as output_limit_exceeded, not spawn_failed or killed_by_signal (TEST-28)", () => {
    // Measured: maxBuffer overflow arrives as error ENOBUFS *with* signal SIGTERM.
    expect(
      classifyExternalVerifyResult({ status: null, signal: "SIGTERM", error: { code: "ENOBUFS" } }),
    ).toEqual({ ok: false, code: "output_limit_exceeded", errno: "ENOBUFS" });
  });

  it("classifies other spawn errors as spawn_failed and keeps the errno (TEST-07 / TEST-39)", () => {
    expect(
      classifyExternalVerifyResult({ status: null, signal: null, error: { code: "ENOENT" } }),
    ).toEqual({ ok: false, code: "spawn_failed", errno: "ENOENT" });
    expect(
      classifyExternalVerifyResult({ status: null, signal: null, error: { code: "EACCES" } }),
    ).toEqual({ ok: false, code: "spawn_failed", errno: "EACCES" });
  });

  it("classifies a signal death as killed_by_signal rather than reporting a null exit code (TEST-19)", () => {
    expect(classifyExternalVerifyResult({ status: null, signal: "SIGSEGV" })).toEqual({
      ok: false,
      code: "killed_by_signal",
      errno: null,
    });
  });

  it("classifies an ordinary non-zero exit as nonzero_exit (TEST-05)", () => {
    expect(classifyExternalVerifyResult({ status: 1, signal: null })).toEqual({
      ok: false,
      code: "nonzero_exit",
      errno: null,
    });
  });

  it("falls back to unknown_failure rather than passing an unrecognized shape", () => {
    expect(classifyExternalVerifyResult({ status: null, signal: null })).toEqual({
      ok: false,
      code: "unknown_failure",
      errno: null,
    });
  });
});

describe("truncateExternalVerifyOutput (TEST-22)", () => {
  it("never exceeds the stated character bound, marker included (TEST-61)", () => {
    // The marker used to be added AFTER slicing to the limit, so the result was
    // MAX_CHARS + marker.length -- 2015 for a bound EARS-16 and the README both state as 2000.
    // A limit that is only approximately the limit is not one, and anything downstream sizing a
    // buffer or a field from that number was being handed a value 15 bytes too small.
    for (const size of [5000, 2001, 2000, 1999]) {
      const out = truncateExternalVerifyOutput("x".repeat(size));
      expect(out).not.toBeNull();
      expect((out as string).length).toBeLessThanOrEqual(EXTERNAL_VERIFY_OUTPUT_MAX_CHARS);
    }
    // The line-count path prepends the same marker and must respect the same ceiling.
    const manyLines = Array.from({ length: 200 }, () => "y".repeat(60)).join("\n");
    const out = truncateExternalVerifyOutput(manyLines);
    expect((out as string).length).toBeLessThanOrEqual(EXTERNAL_VERIFY_OUTPUT_MAX_CHARS);
    expect(out).toContain("...(truncated)");
  });

  it("returns null for empty output", () => {
    expect(truncateExternalVerifyOutput("")).toBeNull();
    expect(truncateExternalVerifyOutput("   \n")).toBeNull();
  });

  it("passes short output through unchanged and unmarked", () => {
    expect(truncateExternalVerifyOutput("one\ntwo")).toBe("one\ntwo");
  });

  it("keeps only the tail beyond the line cap and says so", () => {
    const lines = Array.from(
      { length: EXTERNAL_VERIFY_OUTPUT_MAX_LINES + 5 },
      (_, i) => `line${i}`,
    );
    const result = truncateExternalVerifyOutput(lines.join("\n"));
    expect(result).toContain("...(truncated)");
    expect(result).toContain(`line${lines.length - 1}`);
    expect(result).not.toContain("line0\n");
  });

  it("caps total characters even when the line count is small", () => {
    const result = truncateExternalVerifyOutput("x".repeat(5000));
    expect(result).toContain("...(truncated)");
    expect((result ?? "").length).toBeLessThan(5000);
  });
});

describe("externalVerifyGate: an absent result is not evidence of an unconfigured lane", () => {
  const ADVANCE = ADVANCE_3_TO_4;

  const evaluateWith = (intent: unknown, externalVerify?: unknown) =>
    externalVerifyGate.evaluate({
      trigger: ADVANCE,
      state: {} as never,
      profile: {} as never,
      artifacts: { intent, ...(externalVerify === undefined ? {} : { externalVerify }) } as never,
    });

  it("TEST-67: a CONFIGURED lane with no result refuses, instead of passing on a missing answer", () => {
    // Removing the `skipped` variant did not close this. Absence read on its own says only "no
    // result was supplied", which is equally what a caller that never ran the verifier looks
    // like -- and for a lane that declares a command, treating that as success authorizes the
    // 3->4 edge with nothing behind it. Reproduced against the gate directly before fixing:
    // a configured intent with no artifact returned zero diagnostics.
    const diagnostics = evaluateWith({
      external_verify: { argv: ["/bin/sh", "-c", "echo x"], timeout_seconds: 60 },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("missing_result");
    expect(diagnostics[0]?.severity).toBe("error");
  });

  it("TEST-68: an UNCONFIGURED lane with no result still contributes nothing", () => {
    // The other half, and the reason absence cannot simply be an error: this is the ordinary
    // state of every lane that never opted in, and the feature's central promise is that it
    // changes nothing for them.
    expect(evaluateWith({})).toEqual([]);
  });
});
