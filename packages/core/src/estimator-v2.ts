import type {
  CalibrationObservation,
  EstimateV2Cohort,
  EstimateV2Decision,
  EstimateV2ReasonCode,
  Predictors,
  Profile,
} from "@lane/schemas";
import { TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1 } from "@lane/schemas";
import {
  type EstimatorResult,
  ReferenceTableRequiredError,
  estimate as runEstimatorV1,
} from "./estimator.js";

// M0 spec-lane 0.5.0 (M0 spec §6) — the estimate/v2 honesty layer, built on top of (never
// replacing) core/estimator.ts's existing k-NN/LOO/reference-table logic, which stays
// unchanged. This module decides abstain-vs-predicted per the estimate/v2 contract's own
// state machine and, when it decides "predicted," reuses runEstimatorV1 verbatim over the
// v2-eligible (cohort+basis-matched) subset of the population -- never a second,
// independently-derived quantile computation.

// agent-cost's own real, fixed protocol_version constant (schemas/agent-cost.ts) -- not a
// per-deployment operator choice, so it is never asked for in profile.estimate.cohort.
const MEASURE_CONTRACT_VERSION = "measure/v1";

export interface NovelSurfaceDeclaration {
  value: "established" | "novel";
  declaredAt: string;
}

export interface BuildEstimateV2DecisionInput {
  predictors: Predictors;
  population: readonly CalibrationObservation[];
  profile: Profile;
  target: { metric: "tokens" | "cost_usd" | "cycle_time_min"; unit: string };
  novelSurfaceDeclaration?: NovelSurfaceDeclaration;
  /** Optional profile-level neighbor-distance gate; DISTANCE_ABOVE_THRESHOLD never fires
   * when absent (this codebase does not yet calibrate a default threshold -- see M0 spec
   * §6's open item note in docs/design.md). */
  distanceThreshold?: number;
}

export class CohortNotConfiguredError extends Error {
  constructor() {
    super(
      "profile.estimate.cohort is not configured -- estimate/v2 requires a fully declared cohort " +
        "identity (agent_type/model_provider/model_generation/model_id/routing_policy_digest/" +
        "prompt_policy_digest/execution_profile_digest) before it can produce any decision, " +
        "predicted or abstained (never fabricated). Configure it in a repo-local profile override.",
    );
    this.name = "CohortNotConfiguredError";
  }
}

/** Throws CohortNotConfiguredError if profile.estimate.cohort is absent or incomplete --
 * never returns a partially-filled cohort object (estimate-v2.md's schema requires the
 * full 9-field object unconditionally, predicted or abstained). */
export function resolveEstimateV2Cohort(profile: Profile): EstimateV2Cohort {
  const config = profile.estimate?.cohort;
  if (!config) throw new CohortNotConfiguredError();
  return {
    agent_type: config.agent_type,
    model_provider: config.model_provider,
    model_generation: config.model_generation,
    model_id: config.model_id,
    routing_policy_digest: config.routing_policy_digest,
    prompt_policy_digest: config.prompt_policy_digest,
    execution_profile_digest: config.execution_profile_digest,
    measure_contract_version: MEASURE_CONTRACT_VERSION,
    token_basis: TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
  };
}

/**
 * Classifies why one candidate observation is excluded from the v2-eligible population,
 * or `null` if it is eligible. Checked in estimate/v2's own reason_codes enum order
 * (TOKEN_BASIS_MISMATCH before MODEL_GENERATION_MISMATCH before ROUTING_PROFILE_MISMATCH)
 * so the "exclusive primary reason" counting rule (estimate-v2.md) has an unambiguous,
 * deterministic answer for a candidate that technically fails more than one check.
 */
export function classifyCandidateExclusion(
  candidate: CalibrationObservation,
  target: EstimateV2Cohort,
): EstimateV2ReasonCode | null {
  if (candidate.actual.token_basis !== target.token_basis) return "TOKEN_BASIS_MISMATCH";
  if (!candidate.cohort || candidate.cohort.model_generation !== target.model_generation) {
    return "MODEL_GENERATION_MISMATCH";
  }
  if (candidate.cohort.routing_policy_digest !== target.routing_policy_digest) {
    return "ROUTING_PROFILE_MISMATCH";
  }
  return null;
}

function tallyExclusions(
  population: readonly CalibrationObservation[],
  target: EstimateV2Cohort,
): {
  eligible: CalibrationObservation[];
  excludedByReason: Partial<Record<EstimateV2ReasonCode, number>>;
} {
  const eligible: CalibrationObservation[] = [];
  const excludedByReason: Partial<Record<EstimateV2ReasonCode, number>> = {};
  for (const candidate of population) {
    const reason = classifyCandidateExclusion(candidate, target);
    if (reason === null) {
      eligible.push(candidate);
    } else {
      excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
    }
  }
  return { eligible, excludedByReason };
}

function abstain(
  target: BuildEstimateV2DecisionInput["target"],
  cohort: EstimateV2Cohort,
  candidateCount: number,
  eligibleCount: number,
  excludedByReason: Partial<Record<EstimateV2ReasonCode, number>>,
  reasonCodes: EstimateV2ReasonCode[],
  applicabilityStatus: "unknown" | "out_of_domain" = "unknown",
): EstimateV2Decision {
  return {
    schema_version: "estimate/v2",
    target,
    decision: { status: "abstained", reason_codes: reasonCodes },
    applicability: { status: applicabilityStatus },
    cohort,
    population: {
      candidate_count: candidateCount,
      eligible_count: eligibleCount,
      excluded_by_reason: excludedByReason,
    },
    prediction_interval: { status: "insufficient_data" },
    coverage_history: { frozen_predictions_only: true },
    drift: { status: "insufficient_data" },
  };
}

/**
 * Builds the estimate/v2 decision for `target`. Never fabricates: a missing cohort
 * config throws (CohortNotConfiguredError) rather than emit a decision with an invented
 * identity; an unresolved novel_surface abstains (NOVEL_SURFACE_UNKNOWN) unless the
 * caller declared one; a population that doesn't clear v1's own knn_quantile gate (after
 * the additional cohort filter) abstains INSUFFICIENT_POPULATION/
 * INSUFFICIENT_COMPARABLE_NEIGHBORS rather than report a reference_table/manual_fallback
 * guess as if it were real k-NN evidence.
 */
export function buildEstimateV2Decision(input: BuildEstimateV2DecisionInput): EstimateV2Decision {
  const cohort = resolveEstimateV2Cohort(input.profile);

  const effectivePredictors: Predictors =
    input.predictors.novel_surface !== "unknown" || !input.novelSurfaceDeclaration
      ? input.predictors
      : {
          ...input.predictors,
          novel_surface: input.novelSurfaceDeclaration.value === "novel" ? "true" : "false",
        };

  if (effectivePredictors.novel_surface === "unknown") {
    const { eligible, excludedByReason } = tallyExclusions(input.population, cohort);
    return abstain(
      input.target,
      cohort,
      input.population.length,
      eligible.length,
      excludedByReason,
      ["NOVEL_SURFACE_UNKNOWN"],
    );
  }

  const { eligible, excludedByReason } = tallyExclusions(input.population, cohort);

  let v1Result: EstimatorResult;
  try {
    // No referenceTable (4th arg) is ever passed here -- v2 never reports a
    // reference_table/manual_fallback guess as if it were real k-NN evidence, so v1's own
    // fallback path always surfaces as ReferenceTableRequiredError, never a returned
    // "reference_table" result, for this call.
    v1Result = runEstimatorV1(effectivePredictors, eligible, input.profile);
  } catch (err) {
    if (err instanceof ReferenceTableRequiredError) {
      // estimator.ts's own <8-eligible gate (the exact threshold below which it never
      // even attempts neighbor ranking) vs. its <5-usable-among-nearest-7 gate are two
      // different honesty claims -- "not enough candidates at all" is INSUFFICIENT_
      // POPULATION, "had candidates but too few were comparable enough" is
      // INSUFFICIENT_COMPARABLE_NEIGHBORS. Approximated here by eligible.length alone
      // (this module has no visibility into which top-7 neighbors were eligible_for_knn
      // without re-deriving estimator.ts's own ranking) -- see estimator.ts's `estimate()`.
      const reason: EstimateV2ReasonCode =
        eligible.length < 8 ? "INSUFFICIENT_POPULATION" : "INSUFFICIENT_COMPARABLE_NEIGHBORS";
      return abstain(
        input.target,
        cohort,
        input.population.length,
        eligible.length,
        excludedByReason,
        [reason],
      );
    }
    throw err;
  }

  const nearestDistance = v1Result.neighbors[0]?.distance;
  if (
    input.distanceThreshold !== undefined &&
    nearestDistance !== undefined &&
    nearestDistance > input.distanceThreshold
  ) {
    return {
      ...abstain(
        input.target,
        cohort,
        input.population.length,
        eligible.length,
        excludedByReason,
        ["DISTANCE_ABOVE_THRESHOLD"],
        "out_of_domain",
      ),
      applicability: {
        status: "out_of_domain",
        nearest_distance: nearestDistance,
        distance_threshold: input.distanceThreshold,
      },
    };
  }

  const value =
    input.target.metric === "cost_usd" ? v1Result.predicted.cost_usd : v1Result.predicted.tokens;
  const driftStatus =
    v1Result.populationCondition.leaveOneOutP50Error !== undefined ? "stable" : "insufficient_data";

  return {
    schema_version: "estimate/v2",
    target: input.target,
    predicted: { p50: value.p50, p80: value.p80, value_status: "estimated" },
    decision: { status: "predicted", reason_codes: [] },
    applicability: {
      status: "in_domain",
      ...(nearestDistance !== undefined ? { nearest_distance: nearestDistance } : {}),
      ...(input.distanceThreshold !== undefined
        ? { distance_threshold: input.distanceThreshold }
        : {}),
    },
    cohort,
    population: {
      candidate_count: input.population.length,
      eligible_count: eligible.length,
      excluded_by_reason: excludedByReason,
    },
    prediction_interval: { status: "insufficient_data" },
    coverage_history: { frozen_predictions_only: true },
    drift: { status: driftStatus },
  };
}
