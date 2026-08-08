import { z } from "zod";
import { Iso8601Schema, MeasurementQualitySchema, RiskLevelSchema } from "./common.js";
import { PhaseSchema } from "./phase.js";

// design.md §2.6.
export const ImpactScanSnapshotSchema = z.object({
  scan_version: z.string(),
  repo_commit: z.string(),
  candidate_paths: z.array(z.string()),
  candidate_layers: z.array(z.string()),
  open_items: z.array(z.string()).default([]),
  digest: z.string().describe("sha256 of candidate_paths+layers, for reproducibility checks."),
});
export type ImpactScanSnapshot = z.infer<typeof ImpactScanSnapshotSchema>;

// design.md §2.6 — files_touched_estimate (impact-scan candidate count, "how wide the
// allowed range is") is kept separate from files_touched_observed (actual post-implement
// diff file count, "how many files actually changed"); rev1 conflated the two.
// spec_rule_count is null (not 0) before Phase 2 completes. novel_surface is a 3-state
// value so an empty knowledge DB is never silently read as "definitely novel".
export const PredictorsSchema = z.object({
  files_touched_estimate: z.number().int().nonnegative().nullable(),
  files_touched_observed: z.number().int().nonnegative().nullable(),
  layers_crossed: z.number().int().nonnegative().nullable(),
  risk_class: RiskLevelSchema,
  spec_rule_count: z.number().int().nonnegative().nullable(),
  novel_surface: z.enum(["true", "false", "unknown"]),
});
export type Predictors = z.infer<typeof PredictorsSchema>;

const QuantileSchema = z
  .object({
    p50: z.number().nonnegative().finite(),
    p80: z.number().nonnegative().finite(),
  })
  .refine((q) => q.p50 <= q.p80, { message: "p50 must be <= p80" });
export type Quantile = z.infer<typeof QuantileSchema>;

export const NeighborSchema = z.object({
  intent_id: z.string(),
  distance: z.number().nonnegative(),
  measurement_quality: MeasurementQualitySchema,
});
export type Neighbor = z.infer<typeof NeighborSchema>;

// Named separately (rather than inlined into EstimateRevisionSchema) so
// calibration.ts's CalibrationPredictionEvaluationSchema.predicted can reference the exact
// same shape without reaching into `.shape` on a refined (ZodEffects) schema.
export const PredictedSchema = z.object({
  tokens: QuantileSchema,
  cycle_time_min: QuantileSchema.optional(),
  cost_usd: QuantileSchema,
});
export type Predicted = z.infer<typeof PredictedSchema>;

// design.md §2.6 — the core of the estimate redesign: revisions[] is append-only. Nothing
// in this schema module offers a way to mutate an existing revision; core/application/
// estimate-service.ts is the only place that writes estimate.json and it only exposes
// appendRevision() (never an update/replace), so "no retroactive rewrite" is enforced by
// API shape, not just by convention.
export const EstimateRevisionSchema = z
  .object({
    revision_id: z.string(),
    estimated_at: Iso8601Schema,
    as_of_phase: PhaseSchema,
    repo_commit: z.string(),
    impact_scan_snapshot: ImpactScanSnapshotSchema.optional(),
    estimator_version: z.string(),
    predictors: PredictorsSchema,
    predicted: PredictedSchema,
    // MP-8 (2026-08-08, sol ruling point 7) — every revision's predicted numbers are
    // produced under this single accounting basis (core/token-basis.js). Optional only
    // so a pre-MP-8 revision on disk still parses.
    token_basis: z.string().optional(),
    neighbors: z.array(NeighborSchema),
    population_condition: z.object({
      population_size: z.number().int().nonnegative(),
      method: z.enum(["knn_quantile", "reference_table", "manual_fallback"]),
      experimental: z.boolean().describe("Always true when population_size < 30."),
      leave_one_out_p50_error: z.number().optional(),
      leave_one_out_p80_coverage: z.number().optional(),
    }),
  })
  .refine((r) => r.population_condition.method !== "knn_quantile" || r.predicted.cost_usd.p50 > 0, {
    message: "knn_quantile predictions must not have cost_usd.p50 == 0 (error calc divides by it)",
  });
export type EstimateRevision = z.infer<typeof EstimateRevisionSchema>;

export const EstimateSchema = z.object({
  schema_version: z.string(),
  intent_id: z.string(),
  revisions: z.array(EstimateRevisionSchema).min(1),
});
export type Estimate = z.infer<typeof EstimateSchema>;
