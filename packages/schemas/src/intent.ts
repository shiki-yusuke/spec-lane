import { z } from "zod";
import { ConfidenceSchema, Iso8601Schema, RiskLevelSchema } from "./common.js";

// design.md §2.2.
export const BudgetConstraintSchema = z.object({
  provider: z.enum(["claude", "codex", "any"]),
  unit: z.enum(["usd", "credits"]),
  limit: z.number().positive(),
});
export type BudgetConstraint = z.infer<typeof BudgetConstraintSchema>;

// Gate-port review (2026-08-06) — premise_evidence gate 1 (design.md §3.9), ported
// from the reference implementation's validate.py gate_check_premise_evidence. A
// discriminated union on `required` rather than one object with every field optional: the
// two branches have genuinely different required fields (method/reproduced/evidence vs.
// reason), so whichever branch `required`'s value selects gets its own required fields
// enforced -- required:true without `method` is rejected, required:false without `reason`
// is rejected. This is a plain (non-strict) zod object per branch, though, so a
// required:false record that also happens to carry a stray `method`/`reproduced`/
// `evidence` is *not* rejected -- those extra keys are silently ignored, the same as any
// other unrecognized key on a non-strict zod object (see intent.test.ts's own test
// documenting this). The discriminated union's job here is "enforce the right shape for
// the branch actually chosen," not "detect cross-branch contamination."
//
// `method`'s three values describe *how* the premise's real-world existence was confirmed,
// not how "production-grade" the change is:
//   - "live": direct observation in a runnable environment (ran the code/repro'd the bug
//     against a real system).
//   - "data": existence proven via a record or query (logs, a database row, an existing
//     report) rather than live execution.
//   - "code-only": confirmed only by reading how the code is wired (a static trace of the
//     generation path) — the weakest of the three; the gate emits a warning even when this
//     branch otherwise passes, recommending an upgrade to "live"/"data" where possible.
// MP-8 (2026-08-08, sol ruling point 6) — zod's default enum error message ("Invalid
// enum value. Expected 'live' | 'data' | 'code-only', received '...'") gave `lane
// validate` (MP-7's formatZodError) nothing better to surface than that generic text.
// This fixes the message at the schema layer itself via zod's own errorMap, so no CLI
// code ever needs to redefine the enum or pattern-match the generic issue to produce a
// better message — formatZodError() picks this up verbatim, unchanged.
const PremiseEvidenceMethodSchema = z.enum(["live", "data", "code-only"], {
  errorMap: (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.invalid_enum_value) {
      return {
        message: `premise_evidence.method must be one of live|data|code-only (got: ${JSON.stringify(ctx.data)})`,
      };
    }
    return { message: ctx.defaultError };
  },
});

export const PremiseEvidenceSchema = z.discriminatedUnion("required", [
  z.object({
    required: z.literal(true),
    method: PremiseEvidenceMethodSchema,
    reproduced: z.boolean(),
    evidence: z.string(),
  }),
  z.object({
    required: z.literal(false),
    reason: z.string().min(1),
  }),
]);
export type PremiseEvidence = z.infer<typeof PremiseEvidenceSchema>;

// I-2026-08-29-external-verify-gate — the lane's own declaration of an external verification
// command whose exit status gates the 3_implement -> 4_verify transition (spec.md D1, key 1).
// Declaring it here is not sufficient to run it: the resolved profile must additionally
// authorize this command's digest (profile.ts's ExternalVerifySchema, key 2), so an
// intent.yaml arriving on a pulled branch cannot authorize itself.
//
// Every constraint below is fail-closed at the schema layer on purpose -- `spawnSync` throws
// synchronously (TypeError ERR_INVALID_ARG_VALUE / RangeError ERR_OUT_OF_RANGE, verified on
// Node v22.23.2) for an empty executable, a NUL inside any argv element, or a non-finite /
// negative timeout, so those must never reach the runner:
//   - argv[0] must be ABSOLUTE. A bare name ("dd") or relative path would be resolved through
//     $PATH at spawn time, which would let the environment decide which binary a
//     digest-authorized command actually runs (spec.md 9-2).
//   - no element may be empty or contain a NUL.
//   - timeout_seconds is bounded; the gate blocks the CLI synchronously for this long.
export const ExternalVerifyCommandSchema = z.object({
  argv: z
    .array(
      z
        .string()
        .min(1, "external_verify.argv elements must be non-empty")
        .refine((s) => !s.includes("\u0000"), {
          message: "external_verify.argv elements must not contain a NUL character",
        }),
    )
    .min(1, "external_verify.argv must have at least one element (the executable)")
    .refine((argv) => argv[0]?.startsWith("/") === true, {
      message:
        "external_verify.argv[0] must be an absolute path (a bare command name or relative path would be resolved through $PATH at spawn time, letting the environment choose which binary an authorized digest actually runs)",
    }),
  timeout_seconds: z.number().int().min(1).max(600).default(60),
});
export type ExternalVerifyCommand = z.infer<typeof ExternalVerifyCommandSchema>;

export const IntentSchema = z.object({
  schema_version: z.string().regex(/^\d+\.\d+(\.\d+)?$/),
  intent_id: z.string().regex(/^I-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/),
  // rev1 `linear_id`/`target_issue` generalized to a tracker-agnostic pair; the Tracker
  // port fills these in, pattern validation (e.g. GitHub issue URL shape) is the adapter's
  // job, not the schema's.
  tracker_id: z.string().optional(),
  tracker_url: z.string().optional(),
  target_pr: z
    .string()
    .regex(/^[a-z0-9-]+\/[a-z0-9-]+#\d+$/)
    .optional(),
  execution_mode: z.enum(["manual", "semi_auto", "auto"]).default("manual"),
  budget: z.array(BudgetConstraintSchema).default([]),
  estimate_ref: z
    .string()
    .optional()
    .describe("Path to estimate.json (docs/spec/<intent-id>/estimate.json)."),
  baseline_estimate_revision_id: z
    .string()
    .optional()
    .describe("Adopted EstimateRevision.revision_id. lane next etc. only ever read this."),
  // M2 review follow-up (team review, 2026-07-31): "adopt" is an auditable act (either
  // alongside a brand-new revision, or re-pointing to an already-existing one via
  // `lane estimate --adopt <revision-id>`), so *when* it happened needs its own record
  // rather than being inferrable only from baseline_estimate_revision_id's current value.
  baseline_adopted_at: Iso8601Schema.optional().describe(
    "When baseline_estimate_revision_id was last set via adoptBaselineRevision().",
  ),
  // Gate-port review (2026-08-06) — deliberately optional with no .default(): whether a
  // lane recorded this at all is itself the signal core/gate.ts's premiseEvidenceGate acts
  // on (unrecorded -> warning, since the CLI cannot itself decide whether the gate applies
  // to a given change). A .default() would make "never written" indistinguishable from
  // some fabricated default value, which is exactly what this field must not do.
  premise_evidence: PremiseEvidenceSchema.optional(),
  // I-2026-08-29-external-verify-gate — optional with no .default() for the same reason
  // premise_evidence above is: whether a lane declared one at all is itself the signal
  // core/gate.ts's externalVerifyGate acts on (absent -> the gate never applies and no
  // subprocess is ever spawned). A .default() would make "never configured" indistinguishable
  // from a fabricated empty command.
  external_verify: ExternalVerifyCommandSchema.optional(),
  intent: z.object({
    business_goal: z.string().min(10),
    user_visible_intent: z.string().min(10),
    success: z.array(z.string()).min(1),
    non_goal: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    primary_user: z.string(),
    state_segments: z.array(z.string()).default([]),
    known_affected_behavior: z.array(z.string()).default([]),
    // Renamed from rev1 risk_level. Immutable once written: gates never downgrade it, and
    // no code path in core is allowed to write back to intent.intent.declared_risk. The
    // gate-time effective value lives in LaneState.effective_risk_log instead (§3.4).
    declared_risk: RiskLevelSchema,
    // First-classed (2026-08-29, sol-approved fix for the `--adopt` data-loss bug): before
    // this field existed on the schema, an intent.yaml carrying `intent.critical_invariants`
    // survived a plain `readIntent`/`IntentSchema.parse` (zod ignores unrecognized keys on
    // a non-strict object) but was silently dropped the moment anything re-serialized the
    // parsed value back to disk -- `lane estimate --adopt`'s `writeIntent` re-stringifies
    // the *entire* validated object, so the field vanished from intent.yaml with no error
    // and no trace. See intent-store.ts's inspectIntent/readIntentForWrite for the general
    // guard this schema gap motivated; this entry removes the specific gap for this field.
    critical_invariants: z.array(z.string().min(1)).min(1).optional(),
  }),
  ai_inferred_scope: z.object({
    affected_layers: z.array(z.string()).min(1),
    related_files: z.array(z.string()).default([]),
    required_docs: z.array(z.string()).default([]),
    confidence: ConfidenceSchema,
    open_questions: z.array(z.string()).default([]),
    allowed_paths: z.array(z.string()).min(1),
    forbidden_paths: z.array(z.string()).default([]),
  }),
});
export type Intent = z.infer<typeof IntentSchema>;
