import { z } from "zod";
import { Iso8601Schema, RiskLevelSchema } from "./common.js";
import { PhaseSchema } from "./phase.js";

// design.md §2.5 — the Python reference implementation's lane-state.schema.json declared
// phase_history[].result as an enum with no "in_progress" value, yet the running code path
// (cmd_advance) writes an in-progress entry before it is closed out; that is a real
// schema/implementation gap, not a design choice, and rev2 fixes it here rather than
// reproducing it.
export const PhaseHistoryEntrySchema = z.object({
  phase: PhaseSchema,
  started_at: Iso8601Schema,
  ended_at: Iso8601Schema.optional(),
  result: z.enum(["in_progress", "completed", "halted", "needs_revision", "aborted"]),
  retry_count: z.number().int().nonnegative().default(0),
});
export type PhaseHistoryEntry = z.infer<typeof PhaseHistoryEntrySchema>;

export const HaltInfoSchema = z.object({
  halt_type: z.enum(["hard", "retry_exceeded", "needs_revision_escalated"]),
  halt_reason: z.string(),
  failing_command: z.string().optional(),
  critic_excerpt: z.string().optional(),
  paused_at: Iso8601Schema,
  user_instruction: z.string().nullable().default(null),
});
export type HaltInfo = z.infer<typeof HaltInfoSchema>;

export const RetryLogEntrySchema = z.object({
  fingerprint: z.string().describe("failure kind + error signature"),
  count: z.number().int().min(1),
  limit: z.number().int().min(1).optional(),
  last_seen_at: Iso8601Schema.optional(),
});
export type RetryLogEntry = z.infer<typeof RetryLogEntrySchema>;

// design.md §3.6/§10 Goodhart guard: this is aggregate process telemetry, not a per-person
// metric, so none of these keys may collide with core/goodhart.ts's PERSONAL_DIMENSION_KEYS.
export const MetricsSchema = z.object({
  ai_drafted: z.boolean().optional(),
  human_intervention_count: z.number().int().nonnegative().optional(),
  halt_count: z.number().int().nonnegative().optional(),
  false_halt_count: z.number().int().nonnegative().optional(),
  rework_commit_count: z.number().int().nonnegative().optional(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

// design.md §2.5 — previously an ad-hoc dict; now a typed ledger entry. Field names are a
// rev2 redesign (tokens/turns/cost_usd/cost_credits, session_ids[] for §3.6 window union)
// and intentionally do not mirror the Python reference implementation's build_ledger_entry() dict shape 1:1 — the
// *derivation rules* (entry id / confidence / data_state / included_in_kpi) are what M1's
// differential tests port byte-for-byte, not the on-disk entry shape.
//
// MP-8 (2026-08-08, sol ruling) — `phase` was unconditionally required even though
// `scope` already distinguished "phase" from "lane" entries, so a scope:"lane" entry
// (measuring the whole delivery, not one phase window) had nowhere honest to put its
// phase. Split into a discriminated union on `scope`: a "phase" entry still requires a
// real `phase`; a "lane" entry requires `phase: null`. Both branches also gained
// `since`/`until`/`agents` — the exact agent-cost query selector that produced this
// entry's numbers, so a later re-query (`lane emit-metrics`) can replay the identical
// window instead of drifting from what was actually measured. `LedgerEntrySchemaV2Legacy`
// below is kept as the frozen pre-3.0 flat shape, used only to parse existing v1/v2
// lane-state.json files during migration -- it must never be edited to track new fields.
const LedgerEntryCommonFields = {
  ledger_entry_id: z.string(),
  lane_id: z.string().nullable(),
  source: z.enum(["manual", "claude_jsonl_auto", "codex_sqlite_auto"]),
  session_ids: z.array(z.string()).default([]),
  data_state: z.enum(["no_data", "zero_tokens", "has_usage", "import_failed", "superseded"]),
  confidence: z.enum(["imported_windowed", "imported_lane", "estimated", "manual"]),
  included_in_kpi: z.boolean(),
  tokens: z.number().nonnegative().nullable(),
  turns: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  cost_credits: z.number().nonnegative().nullable(),
  pricing_version: z.string().nullable(),
  pricing_as_of: Iso8601Schema.nullable(),
  imported_at: Iso8601Schema,
  // The agent-cost query selector that produced this entry, so a later re-query can
  // replay it exactly (design.md §2.5 / MP-8 Rule 6). Absent (null) for any entry that
  // predates this field, or that was never built from a single recorded agent-cost call.
  since: Iso8601Schema.nullable().default(null),
  until: Iso8601Schema.nullable().default(null),
  agents: z
    .array(z.enum(["claude", "codex"]))
    .nullable()
    .default(null),
};

const PhaseScopedLedgerEntrySchema = z.object({
  ...LedgerEntryCommonFields,
  scope: z.literal("phase"),
  phase: PhaseSchema,
});

const LaneScopedLedgerEntrySchema = z.object({
  ...LedgerEntryCommonFields,
  scope: z.literal("lane"),
  phase: z.null(),
});

export const LedgerEntrySchema = z.discriminatedUnion("scope", [
  PhaseScopedLedgerEntrySchema,
  LaneScopedLedgerEntrySchema,
]);
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// Frozen pre-3.0 shape (phase always required, no since/until/agents) — migration-source
// only. Do not add new fields here; add them to LedgerEntryCommonFields above instead.
const LedgerEntrySchemaV2Legacy = z.object({
  ledger_entry_id: z.string(),
  lane_id: z.string().nullable(),
  phase: PhaseSchema,
  source: z.enum(["manual", "claude_jsonl_auto", "codex_sqlite_auto"]),
  scope: z.enum(["phase", "lane"]),
  session_ids: z.array(z.string()).default([]),
  data_state: z.enum(["no_data", "zero_tokens", "has_usage", "import_failed", "superseded"]),
  confidence: z.enum(["imported_windowed", "imported_lane", "estimated", "manual"]),
  included_in_kpi: z.boolean(),
  tokens: z.number().nonnegative().nullable(),
  turns: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  cost_credits: z.number().nonnegative().nullable(),
  pricing_version: z.string().nullable(),
  pricing_as_of: Iso8601Schema.nullable(),
  imported_at: Iso8601Schema,
});
type LedgerEntryV2Legacy = z.infer<typeof LedgerEntrySchemaV2Legacy>;

/**
 * Every pre-3.0 entry already has a real `scope`; a "phase" entry's own `phase` value is
 * preserved as-is, while a "lane" entry's `phase` (unconditionally present but never
 * actually read by any "lane"-branch logic, per ledger.ts's deriveIncludedInKpi) is
 * dropped in favor of the new schema's honest `null`. `since`/`until`/`agents` are always
 * unknown for a pre-3.0 entry (the concept didn't exist yet) — `null`, never guessed.
 */
function migrateLedgerEntryV2ToV3(v2: LedgerEntryV2Legacy): LedgerEntry {
  const withSelector = { ...v2, since: null, until: null, agents: null };
  if (v2.scope === "lane") {
    return LedgerEntrySchema.parse({ ...withSelector, phase: null });
  }
  return LedgerEntrySchema.parse(withSelector);
}

export const UsageImportAttemptSchema = z.object({
  lane_id: z.string().nullable(),
  phase: PhaseSchema,
  scope: z.enum(["phase", "lane"]),
  source: z.enum(["claude_jsonl_auto", "codex_sqlite_auto"]),
  exit_status: z.enum(["success", "failed"]),
  data_state: z.string(),
  attempted_at: Iso8601Schema,
});
export type UsageImportAttempt = z.infer<typeof UsageImportAttemptSchema>;

export const GateOverrideSchema = z.object({
  gate_id: z.string(),
  reason: z.string(),
  actor: z.string(),
  overridden_at: Iso8601Schema,
});
export type GateOverride = z.infer<typeof GateOverrideSchema>;

// design.md §3.4 — audit log of the gate-time effective risk, kept separate from
// intent.intent.declared_risk (which is immutable).
export const EffectiveRiskEvaluationSchema = z.object({
  gate_id: z.string(),
  effective_risk: RiskLevelSchema,
  applied_rule_ids: z.array(z.string()),
  profile_digest: z.string(),
  evaluated_at: Iso8601Schema,
});
export type EffectiveRiskEvaluation = z.infer<typeof EffectiveRiskEvaluationSchema>;

export const ModeResolutionSchema = z.object({
  requested_mode: z.enum(["manual", "semi_auto", "auto"]),
  effective_mode: z.enum(["manual", "semi_auto", "auto"]),
  applied_rule_id: z.string().nullable(),
  resolved_at: Iso8601Schema,
});
export type ModeResolution = z.infer<typeof ModeResolutionSchema>;

// I-2026-08-18-design-critic-injection R2/R1 — `lane start --design`'s activation record.
// `.optional()` (not `.default()`/`.nullable()`), matching `metrics` below: a schema
// default or a nullable field with a default still serializes a key (`design_track: null`)
// into every lane-state.json this schema round-trips, including lanes that never passed
// `--design` -- that would itself violate R1 ("no new field appears in lane-state.json"
// when `--design` is not used). `.optional()` with no default means a state object that
// never had this key set parses/serializes with the key genuinely absent, not present-null.
// `activated` is a literal `true` (not a plain boolean) because this field's only reason to
// exist is to record that activation happened plus its provenance -- there is no
// "activated: false" case; a lane that never activated the design track simply omits this
// field entirely (same null-not-zero shape this repo uses elsewhere).
export const DesignTrackSchema = z
  .object({
    activated: z.literal(true),
    activated_by: z.string().min(1),
    activated_at: Iso8601Schema,
  })
  .strict();
export type DesignTrack = z.infer<typeof DesignTrackSchema>;

// I-2026-08-20-promotion-invariants — the honest-until-overwritten record of a gate's
// meaningful content at the moment it last passed, kept human-readable on purpose (core's
// gate.ts's promotionWeakeningGate diffs this against the *current* content at promotion
// time and only demands a written rationale for a strictly-weaker change -- a checksum
// could detect "changed" but not narrate "how", which is the whole point per the
// architect's "checksum is a weak medicine" ruling). Only the two gates whose weakening
// isn't already caught by a hard, tamper-evident check of its own get a snapshot here:
// spec_consensus already binds reviewer_ack to a content digest (gate.ts's
// specConsensusGate), so a second soft diff over it would be redundant.
export const PremiseEvidenceSnapshotSchema = z.object({
  method: z.enum(["live", "data", "code-only"]),
  reproduced: z.boolean(),
  recorded_at: Iso8601Schema,
});
export type PremiseEvidenceSnapshot = z.infer<typeof PremiseEvidenceSnapshotSchema>;

export const SuccessCriteriaSnapshotSchema = z.object({
  // intent.intent.success, verbatim, at the moment success_criteria_matrix last passed
  // with a non-empty matrix and cross-checked criteria (not the matrix's own `criterion`
  // strings -- those are required to match intent's SSOT verbatim already, so recording
  // intent's copy is the same data and keeps this snapshot's meaning tied to the one field
  // core/gate.ts's promotionWeakeningGate actually re-reads at promotion time).
  criteria: z.array(z.string()),
  recorded_at: Iso8601Schema,
});
export type SuccessCriteriaSnapshot = z.infer<typeof SuccessCriteriaSnapshotSchema>;

// I-2026-08-29-external-verify-gate — unlike the two snapshots above (which exist so
// promotionWeakeningGate can diff "what passed then" against "what reads now"), this one
// answers a question the ledger could not otherwise answer at all: did this lane reach
// 4_verify *because* an external verification actually ran and succeeded, or merely because
// none was configured? Without it those two are indistinguishable after the fact.
//
// `recorded_at` is the runner's own completion time, NOT advance.ts's `now` -- `now` is
// captured before the gates run, so reusing it would date the record earlier than the command
// it claims to record by however long that command took (architect review 9-8).
export const ExternalVerifySnapshotSchema = z.object({
  // The shape computeExternalVerifyDigest actually produces, not "a string". Same reasoning as
  // exit_status below: this record is only ever written by lane on a passed command, so anything
  // else here is a hand-edited or corrupted state file, and an empty or arbitrary string would
  // let it assert a verification record with no command identity behind it at all.
  command_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  // Literally 0, not "any integer". This record is only ever written for a command that
  // PASSED (advance.ts writes it on the passed branch and deletes it otherwise), so any other
  // value is a state file that has been hand-edited or corrupted. Accepting `1` here would let
  // such a file assert that a failed verification is a valid success record, which is the one
  // distinction this snapshot exists to preserve.
  exit_status: z.literal(0),
  recorded_at: Iso8601Schema,
});
export type ExternalVerifySnapshot = z.infer<typeof ExternalVerifySnapshotSchema>;

export const GateSnapshotsSchema = z
  .object({
    premise_evidence: PremiseEvidenceSnapshotSchema.optional(),
    success_criteria: SuccessCriteriaSnapshotSchema.optional(),
    // Deleted (not merely left stale) by a successful 3_implement -> 4_verify that ran with no
    // external_verify configured -- otherwise a lane that passed with one, reworked back to
    // 3_implement, and dropped the configuration would still carry the old record, making "not
    // configured this time" look like "verified" (architect review 9-9).
    external_verify: ExternalVerifySnapshotSchema.optional(),
  })
  .optional();
export type GateSnapshots = z.infer<typeof GateSnapshotsSchema>;

// A promotion attempt that found a strictly-weaker snapshot-vs-current diff and was let
// through on a written rationale (gate.ts's promotionWeakeningGate) -- kept as an
// append-only audit trail, never as a bypass token: the rationale is recorded *after* the
// fact of what changed, not consulted to decide whether to detect the change at all.
export const WeakeningAcknowledgementSchema = z.object({
  finding: z.string(),
  rationale: z.string(),
  acknowledged_at: Iso8601Schema,
});
export type WeakeningAcknowledgement = z.infer<typeof WeakeningAcknowledgementSchema>;

// A lane recorded under one gate_ruleset_version whose installed binary now evaluates a
// different one (core/gate.ts's CURRENT_GATE_RULESET_VERSION) does not get silently
// re-interpreted under the new contract (architect ruling) -- `--ack-ruleset-migration`
// is the one explicit, recorded escape hatch.
export const RulesetMigrationSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  acknowledged_at: Iso8601Schema,
});
export type RulesetMigration = z.infer<typeof RulesetMigrationSchema>;

// Current (3.0). MP-8 bump: only `cost_ledger`'s entry shape actually changed
// (LedgerEntrySchema, now a discriminated union) -- every other field is identical to
// 2.0's.
export const LaneStateSchemaV3 = z
  .object({
    schema_version: z.literal("3.0"),
    intent_id: z.string(),
    tracker_url: z.string().nullable(),
    pr_url: z.string().nullable(),
    pr_provenance: z.enum(["advance", "done_overlay", "sync_done"]).nullable().default(null),
    owner: z.string().nullable(),
    current_phase: PhaseSchema,
    status: z.enum(["pending", "running", "paused", "completed", "aborted"]),
    created_at: Iso8601Schema,
    updated_at: Iso8601Schema.optional(),
    phase_history: z.array(PhaseHistoryEntrySchema).default([]),
    halt_info: HaltInfoSchema.nullable().default(null),
    retry_log: z.array(RetryLogEntrySchema).default([]),
    effective_risk_log: z.array(EffectiveRiskEvaluationSchema).default([]),
    mode_resolution_log: z.array(ModeResolutionSchema).default([]),
    cost_ledger: z.array(LedgerEntrySchema).default([]),
    usage_import_attempts: z.array(UsageImportAttemptSchema).default([]),
    usage_import_gate_overrides: z.array(GateOverrideSchema).default([]),
    metrics: MetricsSchema.optional(),
    design_track: DesignTrackSchema.optional(),
    // I-2026-08-20-promotion-invariants — `.optional()` with no default, same reasoning as
    // design_track above: a lane that predates this field (or a lane whose gate_ruleset_version
    // was never explicitly migrated) must round-trip with the key genuinely absent, not a
    // fabricated fallback value, so "absent" stays distinguishable from "recorded" at
    // promotion time (core/gate.ts's gateRulesetVersionGate treats them differently on
    // purpose -- see that gate's doc comment).
    gate_ruleset_version: z.string().optional(),
    gate_snapshots: GateSnapshotsSchema,
    weakening_acknowledgements: z.array(WeakeningAcknowledgementSchema).optional(),
    ruleset_migrations: z.array(RulesetMigrationSchema).optional(),
  })
  // Unknown keys are preserved rather than stripped: silently dropping a future field on
  // every read/write round-trip would be a real (if slow) data-loss bug, not just a type
  // nuisance. Known fields above are still strictly validated; only *unknown* keys pass
  // through untouched.
  .passthrough();
export type LaneState = z.infer<typeof LaneStateSchemaV3>;

// Frozen 2.0 shape (LedgerEntrySchemaV2Legacy-backed) — migration-source only. A real,
// already-existing lane-state.json in the wild may be at this version (e.g. a lane that
// reached 4_verify/5_done, with real phase-scoped ledger entries and/or an existing done
// overlay, before this repo adopted schema 3.0) — MP-8 Rule 8b requires these keep
// reading transparently, the same way a 1.0 file already did before this bump.
export const LaneStateSchemaV2 = z
  .object({
    schema_version: z.literal("2.0"),
    intent_id: z.string(),
    tracker_url: z.string().nullable(),
    pr_url: z.string().nullable(),
    pr_provenance: z.enum(["advance", "done_overlay", "sync_done"]).nullable().default(null),
    owner: z.string().nullable(),
    current_phase: PhaseSchema,
    status: z.enum(["pending", "running", "paused", "completed", "aborted"]),
    created_at: Iso8601Schema,
    updated_at: Iso8601Schema.optional(),
    phase_history: z.array(PhaseHistoryEntrySchema).default([]),
    halt_info: HaltInfoSchema.nullable().default(null),
    retry_log: z.array(RetryLogEntrySchema).default([]),
    effective_risk_log: z.array(EffectiveRiskEvaluationSchema).default([]),
    mode_resolution_log: z.array(ModeResolutionSchema).default([]),
    cost_ledger: z.array(LedgerEntrySchemaV2Legacy).default([]),
    usage_import_attempts: z.array(UsageImportAttemptSchema).default([]),
    usage_import_gate_overrides: z.array(GateOverrideSchema).default([]),
    metrics: MetricsSchema.optional(),
  })
  .passthrough();
export type LaneStateV2 = z.infer<typeof LaneStateSchemaV2>;

export function migrateLaneStateV2ToV3(v2: LaneStateV2): LaneState {
  return LaneStateSchemaV3.parse({
    ...v2,
    schema_version: "3.0",
    cost_ledger: v2.cost_ledger.map(migrateLedgerEntryV2ToV3),
  });
}

// Pre-rev2 shape: the rev2-only audit logs (effective_risk_log/mode_resolution_log) are
// absent, and cost_ledger predates the discriminated-union shape (LedgerEntrySchemaV2Legacy).
//
// **spec-lane 0.5.1 fix (dogfood bug report, 2026-08-09)**: this schema's phase_history
// entry used to have its own narrower inline enum omitting "in_progress", on the
// documented (but, it turns out, incorrect) assumption that "there is no real 1.0
// population for this greenfield TS tool yet." `lane attribution audit` -- which,
// unlike every other command, iterates over *every* intent under specDir rather than one
// named on the command line -- was the first caller to actually exercise that assumption
// against real data, and it does not hold: a real dogfooded repo's docs/spec/ (hundreds
// of lanes going back to the *Python reference implementation*, which has always used
// "1.0"/"2.0" as its own version literals and has always supported "in_progress") is
// overwhelmingly `schema_version: "1.0"` with in-progress phase_history entries -- not a
// hypothetical edge case, the common case. Every non-3.0-versioned real lane in that repo
// failed to parse at all. Fixed by reusing PhaseHistoryEntrySchema (the same 5-value enum
// V2/V3 already use) here instead of a separate, incorrectly-narrower inline definition.
export const LaneStateSchemaV1 = z
  .object({
    schema_version: z.literal("1.0").optional(),
    intent_id: z.string(),
    tracker_url: z.string().nullable().optional(),
    pr_url: z.string().nullable().optional(),
    owner: z.string().nullable().optional(),
    current_phase: PhaseSchema,
    status: z.enum(["pending", "running", "paused", "completed", "aborted"]),
    created_at: Iso8601Schema,
    updated_at: Iso8601Schema.optional(),
    phase_history: z.array(PhaseHistoryEntrySchema).default([]),
    halt_info: HaltInfoSchema.nullable().default(null),
    retry_log: z.array(RetryLogEntrySchema).default([]),
    cost_ledger: z.array(LedgerEntrySchemaV2Legacy).default([]),
    usage_import_attempts: z.array(UsageImportAttemptSchema).default([]),
    usage_import_gate_overrides: z.array(GateOverrideSchema).default([]),
    metrics: MetricsSchema.optional(),
  })
  .passthrough();
export type LaneStateV1 = z.infer<typeof LaneStateSchemaV1>;

export function migrateLaneStateV1ToV2(v1: LaneStateV1): LaneStateV2 {
  return LaneStateSchemaV2.parse({
    ...v1,
    schema_version: "2.0",
    tracker_url: v1.tracker_url ?? null,
    pr_url: v1.pr_url ?? null,
    pr_provenance: null,
    owner: v1.owner ?? null,
    // v1's phase_history now uses the same PhaseHistoryEntrySchema as v2/v3 (see the fix
    // note above), so every v1 entry -- "in_progress" included -- is already a valid v2
    // entry as-is.
    phase_history: v1.phase_history,
    effective_risk_log: [],
    mode_resolution_log: [],
  });
}

/**
 * Version-dispatching parse: routes to the matching schema and upgrades it all the way
 * to the current (3.0) shape in memory — v1 and v2 files transparently upgrade on every
 * read, the same way v1->v2 already did before this bump (design.md §2.5 / sol 裁定:
 * "schema version is version dispatcher + migration", extended by MP-8 Rule 8b: a
 * pre-existing v2 file with real ledger entries and/or an existing done overlay must keep
 * working with no explicit migrate step).
 */
export function parseLaneState(raw: unknown): LaneState {
  const version = (raw as { schema_version?: string } | null | undefined)?.schema_version;
  if (version === "3.0") {
    return LaneStateSchemaV3.parse(raw);
  }
  if (version === "2.0") {
    return migrateLaneStateV2ToV3(LaneStateSchemaV2.parse(raw));
  }
  return migrateLaneStateV2ToV3(migrateLaneStateV1ToV2(LaneStateSchemaV1.parse(raw)));
}
