import { z } from "zod";

// M0 spec-lane 0.5.0 — mirrors ai-agent-skills-playbook's
// contracts/trace/v1/trace-event.schema.json (structural layer). Source of truth:
// docs/protocols/trace-v1.md. See packages/core/test/fixtures/trace/UPSTREAM for the exact
// vendored commit this mirrors, and packages/core/src/trace.ts for the event_id identity
// recipe (RFC 8785 JCS + sha256 — requires node:crypto, kept in core per the
// schemas -> (no deps) / core -> schemas fixed dependency direction, design.md §2.1), the
// personal-dimension scan, and the size/depth limits check. Those three are deliberately
// NOT expressed here, mirroring the contract's own 4-layer verification split (schema /
// event_id recomputation / personal-dimension scan / limits) — this module is layer 1 only.
//
// Every object here is `.strict()` (additionalProperties:false) *except* `payload`, which
// the contract deliberately leaves open (each relation's payload shape is informal) —
// see trace-v1.md's Format table. Several semantic MUSTs the playbook's own minimal JSON
// Schema validator subset cannot express (self-supersedes, from_ref/to_ref <->
// task_run_id/session_id consistency, usage_imported window ordering, per-relation
// required-identity-field presence) ARE expressible in zod's superRefine and are folded in
// below as defense-in-depth — this does not relax the contract, it only catches the same
// rejections one layer earlier than event_id recomputation would.
//
// This schema module intentionally carries no spec-lane-specific vocabulary in any field
// value or enum, matching agent-metrics.ts's own stated intent for the same reason: a
// trace ledger line built from these types must be indistinguishable from one built by an
// entirely unrelated emitter targeting the same public contract.

const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TraceUtcTimestampSchema = z.string().regex(UTC_TIMESTAMP_RE);

export const TRACE_EVENT_ID_PATTERN = /^tr1_[0-9a-f]{64}$/;

export const TraceRefSchema = z
  .object({
    logical_id: z.string().min(1),
    content_digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type TraceRef = z.infer<typeof TraceRefSchema>;

export const TraceActorSchema = z
  .object({
    kind: z.enum(["human", "agent", "cli", "ci"]),
    id: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
  })
  .strict();
export type TraceActor = z.infer<typeof TraceActorSchema>;

// trace-v1.md Format table — 16-value closed set. `incident_observed`/`rolled_back_to` are
// reserved *names*, documentation-only, deliberately NOT enum members (sol architect-review
// 3rd round must1) — see the protocol doc for why emitting either is a plain enum
// violation, not a dedicated semantic check.
export const TRACE_RELATIONS = [
  "declares",
  "refines",
  "acknowledges",
  "critiques",
  "implements",
  "verifies",
  "produced_by",
  "incurred_usage",
  "attributed_to",
  "deployed_as",
  "supersedes",
  "invalidates",
  "session_observed",
  "session_bound",
  "task_run_started",
  "usage_imported",
] as const;
export const TraceRelationSchema = z.enum(TRACE_RELATIONS);
export type TraceRelation = z.infer<typeof TraceRelationSchema>;

const TraceEventBaseSchema = z.object({
  schema_version: z.literal("trace/v1"),
  event_id: z.string().regex(TRACE_EVENT_ID_PATTERN),
  relation: TraceRelationSchema,
  from_ref: TraceRefSchema,
  to_ref: TraceRefSchema,
  occurred_at: TraceUtcTimestampSchema,
  actor: TraceActorSchema,
  trace_id: z.string().min(1).optional(),
  span_id: z.string().min(1).optional(),
  parent_span_id: z.string().min(1).optional(),
  lane_id: z.string().min(1).optional(),
  task_run_id: z.string().min(1).optional(),
  phase_run_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  causation_event_id: z.string().regex(TRACE_EVENT_ID_PATTERN).optional(),
  // Deliberately open (trace-v1.md Format table's `payload` row) — no `.strict()`, no
  // shape constraint beyond "a plain object." The personal-dimension scan (core) is what
  // still polices it.
  payload: z.record(z.string(), z.unknown()).optional(),
  supersedes_event_id: z.string().regex(TRACE_EVENT_ID_PATTERN).optional(),
});

function windowOf(payload: unknown): { since?: unknown; until?: unknown } | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const window = (payload as Record<string, unknown>).window;
  if (window === null || typeof window !== "object") return undefined;
  return window as { since?: unknown; until?: unknown };
}

export const TraceEventSchema = TraceEventBaseSchema.strict().superRefine((event, ctx) => {
  const taskRunRef = event.task_run_id !== undefined ? `task_run:${event.task_run_id}` : undefined;
  const sessionRef = event.session_id !== undefined ? `session:${event.session_id}` : undefined;

  const requireIdentityField = (field: "task_run_id" | "session_id") => {
    if (event[field] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `identity_fields_missing: relation "${event.relation}" requires ${field}`,
        path: [field],
      });
    }
  };

  if (
    event.relation === "session_bound" ||
    event.relation === "task_run_started" ||
    event.relation === "attributed_to"
  ) {
    requireIdentityField("task_run_id");
  }
  if (event.relation === "session_bound" || event.relation === "usage_imported") {
    requireIdentityField("session_id");
  }

  if (event.relation === "usage_imported") {
    const window = windowOf(event.payload);
    if (
      window === undefined ||
      typeof window.since !== "string" ||
      typeof window.until !== "string"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'identity_fields_missing: relation "usage_imported" requires payload.window.since/until',
        path: ["payload", "window"],
      });
    } else if (!UTC_TIMESTAMP_RE.test(window.since) || !UTC_TIMESTAMP_RE.test(window.until)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "payload.window.since/until must be UTC timestamps (literal Z suffix)",
        path: ["payload", "window"],
      });
    } else if (!(Date.parse(window.since) < Date.parse(window.until))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `window_ordering_invalid: since (${window.since}) must be earlier than until (${window.until})`,
        path: ["payload", "window"],
      });
    }
  }

  if (event.relation === "session_bound") {
    if (event.from_ref.logical_id !== taskRunRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ref_field_mismatch: from_ref.logical_id (${event.from_ref.logical_id}) does not match task_run_id-derived "${taskRunRef}"`,
        path: ["from_ref", "logical_id"],
      });
    }
    if (event.to_ref.logical_id !== sessionRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ref_field_mismatch: to_ref.logical_id (${event.to_ref.logical_id}) does not match session_id-derived "${sessionRef}"`,
        path: ["to_ref", "logical_id"],
      });
    }
  } else if (event.relation === "usage_imported") {
    if (event.from_ref.logical_id !== sessionRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ref_field_mismatch: from_ref.logical_id (${event.from_ref.logical_id}) does not match session_id-derived "${sessionRef}"`,
        path: ["from_ref", "logical_id"],
      });
    }
    if (event.to_ref.logical_id !== taskRunRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ref_field_mismatch: to_ref.logical_id (${event.to_ref.logical_id}) does not match task_run_id-derived "${taskRunRef}"`,
        path: ["to_ref", "logical_id"],
      });
    }
  } else if (event.relation === "task_run_started") {
    if (event.to_ref.logical_id !== taskRunRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ref_field_mismatch: to_ref.logical_id (${event.to_ref.logical_id}) does not match task_run_id-derived "${taskRunRef}"`,
        path: ["to_ref", "logical_id"],
      });
    }
  }

  if (event.supersedes_event_id !== undefined && event.supersedes_event_id === event.event_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "self_supersedes: supersedes_event_id must not equal this event's own event_id",
      path: ["supersedes_event_id"],
    });
  }
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;
