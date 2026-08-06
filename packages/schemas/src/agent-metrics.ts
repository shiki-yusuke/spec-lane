import { z } from "zod";

// design.md §4.5 — agent-metrics:v1 / token-usage:v1, the external, normative contract
// this module implements a TS mirror of. Source of truth: ai-agent-skills-playbook's
// docs/protocols/agent-metrics-v1.md + contracts/agent-metrics/v1/{envelope,token-usage}.
// schema.json (vendored at packages/schemas/test/fixtures/agent-metrics/, see
// contracts/agent-metrics/UPSTREAM for the exact commit this mirrors). Every object here
// is `.strict()` (zod's additionalProperties:false) because the contract itself declares
// `additionalProperties: false` throughout — there is deliberately no escape-hatch
// dimension anywhere in this payload (protocol doc section 4).
//
// This schema module intentionally carries no spec-lane-specific vocabulary in any field
// value or enum — a payload built from these types must be indistinguishable from one
// built by an entirely unrelated emitter targeting the same public contract.

// Contract's own generated_at pattern requires a literal "Z" suffix (UTC only), unlike
// this repo's own Iso8601Schema (common.ts), which permits a "+09:00"-style offset for
// lane's *internal* timestamps. Do not reuse Iso8601Schema here -- it would silently
// accept a payload the real contract's own schema (and verify-fixtures.mjs) would reject.
const AgentMetricsUtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

export const EmitterSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();
export type Emitter = z.infer<typeof EmitterSchema>;

export const SubjectSchema = z
  .object({
    namespace: z.string().min(1),
    type: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();
export type Subject = z.infer<typeof SubjectSchema>;

export const RepositorySchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();
export type Repository = z.infer<typeof RepositorySchema>;

export const ChangeSchema = z
  .object({
    type: z.string().min(1).optional(),
    number: z.number().int().nonnegative().optional(),
    url: z.string().min(1).optional(),
    head_sha: z.string().min(1).optional(),
  })
  .strict();
export type Change = z.infer<typeof ChangeSchema>;

// Protocol doc section 4: closed set, kept at agent-cost's own native granularity.
// cache_write_5m/cache_write_1h/cache_write_unknown are never collapsed into one
// cache_write bucket in this contract (a rejected design, protocol doc section 9) --
// unlike an earlier, unpublished, private bridge this repo has no relationship to.
export const TokenKindSchema = z.enum([
  "input_nocache",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "cache_write_unknown",
  "output",
]);
export type TokenKind = z.infer<typeof TokenKindSchema>;

export const PricingStatusSchema = z.enum(["priced", "unpriced", "unknown"]);
export type PricingStatus = z.infer<typeof PricingStatusSchema>;

export const ActivitySchema = z
  .object({
    namespace: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();
export type Activity = z.infer<typeof ActivitySchema>;

export const TokenUsageRecordSchema = z
  .object({
    activity: ActivitySchema,
    agent: z.string().min(1),
    model: z.string().min(1),
    token_kind: TokenKindSchema,
    tokens: z.number().int().nonnegative(),
    priced_tokens: z.number().int().nonnegative().optional(),
    unpriced_tokens: z.number().int().nonnegative().optional(),
    estimated_cost_usd: z.number().nonnegative().optional(),
    credits: z.number().nonnegative().optional(),
    pricing_status: PricingStatusSchema,
  })
  .strict();
export type TokenUsageRecord = z.infer<typeof TokenUsageRecordSchema>;

export const OmissionSchema = z
  .object({
    entry_id: z.string().min(1),
    reason: z.string().min(1),
    detail: z.string().optional(),
  })
  .strict();
export type Omission = z.infer<typeof OmissionSchema>;

export const CoverageSchema = z
  .object({
    status: z.enum(["complete", "partial", "no_data"]),
    eligible_entries: z.number().int().nonnegative(),
    measured_entries: z.number().int().nonnegative(),
    excluded_entries: z.number().int().nonnegative(),
    omissions: z.array(OmissionSchema).optional(),
  })
  .strict();
export type Coverage = z.infer<typeof CoverageSchema>;

export const TokenUsageDataSchema = z
  .object({
    mode: z.literal("snapshot"),
    records: z.array(TokenUsageRecordSchema).max(500),
    coverage: CoverageSchema,
  })
  .strict();
export type TokenUsageData = z.infer<typeof TokenUsageDataSchema>;

// Envelope common fields (protocol doc section 3), generic over `data`/`schema` -- the
// token-usage/v1 kind narrows both below, the same layering envelope.schema.json /
// token-usage.schema.json use (allOf composition).
const AgentMetricsEnvelopeBaseSchema = z.object({
  protocol_version: z.literal("agent-metrics/v1"),
  schema: z.string().regex(/^[a-z][a-z0-9-]*\/v[0-9]+$/),
  upsert_key: z.string().regex(/^am1_[0-9a-f]{64}$/),
  emitter: EmitterSchema,
  subject: SubjectSchema,
  repository: RepositorySchema,
  change: ChangeSchema.optional(),
  generated_at: AgentMetricsUtcTimestampSchema,
  data: z.unknown(),
});

export const AgentMetricsEnvelopeSchema = AgentMetricsEnvelopeBaseSchema.strict();
export type AgentMetricsEnvelope = z.infer<typeof AgentMetricsEnvelopeSchema>;

export const TokenUsagePayloadSchema = AgentMetricsEnvelopeBaseSchema.extend({
  schema: z.literal("token-usage/v1"),
  data: TokenUsageDataSchema,
}).strict();
export type TokenUsagePayload = z.infer<typeof TokenUsagePayloadSchema>;
