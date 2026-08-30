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
import type { CatalogBackedDesignMessage } from "./design-messages.js";
import { formatDesignMessage } from "./design-messages.js";
import type { ExternalVerifyOutcome } from "./external-verify.js";
import { isExternalVerifyTrigger } from "./external-verify.js";
import type { GateTrigger } from "./gate-trigger.js";
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
  /**
   * I-2026-08-29-external-verify-gate — the already-completed result of this lane's external
   * verification command, supplied by the caller exactly like `specDigest` and `design` above.
   * The subprocess runs in the CLI layer (packages/cli/src/external-verify-runner.ts); the gate
   * below only reads the outcome, so `Gate.evaluate` stays synchronous and no existing gate,
   * `evaluateGates`, or call site has to change shape (spec.md D2).
   *
   * Absent whenever the trigger is not the 3_implement -> 4_verify edge, or the lane configured
   * no command -- in both cases externalVerifyGate contributes nothing at all.
   */
  externalVerify?: ExternalVerifyOutcome;
}

// GateTrigger now lives in ./gate-trigger.js so external-verify.ts can depend on it without
// creating a module cycle with this file (I-2026-08-29-external-verify-gate). Re-exported here
// so every existing `import { GateTrigger } from "./gate.js"` / "@lane/core" keeps working.
export type { GateTrigger } from "./gate-trigger.js";

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

/** The design track's gates, named by the id they declare rather than by where they are written. */
export type DesignGateId = "design_establishment" | "design_decision";

/**
 * A diagnostic from a design gate: its message came from the catalog, and its gate id is the one
 * its own gate declares.
 *
 * `Diagnostic.message` stays a plain `string` because the other five gates emit hand-written text
 * legitimately -- `promotionWeakeningGate` quotes the findings it detected, and there is no catalog
 * entry for those. Narrowing the shared type would fail all of them, so the narrowing lives on the
 * design-specific type instead.
 */
export interface DesignDiagnostic<Id extends DesignGateId> extends Diagnostic {
  gateId: Id;
  message: CatalogBackedDesignMessage;
}

/**
 * A gate on the design track, whose `evaluate` may only return design diagnostics.
 *
 * This is the part that makes the guarantee hold rather than merely being available: a
 * design-specific factory alone could be bypassed by calling the ordinary `diagnostic()`, since
 * both return something assignable to `Diagnostic`. Narrowing `evaluate`'s return type means a
 * plain `diagnostic()` call inside one of these gates does not typecheck, so the catalog rule is
 * enforced at the point of writing rather than by a later scan of the source text.
 */
export interface DesignGate<Id extends DesignGateId> extends Gate {
  id: Id;
  evaluate(ctx: GateContext): DesignDiagnostic<Id>[];
}

function designDiagnostic<Id extends DesignGateId>(
  gateId: Id,
  code: string,
  severity: Severity,
  message: CatalogBackedDesignMessage,
): DesignDiagnostic<Id> {
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
  // I-2026-08-20-promotion-invariants: also fires on the promotion trigger, re-evaluated
  // against whatever intent.premise_evidence currently reads on disk -- this is the exact
  // predicate the chain-probe showed nothing re-checked after 1_intent->2_spec.
  appliesTo: (ctx) =>
    ctx.trigger.type === "promotion" ||
    (ctx.trigger.type === "phase_advance" &&
      ctx.trigger.from === "1_intent" &&
      ctx.trigger.to === "2_spec"),
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
  // I-2026-08-20-promotion-invariants: also fires on the promotion trigger, re-evaluated
  // against the current success_criteria_matrix/intent.intent.success on disk.
  appliesTo: (ctx) =>
    ctx.trigger.type === "before_pr_publish" ||
    ctx.trigger.type === "promotion" ||
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
  // I-2026-08-20-promotion-invariants: also fires on the promotion trigger (redundant
  // with the existing `phase_advance{to:"5_done"}` edge in practice, since both currently
  // fire together at the same `advance --phase 5_done` call, but named explicitly here so
  // "promotion re-evaluates spec_consensus" doesn't depend on that coincidence holding).
  appliesTo: (ctx) =>
    (ctx.trigger.type === "before_pr_publish" &&
      (ctx.trigger.phase === "4_verify" || ctx.trigger.phase === "5_done")) ||
    ctx.trigger.type === "promotion" ||
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
 * I-2026-08-20-promotion-invariants — the gate contract a lane was started under
 * (`lane start` stamps `state.gate_ruleset_version` with this constant) versus the one the
 * installed binary actually evaluates. Bump this whenever a change to DEFAULT_GATES alters
 * what promotion requires (a new gate, a stricter predicate on an existing one) — not on
 * every commit, and not for a change that only affects earlier edges (1_intent->2_spec
 * etc.), since those still gate on whatever binary happened to run them at the time.
 */
export const CURRENT_GATE_RULESET_VERSION = "1.0";

/**
 * I-2026-08-20-promotion-invariants — applies only to the promotion trigger. A lane
 * started before this field existed has no recorded ruleset version at all; that is
 * reported (a "missing" diagnostic exists so this is never confused with "checked and
 * fine") but only as a warning, not an error -- turning it into a hard block would refuse
 * promotion for every already-in-flight or already-completed lane the day this ships,
 * which is a materially different (and much more disruptive) decision than "close the gap
 * the chain-probe found." A *recorded* version that disagrees with
 * CURRENT_GATE_RULESET_VERSION is the case the architect's ruling is actually about
 * ("インストール済みバイナリがその版を扱えない場合は、新たに生じた失敗を示す明示的な移行を
 * 要求する... 黙って古い lane を新ルールで再解釈しない") and *is* fail-closed: it blocks
 * until the caller passes `--ack-ruleset-migration`, at which point advance.ts (not this
 * gate) records the migration and stamps the lane to the current version.
 */
export const gateRulesetVersionGate: Gate = {
  id: "gate_ruleset_version",
  appliesTo: (ctx) => ctx.trigger.type === "promotion",
  evaluate: (ctx) => {
    const recorded = ctx.state.gate_ruleset_version;
    if (recorded === undefined) {
      return [
        diagnostic(
          "gate_ruleset_version",
          "unrecorded",
          "warning",
          `gate_ruleset_version is not recorded on this lane (it predates this check) -- promotion cannot verify which gate contract applied when this lane started, and is evaluating it under the installed binary's current ruleset (${CURRENT_GATE_RULESET_VERSION}) with no way to confirm that matches.`,
        ),
      ];
    }
    if (recorded === CURRENT_GATE_RULESET_VERSION) return [];
    if (ctx.trigger.type === "promotion" && ctx.trigger.acknowledgeRulesetMigration) return [];
    return [
      diagnostic(
        "gate_ruleset_version",
        "mismatch",
        "error",
        `this lane recorded gate_ruleset_version=${recorded}, but the installed binary evaluates gate_ruleset_version=${CURRENT_GATE_RULESET_VERSION}. Promotion refuses to silently re-interpret this lane under the new ruleset -- re-run with --ack-ruleset-migration to explicitly migrate it (a one-time, recorded decision).`,
      ),
    ];
  },
};

// I-2026-08-20-promotion-invariants — method "live"/"data" are the two methods
// premiseEvidenceGate itself treats as adequate (only "code-only" earns that gate's own
// weak_evidence warning, gate.ts above), so weakening is a drop into "code-only" from
// either of the other two, never a live<->data move.
const PREMISE_METHOD_STRENGTH: Record<string, number> = { live: 2, data: 2, "code-only": 1 };

/**
 * I-2026-08-20-promotion-invariants — applies only to the promotion trigger. Distinct from
 * premiseEvidenceGate/successCriteriaGate re-evaluated above: those two are hard,
 * fail-closed re-checks of the *current* content against the same pass/fail rule they
 * always used (M2's minimum). This gate instead diffs the current content against the
 * *snapshot* recorded the last time that content passed, and only cares about changes
 * that made things strictly weaker without themselves being caught as an error above --
 * e.g. premise_evidence.method downgraded live->data (still passes premiseEvidenceGate
 * outright, since "data" isn't the weak_evidence-warning method) or a success criterion
 * quietly dropped along with its own intent.success line (still bidirectionally
 * consistent, so successCriteriaGate has nothing to say). Per the architect's ruling this
 * is deliberately friction, not a hard gate: a written `weakeningRationale` unblocks it
 * (downgraded to a warning carrying that rationale for advance.ts to log), and a benign or
 * strengthening edit never asks for one at all -- only `findings.length > 0` reaches the
 * "did you mean to?" branch below.
 */
export const promotionWeakeningGate: Gate = {
  id: "promotion_weakening",
  appliesTo: (ctx) => ctx.trigger.type === "promotion",
  evaluate: (ctx) => {
    if (ctx.trigger.type !== "promotion") return [];
    const findings: string[] = [];
    const snapshots = ctx.state.gate_snapshots;

    const premiseSnapshot = snapshots?.premise_evidence;
    if (premiseSnapshot) {
      const current = ctx.artifacts.intent.premise_evidence;
      if (!current || current.required !== true) {
        findings.push(
          `premise_evidence downgraded from required:true (method=${premiseSnapshot.method}, ` +
            `reproduced=${premiseSnapshot.reproduced}) to required:${current?.required ?? "unrecorded"}`,
        );
      } else {
        const before = PREMISE_METHOD_STRENGTH[premiseSnapshot.method] ?? 0;
        const after = PREMISE_METHOD_STRENGTH[current.method] ?? 0;
        if (after < before) {
          findings.push(
            `premise_evidence.method weakened: ${premiseSnapshot.method} -> ${current.method}`,
          );
        }
        if (premiseSnapshot.reproduced === true && current.reproduced !== true) {
          findings.push(`premise_evidence.reproduced weakened: true -> ${current.reproduced}`);
        }
      }
    }

    const successSnapshot = snapshots?.success_criteria;
    if (successSnapshot) {
      const currentCriteria = new Set(
        ctx.artifacts.intent.intent.success.map((s) => normalizeCriterion(s)),
      );
      const removed = successSnapshot.criteria.filter(
        (c) => !currentCriteria.has(normalizeCriterion(c)),
      );
      if (removed.length > 0) {
        findings.push(
          `success criteria removed since the last recorded pass: ${removed.join(" | ")}`,
        );
      }
    }

    if (findings.length === 0) return [];
    if (!ctx.trigger.weakeningRationale?.trim()) {
      return [
        diagnostic(
          "promotion_weakening",
          "weakening_unacknowledged",
          "error",
          `promotion found this lane strictly weaker than its last recorded pass and requires a written rationale (--weakening-rationale) before proceeding: ${findings.join("; ")}`,
        ),
      ];
    }
    return [
      diagnostic(
        "promotion_weakening",
        "weakening_acknowledged",
        "warning",
        `promotion allowed on a recorded rationale for detected weakening: ${findings.join("; ")} ` +
          `-- rationale: ${ctx.trigger.weakeningRationale.trim()}`,
      ),
    ];
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
export const designEstablishmentGate: DesignGate<"design_establishment"> = {
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
        designDiagnostic(
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
        designDiagnostic(
          "design_establishment",
          "not_established_no_override",
          "error",
          formatDesignMessage("establishment_blocked_no_override", {}),
        ),
      ];
    }
    if (ctx.profile.design_override_forbidden) {
      return [
        designDiagnostic(
          "design_establishment",
          "override_forbidden",
          "error",
          formatDesignMessage("override_forbidden_by_profile", {}),
        ),
      ];
    }
    return [
      designDiagnostic(
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
export const designDecisionGate: DesignGate<"design_decision"> = {
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
        designDiagnostic(
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
        designDiagnostic(
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
        designDiagnostic(
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
          designDiagnostic(
            "design_decision",
            "option_not_qualifying",
            "error",
            formatDesignMessage("decision_option_not_qualifying", { selectedOptionId }),
          ),
        ];
      }
      if (ctx.profile.design_override_forbidden) {
        return [
          designDiagnostic(
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
        designDiagnostic(
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

/**
 * I-2026-08-29-external-verify-gate — turns the runner's already-computed outcome into
 * diagnostics. Every failure is an `error`; nothing here is advisory, because the whole point
 * is that an unverified lane must not reach 4_verify (spec.md D7).
 *
 * appliesTo is the 3_implement -> 4_verify phase_advance edge ONLY. Deliberately narrower than
 * successCriteriaGate, which also matches `before_pr_publish`: `lane validate` evaluates both
 * triggers in one run, so matching both would run the external command twice per validate
 * (spec.md D4). It also never matches `promotion`, so `advance --phase 5_done` re-runs nothing
 * (intent non_goal / spec.md L2).
 *
 * Note this gate reports on work already done rather than doing it: if the caller did not
 * populate `artifacts.externalVerify` (because it is not this edge, or nothing was configured)
 * the gate is silent. That keeps "configured nothing -> changed nothing" true by construction.
 */
export const externalVerifyGate: Gate = {
  id: "external_verify",
  appliesTo: (ctx) => isExternalVerifyTrigger(ctx.trigger),
  evaluate: (ctx) => {
    const outcome = ctx.artifacts.externalVerify;

    // An absent artifact is how a lane that configured NOTHING reaches here (gate-check.ts
    // returns undefined), and for that lane the gate must contribute nothing at all.
    //
    // But absence alone is not evidence of that. Read on its own it says only "no result was
    // supplied", which is equally what a caller that forgot to run the verifier looks like --
    // and for a lane whose intent DOES declare a command, treating that as success authorizes
    // the 3->4 edge with no verification behind it. This is the same fail-open the removed
    // `skipped` variant carried, reached through the absent case instead of a spurious value,
    // so removing that variant did not by itself close it. Reproduced against the gate
    // directly: a configured intent with no artifact returned zero diagnostics.
    //
    // The intent is the thing that says which of the two absences this is, so it is what
    // decides.
    if (!outcome) {
      if (!ctx.artifacts.intent.external_verify) return [];
      return [
        diagnostic(
          "external_verify",
          "missing_result",
          "error",
          "external_verify failed (missing_result): this lane declares external_verify.argv, but no verification result reached the gate. The command was therefore never shown to have passed, and the transition is refused rather than allowed on the strength of a missing answer. This is an internal inconsistency, not a configuration problem -- the caller that built the gate context did not run the verifier. Please report it.",
        ),
      ];
    }
    if (outcome.kind === "passed") return [];

    if (outcome.kind === "refused") {
      if (outcome.code === "unauthorized") {
        return [
          diagnostic(
            "external_verify",
            "unauthorized",
            "error",
            `external_verify failed (unauthorized): this exact command is not authorized, so it was NOT run. Authorization covers the whole command -- every argv element, the timeout, AND the working directory it would run in -- so the same command in a different checkout needs its own entry. To authorize it here, add this digest to allowed_command_digests in ~/.config/lane/external-verify.yaml (lane always reads that literal path; it deliberately does not follow LANE_CONFIG_DIR or XDG_CONFIG_HOME, though $HOME still moves it): ${outcome.commandDigest}`,
          ),
        ];
      }
      if (outcome.code === "authorization_in_profile") {
        return [
          diagnostic(
            "external_verify",
            "authorization_in_profile",
            "error",
            "external_verify failed (authorization_in_profile): the command was NOT run because the resolved profile still carries external_verify.allowed_command_digests. Authorization no longer lives in the profile -- a profile can be selected by --profile or LANE_PROFILE_PATH, and a repository legitimately sets the latter, so it was never evidence that an operator vetted anything. Move the digests to ~/.config/lane/external-verify.yaml -- that literal path, NOT lane's configurable config directory -- and remove the profile entry.",
          ),
        ];
      }
      if (outcome.code === "intent_modified_during_verification") {
        return [
          diagnostic(
            "external_verify",
            "intent_modified_during_verification",
            "error",
            "external_verify failed (intent_modified_during_verification): the verification command ran, but intent.yaml changed while it was running, so this transition would have been decided against an intent that no longer exists on disk. That matters most for external_verify itself: the gate does not run again on the 4_verify -> 5_done edge, so a command swapped in after the authorized one passed would never be checked at all, while the recorded snapshot vouched for the command that did run. Re-run `lane advance` now that the file has settled; nothing was recorded.",
          ),
        ];
      }
      if (outcome.code === "authorization_store_unresolvable") {
        return [
          diagnostic(
            "external_verify",
            "authorization_store_unresolvable",
            "error",
            "external_verify failed (authorization_store_unresolvable): the command was NOT run because ~/.config/lane/external-verify.yaml could be read but its real path could not be resolved -- a dangling symlink, a symlink loop (ELOOP), a permissions change, or a directory that moved while lane was reading it. lane will not reason about where a file sits when it cannot tell where it is. This is NOT the overlap case: moving the store will not help. Check what the path actually points at.",
          ),
        ];
      }
      if (outcome.code === "authorization_store_unreadable") {
        return [
          diagnostic(
            "external_verify",
            "authorization_store_unreadable",
            "error",
            `external_verify failed (authorization_store_unreadable): the command was NOT run because ~/.config/lane/external-verify.yaml exists but could not be read or parsed. Only a store that is genuinely ABSENT authorizes nothing; one that is there but unusable is refused instead, because degrading it to an empty allow-list would resurface as a refusal about the wrong thing -- telling you to add a digest that may already be sitting in the file. Common causes: a misspelled key (the only recognized one is \`allowed_command_digests\`, plural), or the path not being a readable regular file.${outcome.detail === undefined ? "" : ` Parse error: ${outcome.detail}`}`,
          ),
        ];
      }
      if (outcome.code === "authorization_store_inside_workspace") {
        return [
          diagnostic(
            "external_verify",
            "authorization_store_inside_workspace",
            "error",
            "external_verify failed (authorization_store_inside_workspace): the command was NOT run because ~/.config/lane/external-verify.yaml resolves to a path inside the repository being gated (or the spec directory's repository). The usual cause is a dotfiles setup that symlinks ~/.config into a repository -- if that repository is the one being gated, then anything able to edit the worktree can append its own digest to the store without any access to your home directory, which defeats the whole point of authorizing separately. Move the store outside the gated tree, or gate a different tree. Note this check finds an accidental overlap; it is not a barrier against someone deliberately arranging one (spec.md section 7, L14).",
          ),
        ];
      }
      return [
        diagnostic(
          "external_verify",
          "recursion_blocked",
          "error",
          "external_verify failed (recursion_blocked): the command was NOT run because lane is already running inside an external verify command (LANE_EXTERNAL_VERIFY_ACTIVE is set in this environment). A verify command must not invoke lane in a way that re-enters this gate.",
        ),
      ];
    }

    const detail: string[] = [];
    if (outcome.exitStatus !== null) detail.push(`exit_status=${outcome.exitStatus}`);
    if (outcome.signal !== null) detail.push(`signal=${outcome.signal}`);
    if (outcome.errno !== null) detail.push(`errno=${outcome.errno}`);
    const suffix = outcome.outputTail
      ? `\n--- external_verify output (tail, not redacted by lane) ---\n${outcome.outputTail}`
      : "";
    return [
      diagnostic(
        "external_verify",
        outcome.code,
        "error",
        `external_verify failed (${outcome.code}${detail.length > 0 ? `, ${detail.join(", ")}` : ""}). The transition is refused, and no phase change or gate snapshot is recorded.${suffix}`,
      ),
    ];
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

/**
 * M1 default registry, extended by the gate-port review with the two pilot-ported gates,
 * and by I-2026-08-20-promotion-invariants with the two promotion-only gates (both no-op
 * on every other trigger via their own appliesTo()).
 */
/**
 * Every design gate, keyed by its id.
 *
 * The mapped type is what makes this a registry rather than a list: adding a member to
 * `DesignGateId` without registering a gate for it stops compiling, so the id union and the gates
 * cannot drift apart. `packages/cli/test/helpers/design-message-scan.ts` keys its scan on the same
 * ids, and a design gate that exists but is registered nowhere would be checked by neither.
 */
export const DESIGN_GATES: { [K in DesignGateId]: DesignGate<K> } = {
  design_establishment: designEstablishmentGate,
  design_decision: designDecisionGate,
};

export const DEFAULT_GATES: readonly Gate[] = [
  premiseEvidenceGate,
  successCriteriaGate,
  specConsensusGate,
  designEstablishmentGate,
  designDecisionGate,
  gateRulesetVersionGate,
  promotionWeakeningGate,
  externalVerifyGate,
];
