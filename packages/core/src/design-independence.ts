import type { CriticReview, DesignOptionsDoc, EngineRef } from "@lane/schemas";
import { formatDesignMessage } from "./design-messages.js";
import {
  deriveIndependenceStatus,
  type DerivedStatus,
  engineRefIssues as vendoredEngineRefIssues,
  evaluateQualifying,
} from "./vendor/derive-independence/v1/derive-independence.mjs";

// I-2026-08-18-design-critic-injection R12-R26 — the only lane-owned logic here is
// (a) adapting @lane/schemas' typed shapes to the vendored module's plain-object inputs,
// and (b) composing PER-OPTION COVERAGE (R24/R25) and per-review catalogued reason text
// (R26/R45/R46) on top of what the vendored module already returns. The actual lineage
// derivation (R16-R19), the qualifying conjunction (R23), and the engine_ref per-kind
// completeness check (part of R14) are NOT reimplemented (R37) -- every one of those calls
// straight into packages/core/src/vendor/derive-independence/v1/derive-independence.mjs.

export interface ReviewEvaluation {
  reviewIndex: number;
  derivedStatus: DerivedStatus;
  qualifying: boolean;
  /** Verbatim reasons from the vendored module, plus this lane's own catalogued additions. */
  reasons: string[];
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
  const reasons = [
    ...lineage.reasons,
    ...gate.reasons,
    formatDesignMessage("qualifying_conjunction_result", {
      reviewIndex,
      qualifying: gate.qualifying,
    }),
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
export function computeCoverage(doc: DesignOptionsDoc, evaluations: ReviewEvaluation[]): OptionCoverage[] {
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

/** R15: reject a review with no reachable output reference (already schema-required to be
 * *present*; this additionally requires it to actually resolve to content or an honest
 * digest_omitted_reason, i.e. not simply `{logical_id}` with nothing else -- an artifact_ref
 * that names nothing checkable is not "reachable"). */
export function checkReviewOutputReachable(review: CriticReview): boolean {
  const ref = review.review_output_ref;
  return ref.content_digest !== undefined || ref.digest_omitted_reason !== undefined;
}
