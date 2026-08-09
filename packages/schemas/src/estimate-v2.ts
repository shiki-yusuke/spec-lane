import { z } from "zod";

// M0 spec-lane 0.5.0 — mirrors ai-agent-skills-playbook's
// contracts/estimate/v2/estimate-decision.schema.json (structural layer). Source of
// truth: docs/protocols/estimate-v2.md. See
// packages/core/test/fixtures/estimate/UPSTREAM for the exact vendored commit. Same
// layering convention as trace.ts/attribution.ts: every object is `.strict()` except
// `prediction_interval` under `status:"insufficient_data"` (closed to `status` alone, per
// the contract's own schema/if/then/else), and every semantic MUST zod's superRefine CAN
// express (the tagged-union state machine, quantile ordering, population accounting) is
// folded in as defense-in-depth.
//
// This is embedded into spec-lane's own EstimateRevisionSchema (estimate.ts) as an
// optional `decision_v2` field -- a pre-v2 revision on disk simply lacks it (backward-
// compatible read); every new revision this codebase writes populates it (M0 spec §6:
// "書き込みは v2 のみ").

export const ESTIMATE_V2_REASON_CODES = [
  "INSUFFICIENT_POPULATION",
  "INSUFFICIENT_COMPARABLE_NEIGHBORS",
  "DISTANCE_ABOVE_THRESHOLD",
  "TOKEN_BASIS_MISMATCH",
  "MODEL_GENERATION_MISMATCH",
  "ROUTING_PROFILE_MISMATCH",
  "PREDICTOR_SCHEMA_MISMATCH",
  "NOVEL_SURFACE_UNKNOWN",
  "OUT_OF_DOMAIN",
  "MIXED_OR_UNATTRIBUTED_USAGE",
  "DRIFT_WARNING",
  "TARGET_BASIS_UNSUPPORTED",
] as const;
export const EstimateV2ReasonCodeSchema = z.enum(ESTIMATE_V2_REASON_CODES);
export type EstimateV2ReasonCode = z.infer<typeof EstimateV2ReasonCodeSchema>;

/** DRIFT_WARNING is the one ADVISORY code; every other one is BLOCKING (estimate-v2.md's
 * "Tagged-union state machine" section). */
export const ESTIMATE_V2_ADVISORY_REASON_CODES = new Set<EstimateV2ReasonCode>(["DRIFT_WARNING"]);
export const ESTIMATE_V2_BLOCKING_REASON_CODES = new Set<EstimateV2ReasonCode>(
  ESTIMATE_V2_REASON_CODES.filter((c) => !ESTIMATE_V2_ADVISORY_REASON_CODES.has(c)),
);

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

const EstimateV2TargetSchema = z
  .object({
    metric: z.enum(["tokens", "cost_usd", "cycle_time_min"]),
    unit: z.string().min(1),
  })
  .strict();
export type EstimateV2Target = z.infer<typeof EstimateV2TargetSchema>;

const EstimateV2PredictedSchema = z
  .object({
    p50: z.number().nonnegative(),
    p80: z.number().nonnegative(),
    value_status: z.enum(["estimated", "lower_bound"]),
  })
  .strict();
export type EstimateV2Predicted = z.infer<typeof EstimateV2PredictedSchema>;

const EstimateV2DecisionFieldSchema = z
  .object({
    status: z.enum(["predicted", "abstained"]),
    reason_codes: z.array(EstimateV2ReasonCodeSchema),
  })
  .strict();

const EstimateV2ApplicabilitySchema = z
  .object({
    status: z.enum(["in_domain", "out_of_domain", "unknown"]),
    nearest_distance: z.number().nonnegative().optional(),
    distance_threshold: z.number().nonnegative().optional(),
  })
  .strict();

export const EstimateV2CohortSchema = z
  .object({
    agent_type: z.string().min(1),
    model_provider: z.string().min(1),
    model_generation: z.string().min(1),
    model_id: z.string().min(1),
    routing_policy_digest: Sha256HexSchema,
    prompt_policy_digest: Sha256HexSchema,
    measure_contract_version: z.string().min(1),
    token_basis: z.string().min(1),
    execution_profile_digest: Sha256HexSchema,
  })
  .strict();
export type EstimateV2Cohort = z.infer<typeof EstimateV2CohortSchema>;

const EstimateV2PopulationSchema = z
  .object({
    candidate_count: z.number().int().nonnegative(),
    eligible_count: z.number().int().nonnegative(),
    excluded_by_reason: z.record(z.string(), z.number()),
  })
  .strict();

const EstimateV2PredictionIntervalSchema = z
  .object({
    status: z.enum(["available", "insufficient_data"]),
    level: z.number().gt(0).lt(1).optional(),
    lower: z.number().nonnegative().optional(),
    upper: z.number().nonnegative().optional(),
    method: z.string().min(1).optional(),
    calibration_sample_size: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((interval, ctx) => {
    const availableFields = [
      "level",
      "lower",
      "upper",
      "method",
      "calibration_sample_size",
    ] as const;
    if (interval.status === "available") {
      for (const field of availableFields) {
        if (interval[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `prediction_interval_available_incomplete: status "available" requires ${field}`,
            path: [field],
          });
        }
      }
    } else {
      for (const field of availableFields) {
        if (interval[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `prediction_interval_insufficient_data_has_value_field: status "insufficient_data" must not carry ${field}`,
            path: [field],
          });
        }
      }
    }
  });

const EstimateV2CoverageHistorySchema = z
  .object({
    frozen_predictions_only: z.literal(true),
  })
  .strict();

const EstimateV2DriftSchema = z
  .object({
    status: z.enum(["insufficient_data", "stable", "warning"]),
  })
  .strict();

const EstimateV2DecisionBaseSchema = z.object({
  schema_version: z.literal("estimate/v2"),
  target: EstimateV2TargetSchema,
  predicted: EstimateV2PredictedSchema.optional(),
  decision: EstimateV2DecisionFieldSchema,
  applicability: EstimateV2ApplicabilitySchema,
  cohort: EstimateV2CohortSchema,
  population: EstimateV2PopulationSchema,
  prediction_interval: EstimateV2PredictionIntervalSchema,
  coverage_history: EstimateV2CoverageHistorySchema,
  drift: EstimateV2DriftSchema,
});

export const EstimateV2DecisionSchema = EstimateV2DecisionBaseSchema.strict().superRefine(
  (decision, ctx) => {
    const blockingPresent = decision.decision.reason_codes.filter((c) =>
      ESTIMATE_V2_BLOCKING_REASON_CODES.has(c),
    );

    if (decision.decision.status === "abstained") {
      if (decision.predicted !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'abstained_must_not_carry_predicted: decision.status is "abstained" but predicted is present',
          path: ["predicted"],
        });
      }
      if (blockingPresent.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'abstained_requires_blocking_reason_code: decision.status is "abstained" but reason_codes contains no BLOCKING code',
          path: ["decision", "reason_codes"],
        });
      }
      if (decision.prediction_interval.status === "available") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "abstained_must_not_have_available_interval: an abstained decision has no point estimate for an interval to surround",
          path: ["prediction_interval"],
        });
      }
    } else {
      if (decision.predicted === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'predicted_required: decision.status is "predicted" but predicted is absent',
          path: ["predicted"],
        });
      }
      if (blockingPresent.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `predicted_with_blocking_reason_code: decision.status is "predicted" but reason_codes carries BLOCKING code(s) ${blockingPresent.join(", ")}`,
          path: ["decision", "reason_codes"],
        });
      }
      if (decision.applicability.status === "out_of_domain") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'predicted_out_of_domain: decision.status is "predicted" but applicability.status is "out_of_domain"',
          path: ["applicability", "status"],
        });
      }
    }

    if (
      decision.predicted &&
      typeof decision.predicted.p50 === "number" &&
      typeof decision.predicted.p80 === "number" &&
      decision.predicted.p50 > decision.predicted.p80
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `predicted_quantiles_inverted: p50 (${decision.predicted.p50}) must be <= p80 (${decision.predicted.p80})`,
        path: ["predicted"],
      });
    }

    if (
      decision.prediction_interval.status === "available" &&
      typeof decision.prediction_interval.lower === "number" &&
      typeof decision.prediction_interval.upper === "number" &&
      decision.prediction_interval.lower > decision.prediction_interval.upper
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `prediction_interval_inverted: lower (${decision.prediction_interval.lower}) must be <= upper (${decision.prediction_interval.upper})`,
        path: ["prediction_interval"],
      });
    }

    if (decision.population.eligible_count > decision.population.candidate_count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `eligible_exceeds_candidate: population.eligible_count (${decision.population.eligible_count}) must be <= population.candidate_count (${decision.population.candidate_count})`,
        path: ["population", "eligible_count"],
      });
    }

    let sum = 0;
    let sumIsTrustworthy = true;
    for (const [key, value] of Object.entries(decision.population.excluded_by_reason)) {
      if (!(ESTIMATE_V2_REASON_CODES as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `excluded_by_reason_unknown_key: "${key}" is not one of the 12 reason_codes`,
          path: ["population", "excluded_by_reason", key],
        });
        sumIsTrustworthy = false;
        continue;
      }
      if (!Number.isInteger(value) || value < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `excluded_by_reason_invalid_value: excluded_by_reason["${key}"] must be a non-negative integer, got ${JSON.stringify(value)}`,
          path: ["population", "excluded_by_reason", key],
        });
        sumIsTrustworthy = false;
        continue;
      }
      sum += value;
    }
    if (sumIsTrustworthy) {
      const expected = decision.population.candidate_count - decision.population.eligible_count;
      if (sum !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `excluded_by_reason_sum_mismatch: excluded_by_reason values sum to ${sum}, but candidate_count(${decision.population.candidate_count}) - eligible_count(${decision.population.eligible_count}) = ${expected}`,
          path: ["population", "excluded_by_reason"],
        });
      }
    }
  },
);
export type EstimateV2Decision = z.infer<typeof EstimateV2DecisionSchema>;
