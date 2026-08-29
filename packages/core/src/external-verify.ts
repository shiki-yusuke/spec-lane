import { isAbsolute, relative } from "node:path";
import type { ExternalVerifyCommand, Intent, Profile } from "@lane/schemas";
import { computeDigest } from "./digest.js";
import type { GateTrigger } from "./gate-trigger.js";

// I-2026-08-29-external-verify-gate (docs/spec/I-2026-08-29-external-verify-gate/spec.md).
//
// This module is the PURE half of the feature: given a lane's intent, the resolved profile,
// the trigger being evaluated, and a snapshot of the environment, it decides whether an
// external verification command should run, whether it is authorized to run, and exactly what
// argv/timeout to run -- but never runs anything itself. The impure half (the actual
// subprocess) lives behind ExternalVerifyRunner in packages/cli, so the decision logic stays
// unit-testable without spawning, and core keeps the same "IO happens at the boundary" shape
// GateArtifacts already uses for specDigest/design (spec.md D2).

/** Sentinel the runner sets on the child. Its mere PRESENCE in the parent environment means
 * lane is already running inside an external verify command, and a further spawn would
 * recurse. Checked for presence, never truthiness: an empty string or "0" is still evidence
 * that an ancestor set it (architect review 9-7). */
export const EXTERNAL_VERIFY_ACTIVE_ENV = "LANE_EXTERNAL_VERIFY_ACTIVE";

/** Every reason the gate can refuse without ever starting a process. Kept separate from the
 * post-run outcomes below because these are decidable purely, before any IO. */
export type ExternalVerifyRefusal =
  | "unauthorized"
  | "recursion_blocked"
  | "profile_not_explicit"
  | "profile_inside_workspace";

/**
 * The profile tiers whose authorization is honored. `resolveProfilePath` (core/profile.ts)
 * resolves flag > env > repo_local > package_default, and only the first two are things an
 * operator actually named.
 *
 * `package_default` is excluded because of where it physically lives. It is
 * `packages/cli/resources/profiles/generic.profile.yaml`, a tracked file in lane's own
 * repository -- so for anyone running lane from a source checkout (the `npm link` flow the
 * README documents for contributors, i.e. how a maintainer reviews a PR to lane), a pull
 * request can add a command to some lane's intent.yaml AND its authorizing digest to that
 * profile in the same commit, and it executes with no flag and no environment variable set.
 * Reproduced end to end. Excluding this tier costs nothing even when lane is installed
 * normally, since the shipped default deliberately carries no digests at all.
 *
 * `repo_local` (`profiles-local/`) is excluded for the same reason: it is inside the
 * repository being worked on, so it is not a second key either.
 */
const EXPLICITLY_CHOSEN_PROFILE_SOURCES = ["flag", "env"] as const;
export type ExternalVerifyProfileSource = "flag" | "env" | "repo_local" | "package_default";

/** Post-run classification. Order of evaluation is itself part of the contract -- see
 * classifyExternalVerifyResult. */
export type ExternalVerifyFailure =
  | "timeout"
  | "output_limit_exceeded"
  | "spawn_failed"
  | "killed_by_signal"
  | "nonzero_exit"
  | "unknown_failure"
  | "invalid_configuration";

export type ExternalVerifyPlan =
  | { kind: "skip" }
  | { kind: "refuse"; code: ExternalVerifyRefusal; commandDigest: string }
  | {
      kind: "run";
      argv: readonly string[];
      timeoutMs: number;
      commandDigest: string;
      /** The directory this command was authorized for, and the one the runner must use. It
       * travels on the plan rather than being supplied separately so the authorized cwd and the
       * executed cwd cannot drift apart -- relative arguments resolve against it, so a
       * mismatch would mean running a different file than the one authorized. */
      cwd: string;
    };

/** What the runner reports back, and what externalVerifyGate turns into diagnostics. */
export type ExternalVerifyOutcome =
  | { kind: "skipped" }
  | { kind: "refused"; code: ExternalVerifyRefusal; commandDigest: string }
  | { kind: "passed"; commandDigest: string; exitStatus: number; finishedAt: string }
  | {
      kind: "failed";
      code: ExternalVerifyFailure;
      commandDigest: string;
      /** errno (ENOENT/EACCES/...) when the failure came from a spawn error, else null.
       * Surfaced in the diagnostic so "the command is missing" is distinguishable from "the
       * command is not executable" without re-running anything. */
      errno: string | null;
      exitStatus: number | null;
      signal: string | null;
      /** Truncated tail of the child's combined output. NEVER redacted by lane (spec.md L7). */
      outputTail: string | null;
    };

/**
 * Digest over the WHOLE command -- argv, timeout, AND the working directory it will run in.
 *
 * argv rather than just `argv[0]`: authorizing by executable alone would authorize every
 * argument list for that executable, so allowing an interpreter once would allow it to run
 * anything forever (architect review 9-2). timeout is included so an authorized command cannot
 * be silently re-pointed at a much longer deadline.
 *
 * `cwd` is included because without it a digest binds a *string*, not a *file*. Only `argv[0]`
 * is required to be absolute; every later argument may be relative, and relative arguments are
 * resolved by the child against its working directory. An authorization for
 * `["/…/node", "scripts/verify.js"]` granted in a profile that lives outside any one checkout
 * -- which is exactly the arrangement that otherwise gives the strongest guarantee, and which
 * user-level profiles make the norm -- would then match in *any* repository that declares the
 * same two strings, and would run that repository's own `scripts/verify.js`. Reproduced against
 * a live checkout before this parameter existed: a second repo with its own script under the
 * same relative path executed and its lane advanced. Binding cwd makes an authorization mean
 * "this command, in this directory", so the same command in a different checkout is a different
 * digest and is refused until separately authorized.
 *
 * What this still does not bind is the *content* at that path (spec.md L1): editing the script
 * in place keeps the digest, by design -- that file is part of the reviewed working tree.
 */
export function computeExternalVerifyDigest(command: ExternalVerifyCommand, cwd: string): string {
  return `sha256:${computeDigest(
    JSON.stringify({ argv: command.argv, timeout_seconds: command.timeout_seconds, cwd }),
  )}`;
}

/** The one edge this feature gates. Deliberately NOT `before_pr_publish` as well (unlike
 * successCriteriaGate): `lane validate` evaluates both triggers in a single run, and matching
 * both would spawn the command twice per validate (spec.md D4). */
export function isExternalVerifyTrigger(trigger: GateTrigger): boolean {
  return (
    trigger.type === "phase_advance" && trigger.from === "3_implement" && trigger.to === "4_verify"
  );
}

export interface PlanExternalVerifyInput {
  intent: Intent;
  profile: Profile;
  trigger: GateTrigger;
  /** Caller-supplied so this stays pure; the CLI passes `process.env`. */
  env: Readonly<Record<string, string | undefined>>;
  /** The directory the command will run in. Both authorized (via the digest) and used as the
   * child's actual cwd -- the caller must pass the same value to the runner, or a command could
   * be authorized for one directory and executed in another. */
  cwd: string;
  /**
   * Absolute, symlink-resolved path of the profile that produced `profile`. Required, because
   * the two-key design is only worth anything when the two keys are in different hands: an
   * authorization that lives inside the very working tree the command runs from is not a second
   * key at all, since whoever can add the command can add its authorization in the same commit.
   * `undefined` is treated as "cannot establish where the authorization came from" and refuses,
   * rather than assuming the safe case.
   */
  profilePath: string | undefined;
  /**
   * Which tier of `resolveProfilePath` produced the profile. Only a tier the operator named
   * explicitly may authorize a command -- see EXPLICITLY_CHOSEN_PROFILE_SOURCES. `undefined`
   * means the caller could not say, which refuses rather than assuming the safe case.
   */
  profileSource: ExternalVerifyProfileSource | undefined;
}

/**
 * True when `candidate` is the same path as `root` or sits underneath it. Pure string work --
 * both arguments must already be absolute and symlink-resolved by the caller (the adapter),
 * because `/tmp/x` and `/private/tmp/x` are the same directory on macOS but different strings,
 * and a check that could be defeated by respelling a path would not be a check.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function planExternalVerify(input: PlanExternalVerifyInput): ExternalVerifyPlan {
  const command = input.intent.external_verify;
  if (!command) return { kind: "skip" };
  if (!isExternalVerifyTrigger(input.trigger)) return { kind: "skip" };

  const commandDigest = computeExternalVerifyDigest(command, input.cwd);

  // Presence, not truthiness (see EXTERNAL_VERIFY_ACTIVE_ENV). Checked before authorization
  // so a recursive invocation reports the recursion rather than an unrelated authorization
  // failure it would also have hit.
  if (Object.hasOwn(input.env, EXTERNAL_VERIFY_ACTIVE_ENV)) {
    return { kind: "refuse", code: "recursion_blocked", commandDigest };
  }

  // Both of the following run BEFORE the digest comparison, so the diagnostic names the real
  // problem (where the authorization came from) instead of reporting a digest mismatch.

  // 1. The authorization must come from a profile the operator actually named. Neither the
  //    package default nor profiles-local/ qualifies -- both sit inside a repository whose
  //    contents a pull request can change, which makes the "second key" the same key.
  if (
    input.profileSource === undefined ||
    !EXPLICITLY_CHOSEN_PROFILE_SOURCES.includes(
      input.profileSource as (typeof EXPLICITLY_CHOSEN_PROFILE_SOURCES)[number],
    )
  ) {
    return { kind: "refuse", code: "profile_not_explicit", commandDigest };
  }

  // 2. Even a named profile must not sit inside the tree the command runs in -- `--profile <id>`
  //    resolves through profiles-local/, and LANE_PROFILE_PATH accepts a relative path.
  if (input.profilePath === undefined || isPathInside(input.cwd, input.profilePath)) {
    return { kind: "refuse", code: "profile_inside_workspace", commandDigest };
  }

  const allowed = input.profile.external_verify?.allowed_command_digests ?? [];
  if (!allowed.includes(commandDigest)) {
    return { kind: "refuse", code: "unauthorized", commandDigest };
  }

  return {
    kind: "run",
    argv: command.argv,
    timeoutMs: command.timeout_seconds * 1000,
    commandDigest,
    cwd: input.cwd,
  };
}

/** The shape of `spawnSync`'s return this classifier needs, named so the runner and its fakes
 * agree without importing node:child_process into core. */
export interface ExternalVerifyRawResult {
  status: number | null;
  signal: string | null;
  error?: { code?: string } | undefined;
}

/**
 * Classification order IS the contract. Measured on Node v22.23.2 (spec.md §1.2):
 *
 * 1. ETIMEDOUT first. With the default killSignal a child that ignores SIGTERM returns
 *    `status: 0, signal: null, error.code: "ETIMEDOUT"` -- reading `status` first would
 *    classify a timeout as SUCCESS. This is the fail-open case this ordering exists to
 *    prevent, and the runner additionally passes killSignal "SIGKILL" so the deadline is
 *    actually enforced.
 * 2. ENOBUFS next. maxBuffer overflow arrives as `error.code: "ENOBUFS"` WITH
 *    `signal: "SIGTERM"`, so it would otherwise be reported as a generic spawn failure or as
 *    killed_by_signal rather than "your command printed too much".
 * 3. Any other `error` is a genuine spawn failure (ENOENT, EACCES, ...); the errno is kept.
 * 4. `status === null && signal !== null` is a real signal death. Checked before the
 *    `status !== 0` test because `null !== 0` is also true, which would report an exit code
 *    of `null`.
 * 5. A non-zero exit is the ordinary failure.
 * 6. Anything left that is not a clean zero exit is `unknown_failure` rather than silently
 *    passing -- fail-closed on a shape this classifier does not recognize.
 */
export function classifyExternalVerifyResult(
  result: ExternalVerifyRawResult,
):
  | { ok: true; exitStatus: number }
  | { ok: false; code: ExternalVerifyFailure; errno: string | null } {
  const errno = result.error?.code ?? null;
  if (errno === "ETIMEDOUT") return { ok: false, code: "timeout", errno };
  if (errno === "ENOBUFS") return { ok: false, code: "output_limit_exceeded", errno };
  if (result.error) return { ok: false, code: "spawn_failed", errno };
  if (result.status === null && result.signal !== null) {
    return { ok: false, code: "killed_by_signal", errno };
  }
  if (result.status === 0) return { ok: true, exitStatus: 0 };
  if (typeof result.status === "number") return { ok: false, code: "nonzero_exit", errno };
  return { ok: false, code: "unknown_failure", errno };
}

export const EXTERNAL_VERIFY_OUTPUT_MAX_LINES = 20;
export const EXTERNAL_VERIFY_OUTPUT_MAX_CHARS = 2000;

/** Tail of the child's output for the failure diagnostic. lane never inspects or redacts the
 * content (spec.md L7) -- it only bounds how much of it is echoed. */
export function truncateExternalVerifyOutput(output: string): string | null {
  const trimmed = output.trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split("\n");
  let truncated = false;
  let tail = lines;
  if (tail.length > EXTERNAL_VERIFY_OUTPUT_MAX_LINES) {
    tail = tail.slice(-EXTERNAL_VERIFY_OUTPUT_MAX_LINES);
    truncated = true;
  }
  let text = tail.join("\n");
  if (text.length > EXTERNAL_VERIFY_OUTPUT_MAX_CHARS) {
    text = text.slice(-EXTERNAL_VERIFY_OUTPUT_MAX_CHARS);
    truncated = true;
  }
  return truncated ? `...(truncated)\n${text}` : text;
}
