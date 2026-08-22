import { describe, expect, it } from "vitest";
import { EstimateRevisionSchema } from "../src/estimate.js";

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
