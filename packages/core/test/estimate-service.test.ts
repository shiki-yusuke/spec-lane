import { type Intent, IntentSchema, ProfileSchema, VerificationSchema } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  AbstainedRevisionCannotBeBaselineError,
  adoptBaselineRevision,
  buildEstimateRevision,
  buildPredictorsFromIntent,
  createEstimate,
} from "../src/application/estimate-service.js";

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

  it("assembles a schema-valid revision via the reference table when the population is small", () => {
    const predictors = buildPredictorsFromIntent(intent, undefined, undefined);
    const revision = buildEstimateRevision({
      revisionId: "r1",
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
