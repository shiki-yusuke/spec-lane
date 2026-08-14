import { z } from "zod";
import { Iso8601Schema } from "./common.js";

// design.md §2.4. TestMatrix/TestGaps/ManualVerification/goal_stopping_condition are
// carried over unchanged from the reference implementation's verification.schema.json
// (design.md only calls out two legacy fields as removed and spec_consensus as rewritten).
const TestMatrixEntrySchema = z.object({
  ears_rule: z.string().describe('Corresponds to a "Rule N (...)" entry in spec.md.'),
  test_type: z.enum(["unit", "integration", "e2e", "regression", "manual"]),
  test_file: z.string().optional(),
  test_name: z.string().optional(),
  status: z.enum(["existing", "added", "not_verified", "failing", "tbd"]),
  note: z.string().optional(),
});

const TestGapSchema = z.object({
  taxonomy: z.string(),
  description: z.string(),
  location: z.string().optional(),
  priority: z.enum(["high", "medium", "low"]),
});

const ManualVerificationSchema = z.object({
  id: z.string(),
  description: z.string(),
  expected_status: z.string(),
});

// design.md §2.4 — rev1's `disposition` (a single enum) could not express "accepted but
// still needs a reason on record", so it is split into action (what was decided) and
// status (whether that decision is finalized).
export const DeviationSchema = z
  .object({
    spec_ref: z.string(),
    actual: z.string(),
    action: z.enum(["accept", "fix", "update_spec"]),
    status: z.enum(["pending", "resolved"]),
    rationale: z.string().optional(),
    evidence_ref: z.string().optional(),
  })
  .refine((d) => d.status !== "resolved" || (!!d.rationale && d.rationale.length > 0), {
    message: "status=resolved requires rationale (rationale required even for action=accept)",
  });
export type Deviation = z.infer<typeof DeviationSchema>;

export const ReviewerAckSchema = z.object({
  reviewer_kind: z.enum(["self", "independent_agent", "human"]),
  reviewer_id: z.string(),
  acked_at: Iso8601Schema,
  spec_sha256: z.string(),
  verification_sha256: z.string(),
  evidence_ref: z.string().optional(),
  note: z.string().optional(),
  override_reason: z
    .string()
    .optional()
    .describe(
      "Required when reviewer_kind=self is used at effective risk_class=high (audited override).",
    ),
});
export type ReviewerAck = z.infer<typeof ReviewerAckSchema>;

// design.md §2.4 — spec_digest/verification_digest bind reviewer_ack to the exact content
// it was given; any content change invalidates the ack automatically (checked by the
// refine below and re-checked by core's specConsensusGate against a freshly computed
// digest, since a stale in-file digest could otherwise be hand-edited back into sync).
export const SpecConsensusSchema = z
  .object({
    spec_ssot_ref: z.string(),
    spec_digest: z.string(),
    verification_digest: z.string(),
    deviations: z.array(DeviationSchema).default([]),
    reviewer_ack: ReviewerAckSchema.nullable().default(null),
  })
  .refine(
    (sc) =>
      !sc.reviewer_ack ||
      (sc.reviewer_ack.spec_sha256 === sc.spec_digest &&
        sc.reviewer_ack.verification_sha256 === sc.verification_digest),
    {
      message:
        "reviewer_ack digest does not match current spec/verification digest (content changed since ack)",
    },
  );
export type SpecConsensus = z.infer<typeof SpecConsensusSchema>;

// Gate-port review (2026-08-06) — success_criteria gate 2 (design.md §3.9),
// ported from the reference implementation's validate.py gate_check_success_criteria.
// `criterion` is expected to be intent.intent.success's line transcribed verbatim (core's
// successCriteriaGate normalizes and cross-checks both are consistent, not this schema).
// `covered_by` deliberately *includes* "none": rejecting it at the schema level would make
// "I looked and found no coverage" indistinguishable from "I haven't written this row
// yet" -- the gate is what turns covered_by:"none" into a hard error, so the difference
// between a schema-level and a gate-level reject stays visible in the data itself.
export const SuccessCriteriaRowSchema = z.object({
  criterion: z.string().min(1),
  covered_by: z.enum(["test", "diff", "manual", "none"]),
  evidence: z.string().min(1),
  negation_test: z.string().optional(),
});
export type SuccessCriteriaRow = z.infer<typeof SuccessCriteriaRowSchema>;

// Free-form (not Iso8601Schema): the reference implementation's own template records this
// as e.g. "2026-08-06 (Phase 4)", a human-written date-plus-phase label, not a machine
// timestamp.
export const CrossCheckIntentVsSpecSchema = z.object({
  performed_at: z.string().min(1),
  finding: z.string().min(1),
});
export type CrossCheckIntentVsSpec = z.infer<typeof CrossCheckIntentVsSpecSchema>;

export const VerificationSchema = z.object({
  schema_version: z.string(),
  intent_id: z.string().regex(/^I-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/),
  target_pr: z.string().optional(),
  test_matrix: z.array(TestMatrixEntrySchema).min(1),
  test_gaps: z.array(TestGapSchema).default([]),
  manual_verification: z.array(ManualVerificationSchema).default([]),
  goal_stopping_condition: z.array(z.string()).default([]),
  spec_consensus: SpecConsensusSchema.optional(),
  // Optional, non-.default()'d for the same reason premise_evidence is (intent.ts):
  // "never recorded" must stay distinguishable from "recorded as empty" so
  // core/gate.ts's successCriteriaGate can warn rather than silently treat an absent
  // matrix as satisfied.
  success_criteria_matrix: z.array(SuccessCriteriaRowSchema).min(1).optional(),
  cross_check_intent_vs_spec: CrossCheckIntentVsSpecSchema.optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;
