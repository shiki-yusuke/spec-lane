import type {
  Critic,
  DesignCriticAttestation,
  DesignOptionsDoc,
  Intent,
  LaneState,
  Phase,
  Profile,
  Verification,
} from "@lane/schemas";
import { summarizeIndependence } from "./design-independence.js";
import { formatDesignMessage } from "./design-messages.js";
import { normalizeCriterion } from "./normalize-criterion.js";

// design.md §3.3 — rev1's GateContext read `ctx.state.verification`, a field LaneState
// never actually had (sol: "動かないコード"). Gates now receive schema-validated artifacts
// explicitly instead of reaching into ad hoc state.

export interface GateArtifacts {
  intent: Intent;
  critic?: Critic;
  verification?: Verification;
  /** sha256 of the current spec.md/verification.yaml content, computed fresh by the caller. */
  specDigest?: { spec: string; verification: string };
  /**
   * I-2026-08-18-design-critic-injection — populated by gate-check.ts's buildGateContext
   * whenever it exists on disk, regardless of whether state.design_track is active (the
   * two design gates below are what actually gate on activation, via appliesTo()). Read
   * fresh from disk every time, never cached in LaneState (R17): `pointer`/`doc` are the
   * current active revision (or null if none has been submitted yet), `attestation` is
   * this lane's own companion artifact (never absent -- an empty one if the file doesn't
   * exist yet, see design-attestation-store.ts), and `specMdContent` is spec.md's raw
   * content (or null before it exists) for R36's reference check.
   */
  design?: {
    pointer: { design_options_id: string; content_digest: string } | null;
    doc: DesignOptionsDoc | null;
    attestation: DesignCriticAttestation;
    specMdContent: string | null;
  };
}

/**
 * Gate-port review (2026-08-06) — replaces the old flat `{ phase, targetPhase, event }`
 * shape with a discriminated union so a gate's `appliesTo` can't be handed a nonsensical
 * combination (e.g. an `event: "before_pr_publish"` alongside an unrelated `targetPhase`
 * that was never actually the transition being attempted). `phase_advance` is the one real
 * edge (`from` -> `to`) an `advance` call is attempting; `before_pr_publish` is the
 * standalone pre-publish checkpoint `validate` evaluates independently of any specific
 * transition (see packages/cli/src/gate-check.ts).
 */
export type GateTrigger =
  | { type: "phase_advance"; from: Phase; to: Phase }
  | { type: "before_pr_publish"; phase: Phase };

export interface GateContext {
  trigger: GateTrigger;
  state: LaneState;
  artifacts: GateArtifacts;
  profile: Profile;
}

export type Severity = "warning" | "error";

/**
 * Gate-port review (2026-08-06) — replaces the old `GateResult = {pass:true} | {pass:false,
 * reason:string}` (one gate, one verdict, one reason) with an array a gate returns from
 * `evaluate()`. This exists because the ported pilot gates (premise_evidence,
 * success_criteria) can have several independent, simultaneous findings on one evaluation
 * (e.g. success_criteria_matrix can have both an uncovered intent.success line *and* a
 * covered_by:"none" row *and* a missing negation_test, all at once) — the reference
 * implementation's own gate_check_* functions accumulate a `messages: list` rather than
 * stopping at the first problem, and this type is what lets the TS port do the same
 * without losing any of them. `pass` for a whole evaluation is "no diagnostic has
 * severity 'error'" — warnings never block a transition.
 */
export interface Diagnostic {
  gateId: string;
  code: string;
  severity: Severity;
  message: string;
}

export interface Gate {
  id: string;
  appliesTo(ctx: GateContext): boolean;
  evaluate(ctx: GateContext): Diagnostic[];
}

function diagnostic(gateId: string, code: string, severity: Severity, message: string): Diagnostic {
  return { gateId, code, severity, message };
}

const PREMISE_METHODS = ["live", "data", "code-only"] as const;
const PREMISE_EVIDENCE_MIN_CODEPOINTS = 20;

/**
 * Gate 1 (design.md §3.9, ported from the reference implementation's
 * validate.py gate_check_premise_evidence). Applies at the 1_intent->2_spec transition
 * edge, where it is the last mechanical checkpoint before a spec gets drafted against an
 * unconfirmed premise.
 *
 * What this can and cannot check (ported unchanged, including the wording's own
 * disclaimer): it can only tell whether premise_evidence was recorded and whether its
 * shape/thresholds are met, never whether the recorded evidence is actually true, and it
 * cannot itself decide whether this change is even the kind that requires the check
 * (an AI-originated ticket or unobserved symptom introducing a new guard/branch/completion
 * condition) -- that determination is a human/skill-level judgment call the CLI has no way
 * to make. So:
 *   - premise_evidence entirely absent -> warning, never an error (the gate cannot tell
 *     whether it was actually required for this change).
 *   - required:true, reproduced:false -> error (fail-closed: declared applicable, but
 *     confirmation was not obtained).
 *   - required:true, method not in {live, data, code-only} -> error.
 *   - required:true, evidence shorter than 20 *codepoints* after trimming -> error. Code
 *     points, not UTF-16 length (`Array.from(text).length`, not `.length`): a naive
 *     `.length` check would count an emoji as 2 the way Python's `len()` counts it as 1,
 *     silently letting a shorter-than-intended string through the exact threshold the
 *     pilot calibrated (see normalize-criterion.test.ts's sibling concern in
 *     success_criteria for why this repo is careful about codepoint-vs-UTF-16-unit
 *     counting generally).
 *   - required:true, method === "code-only" and otherwise valid -> warning (weakest of the
 *     three evidence methods; recommend upgrading to live/data where possible).
 *   - required:false, reason missing/blank -> error (schema already requires a non-empty
 *     `reason` in this branch, so this is unreachable through a schema-validated Intent —
 *     kept anyway as the gate's own defense in depth, matching the reference
 *     implementation's own redundant check).
 */
export const premiseEvidenceGate: Gate = {
  id: "premise_evidence",
  appliesTo: (ctx) =>
    ctx.trigger.type === "phase_advance" &&
    ctx.trigger.from === "1_intent" &&
    ctx.trigger.to === "2_spec",
  evaluate: (ctx) => {
    const ev = ctx.artifacts.intent.premise_evidence;
    if (!ev) {
      return [
        diagnostic(
          "premise_evidence",
          "missing",
          "warning",
          "premise_evidence is not recorded. If this change is AI-originated or the symptom " +
            "was never directly observed, and it introduces a new guard/branch/completion " +
            "condition, confirm the premise against a real system or data before writing the " +
            "spec (design.md §3.9 gate 1) and record it here.",
        ),
      ];
    }
    if (ev.required === false) {
      if (!ev.reason.trim()) {
        return [
          diagnostic(
            "premise_evidence",
            "reason_missing",
            "error",
            "premise_evidence.required=false requires a non-empty reason",
          ),
        ];
      }
      return [];
    }
    const diagnostics: Diagnostic[] = [];
    if (!PREMISE_METHODS.includes(ev.method)) {
      diagnostics.push(
        diagnostic(
          "premise_evidence",
          "invalid_method",
          "error",
          `premise_evidence.method must be one of ${PREMISE_METHODS.join("|")} (got: ${ev.method})`,
        ),
      );
    }
    if (ev.reproduced !== true) {
      diagnostics.push(
        diagnostic(
          "premise_evidence",
          "not_reproduced",
          "error",
          "premise_evidence.reproduced=false: the premise could not be confirmed to exist. " +
            "Do not advance to 2_spec; pause, cancel, or re-scope to a confirmed problem instead.",
        ),
      );
    }
    const codepoints = Array.from(ev.evidence.trim()).length;
    if (codepoints < PREMISE_EVIDENCE_MIN_CODEPOINTS) {
      diagnostics.push(
        diagnostic(
          "premise_evidence",
          "evidence_too_short",
          "error",
          `premise_evidence.evidence must describe the actual action taken and what was observed (at least ${PREMISE_EVIDENCE_MIN_CODEPOINTS} characters; "should be fine" is not evidence)`,
        ),
      );
    }
    if (diagnostics.length === 0 && ev.method === "code-only") {
      diagnostics.push(
        diagnostic(
          "premise_evidence",
          "weak_evidence",
          "warning",
          "premise_evidence.method=code-only is the weakest of the three methods (a static " +
            "read of the code, not a live/data observation) -- upgrade to live or data if possible.",
        ),
      );
    }
    return diagnostics;
  },
};

/**
 * Gate 2 (design.md §3.9, ported from the reference implementation's
 * validate.py gate_check_success_criteria). Applies at the 3_implement->4_verify
 * transition edge and again at the standalone before_pr_publish checkpoint (a deliberate
 * double-check, not re-documented as "automatically catching PR publish" — see
 * skills/lane/SKILL.md).
 *
 * The cross-check is bidirectional and asymmetric on purpose:
 *   - intent.intent.success line with no corresponding criterion -> error (an accepted
 *     condition nobody actually checked against the final diff).
 *   - success_criteria_matrix row with no corresponding intent.intent.success line ->
 *     warning (direction ②: spec/verification grew a stronger condition than intent's
 *     SSOT was ever updated to say; the fix is to strengthen intent, not to ignore the row).
 *   - a row's covered_by === "none" -> error (skill-level policy is "hold the PR", this is
 *     that policy's mechanical enforcement).
 *   - a row's negation_test is blank -> warning (tautology risk; not always avoidable, so
 *     never an error).
 *   - matrix entirely unrecorded -> warning only (same "the CLI cannot itself decide the
 *     gate applies" reasoning as premise_evidence).
 *   - once every row/direction above is clean, cross_check_intent_vs_spec unrecorded ->
 *     warning (only surfaced once the rest is clean, matching the reference
 *     implementation's own `if ok:` guard).
 *
 * `criterion`<->`success` matching is normalizeCriterion()'d full-text equality, never
 * fuzzy similarity — a criterion that summarizes success is a non-match, not a near-match.
 */
export const successCriteriaGate: Gate = {
  id: "success_criteria",
  appliesTo: (ctx) =>
    ctx.trigger.type === "before_pr_publish" ||
    (ctx.trigger.type === "phase_advance" &&
      ctx.trigger.from === "3_implement" &&
      ctx.trigger.to === "4_verify"),
  evaluate: (ctx) => {
    const success = ctx.artifacts.intent.intent.success;
    const matrix = ctx.artifacts.verification?.success_criteria_matrix;
    if (!matrix) {
      return [
        diagnostic(
          "success_criteria",
          "matrix_missing",
          "warning",
          "success_criteria_matrix is not recorded. Cross-check each line of intent.intent.success " +
            "against the final diff one at a time and record how it is covered, with a negation " +
            "test, before publishing a PR (design.md §3.9 gate 2).",
        ),
      ];
    }

    const diagnostics: Diagnostic[] = [];
    for (const [i, row] of matrix.entries()) {
      if (row.covered_by === "none") {
        diagnostics.push(
          diagnostic(
            "success_criteria",
            "covered_by_none",
            "error",
            `success_criteria_matrix[${i + 1}] covered_by=none: no coverage could be shown for "${row.criterion}". Hold the PR and confirm whether this is a real implementation gap, a criterion that needs rewriting, or genuinely out of scope.`,
          ),
        );
      }
      if (!row.negation_test?.trim()) {
        diagnostics.push(
          diagnostic(
            "success_criteria",
            "negation_test_missing",
            "warning",
            `success_criteria_matrix[${i + 1}].negation_test is empty (tautology risk for "${row.criterion}") -- add something that shows the negative case actually fails, or record why one can't be written.`,
          ),
        );
      }
    }

    if (success.length === 0) {
      diagnostics.push(
        diagnostic(
          "success_criteria",
          "intent_success_empty",
          "warning",
          "intent.intent.success is empty; skipping the bidirectional cross-check",
        ),
      );
      return diagnostics;
    }

    const criteriaNorm = new Set(matrix.map((row) => normalizeCriterion(row.criterion)));
    for (const s of success) {
      if (!criteriaNorm.has(normalizeCriterion(s))) {
        diagnostics.push(
          diagnostic(
            "success_criteria",
            "success_uncovered",
            "error",
            `intent.intent.success has no corresponding success_criteria_matrix row: "${s}" (criterion must transcribe intent.intent.success verbatim; a summary does not match)`,
          ),
        );
      }
    }

    const successNorm = new Set(success.map((s) => normalizeCriterion(s)));
    for (const row of matrix) {
      if (!successNorm.has(normalizeCriterion(row.criterion))) {
        diagnostics.push(
          diagnostic(
            "success_criteria",
            "criterion_extra",
            "warning",
            `success_criteria_matrix has a criterion with no corresponding intent.intent.success line: "${row.criterion}" (if spec/verification grew a stronger condition, update intent -- the SSOT -- to the stronger wording rather than leaving it out of sync)`,
          ),
        );
      }
    }

    if (
      !diagnostics.some((d) => d.severity === "error") &&
      !ctx.artifacts.verification?.cross_check_intent_vs_spec
    ) {
      diagnostics.push(
        diagnostic(
          "success_criteria",
          "cross_check_missing",
          "warning",
          "cross_check_intent_vs_spec is not recorded. Record that direction ② (intent vs. " +
            "spec's own rules/decisions) was performed, even if it found nothing.",
        ),
      );
    }
    return diagnostics;
  },
};

/**
 * design.md §3.3/§5.3 — hard gate binding reviewer_ack to the exact spec/verification
 * content it was given. Applies at the standalone before_pr_publish checkpoint once the
 * lane is actually near publish (4_verify/5_done — a before_pr_publish check while still
 * at 1_intent/2_spec/3_implement would otherwise hard-error on "spec_consensus is not
 * filled in" for a lane that was never expected to have one yet; gate-port review,
 * 2026-08-06, found by validate's own new early-phase before_pr_publish check) and again
 * at the literal 4_verify->5_done transition (a spec.md edit made after the PR was opened
 * but before merge must still be caught).
 */
export const specConsensusGate: Gate = {
  id: "spec_consensus",
  appliesTo: (ctx) =>
    (ctx.trigger.type === "before_pr_publish" &&
      (ctx.trigger.phase === "4_verify" || ctx.trigger.phase === "5_done")) ||
    (ctx.trigger.type === "phase_advance" && ctx.trigger.to === "5_done"),
  evaluate: (ctx) => {
    const consensus = ctx.artifacts.verification?.spec_consensus;
    if (!consensus) {
      return [
        diagnostic("spec_consensus", "not_filled_in", "error", "spec_consensus is not filled in"),
      ];
    }
    if (
      ctx.artifacts.specDigest &&
      (consensus.spec_digest !== ctx.artifacts.specDigest.spec ||
        consensus.verification_digest !== ctx.artifacts.specDigest.verification)
    ) {
      return [
        diagnostic(
          "spec_consensus",
          "digest_mismatch",
          "error",
          "spec/verification content changed after the ack (digest mismatch)",
        ),
      ];
    }
    const pending = consensus.deviations.filter((d) => d.status === "pending");
    if (pending.length > 0) {
      return [
        diagnostic(
          "spec_consensus",
          "unresolved_deviations",
          "error",
          `${pending.length} unresolved deviation(s)`,
        ),
      ];
    }
    const effectiveRisk =
      ctx.state.effective_risk_log.at(-1)?.effective_risk ??
      ctx.artifacts.intent.intent.declared_risk;
    if (
      effectiveRisk === "high" &&
      consensus.reviewer_ack?.reviewer_kind === "self" &&
      !consensus.reviewer_ack.override_reason
    ) {
      return [
        diagnostic(
          "spec_consensus",
          "self_ack_at_high_risk",
          "error",
          "effective risk=high requires override_reason for a self ack",
        ),
      ];
    }
    if (!consensus.reviewer_ack) {
      return [
        diagnostic("spec_consensus", "no_reviewer_ack", "error", "reviewer_ack is not filled in"),
      ];
    }
    return [];
  },
};

/**
 * I-2026-08-18-design-critic-injection R27-R29/R33/R34 (Gherkin: "partial coverage is not
 * establishment", "a scoped override yields an honest status", "a profile may forbid the
 * override"). Applies ONLY while `state.design_track.activated` is true (R1/R3: a lane that
 * never passed `--design` never evaluates this at all -- appliesTo() returning false is
 * this gate's entire contribution to "no new gate is evaluated" for such a lane).
 *
 * Reading order matters for R28 vs R29: an override is looked up ONLY when coverage is
 * incomplete, and a found override degrades the outcome to a WARNING ("not-established,
 * operator-asserted", R28/R32) rather than blocking (R29 blocks only when no override is
 * recorded at all, or when the profile forbids using one, R33).
 */
export const designEstablishmentGate: Gate = {
  id: "design_establishment",
  appliesTo: (ctx) =>
    ctx.state.design_track?.activated === true &&
    ctx.trigger.type === "phase_advance" &&
    ctx.trigger.from === "1_intent" &&
    ctx.trigger.to === "2_spec",
  evaluate: (ctx) => {
    const design = ctx.artifacts.design;
    if (!design?.doc || !design.pointer) {
      return [
        diagnostic(
          "design_establishment",
          "options_missing",
          "error",
          formatDesignMessage("design_options_missing", {}),
        ),
      ];
    }
    const summary = summarizeIndependence(design.doc);
    if (summary.everyOptionCovered) return [];

    const currentDigest = design.pointer.content_digest;
    const uncoveredOptionIds = summary.coverage.filter((c) => !c.covered).map((c) => c.optionId);
    const override = design.attestation.overrides.find(
      (o) =>
        o.scope.design_options_ref.content_digest === currentDigest &&
        uncoveredOptionIds.every((id) => o.scope.uncovered_option_ids.includes(id)),
    );
    if (!override) {
      return [
        diagnostic(
          "design_establishment",
          "not_established_no_override",
          "error",
          formatDesignMessage("establishment_blocked_no_override", {}),
        ),
      ];
    }
    if (ctx.profile.design_override_forbidden) {
      return [
        diagnostic(
          "design_establishment",
          "override_forbidden",
          "error",
          formatDesignMessage("override_forbidden_by_profile", {}),
        ),
      ];
    }
    return [
      diagnostic(
        "design_establishment",
        "not_established_override_recorded",
        "warning",
        formatDesignMessage("establishment_not_established_override", {
          actor: override.actor,
          overriddenAt: override.overridden_at,
          reason: override.reason,
        }),
      ),
    ];
  },
};

/**
 * R34-R36 (Gherkin: "selecting an option no qualifying review covered"). Applies only while
 * the design track is active, at the 2_spec->3_implement edge specifically (R35: "before
 * the implement phase").
 */
export const designDecisionGate: Gate = {
  id: "design_decision",
  appliesTo: (ctx) =>
    ctx.state.design_track?.activated === true &&
    ctx.trigger.type === "phase_advance" &&
    ctx.trigger.from === "2_spec" &&
    ctx.trigger.to === "3_implement",
  evaluate: (ctx) => {
    const design = ctx.artifacts.design;
    if (!design?.doc || !design.pointer) {
      return [
        diagnostic(
          "design_decision",
          "options_missing",
          "error",
          formatDesignMessage("design_options_missing", {}),
        ),
      ];
    }
    const decision = design.attestation.decision;
    if (!decision || decision.design_options_ref.content_digest !== design.pointer.content_digest) {
      // R41: a decision bound to a superseded revision is treated exactly like no decision
      // at all -- it does not carry forward.
      return [
        diagnostic(
          "design_decision",
          "decision_missing",
          "error",
          formatDesignMessage("decision_missing", {}),
        ),
      ];
    }
    const selectedOptionId = decision.selected_option_id;
    if (!design.doc.options.some((o) => o.option_id === selectedOptionId)) {
      return [
        diagnostic(
          "design_decision",
          "option_unknown",
          "error",
          formatDesignMessage("decision_option_unknown", { selectedOptionId }),
        ),
      ];
    }

    const summary = summarizeIndependence(design.doc);
    const coverage = summary.coverage.find((c) => c.optionId === selectedOptionId);
    if (coverage?.covered !== true) {
      const override = design.attestation.overrides.find(
        (o) =>
          o.scope.design_options_ref.content_digest === design.pointer?.content_digest &&
          o.scope.selected_option_id === selectedOptionId,
      );
      if (!override) {
        return [
          diagnostic(
            "design_decision",
            "option_not_qualifying",
            "error",
            formatDesignMessage("decision_option_not_qualifying", { selectedOptionId }),
          ),
        ];
      }
      if (ctx.profile.design_override_forbidden) {
        return [
          diagnostic(
            "design_decision",
            "override_forbidden",
            "error",
            formatDesignMessage("override_forbidden_by_profile", {}),
          ),
        ];
      }
    }

    // R36 is an unconditional SHALL at this point (a decision already exists and qualifies
    // or is overridden) -- unlike premiseEvidenceGate's "cannot tell whether this gate even
    // applies" warn-on-absent pattern, a missing spec.md here IS the failure being checked
    // for (no file means no reference), so this blocks rather than warns.
    if (design.specMdContent === null || !design.specMdContent.includes(selectedOptionId)) {
      return [
        diagnostic(
          "design_decision",
          "spec_missing_reference",
          "error",
          formatDesignMessage("spec_missing_selected_option_reference", { selectedOptionId }),
        ),
      ];
    }
    return [];
  },
};

export interface GateEvaluation {
  diagnostics: Diagnostic[];
  pass: boolean;
}

/**
 * Evaluates every registered gate that applies to this context and collects every
 * diagnostic from all of them — a second gate whose appliesTo() is true is always
 * evaluated even if an earlier gate already produced an error (gate-port review,
 * 2026-08-06: the old version
 * short-circuited on the first failing gate, which would have hidden e.g. a
 * success_criteria error behind whichever gate happened to be checked first).
 * `pass` is true iff no diagnostic anywhere has severity "error" — warnings never block.
 */
export function evaluateGates(gates: readonly Gate[], ctx: GateContext): GateEvaluation {
  const diagnostics: Diagnostic[] = [];
  for (const gate of gates) {
    if (!gate.appliesTo(ctx)) continue;
    diagnostics.push(...gate.evaluate(ctx));
  }
  return { diagnostics, pass: diagnostics.every((d) => d.severity !== "error") };
}

/** M1 default registry, extended by the gate-port review with the two pilot-ported gates. */
export const DEFAULT_GATES: readonly Gate[] = [
  premiseEvidenceGate,
  successCriteriaGate,
  specConsensusGate,
  designEstablishmentGate,
  designDecisionGate,
];
