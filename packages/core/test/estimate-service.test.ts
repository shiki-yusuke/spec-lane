import {
  CURRENT_ACCOUNTING_BASIS,
  type CalibrationObservation,
  EstimateV2DecisionSchema,
  type Intent,
  IntentSchema,
  type Predictors,
  ProfileSchema,
  VerificationSchema,
} from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  AbstainedRevisionCannotBeBaselineError,
  type BuildEstimateRevisionInput,
  adoptBaselineRevision,
  buildEstimateRevision,
  buildPredictorsFromIntent,
  createEstimate,
} from "../src/application/estimate-service.js";
import { ReferenceTableRequiredError, estimate } from "../src/estimator.js";

const intent: Intent = IntentSchema.parse({
  schema_version: "1.0",
  intent_id: "I-2026-07-31-example-feature",
  intent: {
    business_goal: "Reduce onboarding time by clarifying setup docs.",
    user_visible_intent: "New users see setup steps in order.",
    success: ["ok"],
    primary_user: "new_developer",
    declared_risk: "medium",
  },
  ai_inferred_scope: {
    affected_layers: ["docs"],
    confidence: "medium",
    allowed_paths: ["docs/**"],
  },
});

describe("buildPredictorsFromIntent", () => {
  it("derives files_touched_estimate/layers_crossed from impact-scan candidate counts", () => {
    const predictors = buildPredictorsFromIntent(
      intent,
      {
        scan_version: "1.0",
        repo_commit: "abc",
        candidate_paths: ["a.ts", "b.ts", "c.ts"],
        candidate_layers: ["ui", "domain"],
        open_items: [],
        digest: "d",
      },
      undefined,
    );
    expect(predictors.files_touched_estimate).toBe(3);
    expect(predictors.layers_crossed).toBe(2);
    expect(predictors.risk_class).toBe("medium");
    expect(predictors.spec_rule_count).toBeNull();
    expect(predictors.novel_surface).toBe("unknown");
  });

  it("leaves files_touched_estimate/layers_crossed null when there is no impact-scan snapshot yet", () => {
    const predictors = buildPredictorsFromIntent(intent, undefined, undefined);
    expect(predictors.files_touched_estimate).toBeNull();
    expect(predictors.layers_crossed).toBeNull();
  });

  it("derives spec_rule_count from verification.test_matrix once Phase 2 has produced one", () => {
    const verification = VerificationSchema.parse({
      schema_version: "1.0",
      intent_id: intent.intent_id,
      test_matrix: [
        { ears_rule: "Rule 1", test_type: "unit", status: "added" },
        { ears_rule: "Rule 2", test_type: "unit", status: "added" },
      ],
    });
    const predictors = buildPredictorsFromIntent(intent, undefined, verification);
    expect(predictors.spec_rule_count).toBe(2);
  });
});

describe("buildEstimateRevision", () => {
  // M0 spec-lane 0.5.0 — estimate/v2 requires profile.estimate.cohort to be fully
  // configured before buildEstimateRevision will produce ANY revision (predicted or
  // abstained; never a v1-only write, M0 spec §6) -- see CohortNotConfiguredError's own
  // test below for the unconfigured case.
  const profile = ProfileSchema.parse({
    schema_version: "1.0",
    profile_id: "generic",
    estimate: {
      cohort: {
        agent_type: "claude",
        model_provider: "anthropic",
        model_generation: "claude-5",
        model_id: "claude-sonnet-5",
        routing_policy_digest: "a".repeat(64),
        prompt_policy_digest: "b".repeat(64),
        execution_profile_digest: "c".repeat(64),
      },
    },
  });
  const referenceTable = {
    predicted: { tokens: { p50: 100_000, p80: 200_000 }, cost_usd: { p50: 2, p80: 4 } },
  };

  it("fails closed when targetIntentId is empty or whitespace", () => {
    const predictors = buildPredictorsFromIntent(intent, undefined, undefined);
    for (const targetIntentId of ["", " \t\n"]) {
      expect(() =>
        buildEstimateRevision({
          revisionId: "r1",
          targetIntentId,
          estimatedAt: "2026-07-31T09:00:00+09:00",
          asOfPhase: "1_intent",
          repoCommit: "abc1234",
          estimatorVersion: "0.1.0",
          predictors,
          population: [],
          profile,
          referenceTable,
        }),
      ).toThrow("targetIntentId must not be empty or whitespace");
    }
  });

  it("assembles a schema-valid revision via the reference table when the population is small", () => {
    const predictors = buildPredictorsFromIntent(intent, undefined, undefined);
    const revision = buildEstimateRevision({
      revisionId: "r1",
      targetIntentId: intent.intent_id,
      estimatedAt: "2026-07-31T09:00:00+09:00",
      asOfPhase: "1_intent",
      repoCommit: "abc1234",
      estimatorVersion: "0.1.0",
      predictors,
      population: [],
      profile,
      referenceTable,
    });
    expect(revision.revision_id).toBe("r1");
    expect(revision.population_condition.method).toBe("reference_table");
    expect(revision.predicted).toEqual(referenceTable.predicted);
    // v1's own reference_table fallback is unchanged; estimate/v2's own layer still
    // abstains honestly (novel_surface is "unknown" here, per buildPredictorsFromIntent's
    // own M2-era default -- see that function's doc comment).
    expect(revision.decision_v2?.decision.status).toBe("abstained");
    expect(revision.decision_v2?.decision.reason_codes).toContain("NOVEL_SURFACE_UNKNOWN");
  });

  // MP-8 abstain-first fix (2026-08-2x): the bug this fix targets -- v1's own
  // basis-eligible population is too small for a k-NN prediction and no reference table
  // was given (core/estimator.ts's ReferenceTableRequiredError). Previously that
  // exception propagated out of buildEstimateRevision uncaught and the CLI turned it
  // into a bare exit-1 failure with NO revision ever written. Now it is recorded as an
  // honest estimate/v2-abstained revision instead.
  it("records an estimate/v2-abstained revision (no predicted value) instead of throwing when the population is too small and no reference table is given", () => {
    const predictors = buildPredictorsFromIntent(intent, undefined, undefined);
    const revision = buildEstimateRevision({
      revisionId: "r3",
      targetIntentId: intent.intent_id,
      estimatedAt: "2026-08-21T09:00:00+09:00",
      asOfPhase: "1_intent",
      repoCommit: "abc1234",
      estimatorVersion: "0.1.0",
      predictors,
      population: [],
      profile,
      // no referenceTable -- this is exactly the case that used to throw and discard
      // the whole call.
      novelSurfaceDeclaration: { value: "established", declaredAt: "2026-08-21T09:00:00+09:00" },
    });
    expect(revision.revision_id).toBe("r3");
    expect(revision.population_condition.method).toBe("abstained");
    expect(revision.population_condition.population_size).toBe(0);
    expect(revision.predicted).toBeUndefined();
    expect(revision.neighbors).toEqual([]);
    expect(revision.decision_v2?.decision.status).toBe("abstained");
    expect(revision.decision_v2?.decision.reason_codes).toContain("INSUFFICIENT_POPULATION");
  });

  it("throws CohortNotConfiguredError when profile.estimate.cohort is not configured, rather than write a v1-only revision", () => {
    const unconfiguredProfile = ProfileSchema.parse({
      schema_version: "1.0",
      profile_id: "generic",
    });
    const predictors = buildPredictorsFromIntent(intent, undefined, undefined);
    expect(() =>
      buildEstimateRevision({
        revisionId: "r2",
        targetIntentId: intent.intent_id,
        estimatedAt: "2026-07-31T09:00:00+09:00",
        asOfPhase: "1_intent",
        repoCommit: "abc1234",
        estimatorVersion: "0.1.0",
        predictors,
        population: [],
        profile: unconfiguredProfile,
        referenceTable,
      }),
    ).toThrow(/estimate\/v2 requires a fully declared cohort/);
  });

  // requirement 3 (abstain-first fix): an abstained revision has no predicted value and
  // must never become the baseline -- nothing for `lane next`/`lane calibrate` to compare
  // a budget or a measured actual against.
  describe("adoptBaselineRevision", () => {
    it("throws AbstainedRevisionCannotBeBaselineError for a revision whose estimate/v2 decision abstained", () => {
      const predictors = buildPredictorsFromIntent(intent, undefined, undefined);
      const abstainedRevision = buildEstimateRevision({
        revisionId: "r1",
        targetIntentId: intent.intent_id,
        estimatedAt: "2026-08-21T09:00:00+09:00",
        asOfPhase: "1_intent",
        repoCommit: "abc1234",
        estimatorVersion: "0.1.0",
        predictors,
        population: [],
        profile,
        novelSurfaceDeclaration: { value: "established", declaredAt: "2026-08-21T09:00:00+09:00" },
      });
      const estimate = createEstimate(intent.intent_id, "1.0", abstainedRevision);
      expect(() =>
        adoptBaselineRevision(intent, "r1", estimate, "2026-08-21T09:05:00+09:00"),
      ).toThrow(AbstainedRevisionCannotBeBaselineError);
      expect(() =>
        adoptBaselineRevision(intent, "r1", estimate, "2026-08-21T09:05:00+09:00"),
      ).toThrow(/is abstained.*INSUFFICIENT_POPULATION.*no predicted value/s);
    });

    it("still adopts a non-abstained (predicted) revision as before", () => {
      const predictors = buildPredictorsFromIntent(intent, undefined, undefined);
      const revision = buildEstimateRevision({
        revisionId: "r1",
        targetIntentId: intent.intent_id,
        estimatedAt: "2026-08-21T09:00:00+09:00",
        asOfPhase: "1_intent",
        repoCommit: "abc1234",
        estimatorVersion: "0.1.0",
        predictors,
        population: [],
        profile,
        referenceTable,
      });
      const estimate = createEstimate(intent.intent_id, "1.0", revision);
      const updatedIntent = adoptBaselineRevision(
        intent,
        "r1",
        estimate,
        "2026-08-21T09:05:00+09:00",
      );
      expect(updatedIntent.baseline_estimate_revision_id).toBe("r1");
      expect(updatedIntent.baseline_adopted_at).toBe("2026-08-21T09:05:00+09:00");
    });
  });
});

// ---------------------------------------------------------------------------
// I-2026-11-11-estimate-v2-global-v1-gate -- TEST-01/03/04/05 (core side).
// ---------------------------------------------------------------------------

describe("buildEstimateRevision -- estimate/v2 prediction survives a global-v1 abstain (I-2026-11-11)", () => {
  const TARGET = "I-2026-11-12-target-not-done";
  const IMPL = "lane-estimator/0.1.0";
  const cohortConfig = {
    agent_type: "claude",
    model_provider: "anthropic",
    model_generation: "claude-5",
    model_id: "claude-sonnet-5",
    routing_policy_digest: "a".repeat(64),
    prompt_policy_digest: "b".repeat(64),
    execution_profile_digest: "c".repeat(64),
  };
  const profile = ProfileSchema.parse({
    schema_version: "1.0",
    profile_id: "generic",
    estimate: { cohort: cohortConfig },
  });
  const targetPredictors: Predictors = {
    files_touched_estimate: 5,
    files_touched_observed: null,
    layers_crossed: 1,
    risk_class: "medium",
    spec_rule_count: null,
    novel_surface: "unknown",
  };
  const declared = { value: "established" as const, declaredAt: "2026-11-13T09:00:00+09:00" };

  function obs(opts: {
    recordId: string;
    intentId: string;
    files: number;
    tokens: number;
    cohort: boolean;
    eligible: boolean;
  }): CalibrationObservation {
    return {
      schema_version: "1.0",
      record_id: opts.recordId,
      kind: "observation",
      intent_id: opts.intentId,
      recorded_at: "2026-11-01T00:00:00Z",
      predictors: { ...targetPredictors, files_touched_estimate: opts.files },
      predictor_quality: "observed",
      actual: {
        tokens: opts.tokens,
        estimated_cost_usd: opts.tokens / 1000,
        token_basis: CURRENT_ACCOUNTING_BASIS,
      },
      measurement_quality: "observed",
      eligible_for_knn: opts.eligible,
      ...(opts.eligible ? { knn_ineligibility_reasons: [] } : {}),
      provenance: "measured",
      ...(opts.cohort
        ? { cohort: { ...cohortConfig, measure_contract_version: "measure/v1" } }
        : {}),
    };
  }

  // 8 non-target cohort-matched, knn-eligible observations at files 6..13 (record_id is
  // deliberately different from intent_id), so the cohort-subset k-NN picks cal-c0..cal-c6.
  const cohortObs = Array.from({ length: 8 }, (_, i) =>
    obs({
      recordId: `cal-c${i}`,
      intentId: `I-2026-10-0${i + 1}-cohort-${i}`,
      files: 6 + i,
      tokens: 100_000 + i * 10_000,
      cohort: true,
      eligible: true,
    }),
  );
  // 4 nearer (distance 0) cohort-less, v1-ineligible observations -- they occupy 4 of the
  // global v1 nearest 7, leaving 3 usable < 5, so global v1 raises
  // ReferenceTableRequiredError although the cohort subset predicts.
  const nearIneligible = Array.from({ length: 4 }, (_, i) =>
    obs({
      recordId: `cal-n${i}`,
      intentId: `I-2026-09-0${i + 1}-legacy-${i}`,
      files: 5,
      tokens: 1_000,
      cohort: false,
      eligible: false,
    }),
  );
  // The target's own completed observation: cohort-matched, eligible, distance 0, with
  // deliberately distinctive actuals.
  const selfObs = obs({
    recordId: "cal-self",
    intentId: TARGET,
    files: 5,
    tokens: 9_999_999,
    cohort: true,
    eligible: true,
  });

  function build(
    population: CalibrationObservation[],
    extra: Partial<BuildEstimateRevisionInput> = {},
  ) {
    return buildEstimateRevision({
      revisionId: "r1",
      targetIntentId: TARGET,
      estimatedAt: "2026-11-13T09:00:00+09:00",
      asOfPhase: "2_spec",
      repoCommit: "abc1234",
      estimatorVersion: IMPL,
      predictors: targetPredictors,
      population,
      profile,
      novelSurfaceDeclaration: declared,
      ...extra,
    });
  }

  // Independent oracle: the cohort-subset v1 run estimate/v2 performs (novel_surface
  // resolved by the declaration), over exactly the 8 non-target cohort observations.
  const expectedCohortResult = estimate(
    { ...targetPredictors, novel_surface: "false" },
    cohortObs,
    profile,
  );

  it("precondition: global v1 over the same population raises ReferenceTableRequiredError", () => {
    expect(() => estimate(targetPredictors, [...nearIneligible, ...cohortObs], profile)).toThrow(
      ReferenceTableRequiredError,
    );
  });

  it("TEST-01: returns a v2-cohort revision (no throw, no reference table) whose numbers all come from the captured cohort-subset result", () => {
    const revision = build([...nearIneligible, ...cohortObs]);
    expect(revision.estimator_version).toBe("estimate/v2-cohort@lane-estimator/0.1.0");
    expect(revision.decision_v2?.schema_version).toBe("estimate/v2");
    expect(revision.decision_v2?.decision.status).toBe("predicted");
    expect(revision.predicted?.tokens.p50).toBe(revision.decision_v2?.predicted?.p50);
    expect(revision.predicted?.tokens.p80).toBe(revision.decision_v2?.predicted?.p80);
    expect(revision.predicted).toEqual(expectedCohortResult.predicted);
    expect(revision.neighbors).toEqual(expectedCohortResult.neighbors);
    expect(revision.population_condition).toEqual({
      population_size: expectedCohortResult.populationCondition.populationSize,
      method: "knn_quantile",
      experimental: expectedCohortResult.populationCondition.experimental,
      leave_one_out_p50_error: expectedCohortResult.populationCondition.leaveOneOutP50Error,
      leave_one_out_p80_coverage: expectedCohortResult.populationCondition.leaveOneOutP80Coverage,
    });
    expect(revision.population_condition.population_size).toBe(8);
    expect(revision.token_basis).toBe(CURRENT_ACCOUNTING_BASIS);
    expect(revision.novel_surface_declaration?.value).toBe("established");
  });

  it("TEST-01 (self-observation variant): 9 cohort-eligible before self-exclusion, 8 after -- same v2-cohort revision", () => {
    const revision = build([selfObs, ...nearIneligible, ...cohortObs]);
    expect(revision.estimator_version).toBe("estimate/v2-cohort@lane-estimator/0.1.0");
    expect(revision.decision_v2?.decision.status).toBe("predicted");
    expect(revision.decision_v2?.population.eligible_count).toBe(8);
    expect(revision.decision_v2?.population.candidate_count).toBe(12);
    expect(revision.predicted).toEqual(expectedCohortResult.predicted);
    expect(revision.neighbors).toEqual(expectedCohortResult.neighbors);
  });

  it("RULE-02: an error other than ReferenceTableRequiredError from the global v1 run propagates unchanged", () => {
    const boom = new Error("boom from global v1");
    const throwingPopulation = [...nearIneligible, ...cohortObs];
    // A cohort-less, v1-ineligible observation whose predictors throw on read: estimate/v2
    // excludes it before ranking, so the error is raised only by the global v1 run.
    const poisoned = obs({
      recordId: "cal-poison",
      intentId: "I-2026-08-01-poison",
      files: 5,
      tokens: 1,
      cohort: false,
      eligible: false,
    });
    Object.defineProperty(poisoned, "predictors", {
      get() {
        throw boom;
      },
    });
    expect(() => build([...throwingPopulation, poisoned])).toThrow(boom);
  });

  it("TEST-03: v2 abstains + no reference table -> unchanged abstained revision with the existing reason codes", () => {
    // 7 cohort observations: v2 abstains INSUFFICIENT_POPULATION; global v1 raises too.
    const revision = build([...nearIneligible, ...cohortObs.slice(0, 7)]);
    expect(revision.estimator_version).toBe(IMPL);
    expect(revision.population_condition).toEqual({
      population_size: 11,
      method: "abstained",
      experimental: true,
    });
    expect(revision.predicted).toBeUndefined();
    expect(revision.neighbors).toEqual([]);
    expect(revision.decision_v2?.decision).toEqual({
      status: "abstained",
      reason_codes: ["INSUFFICIENT_POPULATION"],
    });
  });

  it("TEST-03: v2 abstains + reference table -> unchanged global-v1 reference_table revision", () => {
    const referenceTable = {
      predicted: { tokens: { p50: 70_000, p80: 140_000 }, cost_usd: { p50: 3, p80: 6 } },
    };
    const revision = build([...nearIneligible, ...cohortObs.slice(0, 7)], { referenceTable });
    expect(revision.estimator_version).toBe(IMPL);
    expect(revision.population_condition.method).toBe("reference_table");
    expect(revision.population_condition.population_size).toBe(11);
    expect(revision.predicted).toEqual(referenceTable.predicted);
    expect(revision.token_basis).toBe("unknown");
    expect(revision.neighbors).toEqual([]);
    expect(revision.decision_v2?.decision.reason_codes).toEqual(["INSUFFICIENT_POPULATION"]);
  });

  it("TEST-04: the target's own distance-0 observation is excluded from both the v1 neighbors and the decision_v2 population", () => {
    // 9 cohort-eligible before self-exclusion, no ineligible ones: global v1 succeeds.
    const revision = build([selfObs, ...cohortObs]);
    expect(revision.estimator_version).toBe(IMPL);
    expect(revision.population_condition.method).toBe("knn_quantile");
    expect(revision.population_condition.population_size).toBe(8);
    expect(revision.neighbors.map((n) => n.intent_id)).not.toContain(TARGET);
    expect(revision.neighbors.map((n) => n.record_id)).not.toContain("cal-self");
    expect(revision.predicted?.tokens.p80).toBeLessThan(9_999_999);
    expect(revision.decision_v2?.population.candidate_count).toBe(8);
    expect(revision.decision_v2?.population.eligible_count).toBe(8);
    expect(revision.decision_v2?.predicted?.p80).toBeLessThan(9_999_999);
    expect(revision.decision_v2?.applicability.nearest_distance).toBeGreaterThan(0);
  });

  it("TEST-05: revision neighbors carry the exact selected observation record_ids; decision_v2 stays strict", () => {
    const revision = build([...nearIneligible, ...cohortObs]);
    expect(revision.neighbors.map((n) => n.record_id)).toEqual([
      "cal-c0",
      "cal-c1",
      "cal-c2",
      "cal-c3",
      "cal-c4",
      "cal-c5",
      "cal-c6",
    ]);
    expect(
      EstimateV2DecisionSchema.safeParse({ ...revision.decision_v2, neighbors: revision.neighbors })
        .success,
    ).toBe(false);
    expect(EstimateV2DecisionSchema.safeParse(revision.decision_v2).success).toBe(true);
  });
});
