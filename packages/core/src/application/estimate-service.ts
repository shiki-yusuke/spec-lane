import {
  type CalibrationObservation,
  type Estimate,
  type EstimateRevision,
  EstimateRevisionSchema,
  type ImpactScanSnapshot,
  type Intent,
  type Phase,
  type Predicted,
  type Predictors,
  type Profile,
  TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
  type Verification,
} from "@lane/schemas";
import { type NovelSurfaceDeclaration, buildEstimateV2Decision } from "../estimator-v2.js";
import { ReferenceTableRequiredError, estimate as runEstimator } from "../estimator.js";

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
 * Thrown by `adoptBaselineRevision` when `revisionId` names a revision that has no
 * `predicted` value at all (`population_condition.method === "abstained"` -- MP-8
 * abstain-first fix), so it has nothing for `lane next`/`lane calibrate` to compare a
 * budget or a measured actual against.
 *
 * Deliberately narrower than "decision_v2 abstained": estimate/v2 can (and often does)
 * abstain for reasons that leave v1's own `predicted` intact -- e.g. NOVEL_SURFACE_UNKNOWN
 * or a cohort mismatch, both computed over v2's own stricter population while v1's
 * broader population still yields a knn_quantile/reference_table prediction (see
 * buildEstimateRevision) -- and adopting *that* kind of revision as an interim baseline
 * has always been allowed; this only blocks the specific case where there is no number
 * at all to adopt. Both `lane estimate --adopt` (bare) and `lane estimate --adopt
 * <revision-id>` route through this one function, so this is the single place the rule
 * is enforced.
 */
export class AbstainedRevisionCannotBeBaselineError extends Error {
  constructor(revisionId: string, reasonCodes: readonly string[]) {
    super(
      `revision_id ${revisionId} is abstained (estimate/v2 reason_codes=${reasonCodes.join(", ")}) and has no predicted value -- an abstained revision can never become the baseline (nothing to compare "lane next"/"lane calibrate" against)`,
    );
    this.name = "AbstainedRevisionCannotBeBaselineError";
  }
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
  const revision = estimate.revisions.find((r) => r.revision_id === revisionId);
  if (!revision) {
    throw new Error(
      `revision_id ${revisionId} does not exist in estimate.json for intent ${intent.intent_id}`,
    );
  }
  if (revision.predicted === undefined) {
    throw new AbstainedRevisionCannotBeBaselineError(
      revisionId,
      revision.decision_v2?.decision.reason_codes ?? [],
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
  referenceTable?: { predicted: Predicted };
  /** M0 spec §6 — a human's `--novel-surface established|novel` declaration, recorded
   * with provenance on the revision and used to resolve estimate/v2's NOVEL_SURFACE_UNKNOWN
   * abstain when `predictors.novel_surface === "unknown"`. */
  novelSurfaceDeclaration?: NovelSurfaceDeclaration;
  /** Optional profile-level neighbor-distance gate for estimate/v2's DISTANCE_ABOVE_THRESHOLD. */
  distanceThreshold?: number;
}

/**
 * Runs core/estimator-v2.ts's buildEstimateV2Decision (the estimate/v2 honesty layer)
 * FIRST, then core/estimator.ts's estimate() (v1, unchanged), and assembles a full,
 * schema-valid EstimateRevision carrying both. Propagates estimator-v2.ts's
 * CohortNotConfiguredError uncaught -- the CLI is responsible for turning it into a
 * clean error message. A revision is never written with only the v1 fields (M0 spec §6:
 * "書き込みは v2 のみ") -- an unconfigured cohort blocks the whole write, it does not
 * silently produce a v1-only revision.
 *
 * MP-8 abstain-first fix (2026-08-2x): when v1's *own* basis-eligible population is too
 * small for a k-NN prediction and the caller gave no reference table, `runEstimator`
 * throws ReferenceTableRequiredError -- previously that exception propagated all the way
 * out of this function and the CLI turned it into a bare exit-1 failure with **no
 * revision ever written at all**, discarding the whole call. estimate/v2's own
 * population is always a subset of v1's basis-eligible population (it additionally
 * filters by cohort match, see estimator-v2.ts's tallyExclusions), so whenever v1 throws
 * here, `decisionV2` has -- unless CohortNotConfiguredError already threw above --
 * already abstained (INSUFFICIENT_POPULATION or INSUFFICIENT_COMPARABLE_NEIGHBORS) for
 * the same underlying reason. This is caught below and turned into a revision with no
 * `predicted` at all (`population_condition.method: "abstained"`) instead of discarding
 * the call. That is not the silent-placeholder-default MP-8 forbade (sol ruling point 7,
 * 2026-08-08) -- it never fabricates a number -- it is the opposite: an honest,
 * queryable record that says "not enough data, here's exactly why" instead of either
 * inventing a number or losing the record entirely. `--reference-tokens-p50` et al. still
 * work exactly as before when the caller does supply one (see the non-abstain branch
 * below); this only changes what happens when none was given.
 */
export function buildEstimateRevision(input: BuildEstimateRevisionInput): EstimateRevision {
  const decisionV2 = buildEstimateV2Decision({
    predictors: input.predictors,
    population: input.population,
    profile: input.profile,
    target: { metric: "tokens", unit: "tokens" },
    novelSurfaceDeclaration: input.novelSurfaceDeclaration,
    distanceThreshold: input.distanceThreshold,
  });

  const novelSurfaceDeclarationFields = input.novelSurfaceDeclaration
    ? {
        novel_surface_declaration: {
          value: input.novelSurfaceDeclaration.value,
          source: "manual_declaration" as const,
          declared_at: input.novelSurfaceDeclaration.declaredAt,
        },
      }
    : {};

  let result: ReturnType<typeof runEstimator>;
  try {
    result = runEstimator(input.predictors, input.population, input.profile, input.referenceTable);
  } catch (err) {
    if (!(err instanceof ReferenceTableRequiredError)) throw err;
    if (decisionV2.decision.status !== "abstained") {
      // Should not happen given the subset relationship documented above -- surface the
      // original error rather than mask an unexpected state with a fabricated abstain.
      throw err;
    }
    return EstimateRevisionSchema.parse({
      revision_id: input.revisionId,
      estimated_at: input.estimatedAt,
      as_of_phase: input.asOfPhase,
      repo_commit: input.repoCommit,
      impact_scan_snapshot: input.impactScanSnapshot,
      estimator_version: input.estimatorVersion,
      predictors: input.predictors,
      token_basis: TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
      neighbors: [],
      population_condition: {
        population_size: err.populationSize,
        method: "abstained" as const,
        experimental: true,
      },
      decision_v2: decisionV2,
      ...novelSurfaceDeclarationFields,
    });
  }

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
    decision_v2: decisionV2,
    ...novelSurfaceDeclarationFields,
  });
}
