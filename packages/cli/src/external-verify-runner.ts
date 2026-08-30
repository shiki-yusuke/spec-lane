import { spawnSync } from "node:child_process";
import {
  EXTERNAL_VERIFY_ACTIVE_ENV,
  type ExternalVerifyOutcome,
  type ExternalVerifyPlan,
  classifyExternalVerifyResult,
  truncateExternalVerifyOutput,
} from "@lane/core";

// I-2026-08-29-external-verify-gate — the impure half. core/external-verify.ts decides what
// (if anything) to run; this actually runs it. Kept behind an injectable interface so gate
// evaluation can be tested without spawning, and so the one place in this feature that touches
// the process table is a single named boundary (spec.md D2).

export interface ExternalVerifyRunnerContext {
  intentId: string;
  phaseFrom: string;
  phaseTo: string;
  specDir: string;
  // NOTE: no `cwd` here on purpose. The working directory is part of what was authorized
  // (it is inside the digest), so it travels on the plan (`plan.cwd`) -- a separate
  // context field would be a second source of truth that could disagree with the digest, i.e.
  // a command authorized for one directory executed in another.
}

export interface ExternalVerifyRunner {
  run(
    plan: Extract<ExternalVerifyPlan, { kind: "run" }>,
    ctx: ExternalVerifyRunnerContext,
  ): ExternalVerifyOutcome;
}

/** 1 MiB. Explicit rather than left to Node's default so the ENOBUFS branch has a defined,
 * documented threshold instead of an implementation detail that could change under us. */
export const EXTERNAL_VERIFY_MAX_BUFFER = 1024 * 1024;

/**
 * Environment handed to the child: the parent's, plus lane's own context. Every LANE_* key is
 * OVERWRITTEN, never merged -- if the parent already had LANE_INTENT_ID from some unrelated
 * tooling, the child must still see the intent lane is actually gating (spec.md D5 / TEST-26).
 *
 * EXTERNAL_VERIFY_ACTIVE_ENV is what makes a nested `lane advance`/`lane validate` inside the
 * verify command refuse to spawn again (core's planExternalVerify). It stops accidental
 * recursion by a cooperative verifier; it is not a boundary against a child that deliberately
 * strips it before spawning a grandchild (spec.md L8).
 */
function childEnv(ctx: ExternalVerifyRunnerContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LANE_INTENT_ID: ctx.intentId,
    LANE_PHASE_FROM: ctx.phaseFrom,
    LANE_PHASE_TO: ctx.phaseTo,
    LANE_SPEC_DIR: ctx.specDir,
    [EXTERNAL_VERIFY_ACTIVE_ENV]: "1",
  };
}

export const defaultExternalVerifyRunner: ExternalVerifyRunner = {
  run(plan, ctx) {
    const [executable, ...args] = plan.argv;
    // Unreachable through a schema-validated Intent (argv has min length 1), but the runner
    // must not depend on its caller having validated: spawnSync THROWS on an empty executable.
    if (executable === undefined) {
      return {
        kind: "failed",
        code: "invalid_configuration",
        commandDigest: plan.commandDigest,
        errno: null,
        exitStatus: null,
        signal: null,
        outputTail: "external_verify.argv is empty",
      };
    }

    // spawnSync blocks the event loop for up to timeoutMs with no way to stream the child's
    // output (it is only available after exit), so without this line the CLI looks hung.
    process.stderr.write(
      `[external_verify] running ${executable} (timeout ${Math.round(plan.timeoutMs / 1000)}s)...\n`,
    );

    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(executable, args, {
        // From the plan, never from the context: this is the directory the digest authorized,
        // and relative arguments resolve against it.
        cwd: plan.cwd,
        env: childEnv(ctx),
        timeout: plan.timeoutMs,
        // MEASURED, NOT ASSUMED (Node v22.23.2, spec.md §1.2): with the default SIGTERM, a
        // child that ignores it is NOT killed at the deadline -- spawnSync waits for its
        // natural exit (5033ms observed for a 300ms timeout) and returns status 0 with
        // error.code ETIMEDOUT. SIGKILL is what actually bounds the wait (303ms observed).
        killSignal: "SIGKILL",
        maxBuffer: EXTERNAL_VERIFY_MAX_BUFFER,
        encoding: "utf-8",
        // Never a shell: argv elements reach the child verbatim, so a metacharacter in an
        // argument is an argument, not syntax (same rule as wrapper-bind.ts).
        shell: false,
      });
    } catch (error) {
      // spawnSync throws synchronously for a NUL inside argv or an out-of-range timeout
      // (ERR_INVALID_ARG_VALUE / ERR_OUT_OF_RANGE). The schema rejects both first; this is the
      // second line of defence so a throw can never escape gate evaluation.
      return {
        kind: "failed",
        code: "invalid_configuration",
        commandDigest: plan.commandDigest,
        errno: (error as NodeJS.ErrnoException).code ?? null,
        exitStatus: null,
        signal: null,
        outputTail: truncateExternalVerifyOutput(String((error as Error).message ?? "")),
      };
    }

    const finishedAt = new Date().toISOString();
    const classified = classifyExternalVerifyResult({
      status: result.status,
      signal: result.signal,
      error: result.error as { code?: string } | undefined,
    });

    if (classified.ok) {
      return {
        kind: "passed",
        commandDigest: plan.commandDigest,
        exitStatus: classified.exitStatus,
        finishedAt,
      };
    }

    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return {
      kind: "failed",
      code: classified.code,
      commandDigest: plan.commandDigest,
      errno: classified.errno,
      exitStatus: result.status,
      signal: result.signal,
      outputTail: truncateExternalVerifyOutput(combined),
    };
  },
};
