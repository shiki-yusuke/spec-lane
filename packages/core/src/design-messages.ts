// I-2026-08-18-design-critic-injection R45/R46 — every message the new `lane design *`
// commands and gates emit is addressed by a stable id in this catalog, never keyed by its
// own source text (R45), and reason text is composed by filling named placeholders into a
// whole catalogued template, never by concatenating fragments (R46: contrast with e.g.
// gate.ts's premiseEvidenceGate, which is free to build a message out of string
// concatenation because it predates this rule and is not one of "the new commands").
//
// `formatDesignMessage` fails closed (throws) on an unknown id or a template/params
// mismatch -- a silently-wrong reason string would defeat R26 ("report the reasons ... never
// a bare verdict") by looking like a real reason while actually being malformed.

export const DESIGN_MESSAGE_CATALOG = {
  activation_recorded: "the design track was activated by {activatedBy} at {activatedAt}",
  producer_supplied_classification_rejected:
    'field "{fieldName}" is a producer-supplied independence classification; this lane only accepts a derived classification, never one written by the document\'s own author (R16)',
  review_output_ref_missing:
    "critic_reviews[{reviewIndex}] has no reachable review_output_ref; a review with no output cannot be counted (R15)",
  absolute_no_involvement_rejected:
    "critic_reviews[{reviewIndex}].prior_involvement cannot assert universal non-involvement; only none_observed_in_recorded_scope (bounded to a stated, checkable scope) is expressible (R20)",
  observation_scope_ref_missing:
    "critic_reviews[{reviewIndex}] claims prior_involvement=none_observed_in_recorded_scope but has no observation_scope_ref naming what was actually examined (R21)",
  relation_comparison: "vs shaper {shaperDescription} (how={how}): {relation} -- {reason}",
  closest_relation_selected:
    "closest (least independent) relationship across all shapers: {relation}",
  qualifying_lineage_clears:
    "derived_status={derivedStatus} clears the lineage dimension (different_lineage or human_third_party)",
  qualifying_lineage_fails:
    "derived_status={derivedStatus} does not clear the lineage dimension (needs different_lineage or human_third_party)",
  qualifying_involvement_clears:
    "prior_involvement={priorInvolvement} clears the involvement dimension (none_observed_in_recorded_scope)",
  qualifying_involvement_fails:
    "prior_involvement={priorInvolvement} does not clear the involvement dimension (needs none_observed_in_recorded_scope)",
  qualifying_conjunction_result:
    "critic_reviews[{reviewIndex}] qualifying={qualifying}: both the lineage and involvement dimensions must clear (R23)",
  coverage_missing_for_option: "option {optionId} has no qualifying review covering it",
  coverage_present_for_option:
    "option {optionId} is covered by {qualifyingCount} qualifying review(s)",
  design_options_missing:
    "the design track is active but no design_options revision has been submitted yet; run `lane design submit` before advancing past 1_intent (R34)",
  establishment_established:
    "establishment=established: every option in decision_request.option_ids is covered by at least one qualifying review (R27)",
  establishment_blocked_no_override:
    "establishment could not be shown (no qualifying coverage, or coverage is partial) and no override is recorded; the transition is blocked (R29)",
  establishment_not_established_override:
    "establishment=not-established, operator-asserted via override by {actor} at {overriddenAt}: {reason} (R28/R32)",
  override_rejected_not_scoped:
    "override rejected: not scoped to the active design_options revision and its uncovered options (R31)",
  override_rejected_artifact_field:
    "override rejected: an override recorded as a field inside a document the same agent authors is not accepted; use `lane design override` (R30)",
  override_forbidden_by_profile:
    "the active profile forbids the design override; the transition is blocked regardless of any override recorded (R33)",
  decision_missing:
    "no decision record is bound to the active design_options revision; run `lane design decide` before the implement phase (R35)",
  decision_option_not_qualifying:
    "decision.selected_option_id={selectedOptionId} was not covered by a qualifying review, and no override scoped to that option is recorded (R35)",
  decision_option_unknown:
    "decision.selected_option_id={selectedOptionId} does not name an option in the active design_options revision (R35)",
  spec_missing_selected_option_reference:
    "spec.md does not reference the selected option identifier {selectedOptionId} (R36)",
  pin_unresolvable:
    "vendored derivation pin is unresolvable: upstream commit {commit} does not exist in the upstream checkout at all (remedy: re-pin to a current upstream commit, per UPSTREAM marker at {markerPath}) (R40)",
  pin_not_on_main:
    "vendored derivation pin resolves but is not an ancestor of upstream main: commit {commit} exists only on a branch (remedy: re-pin to a commit on upstream main once merged, per UPSTREAM marker at {markerPath}) (R39/R40)",
  pin_content_mismatch:
    "vendored derivation content mismatch: recorded tree hash {recordedHash} does not match the vendored bytes' actual hash {actualHash} (remedy: re-vendor from the pinned commit) (R40)",
  // R45/R46 (team-lead review, 2026-08-19): "every message the new commands emit" is not
  // scoped to gate diagnostics alone -- the `lane design *` CLI commands' own output
  // (errors, confirmations) is included too. These entries close that gap; the
  // exhaustiveness check lives in packages/cli/test/design-message-catalog.test.ts.
  design_lane_not_found: "Lane state not found: {intentId}",
  design_not_activated: "{intentId} was not started with --design; the design track is not active",
  design_file_read_failed: "could not read/parse {file}: {detail}",
  design_submit_schema_invalid: "{file} does not conform to design-options/v1: {detail}",
  design_submit_rejected: "rejected (lane-owned checks): {problems}",
  design_decision_request_dangling_option:
    "decision_request.option_ids references unknown option_id(s): {ids}",
  design_submit_success:
    "active design_options revision for {intentId} -> {digest} (design_options_id={designOptionsId})",
  design_override_recorded: "recorded override for {intentId} scoped to {digest}",
  design_decide_recorded: "recorded decision for {intentId}: {optionId} (bound to {digest})",
  design_status_header: "design_options_id={designOptionsId} content_digest={contentDigest}",
  design_status_option_coverage: "option {optionId}: covered={covered} ({reasons})",
  design_status_review_summary:
    "critic_reviews[{reviewIndex}]: derived_status={derivedStatus} qualifying={qualifying}",
  design_status_totals: "total_reviews={totalReviews} qualifying_reviews={qualifyingReviews}",
  engine_ref_prohibited_human_format:
    'engine_ref.human_ref matched a prohibited address-shaped format ("{matchedFormat}"); this lane rejects the format, it does not attempt to decide whether the value denotes a natural person (R43/R44a)',
  engine_ref_prohibited_session_format:
    'engine_ref.session_ref matched a prohibited credential-shaped format ("{matchedFormat}") (R44)',
} as const;

export type DesignMessageId = keyof typeof DESIGN_MESSAGE_CATALOG;

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Fills a catalogued template's named placeholders. Throws (fail closed, matching this
 * repo's other fail-closed conventions) rather than emitting a partially-filled string when
 * `id` is unknown or a placeholder in the template has no matching key in `params` -- a
 * reason string that silently kept a literal "{foo}" in it would be worse than an error,
 * since R26 requires every qualify/not-qualify verdict to always carry a legible reason.
 */
export function formatDesignMessage(
  id: DesignMessageId,
  params: Record<string, string | number | boolean> = {},
): string {
  const template = DESIGN_MESSAGE_CATALOG[id];
  if (template === undefined) {
    throw new Error(`formatDesignMessage: unknown message id "${id}"`);
  }
  return template.replace(PLACEHOLDER_RE, (match, key: string) => {
    if (!(key in params)) {
      throw new Error(
        `formatDesignMessage: template "${id}" references placeholder {${key}} with no matching param`,
      );
    }
    return String(params[key]);
  });
}
