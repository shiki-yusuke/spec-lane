import { z } from "zod";
import { Iso8601Schema } from "./common.js";
import {
  EffectiveRiskEvaluationSchema,
  RulesetMigrationSchema,
  WeakeningAcknowledgementSchema,
} from "./lane-state.js";

// M0 spec-lane 0.5.0 — `lane evidence export --format lane-evidence:v1`. **Owned by
// spec-lane, not ai-agent-skills-playbook, for now** (M0 spec §5): this is a first-cut
// digest bundle for the pilot's own consumption, shipped ahead of any external consumer.
// If/when a downstream consumer (the plan's own `release-evidence` tool, or similar)
// starts reading this shape, it should be promoted into the playbook's `contracts/` the
// same way trace/v1, attribution/v1, and estimate/v2 already were -- at that point this
// schema becomes read-only/frozen like those three, and any further change goes through
// the playbook's own architect-review process instead of a spec-lane-local edit. Until
// then, this schema may change within spec-lane without that ceremony (see CHANGELOG.md).

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

const DigestedArtifactSchema = z
  .object({
    path: z.string().min(1),
    digest: Sha256HexSchema,
  })
  .strict();
export type DigestedArtifact = z.infer<typeof DigestedArtifactSchema>;

const SuccessCriteriaMatrixSummarySchema = z
  .object({
    row_count: z.number().int().nonnegative(),
    covered_by_none_count: z.number().int().nonnegative(),
    negation_test_missing_count: z.number().int().nonnegative(),
  })
  .strict();

const ConsensusAckSummarySchema = z
  .object({
    reviewer_kind: z.enum(["self", "independent_agent", "human"]),
    reviewer_id: z.string().min(1),
    acked_at: Iso8601Schema,
    spec_digest: Sha256HexSchema,
    verification_digest: Sha256HexSchema,
    override_reason_present: z.boolean(),
    pending_deviation_count: z.number().int().nonnegative(),
  })
  .strict();

const PremiseEvidenceSummarySchema = z
  .object({
    required: z.boolean(),
    method: z.string().optional(),
    reproduced: z.boolean().optional(),
  })
  .strict();

const DoneOverlaySummarySchema = z
  .object({
    done_source: z.literal("local_overlay"),
    pr_url: z.string().nullable(),
    merge_sha: z.string().nullable(),
    verify_ended_at: Iso8601Schema,
    done_recorded_at: Iso8601Schema,
  })
  .strict();

const LedgerSummarySchema = z
  .object({
    entry_count: z.number().int().nonnegative(),
    included_in_kpi_count: z.number().int().nonnegative(),
    total_tokens: z.number().nonnegative().nullable(),
    total_cost_usd: z.number().nonnegative().nullable(),
    sources: z.array(z.enum(["manual", "claude_jsonl_auto", "codex_sqlite_auto"])),
    // I-2026-09-10-agent-cost-v2-basis-gate RULE-35 — always emitted (this object is
    // `.strict()`, so these are required, not optional): the normalized bases of the
    // summed entries, de-duplicated and ascending lexicographic, plus whether that set is
    // a single basis. A consumer then sees a cross-basis total without reading this
    // repo's schema comments. The empty-entries case (no ledger entries at all) is
    // "unqualified" per RULE-35, not "single".
    accounting_bases: z.array(z.string()),
    accounting_basis_status: z.enum(["single", "unqualified"]),
  })
  .strict();

// issue #46 — the 5_done-time audit records (risk evaluation, R5 ruleset-migration ack,
// R8 weakening rationale) now live only in the done overlay's `state_delta` (never
// written back into in-repo lane-state.json), so a consumer reading evidence-export alone
// would otherwise lose them entirely. Mirrors DoneOverlay["state_delta"] shape directly
// rather than re-summarizing it, since these are already small, bounded, append-only
// audit arrays -- no digesting/counting needed the way ledger_summary needs for cost_ledger.
const StateDeltaSummarySchema = z
  .object({
    effective_risk_log: z.array(EffectiveRiskEvaluationSchema),
    ruleset_migrations: z.array(RulesetMigrationSchema),
    weakening_acknowledgements: z.array(WeakeningAcknowledgementSchema),
    gate_ruleset_version: z.string().optional(),
  })
  .strict();

export const LaneEvidenceSchema = z
  .object({
    schema_version: z.literal("lane-evidence:v1"),
    intent_id: z.string().min(1),
    generated_at: Iso8601Schema,
    current_phase: z.string().min(1),
    artifacts: z
      .object({
        intent: DigestedArtifactSchema,
        spec: DigestedArtifactSchema.nullable(),
        verification: DigestedArtifactSchema.nullable(),
        success_criteria_matrix: SuccessCriteriaMatrixSummarySchema.nullable(),
        consensus_ack: ConsensusAckSummarySchema.nullable(),
        premise_evidence: PremiseEvidenceSummarySchema.nullable(),
        done_overlay: DoneOverlaySummarySchema.nullable(),
        ledger_summary: LedgerSummarySchema,
        // issue #46 follow-up (architect review) — `.optional()` (not just `.nullable()`):
        // an evidence document produced before this field existed has no `state_delta` key
        // at all, and must still validate against this schema, not just the current
        // no-overlay case's explicit `null`.
        state_delta: StateDeltaSummarySchema.nullable().optional(),
      })
      .strict(),
  })
  .strict();
export type LaneEvidence = z.infer<typeof LaneEvidenceSchema>;
