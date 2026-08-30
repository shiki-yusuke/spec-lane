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
  | "authorization_in_profile"
  | "authorization_store_inside_workspace"
  | "authorization_store_unresolvable"
  | "authorization_store_unreadable"
  | "intent_modified_during_verification"
  | "profile_modified_during_verification";

/** Every member of ExternalVerifyRefusal, as VALUES rather than only as a type.
 *
 * It exists so a test can walk the list -- spec.md's D7 table is normative, and it went stale
 * six times by being maintained from memory. A promise to grep harder failed each round; a
 * value the test can enumerate cannot. Adding a member to the union above without adding it
 * here is a type error, and adding it here without documenting it fails the test. */
export const EXTERNAL_VERIFY_REFUSALS = [
  "unauthorized",
  "recursion_blocked",
  "authorization_in_profile",
  "authorization_store_inside_workspace",
  "authorization_store_unresolvable",
  "authorization_store_unreadable",
  "intent_modified_during_verification",
  "profile_modified_during_verification",
] as const satisfies readonly ExternalVerifyRefusal[];

/**
 * Codes the GATE emits directly, which never travel through an ExternalVerifyOutcome.
 *
 * Separate list because the first version of the D7 coverage test walked only the two outcome
 * unions and therefore did not notice that `missing_result` -- added two commits earlier, and
 * the one code standing between a configured lane and an unverified transition -- was in
 * neither union nor in D7. A completeness check that is itself incomplete reports success, and
 * is worse than no check, because it stops anyone looking.
 */
export const EXTERNAL_VERIFY_GATE_ONLY_CODES = ["missing_result"] as const;

/**
 * Where authorization is allowed to come from, and why it is not the profile.
 *
 * Four designs were tried and broken in review, all by the same mistake -- deriving trust from
 * a path relationship the attacker also controls (the fourth, using resolveConfigDir(), is
 * below; two further rounds then broke the check that survived, see spec.md sections 13-14):
 *
 *   1. Digest over argv alone. A relative argument resolves against the child's directory, so an
 *      authorization matched a different repository's file of the same name.
 *   2. "The profile must be outside the working tree." lane's own source checkout, where the
 *      bundled default profile lives, is a *different* directory from the tree being worked on,
 *      so this passed and the exploit still fired.
 *   3. "Only the --profile / LANE_PROFILE_PATH tiers may authorize." Setting LANE_PROFILE_PATH
 *      per repository is a legitimate, intended way to select a project profile (`.envrc`, mise,
 *      npm scripts all do this), so it is not evidence an operator vetted anything. Worse,
 *      `--spec-dir` lets the intent come from one checkout while the process runs in another, so
 *      both keys can sit in a directory the attacker controls.
 *
 * No "outside X" rule can work: the attacker can put a file anywhere writable, so every such
 * rule is satisfiable. The only thing that helps is for lane to stop offering a pointer at all
 * and read authorization from a location it fixes itself: `~/.config/lane/external-verify.yaml`,
 * derived from `homedir()` alone. Note this deliberately does NOT go through
 * `resolveConfigDir()` -- that honors LANE_CONFIG_DIR/XDG_CONFIG_HOME, which is the
 * indirection design #4 was broken through.
 *
 * This is not an absolute boundary and should not be described as one. An environment that can
 * rewrite LANE_CONFIG_DIR/XDG_CONFIG_HOME/HOME can also rewrite PATH and replace the `lane`
 * binary outright, which no gate here can defend against. What changed is that lane no longer
 * ships a knob whose *purpose* is selecting the authorization file, and which repositories set
 * as a matter of course.
 */

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

/** Same reasoning as EXTERNAL_VERIFY_REFUSALS above. */
export const EXTERNAL_VERIFY_FAILURES = [
  "timeout",
  "output_limit_exceeded",
  "spawn_failed",
  "killed_by_signal",
  "nonzero_exit",
  "unknown_failure",
  "invalid_configuration",
] as const satisfies readonly ExternalVerifyFailure[];

export type ExternalVerifyPlan =
  | { kind: "skip" }
  | { kind: "refuse"; code: ExternalVerifyRefusal; commandDigest: string; detail?: string }
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
  /** `detail` carries the underlying reason when the refusal has one the operator needs (a
   * store parse error names the offending key). Absent for refusals whose code says it all. */
  | { kind: "refused"; code: ExternalVerifyRefusal; commandDigest: string; detail?: string }
  // `exitStatus: 0` literally: classifyExternalVerifyResult only reports ok for `status === 0`
  // with no error, so a passed outcome cannot carry anything else. Typing it as `number` let
  // advance.ts copy an arbitrary integer into the lane-state snapshot's exit_status, which the
  // schema now pins to 0 -- the type and the schema agree instead of one trusting the other.
  | { kind: "passed"; commandDigest: string; exitStatus: 0; finishedAt: string }
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
   * The digests the operator has authorized, read by the caller from
   * `~/.config/lane/external-verify.yaml` -- not from the profile, and not from anything a flag
   * or a repository-set lane variable can point at. `$HOME` itself still moves it; see the
   * design note above for what that does and does not buy.
   */
  authorizedDigests: readonly string[];
  /**
   * Absolute, symlink-resolved path of the authorization store, so it can be checked against the
   * directories below. `undefined` means the caller could not determine it, which refuses.
   */
  authorizationStorePath: string | undefined;
  /**
   * Set when the caller could not read the store at all, carrying the refusal code it decided
   * on and the underlying detail.
   *
   * It is passed in rather than refused at the adapter, so that ONE place decides refusal
   * order. Refusing where the read happens put the store ahead of the two checks that are
   * supposed to precede it: an unreadable store masked `recursion_blocked`, and -- the case
   * that matters -- it masked `authorization_in_profile`, whose entire purpose is to tell an
   * operator with a legacy profile which file to fix. A typo in one file hid the diagnosis
   * about a different file.
   */
  authorizationStoreFailure?: { code: ExternalVerifyRefusal; detail: string };
  /**
   * Absolute, symlink-resolved worktrees the authorization must NOT live inside: the directory
   * the command runs in, and the directory the intent came from. Those are two different places
   * -- `--spec-dir` lets a lane be driven from one checkout while the process runs in another,
   * which is precisely how the previous design was defeated.
   */
  workspaces: readonly string[];
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

  // Both checks below run BEFORE the digest comparison, so the diagnostic names the real
  // problem instead of reporting a mismatch the operator cannot interpret.

  // 1. Authorization used to live in the profile. It does not any more, and a profile still
  //    carrying it would otherwise fail as a plain "unauthorized", sending the operator to fix
  //    the wrong file. Say so explicitly instead.
  if (input.profile.external_verify !== undefined) {
    return { kind: "refuse", code: "authorization_in_profile", commandDigest };
  }

  // 2. The store could not be read. Checked here, AFTER recursion and the legacy-profile
  //    migration refusal, because both of those describe problems the operator can act on
  //    without the store being readable at all -- and the profile one names a different file.
  if (input.authorizationStoreFailure !== undefined) {
    return {
      kind: "refuse",
      code: input.authorizationStoreFailure.code,
      commandDigest,
      detail: input.authorizationStoreFailure.detail,
    };
  }

  // 3. The store must not RESOLVE to a path inside either worktree.
  //
  //    READ THIS BEFORE TREATING IT AS A SECURITY BOUNDARY: it is not one. It detects an
  //    operator's misconfiguration; it does not stop an adversary. Four rounds of review were
  //    spent trying to make it a boundary, and it was defeated every time. The reason it cannot
  //    work is structural, not a gap in the implementation:
  //
  //      - lane and the adversary run as the SAME UID. Every filesystem permission lane can
  //        observe is identical for both, so no stat() answers "who may write this file".
  //      - Answering "can this file be written from inside the gated tree" would require
  //        enumerating every name for the inode (a whole-filesystem scan) and every past write
  //        (nothing records that). A hard link created, written through, and removed leaves
  //        st_nlink back at 1 with the injected bytes still there -- reproduced.
  //      - The tree's own boundary is not authoritative either: `git rev-parse --show-toplevel`
  //        is decided by where a `.git` sits, and the adversary writes the worktree, so it can
  //        plant one in a subdirectory and shrink the answer -- reproduced.
  //
  //    What separates the operator's store from the adversary's reach is how the agent's
  //    sandbox is scoped -- and "writes confined to the worktree" is NOT the right statement of
  //    it. Under a path-prefix write filter, link(store, worktree/x) creates a name inside the
  //    worktree and writing through it targets a path inside the worktree; both are permitted
  //    and the store changes anyway. The property actually required is that no path the
  //    adversary can create resolves to the store's inode -- a mount/filesystem-view property.
  //    lane verifies none of it; spec.md L14 states it as an assumption instead of pretending
  //    to check it.
  //
  //    So what is this check still for? The honest, common misconfiguration: symlinking
  //    ~/.config into a dotfiles repository (stow, chezmoi) that then gets gated. Nobody is
  //    evading anything there -- the operator simply cannot see that their authorization file
  //    is now inside the tree being gated. Catching that is worth doing. Claiming it holds
  //    against someone who is trying is what kept being wrong.
  //    Two distinct failures, deliberately NOT one code. "I could not work out where this file
  //    is" and "this file is inside the tree being gated" call for different actions, and the
  //    overlap message names a specific cause (a dotfiles symlink) that is simply wrong for a
  //    dangling link or a permissions change. Sending an operator to move a store that is not
  //    misplaced is the same wrong-file misdiagnosis this feature keeps having to fix.
  if (input.authorizationStorePath === undefined) {
    return { kind: "refuse", code: "authorization_store_unresolvable", commandDigest };
  }
  if (input.workspaces.some((root) => isPathInside(root, input.authorizationStorePath as string))) {
    return { kind: "refuse", code: "authorization_store_inside_workspace", commandDigest };
  }

  if (!input.authorizedDigests.includes(commandDigest)) {
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
 * 2. ENOBUFS next. maxBuffer overflow arrives as `error.code: "ENOBUFS"` WITH a non-null
 *    `signal`, so it would otherwise be reported as a generic spawn failure or as
 *    killed_by_signal rather than "your command printed too much". (The signal is whatever
 *    `killSignal` is -- SIGTERM by Node's default, but SIGKILL under the runner, which sets it.
 *    Measured both ways; the ordering here does not depend on which.)
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
): { ok: true; exitStatus: 0 } | { ok: false; code: ExternalVerifyFailure; errno: string | null } {
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
/** Counted against EXTERNAL_VERIFY_OUTPUT_MAX_CHARS, not added on top of it. */
export const EXTERNAL_VERIFY_TRUNCATION_MARKER = "...(truncated)\n";

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
  // The marker is part of the budget, not an addition to it. Keeping MAX_CHARS of output and
  // THEN prepending the marker produced MAX_CHARS + marker.length -- 2015 for a stated bound of
  // 2000. Small, but the bound is the thing EARS-16 and the README promise, and a limit that
  // is only approximately the limit is not one.
  const budget = EXTERNAL_VERIFY_OUTPUT_MAX_CHARS - EXTERNAL_VERIFY_TRUNCATION_MARKER.length;
  if (truncated) {
    if (text.length > budget) text = text.slice(-budget);
  } else if (text.length > EXTERNAL_VERIFY_OUTPUT_MAX_CHARS) {
    text = text.slice(-budget);
    truncated = true;
  }
  return truncated ? `${EXTERNAL_VERIFY_TRUNCATION_MARKER}${text}` : text;
}
