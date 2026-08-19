import type { CalibrationObservation, Predictors, Profile } from "@lane/schemas";
import { EstimateV2DecisionSchema, TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1 } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  CohortNotConfiguredError,
  buildEstimateV2Decision,
  classifyCandidateExclusion,
} from "../src/estimator-v2.js";

function predictors(overrides: Partial<Predictors> = {}): Predictors {
  return {
    files_touched_estimate: 5,
    files_touched_observed: null,
    layers_crossed: 1,
    risk_class: "low",
    spec_rule_count: null,
    novel_surface: "unknown",
    ...overrides,
  };
}

const baseProfile: Profile = {
  schema_version: "1.0",
  profile_id: "generic",
  applies_to_repo: "",
  existing_ssot: {},
  extra_lenses: [],
  layer_ownership: {},
  risk_auto_upgrade: [],
  required_commands: { pre_implement: [], during_implement: [], pre_pr: [], post_implement: [] },
  forbidden_paths_for_low_risk: [],
  isomorphism_rules: { enabled: true, enforced_in: [] },
  test_coverage_floor: { unit_test_per_ears_rule_minimum: 1 },
  distance_caps: { files_touched_estimate: 50, layers_crossed: 10, spec_rule_count: 30 },
  design_override_forbidden: false,
};

const cohortConfig = {
  agent_type: "claude",
  model_provider: "anthropic",
  model_generation: "claude-5",
  model_id: "claude-sonnet-5",
  routing_policy_digest: "a".repeat(64),
  prompt_policy_digest: "b".repeat(64),
  execution_profile_digest: "c".repeat(64),
};

const configuredProfile: Profile = { ...baseProfile, estimate: { cohort: cohortConfig } };

function observation(
  id: string,
  tokens: number,
  filesTouched: number,
  withCohort = true,
): CalibrationObservation {
  return {
    schema_version: "1.0",
    record_id: id,
    kind: "observation",
    intent_id: id,
    recorded_at: "2026-08-09T00:00:00Z",
    predictors: predictors({ files_touched_estimate: filesTouched }),
    predictor_quality: "observed",
    actual: {
      tokens,
      estimated_cost_usd: tokens / 1000,
      token_basis: TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
    },
    measurement_quality: "observed",
    eligible_for_knn: true,
    provenance: "measured",
    ...(withCohort
      ? {
          cohort: {
            ...cohortConfig,
            measure_contract_version: "measure/v1",
          },
        }
      : {}),
  };
}

const target = { metric: "tokens" as const, unit: "tokens" };

describe("resolveEstimateV2Cohort / CohortNotConfiguredError", () => {
  it("throws when profile.estimate.cohort is not configured", () => {
    expect(() =>
      buildEstimateV2Decision({
        predictors: predictors(),
        population: [],
        profile: baseProfile,
        target,
      }),
    ).toThrow(CohortNotConfiguredError);
  });
});

describe("classifyCandidateExclusion", () => {
  const targetCohort = {
    ...cohortConfig,
    measure_contract_version: "measure/v1",
    token_basis: TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
  };

  it("returns null (eligible) for a fully matching candidate", () => {
    expect(classifyCandidateExclusion(observation("a", 100, 1), targetCohort)).toBeNull();
  });

  it("TOKEN_BASIS_MISMATCH takes priority over a cohort mismatch", () => {
    const obs: CalibrationObservation = {
      ...observation("a", 100, 1),
      actual: { tokens: 100, token_basis: "some-other-basis" },
      cohort: undefined,
    };
    expect(classifyCandidateExclusion(obs, targetCohort)).toBe("TOKEN_BASIS_MISMATCH");
  });

  it("MODEL_GENERATION_MISMATCH when cohort is entirely absent", () => {
    expect(classifyCandidateExclusion(observation("a", 100, 1, false), targetCohort)).toBe(
      "MODEL_GENERATION_MISMATCH",
    );
  });

  it("ROUTING_PROFILE_MISMATCH when model_generation matches but routing digest doesn't", () => {
    const obs = observation("a", 100, 1);
    obs.cohort = {
      ...(obs.cohort as NonNullable<typeof obs.cohort>),
      routing_policy_digest: "f".repeat(64),
    };
    expect(classifyCandidateExclusion(obs, targetCohort)).toBe("ROUTING_PROFILE_MISMATCH");
  });
});

describe("buildEstimateV2Decision", () => {
  it("abstains NOVEL_SURFACE_UNKNOWN when novel_surface is unknown and undeclared", () => {
    const decision = buildEstimateV2Decision({
      predictors: predictors({ novel_surface: "unknown" }),
      population: [],
      profile: configuredProfile,
      target,
    });
    expect(decision.decision.status).toBe("abstained");
    expect(decision.decision.reason_codes).toEqual(["NOVEL_SURFACE_UNKNOWN"]);
    expect(decision.predicted).toBeUndefined();
    expect(decision.cohort.model_generation).toBe("claude-5");
    expect(EstimateV2DecisionSchema.safeParse(decision).success).toBe(true);
  });

  it("a --novel-surface declaration resolves the novel_surface gate (still abstains INSUFFICIENT_POPULATION with no eligible population)", () => {
    const decision = buildEstimateV2Decision({
      predictors: predictors({ novel_surface: "unknown" }),
      population: [],
      profile: configuredProfile,
      target,
      novelSurfaceDeclaration: { value: "established", declaredAt: "2026-08-09T00:00:00Z" },
    });
    expect(decision.decision.reason_codes).toEqual(["INSUFFICIENT_POPULATION"]);
    expect(EstimateV2DecisionSchema.safeParse(decision).success).toBe(true);
  });

  it("abstains INSUFFICIENT_POPULATION when every candidate lacks a matching cohort (the expected state right after this feature ships)", () => {
    const population = Array.from({ length: 10 }, (_, i) =>
      observation(`p${i}`, 1000 * (i + 1), i + 1, false),
    );
    const decision = buildEstimateV2Decision({
      predictors: predictors({ novel_surface: "false" }),
      population,
      profile: configuredProfile,
      target,
    });
    expect(decision.decision.status).toBe("abstained");
    expect(decision.decision.reason_codes).toEqual(["INSUFFICIENT_POPULATION"]);
    expect(decision.population.candidate_count).toBe(10);
    expect(decision.population.eligible_count).toBe(0);
    expect(decision.population.excluded_by_reason.MODEL_GENERATION_MISMATCH).toBe(10);
    expect(EstimateV2DecisionSchema.safeParse(decision).success).toBe(true);
  });

  it("excluded_by_reason always reconciles with candidate_count - eligible_count", () => {
    const matched = Array.from({ length: 9 }, (_, i) =>
      observation(`m${i}`, 1000 * (i + 1), i + 1, true),
    );
    const unmatched = Array.from({ length: 3 }, (_, i) => observation(`u${i}`, 500, i + 1, false));
    const decision = buildEstimateV2Decision({
      predictors: predictors({ novel_surface: "false" }),
      population: [...matched, ...unmatched],
      profile: configuredProfile,
      target,
    });
    const excludedSum = Object.values(decision.population.excluded_by_reason).reduce(
      (s, v) => s + v,
      0,
    );
    expect(excludedSum).toBe(
      decision.population.candidate_count - decision.population.eligible_count,
    );
    expect(decision.population.eligible_count).toBe(9);
    expect(EstimateV2DecisionSchema.safeParse(decision).success).toBe(true);
  });

  it("predicts (reusing v1's k-NN numbers verbatim) once enough cohort-matched population exists", () => {
    const population = Array.from({ length: 10 }, (_, i) =>
      observation(`p${i}`, 100_000 + i * 10_000, i + 1, true),
    );
    const decision = buildEstimateV2Decision({
      predictors: predictors({ novel_surface: "false" }),
      population,
      profile: configuredProfile,
      target,
    });
    expect(decision.decision.status).toBe("predicted");
    expect(decision.decision.reason_codes).toEqual([]);
    expect(decision.predicted).toBeDefined();
    expect(decision.predicted?.p50).toBeLessThanOrEqual(decision.predicted?.p80 as number);
    expect(decision.applicability.status).toBe("in_domain");
    expect(decision.prediction_interval.status).toBe("insufficient_data");
    expect(decision.coverage_history.frozen_predictions_only).toBe(true);
    expect(EstimateV2DecisionSchema.safeParse(decision).success).toBe(true);
  });

  it("a candidate beyond --distance-threshold abstains DISTANCE_ABOVE_THRESHOLD (out_of_domain)", () => {
    const population = Array.from({ length: 10 }, (_, i) =>
      observation(`p${i}`, 100_000 + i * 10_000, i + 1, true),
    );
    const decision = buildEstimateV2Decision({
      // risk_class "high" is maximally distant (ordinal) from every population entry's
      // "low", guaranteeing a nonzero nearest distance to compare against the threshold.
      predictors: predictors({ novel_surface: "false", risk_class: "high" }),
      population,
      profile: configuredProfile,
      target,
      distanceThreshold: 0,
    });
    expect(decision.decision.status).toBe("abstained");
    expect(decision.decision.reason_codes).toEqual(["DISTANCE_ABOVE_THRESHOLD"]);
    expect(decision.applicability.status).toBe("out_of_domain");
    expect(EstimateV2DecisionSchema.safeParse(decision).success).toBe(true);
  });
});
