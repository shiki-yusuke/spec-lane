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

// cohort-3 measurement fix (2026-08-29) -- describes *why* requested_model/
// requested_reasoning_effort on a v2 binding-record are null, which matters because null
// here never means "confirmed uncontrolled"; it only ever means "this extractor could not
// derive a value from the spawned argv":
//   - "captured": both requested_model and requested_reasoning_effort were parsed from a
//     recognized canonical flag form.
//   - "absent": the relevant flag(s) were simply never given (including every
//     `lane work bind` manual_bind record -- there is no argv to inspect for a session the
//     caller started themselves).
//   - "unsupported_syntax": the invocation used a non-canonical spelling this extractor
//     doesn't parse (an alias like `-m`, or a combined `--model=<v>` token) -- the command
//     itself is never rejected for this, only the value is left null.
//   - "ambiguous": the canonical flag appeared more than once, or with no value at all --
//     recording a guessed value here would risk misattributing cost to the wrong
//     model/effort, so this is null'd out and warned rather than guessed.
export const AttributionCaptureStatusSchema = z.enum([
  "captured",
  "absent",
  "unsupported_syntax",
  "ambiguous",
]);
export type AttributionCaptureStatus = z.infer<typeof AttributionCaptureStatusSchema>;

const BindingRecordCommonFieldsShape = {
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
};

// attribution/v1 is vendored/frozen (see packages/core/test/fixtures/attribution/UPSTREAM)
// -- kept exactly as before, byte-for-byte, so every already-existing v1 binding-record
// (real ledger data or vendored fixtures) keeps parsing exactly as it always has.
const BindingRecordV1ObjectSchema = z
  .object({
    schema_version: z.literal("attribution/v1"),
    ...BindingRecordCommonFieldsShape,
  })
  .strict();

// New with the requested-model/effort capture fix: every *new* binding going forward
// (both `lane work run`'s wrapper-bind and `lane work bind`'s manual_bind) is projected as
// v2 -- see core/attribution.ts's deriveBindingRecordsFromTrace for where that projection
// decision is made. requested_model/requested_reasoning_effort are `nullable()`, not
// `.optional()`: a v2 record always takes a stance on whether it captured them (see
// AttributionCaptureStatusSchema above for what null means).
const BindingRecordV2ObjectSchema = z
  .object({
    schema_version: z.literal("attribution/v2"),
    ...BindingRecordCommonFieldsShape,
    requested_model: z.string().min(1).nullable(),
    requested_reasoning_effort: z.string().min(1).nullable(),
    capture_status: AttributionCaptureStatusSchema,
  })
  .strict();

type BindingRecordUnion =
  | z.infer<typeof BindingRecordV1ObjectSchema>
  | z.infer<typeof BindingRecordV2ObjectSchema>;

function refineBindingRecordInvariants(record: BindingRecordUnion, ctx: z.RefinementCtx) {
  if (record.binding_method === "manual_bind" && record.actor?.kind !== "human") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'manual_bind_requires_human_actor: a manual_bind binding-record must carry actor.kind == "human"',
      path: ["actor"],
    });
  }

  // sol review (2026-08-29, must 2): capture_status and the two nullable capture values
  // must agree -- otherwise a corrupted/hand-edited record could claim capture_status=
  // "captured" with both values null (or "absent" with both values populated), and every
  // reader downstream (cohort-3 joins included) would have no way to tell which of the two
  // contradicting signals to trust. "captured" is the ONLY status where both values are
  // required non-null; every other status requires at least one to be null (see
  // agent-invocation-capture.ts's combineCaptureStatus: capture_status is a record-level
  // summary across both fields, not a per-field flag, so "one captured + one not" is a
  // real, valid state that is *not* itself "captured").
  if (record.schema_version === "attribution/v2") {
    const bothNonNull =
      record.requested_model !== null && record.requested_reasoning_effort !== null;
    if (record.capture_status === "captured" && !bothNonNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'capture_status_captured_requires_both_values: capture_status="captured" requires both requested_model and requested_reasoning_effort to be non-null',
        path: ["capture_status"],
      });
    }
    if (record.capture_status !== "captured" && bothNonNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `capture_status_requires_at_least_one_null: capture_status="${record.capture_status}" requires requested_model or requested_reasoning_effort to be null (both non-null is only valid when capture_status="captured")`,
        path: ["capture_status"],
      });
    }
  }
}

// Reader accepts both v1 and v2 (discriminated union on schema_version) -- every existing
// v1 record stays valid; every new binding-record a writer produces is v2 (see
// core/attribution.ts). z.discriminatedUnion requires plain ZodObject members (not
// ZodEffects), so refineBindingRecordInvariants is applied once, after the union, rather
// than per-branch.
//
// sol review (2026-08-29, should 2): attribution/v2 is an internal-only extension right
// now -- unlike attribution/v1 (vendored from ai-agent-skills-playbook, see
// packages/core/test/fixtures/attribution/UPSTREAM), it is not part of that external
// contract and has no upstream JSON Schema/fixture counterpart of its own. It is also not
// among generate-json-schema.ts's `targets` (that script only covers schemas with a
// single, non-data-dependent shape used across a TS/JSON boundary -- attribution/v1's
// JSON Schema is vendored, not generated, for the same reason). If attribution/v2 is ever
// promoted to an external contract, it needs the same treatment v1 got: its own vendored
// JSON Schema + fixtures, not zod-to-json-schema generation.
export const BindingRecordSchema = z
  .discriminatedUnion("schema_version", [BindingRecordV1ObjectSchema, BindingRecordV2ObjectSchema])
  .superRefine(refineBindingRecordInvariants);
export type BindingRecord = z.infer<typeof BindingRecordSchema>;
export type BindingRecordV1 = z.infer<typeof BindingRecordV1ObjectSchema>;
export type BindingRecordV2 = z.infer<typeof BindingRecordV2ObjectSchema>;

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
