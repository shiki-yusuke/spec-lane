import {
  type CalibrationObservation,
  type Estimate,
  type EstimateRevision,
  EstimateRevisionSchema,
  type ImpactScanSnapshot,
  type Intent,
  type Phase,
  type Predictors,
  type Profile,
  TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
  type Verification,
} from "@lane/schemas";
import { estimate as runEstimator } from "../estimator.js";

// design.md §2.6/§3.8 — the only way to add a revision. There is deliberately no
// update/replace export: retroactively editing a past prediction would introduce
// hindsight bias into the calibration loop this whole feature exists to support. `lane
// estimate` always creates a new revision; `lane estimate --adopt <id>` only ever updates
// intent.baseline_estimate_revision_id (adoptBaselineRevision below), never the revision
// itself.
export function appendRevision(estimate: Estimate, revision: EstimateRevision): Estimate {
  if (estimate.revisions.some((r) => r.revision_id === revision.revision_id)) {
    throw new Error(
      `revision_id ${revision.revision_id} already exists in estimate.json (revisions are append-only)`,
    );
  }
  return { ...estimate, revisions: [...estimate.revisions, revision] };
}

export function createEstimate(
  intentId: string,
  schemaVersion: string,
  firstRevision: EstimateRevision,
): Estimate {
  return { schema_version: schemaVersion, intent_id: intentId, revisions: [firstRevision] };
}

/**
 * `lane next` and friends only ever read intent.baseline_estimate_revision_id — this is
 * the one function that is allowed to set it, and it never touches estimate.revisions.
 *
 * `adoptedAt` is a required, caller-supplied timestamp (never computed inside this pure
 * function) so the audit trail (`baseline_adopted_at`, M2 review follow-up 2026-07-31) is
 * testable and doesn't depend on wall-clock time. This same function backs both `lane
 * estimate --adopt` (new revision, adopted immediately) and `lane estimate --adopt
 * <revision-id>` (re-pointing to an already-existing revision, no new revision created) —
 * both are "adopt" in the sense this function cares about: only the baseline pointer moves.
 */
export function adoptBaselineRevision(
  intent: Intent,
  revisionId: string,
  estimate: Estimate,
  adoptedAt: string,
): Intent {
  if (!estimate.revisions.some((r) => r.revision_id === revisionId)) {
    throw new Error(
      `revision_id ${revisionId} does not exist in estimate.json for intent ${intent.intent_id}`,
    );
  }
  return { ...intent, baseline_estimate_revision_id: revisionId, baseline_adopted_at: adoptedAt };
}

export function findBaselineRevision(
  intent: Intent,
  estimate: Estimate,
): EstimateRevision | undefined {
  if (!intent.baseline_estimate_revision_id) return undefined;
  return estimate.revisions.find((r) => r.revision_id === intent.baseline_estimate_revision_id);
}

/**
 * design.md §2.6 — files_touched_estimate comes from impact-scan's candidate path count
 * (not an allowed_paths glob count, which measures "how wide the permission is", not "how
 * many files are predicted to change" — sol's rev1 critique). spec_rule_count is null
 * (not 0) until Phase 2's verification.yaml exists. novel_surface is always "unknown"
 * here: M2 does not wire a knowledge-DB novelty check into estimate-service yet, and
 * guessing "false" would misrepresent an unchecked question as a checked one.
 */
export function buildPredictorsFromIntent(
  intent: Intent,
  impactScan: ImpactScanSnapshot | undefined,
  verification: Verification | undefined,
): Predictors {
  return {
    files_touched_estimate: impactScan ? impactScan.candidate_paths.length : null,
    files_touched_observed: null,
    layers_crossed: impactScan ? impactScan.candidate_layers.length : null,
    risk_class: intent.intent.declared_risk,
    spec_rule_count: verification ? verification.test_matrix.length : null,
    novel_surface: "unknown",
  };
}

export interface BuildEstimateRevisionInput {
  revisionId: string;
  estimatedAt: string;
  asOfPhase: Phase;
  repoCommit: string;
  impactScanSnapshot?: ImpactScanSnapshot;
  estimatorVersion: string;
  predictors: Predictors;
  population: readonly CalibrationObservation[];
  profile: Profile;
  /**
   * MP-8 (2026-08-08, sol ruling point 7) — optional now: `estimate()` only actually
   * needs one when the (basis-filtered) population is too small for a k-NN prediction,
   * and throws ReferenceTableRequiredError if it needed one and none was given. There is
   * no more silent placeholder default -- the caller decides whether it has a real
   * reference table to offer, not this function.
   */
  referenceTable?: { predicted: EstimateRevision["predicted"] };
}

/**
 * Runs core/estimator.ts's estimate() and assembles a full, schema-valid EstimateRevision.
 * Propagates estimator.ts's ReferenceTableRequiredError uncaught -- the CLI is
 * responsible for turning that into a clean error message.
 */
export function buildEstimateRevision(input: BuildEstimateRevisionInput): EstimateRevision {
  const result = runEstimator(
    input.predictors,
    input.population,
    input.profile,
    input.referenceTable,
  );
  return EstimateRevisionSchema.parse({
    revision_id: input.revisionId,
    estimated_at: input.estimatedAt,
    as_of_phase: input.asOfPhase,
    repo_commit: input.repoCommit,
    impact_scan_snapshot: input.impactScanSnapshot,
    estimator_version: input.estimatorVersion,
    predictors: input.predictors,
    predicted: result.predicted,
    token_basis: TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
    neighbors: result.neighbors,
    population_condition: {
      population_size: result.populationCondition.populationSize,
      method: result.populationCondition.method,
      experimental: result.populationCondition.experimental,
      leave_one_out_p50_error: result.populationCondition.leaveOneOutP50Error,
      leave_one_out_p80_coverage: result.populationCondition.leaveOneOutP80Coverage,
    },
  });
}
