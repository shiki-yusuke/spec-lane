import { z } from "zod";

// I-2026-08-18-design-critic-injection (R4-R11, R37, Dependency table "Upstream contract
// shape"). Hand-authored zod mirror of upstream ai-agent-skills-playbook's
// `contracts/design-options/v1/design-options.schema.json` -- the engine_ref/critic/
// prior_involvement revision of that contract (the pre-existing, already-merged revision of
// the same file still carries the old producer-asserted `independence_status` enum +
// free-text `critic_engine`, which is exactly what R13/R16 require replacing; see this
// lane's own build notes for why the pin this file is checked against is still open).
//
// This is a *structural* mirror only: every `required`/`properties`/$defs shape and every
// schema-level `allOf` conditional the upstream .schema.json itself encodes. It deliberately
// does NOT include the extra semantic checks upstream's own verify-fixtures.mjs applies on
// top of the schema (option_id uniqueness, decision_request.option_ids resolving against
// options[], engine_ref per-kind field completeness via unknown_fields) -- folding those in
// here would make this schema reject documents the raw upstream .schema.json alone accepts,
// which would break the accept/reject conformance-parity test this lane's test suite runs
// against the vendored raw schema file (same layering convention as attribution.ts: this
// file is the zod-side of the mirror, the semantic-only checks are a separate lane-owned
// layer applied after a successful parse -- see design-independence.ts for those).
//
// R43/R44 (format-only rejection of address-shaped human_ref / credential-shaped
// session_ref) are ALSO not enforced here for the same reason: the upstream schema itself
// places no such constraint on those fields, so folding it into this mirror would again
// break conformance parity. They live in engine-ref-guard.ts instead, applied as an
// additional lane-owned gate on top of a schema-valid document.

const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DesignOptionsUtcTimestampSchema = z.string().regex(UTC_TIMESTAMP_RE);
const ContentDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

// $defs/artifact_ref
const ArtifactRefBaseSchema = z
  .object({
    logical_id: z.string().min(1),
    uri: z.string().min(1).optional(),
    source_repo: z.string().min(1).optional(),
    content_digest: ContentDigestSchema.optional(),
    digest_omitted_reason: z.string().min(1).optional(),
  })
  .strict();

export const ArtifactRefSchema = ArtifactRefBaseSchema.superRefine((ref, ctx) => {
  if (ref.content_digest === undefined && ref.digest_omitted_reason === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "content_digest absent requires digest_omitted_reason",
      path: ["digest_omitted_reason"],
    });
  }
  if (ref.content_digest !== undefined && ref.digest_omitted_reason !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "content_digest and digest_omitted_reason are mutually exclusive",
      path: ["digest_omitted_reason"],
    });
  }
  if (ref.content_digest !== undefined && ref.uri === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "content_digest present requires uri",
      path: ["uri"],
    });
  }
  if (ref.source_repo !== undefined && ref.uri === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "source_repo present requires uri",
      path: ["uri"],
    });
  }
});
export type ArtifactRef = z.infer<typeof ArtifactRefBaseSchema>;

// $defs/engine_ref -- structural only (kind is the only schema-required field; per-kind
// completeness is verify-fixtures.mjs-only upstream, ported as engineRefIssues() via the
// vendored derive-independence module, not re-checked here).
export const EngineRefSchema = z
  .object({
    kind: z.enum(["model", "human"]),
    provider: z.string().min(1).optional(),
    family: z.string().min(1).optional(),
    model_id: z.string().min(1).optional(),
    session_ref: z.string().min(1).optional(),
    human_ref: z.string().min(1).optional(),
    is_decision_maker: z.boolean().optional(),
    unknown_fields: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type EngineRef = z.infer<typeof EngineRefSchema>;

// $defs/artifactShaper
const ArtifactShaperBaseSchema = z
  .object({
    engine_ref: EngineRefSchema,
    how: z.enum(["authored", "reviewed_brief", "reviewed_predecessor_options", "other"]),
    how_note: z.string().min(1).optional(),
  })
  .strict();

export const ArtifactShaperSchema = ArtifactShaperBaseSchema.superRefine((shaper, ctx) => {
  if (shaper.how === "other" && shaper.how_note === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'how="other" requires how_note',
      path: ["how_note"],
    });
  }
});
export type ArtifactShaper = z.infer<typeof ArtifactShaperBaseSchema>;

// $defs/option
export const DesignOptionSchema = z
  .object({
    option_id: z.string().min(1),
    summary: z.string().min(1),
    key_assumptions: z.array(z.string().min(1)).min(1),
    falsifiers: z.array(z.string().min(1)).min(1),
    observable_proxies: z.array(z.string().min(1)).min(1),
    predicted_outcomes: z.array(z.string().min(1)).min(1),
    rollback_strategy: z.string().min(1),
  })
  .strict();
export type DesignOption = z.infer<typeof DesignOptionSchema>;

export const PriorInvolvementSchema = z.enum([
  "shaped_options",
  "shaped_dependency",
  "reviewed_predecessor",
  "none_observed_in_recorded_scope",
  "unknown",
]);
export type PriorInvolvement = z.infer<typeof PriorInvolvementSchema>;

// $defs/criticReview
const CriticReviewBaseSchema = z
  .object({
    critic: EngineRefSchema,
    prior_involvement: PriorInvolvementSchema,
    observation_scope_ref: ArtifactRefSchema.optional(),
    review_output_ref: ArtifactRefSchema,
    reviewed_at: DesignOptionsUtcTimestampSchema,
    target_option_ids: z.array(z.string().min(1)).min(1),
    notes_ref: ArtifactRefSchema.optional(),
  })
  .strict();

export const CriticReviewSchema = CriticReviewBaseSchema.superRefine((review, ctx) => {
  const requiresScope = review.prior_involvement === "none_observed_in_recorded_scope";
  if (requiresScope && review.observation_scope_ref === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "prior_involvement=none_observed_in_recorded_scope requires observation_scope_ref",
      path: ["observation_scope_ref"],
    });
  }
  if (!requiresScope && review.observation_scope_ref !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "observation_scope_ref is only meaningful for prior_involvement=none_observed_in_recorded_scope",
      path: ["observation_scope_ref"],
    });
  }
});
export type CriticReview = z.infer<typeof CriticReviewBaseSchema>;

// $defs/decisionRequest
export const DecisionRequestSchema = z
  .object({
    open_questions: z.array(z.string().min(1)).min(1),
    option_ids: z.array(z.string().min(1)).min(1),
    what_would_change_the_answer: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const DesignOptionsDocSchema = z
  .object({
    schema_version: z.literal("design-options/v1"),
    design_options_id: z.string().min(1),
    intent_ref: ArtifactRefSchema,
    artifact_shapers: z.array(ArtifactShaperSchema).min(1),
    options: z.array(DesignOptionSchema).min(1),
    critic_reviews: z.array(CriticReviewSchema).min(1),
    decision_request: DecisionRequestSchema,
  })
  .strict();
export type DesignOptionsDoc = z.infer<typeof DesignOptionsDocSchema>;
