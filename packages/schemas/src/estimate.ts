import { z } from "zod";
import { Iso8601Schema, MeasurementQualitySchema, RiskLevelSchema } from "./common.js";
import { EstimateV2DecisionSchema } from "./estimate-v2.js";
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
    // MP-8 (2026-08-2x) abstain-first fix — optional because `population_condition.method
    // === "abstained"` records a revision with no point estimate at all: v1's own
    // basis-eligible population was too small for a k-NN prediction and no reference
    // table was given (core/estimator.ts's ReferenceTableRequiredError). This is a
    // *different* honesty claim than MP-8's own point (sol ruling point 7, 2026-08-08),
    // which forbade a *silent placeholder default* -- fabricating a number nobody asked
    // for. Recording "we don't have enough data, here's exactly why" with no `predicted`
    // field at all is the opposite of that: a positive, honest record instead of either a
    // fabricated number or a discarded call (see buildEstimateRevision in
    // core/application/estimate-service.ts, which is the only place that ever sets
    // `method: "abstained"`). Every other method (`knn_quantile`, `reference_table`,
    // `manual_fallback`) still requires `predicted` unconditionally -- see the `.refine`
    // below.
    predicted: PredictedSchema.optional(),
    // MP-8 (2026-08-08, sol ruling point 7) — every revision's predicted numbers are
    // produced under this single accounting basis (core/token-basis.js). Optional only
    // so a pre-MP-8 revision on disk still parses.
    token_basis: z.string().optional(),
    neighbors: z.array(NeighborSchema),
    population_condition: z.object({
      population_size: z.number().int().nonnegative(),
      // "abstained" (MP-8 abstain-first fix) — the (basis-eligible) population was too
      // small for a k-NN prediction and no reference table was given; this revision
      // carries no `predicted` at all (see the field's own doc comment above). Distinct
      // from "reference_table", which also fires below the same population threshold but
      // *does* carry a predicted value -- a caller-supplied manual guess.
      method: z.enum(["knn_quantile", "reference_table", "manual_fallback", "abstained"]),
      experimental: z.boolean().describe("Always true when population_size < 30."),
      leave_one_out_p50_error: z.number().optional(),
      leave_one_out_p80_coverage: z.number().optional(),
    }),
    // M0 spec-lane 0.5.0 (M0 spec §6) — the estimate/v2 contract-shaped decision this
    // revision carries. Optional so a pre-v2 revision (this schema's v1 shape, all fields
    // above) still parses unchanged (backward-compatible read) -- every NEW revision this
    // codebase writes always populates it ("書き込みは v2 のみ"). See
    // core/estimator-v2.ts for how this is built and estimate-v2.ts for the mirrored
    // contract shape itself.
    decision_v2: EstimateV2DecisionSchema.optional(),
    // A human's `--novel-surface established|novel` declaration that resolved a
    // NOVEL_SURFACE_UNKNOWN abstain into a usable predictor value, recorded with
    // provenance (M0 spec §6: "宣言は predictors に provenance 付きで記録") -- a first-class
    // fact on the revision itself, not silently folded into `predictors.novel_surface`
    // (which stays whatever core/estimator.ts's own v1 logic already sets it to).
    novel_surface_declaration: z
      .object({
        value: z.enum(["established", "novel"]),
        source: z.literal("manual_declaration"),
        declared_at: Iso8601Schema,
      })
      .optional(),
  })
  // MP-8 abstain-first fix — `predicted` is required for every method except
  // "abstained", and forbidden (not just optional) for "abstained": an abstained
  // revision has no point estimate at all, by construction (buildEstimateRevision never
  // sets both). This is the top-level analog of EstimateV2DecisionSchema's own
  // abstained_must_not_carry_predicted rule for `decision_v2.predicted` -- same honesty
  // rule, enforced again at this schema's own `predicted` field.
  .refine(
    (r) =>
      r.population_condition.method === "abstained"
        ? r.predicted === undefined
        : r.predicted !== undefined,
    {
      message:
        'predicted is required unless population_condition.method is "abstained", and must be absent when it is',
      path: ["predicted"],
    },
  )
  .refine(
    (r) =>
      r.population_condition.method !== "knn_quantile" ||
      (r.predicted !== undefined && r.predicted.cost_usd.p50 > 0),
    {
      message:
        "knn_quantile predictions must not have cost_usd.p50 == 0 (error calc divides by it)",
    },
  );
export type EstimateRevision = z.infer<typeof EstimateRevisionSchema>;

export const EstimateSchema = z.object({
  schema_version: z.string(),
  intent_id: z.string(),
  revisions: z.array(EstimateRevisionSchema).min(1),
});
export type Estimate = z.infer<typeof EstimateSchema>;
