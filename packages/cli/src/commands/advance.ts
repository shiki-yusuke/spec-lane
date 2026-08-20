import {
  CURRENT_GATE_RULESET_VERSION,
  createDoneOverlay,
  isDoneOverlayGuarded,
  isValidTransition,
  loadProfile,
  readDoneOverlay,
  recordEffectiveRiskEvaluation,
  resolveProfilePath,
} from "@lane/core";
import type { GateSnapshots, Intent, Phase } from "@lane/schemas";
import { packageDefaultProfilePath } from "../default-profile.js";
import { dedupeDiagnostics, evaluateGatesForTrigger, formatDiagnostics } from "../gate-check.js";
import { readIntent } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, readLaneState, writeLaneState } from "../state-store.js";
import { readVerificationIfExists } from "../verification-store.js";
import type { CommandResult } from "./start.js";

export interface AdvanceOptions {
  specDir?: string;
  profile?: string;
  prUrl?: string;
  mergeSha?: string;
  toolVersion?: string;
  /** ISO 8601 timestamp of when the PR actually merged. Required for --phase 5_done. */
  mergedAt?: string;
  /**
   * I-2026-08-20-promotion-invariants — required by promotionWeakeningGate only when it
   * actually finds a strictly-weaker snapshot-vs-current diff; ignored (and harmless to
   * pass) otherwise.
   */
  weakeningRationale?: string;
  /**
   * I-2026-08-20-promotion-invariants — the one explicit escape hatch gateRulesetVersionGate
   * accepts for a lane whose recorded gate_ruleset_version disagrees with the installed
   * binary's CURRENT_GATE_RULESET_VERSION. Recording the migration (not just letting the
   * gate pass) happens below, after every gate has actually passed.
   */
  ackRulesetMigration?: boolean;
}

/**
 * Phase transition (design.md §3.3/§3.6). Any transition — forward or the two documented
 * rework edges — closes the current in_progress phase_history entry and opens a new one
 * for the target phase.
 *
 * Gate-port review (2026-08-06): every transition now runs
 * "validity check -> read artifacts -> evaluate gates -> update state", in that order, not
 * just 5_done (which is what the pre-existing spec_consensus gate happened to need before
 * premise_evidence/success_criteria were ported in). If any applicable gate produces an
 * error diagnostic, this function returns without writing anything to lane-state.json —
 * a failed advance attempt must leave zero trace in the persisted state, as if it had
 * never been called (this deliberately drops the previous 5_done-only behavior of still
 * persisting the effective-risk audit entry on a blocked transition; that entry is not a
 * calibrated pilot semantic, it was spec-lane's own plumbing, and "no mutation on error"
 * is a strictly simpler invariant to reason about). Warnings never block a transition, but
 * are still surfaced in the success message so they are not silently dropped.
 *
 * `--phase 5_done` never touches lane-state.json's current_phase: it writes a done overlay
 * instead (design.md §3.6 "merge itself is the done signal"), matching the Python
 * reference implementation's v0.2.0 behavior.
 */
export function runAdvance(
  intentId: string,
  targetPhase: Phase,
  opts: AdvanceOptions,
): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir });

  if (!laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: `Lane state not found: ${intentId}` };
  }
  const state = readLaneState(specDir, intentId);
  const current = state.current_phase;

  if (isDoneOverlayGuarded(specDir, intentId, state)) {
    const overlay = readDoneOverlay(specDir, intentId);
    return {
      exitCode: 2,
      message: `Lane is already 5_done (local overlay: ${overlay?.done_recorded_at})`,
    };
  }

  if (!isValidTransition(current, targetPhase)) {
    return {
      exitCode: 2,
      message: `Invalid transition: ${current} -> ${targetPhase}`,
    };
  }

  if (targetPhase === "5_done") {
    if (current !== "4_verify") {
      return {
        exitCode: 2,
        message: `5_done can only be reached from 4_verify (current: ${current})`,
      };
    }
    // orchestrator.py's finish flow (~line 2065) always takes the real PR merge time as
    // an explicit input rather than defaulting to "now" — cycle time must reflect when
    // the PR actually merged, not whenever someone happened to run this command.
    if (!opts.mergedAt) {
      return {
        exitCode: 1,
        message: "--merged-at <ISO 8601 timestamp> is required when advancing to 5_done",
      };
    }
  }

  const intent = readIntent(specDir, intentId);
  const { path: profilePath } = resolveProfilePath({
    explicit: opts.profile,
    cwd: process.cwd(),
    packageDefaultPath: packageDefaultProfilePath(),
  });
  const profile = loadProfile(profilePath);

  const now = new Date().toISOString();
  const stateWithRisk = recordEffectiveRiskEvaluation(state, intent, profile, "phase_advance", now);

  const phaseAdvanceEvaluation = evaluateGatesForTrigger(
    specDir,
    intentId,
    stateWithRisk,
    intent,
    profile,
    { type: "phase_advance", from: current, to: targetPhase },
  );
  // I-2026-08-20-promotion-invariants: `→ 5_done` also fires the independent `promotion`
  // trigger, in addition to (not instead of) the `phase_advance` edge above -- see gate.ts's
  // GateTrigger doc comment for why this is a second evaluation rather than folding
  // "promotion" into the existing edge's own appliesTo. Deduped the same way validate.ts
  // already merges two triggers' diagnostics, since specConsensusGate legitimately applies
  // to both and would otherwise report the same finding twice.
  const promotionEvaluation =
    targetPhase === "5_done"
      ? evaluateGatesForTrigger(specDir, intentId, stateWithRisk, intent, profile, {
          type: "promotion",
          weakeningRationale: opts.weakeningRationale,
          acknowledgeRulesetMigration: opts.ackRulesetMigration,
        })
      : null;
  const allDiagnostics = dedupeDiagnostics([
    ...phaseAdvanceEvaluation.diagnostics,
    ...(promotionEvaluation?.diagnostics ?? []),
  ]);
  const { errors, warnings } = formatDiagnostics(allDiagnostics);
  if (errors.length > 0) {
    // No writeLaneState call here at all: a blocked transition leaves the persisted state
    // byte-for-byte unchanged, including the effective-risk audit entry computed above.
    return { exitCode: 3, message: `Gate failed: ${errors.join("; ")}` };
  }

  if (targetPhase === "5_done") {
    let stateForDone = stateWithRisk;
    // I-2026-08-20-promotion-invariants: the migration is recorded (and the version
    // stamped) only once every gate above has actually passed -- an --ack-ruleset-migration
    // flag on a promotion that otherwise fails does not silently bank a version bump.
    if (
      stateWithRisk.gate_ruleset_version !== undefined &&
      stateWithRisk.gate_ruleset_version !== CURRENT_GATE_RULESET_VERSION &&
      opts.ackRulesetMigration
    ) {
      stateForDone = {
        ...stateForDone,
        gate_ruleset_version: CURRENT_GATE_RULESET_VERSION,
        ruleset_migrations: [
          ...(stateForDone.ruleset_migrations ?? []),
          {
            from: stateWithRisk.gate_ruleset_version,
            to: CURRENT_GATE_RULESET_VERSION,
            acknowledged_at: now,
          },
        ],
      };
    }
    const weakeningFinding = allDiagnostics.find(
      (d) => d.gateId === "promotion_weakening" && d.code === "weakening_acknowledged",
    );
    if (weakeningFinding && opts.weakeningRationale?.trim()) {
      stateForDone = {
        ...stateForDone,
        weakening_acknowledgements: [
          ...(stateForDone.weakening_acknowledgements ?? []),
          {
            finding: weakeningFinding.message,
            rationale: opts.weakeningRationale.trim(),
            acknowledged_at: now,
          },
        ],
      };
    }
    createDoneOverlay({
      specDir,
      intentId,
      state: stateForDone,
      verifyEndedAt: opts.mergedAt as string,
      prUrl: opts.prUrl,
      mergeSha: opts.mergeSha ?? null,
      toolVersion: opts.toolVersion ?? "0.6.0",
    });
    writeLaneState(specDir, intentId, stateForDone);
    return {
      exitCode: 0,
      message: [`Recorded 5_done via local overlay for ${intentId}`, ...warnings].join("\n"),
    };
  }

  const phaseHistory = stateWithRisk.phase_history.map((ph) =>
    ph.phase === current && ph.result === "in_progress"
      ? { ...ph, ended_at: now, result: "completed" as const }
      : ph,
  );
  phaseHistory.push({ phase: targetPhase, started_at: now, result: "in_progress", retry_count: 0 });

  // I-2026-08-20-promotion-invariants: capture the semantic snapshot a *later* promotion
  // will diff against, right at the moment premise_evidence/success_criteria actually
  // passed -- not retroactively, and not on every advance (only these two edges, matching
  // where premiseEvidenceGate/successCriteriaGate's own primary appliesTo edge already is).
  const gateSnapshots = buildUpdatedGateSnapshots(
    stateWithRisk.gate_snapshots,
    current,
    targetPhase,
    intent,
    specDir,
    intentId,
    now,
  );

  writeLaneState(specDir, intentId, {
    ...stateWithRisk,
    gate_snapshots: gateSnapshots,
    current_phase: targetPhase,
    status: "running",
    updated_at: now,
    phase_history: phaseHistory,
  });

  return {
    exitCode: 0,
    message: [`Advanced ${intentId}: ${current} -> ${targetPhase}`, ...warnings].join("\n"),
  };
}

/**
 * I-2026-08-20-promotion-invariants — only ever called once the edge's own gate has
 * already passed with no error (this function runs after the `errors.length > 0` early
 * return above), so "matrix/evidence present and used" here means the same thing it meant
 * to premiseEvidenceGate/successCriteriaGate a few lines up. Only takes a snapshot when
 * there is something concrete to protect against a later weakening: premise_evidence
 * absent, or recorded as not-required, or success_criteria_matrix absent/empty leave the
 * prior snapshot (if any) untouched rather than overwriting it with "nothing recorded".
 */
function buildUpdatedGateSnapshots(
  previous: GateSnapshots,
  from: Phase,
  to: Phase,
  intent: Intent,
  specDir: string,
  intentId: string,
  recordedAt: string,
): GateSnapshots {
  let next = previous;
  if (from === "1_intent" && to === "2_spec") {
    const ev = intent.premise_evidence;
    if (ev?.required === true) {
      next = {
        ...next,
        premise_evidence: { method: ev.method, reproduced: ev.reproduced, recorded_at: recordedAt },
      };
    }
  }
  if (from === "3_implement" && to === "4_verify") {
    const verification = readVerificationIfExists(specDir, intentId);
    if (verification?.success_criteria_matrix?.length && intent.intent.success.length > 0) {
      next = {
        ...next,
        success_criteria: { criteria: [...intent.intent.success], recorded_at: recordedAt },
      };
    }
  }
  return next;
}
