import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EstimateV2DecisionSchema } from "../src/estimate-v2.js";
import { EstimateRevisionSchema } from "../src/estimate.js";
import { CURRENT_ACCOUNTING_BASIS } from "../src/token-basis.js";

const generatedEstimateSchema: unknown = JSON.parse(
  readFileSync(new URL("../generated/estimate.schema.json", import.meta.url), "utf-8"),
);

// These are the zod-only refine invariants that zod-to-json-schema drops (see
// differential.test.ts's header comment), so they are unit-tested here instead.
const baseRevision = {
  revision_id: "r1",
  estimated_at: "2026-07-31T09:00:00+09:00",
  as_of_phase: "1_intent" as const,
  repo_commit: "abc1234",
  estimator_version: "0.1.0",
  predictors: {
    files_touched_estimate: 5,
    files_touched_observed: null,
    layers_crossed: 1,
    risk_class: "low" as const,
    spec_rule_count: null,
    novel_surface: "unknown" as const,
  },
  neighbors: [],
};

describe("EstimateRevisionSchema refine invariants", () => {
  it("rejects p50 > p80 within a quantile", () => {
    const result = EstimateRevisionSchema.safeParse({
      ...baseRevision,
      predicted: { tokens: { p50: 200, p80: 100 }, cost_usd: { p50: 1, p80: 2 } },
      population_condition: { population_size: 3, method: "reference_table", experimental: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects knn_quantile predictions with cost_usd.p50 == 0", () => {
    const result = EstimateRevisionSchema.safeParse({
      ...baseRevision,
      predicted: { tokens: { p50: 100, p80: 200 }, cost_usd: { p50: 0, p80: 2 } },
      population_condition: { population_size: 10, method: "knn_quantile", experimental: false },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed knn_quantile revision", () => {
    const result = EstimateRevisionSchema.safeParse({
      ...baseRevision,
      predicted: { tokens: { p50: 100, p80: 200 }, cost_usd: { p50: 1, p80: 2 } },
      population_condition: { population_size: 10, method: "knn_quantile", experimental: false },
    });
    expect(result.success).toBe(true);
  });

  // MP-8 abstain-first fix — population_condition.method: "abstained" is the one case
  // where `predicted` must be absent, not just optional; every other method still
  // requires it (see buildEstimateRevision, core/application/estimate-service.ts, which
  // is the only place that ever sets this method).
  it("accepts an abstained revision with no predicted value", () => {
    const result = EstimateRevisionSchema.safeParse({
      ...baseRevision,
      population_condition: { population_size: 3, method: "abstained", experimental: true },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an abstained revision that carries a predicted value (predicted must not leak into an abstain)", () => {
    const result = EstimateRevisionSchema.safeParse({
      ...baseRevision,
      predicted: { tokens: { p50: 100, p80: 200 }, cost_usd: { p50: 1, p80: 2 } },
      population_condition: { population_size: 3, method: "abstained", experimental: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-abstained revision with no predicted value", () => {
    const result = EstimateRevisionSchema.safeParse({
      ...baseRevision,
      population_condition: { population_size: 10, method: "reference_table", experimental: true },
    });
    expect(result.success).toBe(false);
  });
});

// I-2026-11-11-estimate-v2-global-v1-gate (D5/RULE-05, TEST-05) -- optional
// neighbors[].record_id on the local revision schema; the strict estimate/v2 contract
// mirror is unchanged and still rejects it.
describe("EstimateRevisionSchema neighbors[].record_id (TEST-05)", () => {
  const knnRevision = {
    ...baseRevision,
    predicted: { tokens: { p50: 100, p80: 200 }, cost_usd: { p50: 1, p80: 2 } },
    population_condition: { population_size: 10, method: "knn_quantile", experimental: true },
  };

  it("persists the exact neighbor record_id", () => {
    const result = EstimateRevisionSchema.parse({
      ...knnRevision,
      neighbors: [
        { record_id: "cal-0007", intent_id: "I-a", distance: 0.1, measurement_quality: "observed" },
        { record_id: "cal-0008", intent_id: "I-a", distance: 0.2, measurement_quality: "observed" },
      ],
    });
    expect(result.neighbors.map((n) => n.record_id)).toEqual(["cal-0007", "cal-0008"]);
  });

  it("still parses an old revision whose neighbors have no record_id (backward-read compatible)", () => {
    const result = EstimateRevisionSchema.safeParse({
      ...knnRevision,
      neighbors: [{ intent_id: "I-a", distance: 0.1, measurement_quality: "observed" }],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.neighbors[0]?.record_id).toBeUndefined();
  });

  it("the generated JSON schema declares record_id as an optional neighbor property", () => {
    const neighborItems = (
      generatedEstimateSchema as {
        definitions: {
          estimate: {
            properties: {
              revisions: {
                items: {
                  properties: {
                    neighbors: { items: { properties: object; required: string[] } };
                  };
                };
              };
            };
          };
        };
      }
    ).definitions.estimate.properties.revisions.items.properties.neighbors.items;
    expect(neighborItems.properties).toHaveProperty("record_id");
    expect(neighborItems.required).not.toContain("record_id");
  });

  it("the strict estimate/v2 decision contract still rejects a neighbor record_id", () => {
    const decision = {
      schema_version: "estimate/v2",
      target: { metric: "tokens", unit: "tokens" },
      decision: { status: "abstained", reason_codes: ["INSUFFICIENT_POPULATION"] },
      applicability: { status: "unknown" },
      cohort: {
        agent_type: "claude",
        model_provider: "anthropic",
        model_generation: "claude-5",
        model_id: "claude-sonnet-5",
        routing_policy_digest: "a".repeat(64),
        prompt_policy_digest: "b".repeat(64),
        execution_profile_digest: "c".repeat(64),
        measure_contract_version: "measure/v1",
        token_basis: CURRENT_ACCOUNTING_BASIS,
      },
      population: { candidate_count: 0, eligible_count: 0, excluded_by_reason: {} },
      prediction_interval: { status: "insufficient_data" },
      coverage_history: { frozen_predictions_only: true },
      drift: { status: "insufficient_data" },
    };
    expect(EstimateV2DecisionSchema.safeParse(decision).success).toBe(true);
    expect(
      EstimateV2DecisionSchema.safeParse({
        ...decision,
        neighbors: [{ record_id: "cal-0007", intent_id: "I-a", distance: 0.1 }],
      }).success,
    ).toBe(false);
    expect(EstimateV2DecisionSchema.safeParse({ ...decision, record_id: "cal-0007" }).success).toBe(
      false,
    );
  });
});
