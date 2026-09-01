import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_GATES,
  type Diagnostic,
  type ExternalVerifyOutcome,
  type ExternalVerifyRefusal,
  type GateContext,
  type GateEvaluation,
  type GateTrigger,
  canonicalVerificationContent,
  computeDigest,
  computeExternalVerifyDigest,
  evaluateGates,
  isExternalVerifyTrigger,
  loadProfile,
  planExternalVerify,
  truncateExternalVerifyOutput,
} from "@lane/core";
import type { Intent, LaneState, Profile } from "@lane/schemas";
import { readCriticIfExists } from "./critic-store.js";
import { readDesignAttestation } from "./design-attestation-store.js";
import { readActiveDesignOptionsIfExists } from "./design-options-store.js";
import {
  type ExternalVerifyRunner,
  defaultExternalVerifyRunner,
} from "./external-verify-runner.js";
import { readExternalVerifyStore } from "./external-verify-store.js";
import { gitWorktreeRootChain } from "./git-info.js";
import { readIntent } from "./intent-store.js";

import { readSpecMdIfExists } from "./spec-store.js";
import { readVerificationIfExists } from "./verification-store.js";

/**
 * Shared by validate.ts and advance.ts (gate-port review, 2026-08-06: both now evaluate
 * gates on every transition/checkpoint, not just 5_done/before_pr_publish, so both need
 * the same artifact-reading + digest-computation logic — reading verification.yaml/
 * critic.yaml fresh from disk and computing spec.md/verification.yaml digests right here,
 * so a gate always checks the *current* on-disk content against whatever digest is
 * recorded in verification.yaml's spec_consensus, not a value someone forgot to refresh).
 *
 * `readCriticIfExists` throws (schema error) if critic.yaml exists but is malformed — same
 * "read-if-exists, but validate strictly when present" contract intent.yaml/
 * verification.yaml already follow.
 */
/**
 * I-2026-08-29-external-verify-gate — everything the external verify step needs that is not
 * already a parameter of buildGateContext. Optional so every existing caller is unchanged; the
 * runner is injectable so tests can count invocations and simulate failure modes without
 * spawning (spec.md D2).
 */
export interface ExternalVerifyOptions {
  runner?: ExternalVerifyRunner;
  /** Defaults to process.env. Supplied explicitly by tests exercising the recursion sentinel. */
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** Where `profile` was loaded from, used ONLY to notice that the file changed while the
   * command ran (see profileChangedDuringVerification). Never consulted for authorization. */
  profilePath?: string;
  /**
   * Overrides the authorization store read. Test seam only -- real callers let it come from
   * `~/.config/lane/external-verify.yaml`, which is the entire point (nothing per-invocation may select
   * where authorization comes from).
   */
  /** Test seam. `exists` defaults to true: a fixture that injects digests is standing in for a
   * store that is present, and the absent case has its own fixtures. */
  store?: { path: string; digests: readonly string[]; exists?: boolean };
}

/**
 * Symlink-resolves a path for the inside-the-workspace comparison, falling back to the input if
 * it cannot be resolved. Lives here rather than in core because it touches the filesystem; core
 * gets two already-resolved strings and does pure string work on them. Without this, `/tmp/x`
 * and `/private/tmp/x` -- the same directory on macOS -- compare as unrelated, and the check
 * could be sidestepped by respelling a path.
 */
function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Like resolveRealPath, but reports failure as `undefined` instead of falling back to the
 * unresolved string.
 *
 * The difference matters only for the authorization store. core's planExternalVerify refuses
 * when `authorizationStorePath` is undefined -- "I could not determine where this file actually
 * is, so I will not reason about where it sits" -- but that branch was unreachable in
 * production, because this path went through resolveRealPath and every failure came back as the
 * original string. The overlap check would then compare an unresolved path, which is the exact
 * thing resolveRealPath exists to prevent, and silently continue.
 *
 * A store that does not exist never reaches this function (the caller checks `exists` first),
 * so getting here means the file was readable a moment ago and realpath still failed -- a race,
 * a permissions change, or a broken link, none of which should be resolved by guessing.
 */
/**
 * Realpath of the deepest ancestor that exists, with the missing tail re-appended.
 *
 * For a store that does NOT exist there is nothing to realpath, but its pathname still has to be
 * comparable with the realpath'd workspaces -- otherwise the overlap check silently cannot see
 * it. On macOS that is not hypothetical: a home directory under /var resolves to /private/var,
 * so an absent store inside the gated tree compared as unrelated and the check never fired.
 * Found by writing the test for the absent-under-workspace case.
 */
function resolveRealPathOfNearestAncestor(path: string): string {
  let existing = dirname(path);
  const missing: string[] = [basename(path)];
  let previous = "";
  while (existing !== previous) {
    try {
      return join(realpathSync(existing), ...missing.reverse());
    } catch {
      missing.push(basename(existing));
      previous = existing;
      existing = dirname(existing);
    }
  }
  return path;
}

function resolveRealPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Decides-then-runs the external verification command, or does neither. Returns `undefined`
 * (rather than a "skipped" outcome) when there is nothing to do, so `artifacts.externalVerify`
 * stays absent for every lane that configured nothing -- the gate then contributes nothing and
 * no behavior changes at all.
 *
 * This is the ONLY place the command is executed, and planExternalVerify already restricts that
 * to the 3_implement -> 4_verify phase_advance trigger. `lane validate` evaluates two triggers
 * per run and therefore calls buildGateContext twice; if the run condition were any looser the
 * command would be spawned twice per validate (spec.md D4 / TEST-24).
 */
function resolveExternalVerify(
  intent: Intent,
  profile: Profile,
  trigger: GateTrigger,
  specDir: string,
  intentId: string,
  options: ExternalVerifyOptions,
): ExternalVerifyOutcome | undefined {
  // Resolved once and handed to planExternalVerify, which both authorizes it (it is part of the
  // digest) and puts it on the returned plan for the runner to use. There is deliberately no
  // second cwd anywhere in this path.
  // Read nothing, and touch no filesystem, for a lane that never opted in. planExternalVerify
  // returns "skip" for both of these too, but by then the store has already been read -- and a
  // malformed store THROWS (verified: a type-violating allowed_command_digests raises ZodError).
  // Reading it unconditionally therefore made every lane command crash on someone else's typo,
  // including lanes with no external_verify at all, which is exactly the "configuring nothing
  // changes nothing" promise this feature is built on. The duplicated guard is deliberate.
  if (!intent.external_verify || !isExternalVerifyTrigger(trigger)) return undefined;

  const cwd = resolveRealPath(options.cwd ?? process.cwd());
  // Reading the store can THROW -- a malformed one is refused rather than read as empty, which
  // is the right call (see external-verify-store.ts) but is only half of it. The throw had no
  // handler anywhere on this path, so it went past the gate, past advance, and out of main as a
  // raw ZodError dump with exit 2. That is the same "crash before deciding" shape this function
  // already converts for a throwing runner a few lines below -- refusing with a diagnostic that
  // names the misspelled key is what the operator can act on.
  let store: { path: string; digests: readonly string[]; exists?: boolean } | undefined;
  let storeFailure: { code: ExternalVerifyRefusal; detail: string } | undefined;
  try {
    store = options.store ?? readExternalVerifyStore();
  } catch (error) {
    // ELOOP is a cyclic or self-referential symlink: the pathname exists, it just does not lead
    // anywhere, which is the unresolvable case and not the unreadable one. Reporting it as
    // "could not be parsed" would send the operator looking for a misspelled key in a file that
    // cannot be opened at all.
    const code: ExternalVerifyRefusal =
      (error as NodeJS.ErrnoException)?.code === "ELOOP"
        ? "authorization_store_unresolvable"
        : "authorization_store_unreadable";
    // NOT returned here. planExternalVerify decides refusal order, and refusing at the read put
    // the store ahead of the checks that must precede it -- notably the legacy-profile
    // migration refusal, which names a DIFFERENT file to fix and was being masked by a typo in
    // this one.
    storeFailure = { code, detail: (error as Error)?.message ?? String(error) };
  }
  const plan = planExternalVerify({
    intent,
    profile,
    trigger,
    env: options.env ?? process.env,
    cwd,
    authorizedDigests: store?.digests ?? [],
    ...(storeFailure === undefined ? {} : { authorizationStoreFailure: storeFailure }),
    // Only demanded for a store that exists. An absent store resolves to nothing by definition,
    // and refusing on that would replace "here is the digest to add" with a refusal about a file
    // the operator has not created yet -- the ordinary state for everyone who has not enabled
    // this feature.
    authorizationStorePath:
      store === undefined
        ? undefined
        : (store.exists ?? true)
          ? resolveRealPathOrUndefined(store.path)
          : resolveRealPathOfNearestAncestor(store.path),
    // Two distinct trees: where the command runs, and where the intent came from. `--spec-dir`
    // makes these different, and treating only the first as the workspace is what let the
    // previous design be defeated.
    //
    // Each is widened to its enclosing git worktree AND every superproject above it, because the
    // tree an adversary can write is the repository -- not whichever directory the operator
    // launched lane from. Passing `cwd` itself was broken in review by running `lane advance`
    // from a SUBDIRECTORY of the very repository holding the store. Widening only to
    // `--show-toplevel` then cut the other way for a submodule: launching from inside one shrank
    // the workspace to the submodule root, so an overlap with the OUTER repository went
    // unreported (spec.md L13). gitWorktreeRootChain climbs `--show-superproject-working-tree` to
    // include the outer roots too (issue #35). Falls back to the directory itself outside a git
    // repo, which is no worse than what it replaced.
    workspaces: [
      ...new Set(
        [cwd, resolveRealPath(specDir)].flatMap((d) => {
          const chain = gitWorktreeRootChain(d);
          return chain.length > 0 ? chain : [d];
        }),
      ),
    ],
  });
  if (plan.kind === "skip") return undefined;
  if (plan.kind === "refuse") {
    return {
      kind: "refused",
      code: plan.code,
      commandDigest: plan.commandDigest,
      ...(plan.detail === undefined ? {} : { detail: plan.detail }),
    };
  }
  // Snapshotted BEFORE the command runs, to be compared with what is on disk afterwards.
  //
  // The intent reaching this function was read by buildGateContext's caller, so unlike every
  // other artifact it is not re-read after the verifier. A verifier that edits intent.yaml --
  // and editing files is what verifiers do -- therefore leaves this whole transition decided
  // against an intent that no longer exists.
  //
  // An earlier revision recorded that as a limitation and argued it was not an authorization
  // hole, on the grounds that the next transition would recompute the digest and require fresh
  // authorization. That was wrong, and review caught it: the gate only fires on
  // 3_implement -> 4_verify (isExternalVerifyTrigger), and L2 says it is deliberately not
  // re-checked at 5_done. So there IS no next transition that reauthorizes. A command swapped
  // in after the authorized one passed would never be checked at all, while
  // gate_snapshots.external_verify vouched for the command that did run.
  const intentBefore = computeDigest(JSON.stringify(intent));
  // Same window, same reasoning, different file. `profile` is also read by buildGateContext's
  // caller, and a repository-selected profile (--profile / LANE_PROFILE_PATH, both ordinary
  // things for a project to set) can be rewritten by the verifier: adding the legacy
  // `external_verify` key, which the FINAL profile should be refused for, or changing a knob
  // like design_override_forbidden that the remaining gates are about to evaluate.
  //
  // `options.profilePath` exists ONLY for this comparison. It is emphatically not a return to
  // the profile-based authorization designs (spec.md section 12) -- nothing is read from it to
  // decide whether a command may run; it is read to notice that the file moved.
  const profileBefore = computeDigest(JSON.stringify(profile));

  const runner = options.runner ?? defaultExternalVerifyRunner;
  // The runner interface promises an outcome, never a throw, and the built-in one keeps that
  // promise (it catches spawnSync's synchronous throws itself). But this is the boundary where
  // an *injected* runner runs, and a throw here escapes gate evaluation entirely -- past the
  // gate, past `advance`, out of the CLI -- rather than refusing the transition. A gate whose
  // failure mode is "crash before deciding" is not fail-closed, whatever EARS-12 says. Convert
  // it here, where the outcome type is still available to convert it into.
  const outcome = ((): ExternalVerifyOutcome => {
    try {
      return runner.run(plan, {
        intentId,
        phaseFrom: trigger.type === "phase_advance" ? trigger.from : "",
        phaseTo: trigger.type === "phase_advance" ? trigger.to : "",
        specDir,
      });
    } catch (error) {
      return {
        kind: "failed",
        code: "invalid_configuration",
        commandDigest: plan.commandDigest,
        errno: (error as NodeJS.ErrnoException).code ?? null,
        exitStatus: null,
        signal: null,
        outputTail: truncateExternalVerifyOutput(String((error as Error)?.message ?? error)),
      };
    }
  })();

  // Checked AFTER the command ran, and regardless of how it went: an intent that moved under a
  // failing verifier is just as unsafe to decide against as one that moved under a passing one.
  if (intentChangedDuringVerification(specDir, intentId, intentBefore)) {
    return {
      kind: "refused",
      code: "intent_modified_during_verification",
      commandDigest: plan.commandDigest,
    };
  }
  if (profileChangedDuringVerification(options.profilePath, profileBefore)) {
    return {
      kind: "refused",
      code: "profile_modified_during_verification",
      commandDigest: plan.commandDigest,
    };
  }
  return outcome;
}

/**
 * True when the profile file changed while the verification command was running.
 *
 * `undefined` means the caller did not tell us where the profile came from, in which case there
 * is nothing to compare and this reports no change -- the pre-existing behaviour, not a new
 * silent pass. An unreadable or now-invalid profile counts as changed: it is certainly not the
 * one that was loaded.
 */
function profileChangedDuringVerification(
  profilePath: string | undefined,
  digestBefore: string,
): boolean {
  if (profilePath === undefined) return false;
  try {
    return computeDigest(JSON.stringify(loadProfile(profilePath))) !== digestBefore;
  } catch {
    return true;
  }
}

/**
 * Refuses when intent.yaml changed while the verification command was running.
 *
 * Deliberately compares the WHOLE intent, not just `external_verify`. The authorization case is
 * the one that has to be closed, but every other gate on this transition is also evaluated
 * against the intent read before the command ran -- `intent.success` feeding success_criteria,
 * for instance -- and deciding a transition against a moving target is not something to do
 * selectively. Re-running once the file has settled is cheap; the command is authorized, so it
 * simply runs again.
 *
 * A missing or unreadable intent afterwards counts as changed: it certainly is not the file
 * that was read.
 */
function intentChangedDuringVerification(
  specDir: string,
  intentId: string,
  digestBefore: string,
): boolean {
  try {
    return computeDigest(JSON.stringify(readIntent(specDir, intentId))) !== digestBefore;
  } catch {
    return true;
  }
}

export function buildGateContext(
  specDir: string,
  intentId: string,
  state: LaneState,
  intent: Intent,
  profile: Profile,
  trigger: GateTrigger,
  externalVerifyOptions: ExternalVerifyOptions = {},
): GateContext {
  // The external verification command runs FIRST, before any artifact is read.
  //
  // It used to run last, after verification.yaml, critic.yaml, spec.md and the design artifacts
  // had all been read -- so a verify command that touches any of them exited zero and left the
  // remaining gates evaluating, and the transition being snapshotted from, content that no
  // longer existed on disk. `spec_consensus` binds a reviewer's ack to digests of spec.md and
  // verification.yaml, so a stale read there is an ack vouching for content nobody acked.
  // Running a command that regenerates artifacts is an ordinary thing for a verifier to do.
  //
  // Reordering does not make anything less accurate: every artifact below is now read as it
  // stands after the command ran, which is the state the transition is actually about.
  const externalVerify = resolveExternalVerify(
    intent,
    profile,
    trigger,
    specDir,
    intentId,
    externalVerifyOptions,
  );

  const verification = readVerificationIfExists(specDir, intentId);
  const critic = readCriticIfExists(specDir, intentId, profile);
  let specDigest: GateContext["artifacts"]["specDigest"];
  if (verification) {
    const specContent = readSpecMdIfExists(specDir, intentId) ?? "";
    specDigest = {
      spec: computeDigest(specContent),
      verification: computeDigest(canonicalVerificationContent(verification)),
    };
  }
  // I-2026-08-18-design-critic-injection — read fresh every call, exactly like
  // verification/critic above (R17: never persisted/cached). Read unconditionally (not
  // gated on state.design_track) so a stray design/ directory left behind after a lane
  // deactivates would still be visible to `lane design status`; the two design gates
  // themselves are what actually gate on activation (their own appliesTo()).
  const activeDesign = readActiveDesignOptionsIfExists(specDir, intentId);
  const design = {
    pointer: activeDesign?.pointer ?? null,
    doc: activeDesign?.doc ?? null,
    attestation: readDesignAttestation(specDir, intentId),
    specMdContent: readSpecMdIfExists(specDir, intentId),
  };

  return {
    trigger,
    state,
    profile,
    artifacts: {
      intent,
      critic,
      verification: verification ?? undefined,
      specDigest,
      design,
      ...(externalVerify === undefined ? {} : { externalVerify }),
    },
  };
}

/** Builds the GateContext for `trigger` and evaluates DEFAULT_GATES against it in one call. */
export function evaluateGatesForTrigger(
  specDir: string,
  intentId: string,
  state: LaneState,
  intent: Intent,
  profile: Profile,
  trigger: GateTrigger,
  externalVerifyOptions: ExternalVerifyOptions = {},
): GateEvaluation {
  return evaluateGatesForTriggerDetailed(
    specDir,
    intentId,
    state,
    intent,
    profile,
    trigger,
    externalVerifyOptions,
  ).evaluation;
}

/**
 * I-2026-08-29-external-verify-gate — same evaluation, but also hands back the context it was
 * built from. `advance.ts` needs the external verify outcome to record its gate snapshot, and
 * the context is where that outcome lives; returning it is a smaller change than exporting
 * DEFAULT_GATES to the command layer so it can compose the two calls itself (architect review
 * 9-12). Crucially it also means the command is built (and therefore run) exactly ONCE per
 * evaluation, not once for the gates and again for the snapshot.
 */
export function evaluateGatesForTriggerDetailed(
  specDir: string,
  intentId: string,
  state: LaneState,
  intent: Intent,
  profile: Profile,
  trigger: GateTrigger,
  externalVerifyOptions: ExternalVerifyOptions = {},
): { context: GateContext; evaluation: GateEvaluation } {
  const context = buildGateContext(
    specDir,
    intentId,
    state,
    intent,
    profile,
    trigger,
    externalVerifyOptions,
  );
  return { context, evaluation: evaluateGates(DEFAULT_GATES, context) };
}

/**
 * Codex review (2026-08-06, should): `validate` evaluates two triggers per call (the
 * forward phase_advance edge and the standalone before_pr_publish checkpoint) and merges
 * their diagnostics -- a gate whose appliesTo() matches *both* (successCriteriaGate at
 * 3_implement, whose appliesTo covers both `phase_advance{from:3_implement,to:4_verify}`
 * and `before_pr_publish{phase:3_implement}`) would otherwise report the exact same
 * finding twice. Dedupes by (gateId, code, message) -- not by reference identity, since
 * the two evaluateGatesForTrigger() calls each build their own fresh Diagnostic objects
 * from the same underlying artifacts. `advance`'s own enforcement is untouched by this:
 * it only ever evaluates a single trigger per call, so it never had a duplicate to dedupe.
 */
export function dedupeDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    const key = `${d.gateId}\u0000${d.code}\u0000${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * CLI-facing formatting: errors and warnings each prefixed with their gate id, so a
 * message like "[success_criteria] ..." is traceable to the gate that raised it without
 * needing to inspect the Diagnostic objects directly. Takes a plain diagnostics array
 * (rather than a whole GateEvaluation) since validate.ts merges diagnostics from more than
 * one evaluateGatesForTrigger() call before formatting.
 */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const d of diagnostics) {
    const line = `[${d.gateId}] ${d.message}`;
    (d.severity === "error" ? errors : warnings).push(line);
  }
  return { errors, warnings };
}
