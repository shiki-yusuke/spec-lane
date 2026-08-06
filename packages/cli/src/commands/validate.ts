import {
  isForwardTransition,
  loadProfile,
  recordEffectiveRiskEvaluation,
  resolveProfilePath,
  validNextPhases,
} from "@lane/core";
import type { Critic, Intent } from "@lane/schemas";
import { ZodError } from "zod";
import { readCriticIfExists } from "../critic-store.js";
import { packageDefaultProfilePath } from "../default-profile.js";
import { dedupeDiagnostics, evaluateGatesForTrigger, formatDiagnostics } from "../gate-check.js";
import { intentExists, readIntent } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, readLaneState, writeLaneState } from "../state-store.js";
import type { CommandResult } from "./start.js";

/**
 * MP-7 dogfood fix (2026-08-07): an unformatted ZodError's own `Error#message` getter is
 * exactly `JSON.stringify(issues, null, 2)` -- so before this helper existed, a schema
 * violation in intent.yaml/critic.yaml surfaced as a raw JSON issues array printed
 * straight to the console (via main.ts's top-level `.catch()`), instead of a message in
 * the same human-readable style gate diagnostics already use (`formatDiagnostics`'s own
 * `"[gateId] message"`). One line per issue: `<file>: <path>: <message>` (`<path>` joins
 * the issue's dotted field path, or `(root)` if the issue applies to the object itself).
 * Deliberately scoped to `runValidate` only (not a shared/global formatter) -- `advance`'s
 * own `readIntent`/`readCriticIfExists` calls still let a ZodError propagate unformatted,
 * a known, intentionally out-of-scope asymmetry recorded in CHANGELOG.md's 0.3.1 entry.
 */
function formatZodError(fileLabel: string, error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${fileLabel}: ${path}: ${issue.message}`;
    })
    .join("\n");
}

export interface ValidateOptions {
  specDir?: string;
  profile?: string;
}

/**
 * design.md §3.3/§3.4/§10 — validates whatever artifacts exist for the lane so far.
 * (Codex M1 review, must-3) recomputes+records the profile-driven effective risk before
 * evaluating any gate, so risk_auto_upgrade rules actually affect the outcome instead of
 * being dead config. Exit codes follow the Python reference implementation's convention: 0=pass, 2=lane state
 * error, 3=gate failure.
 *
 * Gate-port review (2026-08-06): validate is the "diagnose anytime" checker — unlike
 * advance, it never attempts a real transition, so there is no single trigger to check.
 * It instead evaluates gates against *both* of the two triggers relevant to wherever the
 * lane currently sits: the forward phase_advance edge from the current phase (so e.g.
 * premise_evidence's 1_intent->2_spec gate is reachable from `lane validate` while still
 * at 1_intent, before anyone has actually tried `lane advance`) and the standalone
 * before_pr_publish checkpoint (so success_criteria/spec_consensus's "double check" is
 * always reachable regardless of phase). This replaces the old early return that skipped
 * gate evaluation entirely below 4_verify/5_done, which meant premise_evidence's own gate
 * was never reachable through validate at all.
 *
 * Codex review (2026-08-06, should): a gate whose appliesTo() matches both of those
 * triggers (successCriteriaGate at 3_implement, since its appliesTo covers both the
 * 3_implement->4_verify edge and every before_pr_publish phase) would otherwise report the
 * same finding twice. The two calls' diagnostics are merged through dedupeDiagnostics()
 * (gate-check.ts), which dedupes by (gateId, code, message) before formatting.
 *
 * Codex M4 review, must-2: critic.yaml has no CLI-side schema check of its own before this
 * fix, so a malformed one (wrong lens set, `applicable` missing finding/taxonomy, etc.)
 * could pass every gate undetected all the way to 5_done. It's checked here whenever it
 * exists (readCriticIfExists throws, same as readIntent above, if it's malformed) — never
 * required before it's actually written, matching intent.yaml/verification.yaml's own
 * "read-if-exists" convention. (gate-check.ts's buildGateContext reads it again
 * independently for gate evaluation itself; this call is only so the message below can
 * say whether one was found.)
 */
export function runValidate(intentId: string, opts: ValidateOptions): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir });

  if (!laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: `Lane state not found: ${intentId}` };
  }
  if (!intentExists(specDir, intentId)) {
    return { exitCode: 2, message: `intent.yaml not found for ${intentId}` };
  }

  let state = readLaneState(specDir, intentId);
  let intent: Intent;
  try {
    intent = readIntent(specDir, intentId);
  } catch (err) {
    if (err instanceof ZodError) {
      return { exitCode: 2, message: formatZodError("intent.yaml", err) };
    }
    throw err; // non-schema error (e.g. invalid YAML syntax) -- unchanged, propagates as before
  }

  const { path: profilePath } = resolveProfilePath({
    explicit: opts.profile,
    cwd: process.cwd(),
    packageDefaultPath: packageDefaultProfilePath(),
  });
  const profile = loadProfile(profilePath);
  let critic: Critic | undefined;
  try {
    critic = readCriticIfExists(specDir, intentId, profile);
  } catch (err) {
    if (err instanceof ZodError) {
      return { exitCode: 2, message: formatZodError("critic.yaml", err) };
    }
    throw err; // non-schema error (e.g. invalid YAML syntax) -- unchanged, propagates as before
  }

  // Every validate call is a gate-evaluation event for audit purposes, even for phases
  // where no gate currently applies (design.md §3.4: recomputed "gate 毎に"). Unlike
  // advance, this is persisted unconditionally — validate never mutates current_phase, so
  // there is no "failed attempt" state to keep clean; accumulating one audit entry per
  // validate call is harmless and intentional.
  const now = new Date().toISOString();
  state = recordEffectiveRiskEvaluation(state, intent, profile, "validate", now);
  writeLaneState(specDir, intentId, state);

  const currentPhase = state.current_phase;
  const forwardTarget = validNextPhases(currentPhase).find((p) =>
    isForwardTransition(currentPhase, p),
  );

  const diagnostics = dedupeDiagnostics([
    ...(forwardTarget
      ? evaluateGatesForTrigger(specDir, intentId, state, intent, profile, {
          type: "phase_advance",
          from: currentPhase,
          to: forwardTarget,
        }).diagnostics
      : []),
    ...evaluateGatesForTrigger(specDir, intentId, state, intent, profile, {
      type: "before_pr_publish",
      phase: currentPhase,
    }).diagnostics,
  ]);
  const { errors, warnings } = formatDiagnostics(diagnostics);

  if (errors.length > 0) {
    return { exitCode: 3, message: `Gate failed: ${errors.join("; ")}` };
  }
  const summary = `intent.yaml is valid${critic ? " and critic.yaml is valid" : ""} (phase=${currentPhase}).`;
  return { exitCode: 0, message: [summary, ...warnings].join("\n") };
}
