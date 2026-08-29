import { realpathSync } from "node:fs";
import {
  DEFAULT_GATES,
  type Diagnostic,
  type ExternalVerifyOutcome,
  type ExternalVerifyProfileSource,
  type GateContext,
  type GateEvaluation,
  type GateTrigger,
  canonicalVerificationContent,
  computeDigest,
  evaluateGates,
  planExternalVerify,
} from "@lane/core";
import type { Intent, LaneState, Profile } from "@lane/schemas";
import { readCriticIfExists } from "./critic-store.js";
import { readDesignAttestation } from "./design-attestation-store.js";
import { readActiveDesignOptionsIfExists } from "./design-options-store.js";
import {
  type ExternalVerifyRunner,
  defaultExternalVerifyRunner,
} from "./external-verify-runner.js";
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
  /**
   * Path of the profile that authorized (or failed to authorize) the command -- i.e. the `path`
   * `resolveProfilePath` returned. Real callers must pass it: an authorization coming from
   * inside the working tree is refused, and omitting this is treated as "cannot tell", which
   * refuses too.
   */
  profilePath?: string;
  /** Which tier of resolveProfilePath produced the profile; only "flag"/"env" may authorize. */
  profileSource?: ExternalVerifyProfileSource;
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
  const plan = planExternalVerify({
    intent,
    profile,
    trigger,
    env: options.env ?? process.env,
    // process.cwd() is already symlink-resolved; the profile path may not be, so both sides of
    // the inside-the-workspace comparison are resolved before core sees them.
    cwd: resolveRealPath(options.cwd ?? process.cwd()),
    profilePath:
      options.profilePath === undefined ? undefined : resolveRealPath(options.profilePath),
    profileSource: options.profileSource,
  });
  if (plan.kind === "skip") return undefined;
  if (plan.kind === "refuse") {
    return { kind: "refused", code: plan.code, commandDigest: plan.commandDigest };
  }
  const runner = options.runner ?? defaultExternalVerifyRunner;
  return runner.run(plan, {
    intentId,
    phaseFrom: trigger.type === "phase_advance" ? trigger.from : "",
    phaseTo: trigger.type === "phase_advance" ? trigger.to : "",
    specDir,
  });
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

  const externalVerify = resolveExternalVerify(
    intent,
    profile,
    trigger,
    specDir,
    intentId,
    externalVerifyOptions,
  );

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
