import { z } from "zod";

// M0 spec-lane 0.5.0 — mirrors ai-agent-skills-playbook's
// contracts/attribution/v1/{binding-record,audit-result}.schema.json. Source of truth:
// docs/protocols/attribution-v1.md. See packages/core/test/fixtures/attribution/UPSTREAM
// for the exact vendored commit. Same layering convention as trace.ts: structural
// constraints plus the semantic MUSTs zod's superRefine CAN express are folded in here as
// defense-in-depth; the personal-dimension scan is left to the caller (both schemas here
// are fully `.strict()`, so a forbidden key would already be caught as an unrecognized
// key -- the scan exists to enumerate every offending key individually, which a single
// "unrecognized_keys" schema issue does not).

const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const AttributionUtcTimestampSchema = z.string().regex(UTC_TIMESTAMP_RE);

export const AttributionActorSchema = z
  .object({
    kind: z.enum(["human", "agent", "cli", "ci"]),
    id: z.string().min(1).optional(),
  })
  .strict();
export type AttributionActor = z.infer<typeof AttributionActorSchema>;

export const BindingMethodSchema = z.enum([
  "pre_assigned_session_id",
  "self_reported_thread_id",
  "manual_bind",
]);
export type BindingMethod = z.infer<typeof BindingMethodSchema>;

const BindingRecordBaseSchema = z.object({
  schema_version: z.literal("attribution/v1"),
  task_run_id: z.string().min(1),
  phase_run_id: z.string().min(1).optional(),
  lane_id: z.string().min(1),
  intent_id: z.string().min(1),
  agent: z.enum(["claude", "codex"]),
  binding_method: BindingMethodSchema,
  session_id: z.string().min(1),
  bound_at: AttributionUtcTimestampSchema,
  binding_status: z.enum(["bound", "superseded"]),
  actor: AttributionActorSchema.optional(),
});

export const BindingRecordSchema = BindingRecordBaseSchema.strict().superRefine((record, ctx) => {
  if (record.binding_method === "manual_bind" && record.actor?.kind !== "human") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'manual_bind_requires_human_actor: a manual_bind binding-record must carry actor.kind == "human"',
      path: ["actor"],
    });
  }
});
export type BindingRecord = z.infer<typeof BindingRecordSchema>;

export const ATTRIBUTION_VIOLATION_REASON_CODES = [
  "UNBOUND_SESSION",
  "MULTI_TASK_BINDING",
  "ORPHAN_USAGE",
  "MEASUREMENT_INCOMPLETE",
] as const;
export const AttributionViolationReasonCodeSchema = z.enum(ATTRIBUTION_VIOLATION_REASON_CODES);
export type AttributionViolationReasonCode = z.infer<typeof AttributionViolationReasonCodeSchema>;

const AttributionViolationSchema = z
  .object({
    reason_code: AttributionViolationReasonCodeSchema,
    session_id: z.string().min(1),
    task_run_id: z.string().min(1).optional(),
    detail: z.string().min(1),
  })
  .strict();
export type AttributionViolation = z.infer<typeof AttributionViolationSchema>;

const LIST_REASON_CODE: Record<
  "unbound" | "mixed" | "orphan_usage" | "measurement_incomplete",
  AttributionViolationReasonCode
> = {
  unbound: "UNBOUND_SESSION",
  mixed: "MULTI_TASK_BINDING",
  orphan_usage: "ORPHAN_USAGE",
  measurement_incomplete: "MEASUREMENT_INCOMPLETE",
};

const AuditResultBaseSchema = z.object({
  schema_version: z.literal("attribution/v1"),
  generated_at: AttributionUtcTimestampSchema,
  window: z
    .object({
      since: AttributionUtcTimestampSchema,
      until: AttributionUtcTimestampSchema,
    })
    .strict(),
  sessions: z
    .object({
      exactly_attributed: z.array(
        z
          .object({
            session_id: z.string().min(1),
            tokens: z.number().int().nonnegative(),
          })
          .strict(),
      ),
      unbound: z.array(z.string().min(1)),
      mixed: z.array(z.string().min(1)),
      orphan_usage: z.array(z.string().min(1)),
      measurement_incomplete: z.array(z.string().min(1)),
    })
    .strict(),
  tokens: z
    .object({
      exact_attributed: z.number().int().nonnegative().nullable(),
      total_measured: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  research_eligible: z.boolean(),
  violations: z.array(AttributionViolationSchema),
});

export const AttributionAuditResultSchema = AuditResultBaseSchema.strict().superRefine(
  (audit, ctx) => {
    if (!(Date.parse(audit.window.since) < Date.parse(audit.window.until))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `window_ordering_invalid: since (${audit.window.since}) must be earlier than until (${audit.window.until})`,
        path: ["window"],
      });
    }

    if (audit.violations.length > 0 && audit.research_eligible) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "research_eligible_violates_fail_closed_rule: research_eligible must be false whenever violations is non-empty",
        path: ["research_eligible"],
      });
    }

    const listEntries: Array<
      ["unbound" | "mixed" | "orphan_usage" | "measurement_incomplete", readonly string[]]
    > = [
      ["unbound", audit.sessions.unbound],
      ["mixed", audit.sessions.mixed],
      ["orphan_usage", audit.sessions.orphan_usage],
      ["measurement_incomplete", audit.sessions.measurement_incomplete],
    ];
    const seen = new Map<string, string>();
    let disjoint = true;
    const noteSeen = (sessionId: string, listName: string) => {
      const prior = seen.get(sessionId);
      if (prior && prior !== listName) disjoint = false;
      seen.set(sessionId, listName);
    };
    for (const { session_id } of audit.sessions.exactly_attributed)
      noteSeen(session_id, "exactly_attributed");
    for (const [name, ids] of listEntries) for (const id of ids) noteSeen(id, name);
    if (!disjoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "sessions_not_disjoint: a session_id appears in more than one of the five sessions lists",
        path: ["sessions"],
      });
    }

    for (const [listName, ids] of listEntries) {
      const reasonCode = LIST_REASON_CODE[listName];
      for (const id of ids) {
        const hasMatch = audit.violations.some(
          (v) => v.session_id === id && v.reason_code === reasonCode,
        );
        if (!hasMatch) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `missing_violation_for_session: sessions.${listName} contains "${id}" with no matching violations[] entry (reason_code=${reasonCode})`,
            path: ["sessions", listName],
          });
        }
      }
    }
    for (const violation of audit.violations) {
      const listName = (Object.entries(LIST_REASON_CODE).find(
        ([, code]) => code === violation.reason_code,
      )?.[0] ?? null) as keyof typeof LIST_REASON_CODE | null;
      const list = listName ? audit.sessions[listName] : undefined;
      if (!list?.includes(violation.session_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing_violation_for_session: violations[] entry for "${violation.session_id}" (${violation.reason_code}) has no corresponding session in sessions.${listName ?? "?"}`,
          path: ["violations"],
        });
      }
    }

    const exactSum = audit.sessions.exactly_attributed.reduce((sum, s) => sum + s.tokens, 0);
    const allEmpty =
      audit.sessions.exactly_attributed.length === 0 &&
      audit.sessions.unbound.length === 0 &&
      audit.sessions.mixed.length === 0 &&
      audit.sessions.orphan_usage.length === 0 &&
      audit.sessions.measurement_incomplete.length === 0;

    if (allEmpty) {
      if (audit.tokens.exact_attributed !== null || audit.tokens.total_measured !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "unattributed_must_be_null_not_zero: tokens.exact_attributed/total_measured must be null (not 0) when all five sessions lists are empty",
          path: ["tokens"],
        });
      }
    } else {
      if (audit.tokens.exact_attributed !== exactSum) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `exact_attributed_sum_mismatch: tokens.exact_attributed (${audit.tokens.exact_attributed}) must equal the sum of sessions.exactly_attributed[].tokens (${exactSum})`,
          path: ["tokens", "exact_attributed"],
        });
      }
      if (
        audit.tokens.total_measured !== null &&
        audit.tokens.exact_attributed !== null &&
        audit.tokens.total_measured < audit.tokens.exact_attributed
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `total_measured_below_exact_attributed: tokens.total_measured (${audit.tokens.total_measured}) must be >= tokens.exact_attributed (${audit.tokens.exact_attributed})`,
          path: ["tokens", "total_measured"],
        });
      }
    }
  },
);
export type AttributionAuditResult = z.infer<typeof AttributionAuditResultSchema>;
