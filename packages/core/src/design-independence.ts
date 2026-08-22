import type { CriticReview, DesignOptionsDoc, EngineRef } from "@lane/schemas";
import { type CatalogBackedDesignMessage, formatDesignMessage } from "./design-messages.js";
import {
  type DerivedStatus,
  type ReasonRecord,
  deriveIndependenceStatus,
  evaluateQualifying,
  engineRefIssues as vendoredEngineRefIssues,
} from "./vendor/derive-independence/v1/derive-independence.mjs";

// I-2026-08-18-design-critic-injection R12-R26 — the only lane-owned logic here is
// (a) adapting @lane/schemas' typed shapes to the vendored module's plain-object inputs,
// and (b) composing PER-OPTION COVERAGE (R24/R25) and per-review catalogued reason text
// (R26/R45/R46) on top of what the vendored module already returns. The actual lineage
// derivation (R16-R19), the qualifying conjunction (R23), and the engine_ref per-kind
// completeness check (part of R14) are NOT reimplemented (R37) -- every one of those calls
// straight into packages/core/src/vendor/derive-independence/v1/derive-independence.mjs.

/**
 * R46 (2026-08-22 re-vendor, I-2026-08-22-r46-vendored-reason-catalog): maps ONE vendored
 * `{code, params}` reason_record onto a whole catalogued message -- never a raw vendored
 * string, and never string concatenation. `shaper_relation`'s nested `params.inner` is
 * mapped recursively so a multi-level reason (e.g. "vs shaper X: same_provider_different_family
 * -- same provider (Y), different family (...)") is composed entirely from catalog
 * templates, not a catalogued wrapper glued to a raw inner sentence.
 *
 * `context.reviewIndex` is NOT part of the vendored record -- the vendored module has no
 * concept of "which review in a document this is" (that is this codebase's own indexing,
 * see evaluateReview below). It exists only because the "conjunction" code maps onto
 * `qualifying_conjunction_result`, the one catalog entry here that names a reviewIndex.
 *
 * The `switch` is exhaustive over the vendored module's own closed `ReasonCode` union (the
 * `default` branch's `record: never` only compiles because every real case is handled
 * above it), so a re-vendor that adds a new code fails to typecheck here until a matching
 * `case` is added -- the type-level half of the living-contract test in
 * design-independence-reason-catalog.test.ts, which checks the same completeness at
 * runtime against the vendored module's own `REASON_CODES` array. The runtime `default`
 * additionally fails closed (throws, never renders a placeholder guess) for a record whose
 * `code` doesn't match any of the vendored module's own REASON_CODES at all -- reachable
 * only from corrupted/fabricated input (the vendored module itself only ever produces one
 * of the closed set), matching this repo's own fail-closed convention elsewhere.
 */
export function mapReasonRecordToDesignMessage(
  record: ReasonRecord,
  context: { reviewIndex: number },
): CatalogBackedDesignMessage {
  switch (record.code) {
    case "critic_ref_missing":
      return formatDesignMessage("independence_critic_ref_missing", {});
    case "human_third_party":
      return formatDesignMessage("independence_human_third_party", {});
    case "human_is_decision_maker":
      return formatDesignMessage("independence_human_is_decision_maker", {});
    case "human_missing_decision_maker_flag":
      return formatDesignMessage("independence_human_missing_decision_maker_flag", {});
    case "no_artifact_shapers":
      return formatDesignMessage("independence_no_artifact_shapers", {});
    case "shaper_relation":
      return formatDesignMessage("relation_comparison", {
        shaperDescription: record.params.shaper_desc,
        how: record.params.how,
        relation: record.params.relation,
        reason: mapReasonRecordToDesignMessage(record.params.inner, context),
      });
    case "unknown_shaper_comparison":
      return formatDesignMessage("independence_unknown_shaper_comparison", {});
    case "closest_relation":
      return formatDesignMessage("closest_relation_selected", {
        relation: record.params.relation,
      });
    case "no_shared_lineage_possible":
      return formatDesignMessage("independence_no_shared_lineage_possible", {
        shaperKind: record.params.shaper_kind ?? "unrecorded",
        criticKind: record.params.critic_kind ?? "unrecorded",
      });
    case "provider_unknown":
      return formatDesignMessage("independence_provider_unknown", {});
    case "different_provider":
      return formatDesignMessage("independence_different_provider", {
        shaperProvider: record.params.shaper_provider,
        criticProvider: record.params.critic_provider,
      });
    case "same_provider_different_family":
      return formatDesignMessage("independence_same_provider_different_family", {
        provider: record.params.provider,
        shaperFamily: record.params.shaper_family,
        criticFamily: record.params.critic_family,
      });
    case "same_family_different_model":
      // The vendored module folds "+family" into ONE fragment-assembled sentence
      // (`same provider${family_confirmed ? "+family" : ""} (...)`) -- R46 forbids
      // exactly that here, so this is two whole catalog templates instead, chosen by
      // family_confirmed, never one template with a conditionally-inserted fragment.
      return formatDesignMessage(
        record.params.family_confirmed
          ? "independence_same_family_different_model_family_confirmed"
          : "independence_same_family_different_model",
        {
          provider: record.params.provider,
          shaperModelId: record.params.shaper_model_id,
          criticModelId: record.params.critic_model_id,
        },
      );
    case "same_session_ref":
      return formatDesignMessage("independence_same_session_ref", {});
    case "different_session_ref":
      return formatDesignMessage("independence_different_session_ref", {});
    case "session_ref_one_side":
      return formatDesignMessage("independence_session_ref_one_side", {});
    case "session_ref_neither_side":
      return formatDesignMessage("independence_session_ref_neither_side", {});
    case "lineage_dimension":
      return formatDesignMessage(
        record.params.clears ? "qualifying_lineage_clears" : "qualifying_lineage_fails",
        { derivedStatus: record.params.derived_status },
      );
    case "involvement_dimension":
      return formatDesignMessage(
        record.params.clears ? "qualifying_involvement_clears" : "qualifying_involvement_fails",
        {
          // @lane/schemas' PriorInvolvementSchema requires this field (never optional), so
          // every real call site passes a concrete value; the vendored signature accepts
          // null/undefined only because it has no dependency on lane's own schemas
          // (R37) -- "unrecorded" is a defensive fallback, not an expected runtime value.
          priorInvolvement: record.params.prior_involvement ?? "unrecorded",
        },
      );
    case "conjunction":
      return formatDesignMessage("qualifying_conjunction_result", {
        reviewIndex: context.reviewIndex,
        qualifying: record.params.qualifying,
      });
    default: {
      const unreachable: never = record;
      throw new Error(
        `mapReasonRecordToDesignMessage: unrecognized reason code ${JSON.stringify(
          (unreachable as ReasonRecord).code,
        )} (vendored pin bumped without updating this mapping?)`,
      );
    }
  }
}

export interface ReviewEvaluation {
  reviewIndex: number;
  derivedStatus: DerivedStatus;
  qualifying: boolean;
  /** R46: every reason composed from a whole catalogued message, never a raw vendored
   * string -- see mapReasonRecordToDesignMessage. */
  reasons: CatalogBackedDesignMessage[];
}

/** R13/R14 completeness check, delegated to the vendored module's own engineRefIssues. */
export function checkEngineRefCompleteness(engineRef: EngineRef, label: string): string[] {
  return vendoredEngineRefIssues(engineRef, label);
}

/**
 * R16-R19, R23: derives independence + qualification for one critic_reviews[] entry
 * against every artifact_shapers[] entry of the same document, taking the closest (R18).
 */
export function evaluateReview(doc: DesignOptionsDoc, reviewIndex: number): ReviewEvaluation {
  const review = doc.critic_reviews[reviewIndex];
  if (!review) {
    throw new Error(`evaluateReview: no critic_reviews[${reviewIndex}] in this document`);
  }
  const lineage = deriveIndependenceStatus({
    artifactShapers: doc.artifact_shapers,
    critic: review.critic,
  });
  const gate = evaluateQualifying({
    derived_status: lineage.derived_status,
    prior_involvement: review.prior_involvement,
  });
  const context = { reviewIndex };
  // gate.reason_records' own last entry is always "conjunction" (evaluateQualifying pushes
  // it unconditionally), which maps onto qualifying_conjunction_result -- no separate,
  // manually-built duplicate of that summary line is pushed here any more (R46: it must
  // come from a mapped reason_record like every other line, not be assembled by hand).
  const reasons = [
    ...lineage.reason_records.map((r) => mapReasonRecordToDesignMessage(r, context)),
    ...gate.reason_records.map((r) => mapReasonRecordToDesignMessage(r, context)),
  ];
  return {
    reviewIndex,
    derivedStatus: lineage.derived_status,
    qualifying: gate.qualifying,
    reasons,
  };
}

export function evaluateAllReviews(doc: DesignOptionsDoc): ReviewEvaluation[] {
  return doc.critic_reviews.map((_, i) => evaluateReview(doc, i));
}

export interface OptionCoverage {
  optionId: string;
  qualifyingReviewIndexes: number[];
  totalReviewIndexes: number[];
  covered: boolean;
  reasons: string[];
}

/**
 * R24/R25: per-option coverage for every option_id decision_request actually asks about
 * (not necessarily every options[] entry -- decision_request.option_ids is the set "offered
 * for decision", matching R24's own wording). R25: this is reported per-option and BEFORE
 * any total/qualifying count is shown -- see computeEstablishment below for where the two
 * counts (total, qualifying) are finally surfaced, always alongside this coverage map, never
 * alone.
 */
export function computeCoverage(
  doc: DesignOptionsDoc,
  evaluations: ReviewEvaluation[],
): OptionCoverage[] {
  return doc.decision_request.option_ids.map((optionId) => {
    const matching = doc.critic_reviews
      .map((review, i) => ({ review, i }))
      .filter(({ review }) => review.target_option_ids.includes(optionId));
    const totalReviewIndexes = matching.map(({ i }) => i);
    const qualifyingReviewIndexes = matching
      .filter(({ i }) => evaluations[i]?.qualifying)
      .map(({ i }) => i);
    const covered = qualifyingReviewIndexes.length > 0;
    const reasons = [
      covered
        ? formatDesignMessage("coverage_present_for_option", {
            optionId,
            qualifyingCount: qualifyingReviewIndexes.length,
          })
        : formatDesignMessage("coverage_missing_for_option", { optionId }),
    ];
    return { optionId, qualifyingReviewIndexes, totalReviewIndexes, covered, reasons };
  });
}

export interface IndependenceSummary {
  evaluations: ReviewEvaluation[];
  coverage: OptionCoverage[];
  totalReviews: number;
  qualifyingReviews: number;
  /** R27/R24: every decision_request.option_ids entry has covered===true. */
  everyOptionCovered: boolean;
}

/** Top-level entry point: R12-R26 combined, everything computed fresh (R17), never stored. */
export function summarizeIndependence(doc: DesignOptionsDoc): IndependenceSummary {
  const evaluations = evaluateAllReviews(doc);
  const coverage = computeCoverage(doc, evaluations);
  return {
    evaluations,
    coverage,
    totalReviews: evaluations.length,
    qualifyingReviews: evaluations.filter((e) => e.qualifying).length,
    everyOptionCovered: coverage.every((c) => c.covered),
  };
}

/**
 * R15: reject a review with no reachable output reference. Already schema-required to be
 * *present* (upstream's design-options/v1 requires review_output_ref); this additionally
 * requires a real `content_digest`, stricter than `intent_ref`/`observation_scope_ref`/
 * `notes_ref` (which accept `digest_omitted_reason` as an honest alternative).
 *
 * Team-lead review (2026-08-19): accepting `digest_omitted_reason` here reopened exactly
 * the hole R15 exists to close. `digest_omitted_reason` is legitimate when a reference
 * genuinely cannot be hashed (upstream's own example: a prose chat brief that was never a
 * file at all) -- but a critic's review output is always something the operator saved as a
 * file, so it is always hashable. Accepting the same escape hatch here would let "a review
 * without a reachable output" (Gherkin) through by simply writing
 * `digest_omitted_reason: "not preserved"` instead of an actual digest -- lane is free to
 * hold this field to a higher bar than the generic upstream artifact_ref allows, since
 * upstream only defines the shape, not which fields each consumer must fill in.
 */
export function checkReviewOutputReachable(review: CriticReview): boolean {
  const ref = review.review_output_ref;
  return ref.content_digest !== undefined;
}
