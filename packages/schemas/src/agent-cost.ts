import { z } from "zod";

// design.md §4.1 — agent-cost's real `measure --format json` contract (protocol_version
// "measure/v1", published 2026-07-31 in the agent-cost README's "Machine consumption"
// section). This supersedes design.md's original speculative draft (a `--window` list +
// a flat `facts: Fact[]` array): the actual CLI is session-id keyed
// (`measure --session-id <id> [--session-id <id> ...]`, at least one required) and
// returns pre-aggregated per-session and union totals, not raw facts. Validated at the
// TelemetryAdapter boundary since this crosses a subprocess boundary — a caller must
// check protocol_version before trusting the shape.

const AgentCostTotalsSchema = z.object({
  tokens: z.number().nonnegative(),
  priced_tokens: z.number().nonnegative(),
  unpriced_tokens: z.number().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  credits: z.number().nonnegative(),
});
export type AgentCostTotals = z.infer<typeof AgentCostTotalsSchema>;

// Gate-port/MP-3 review (2026-08-07) — was an opaque `z.record` ("not consumed
// field-by-field by lane yet, M2 only reads totals"). The agent-metrics emitter
// (core/application/metrics-service.ts) is the first consumer that reads `measure`'s own
// per-row breakdown, so this is now modeled to the real shape agent-cost's
// agent_cost/aggregate.py Row.to_dict() emits -- confirmed by reading that dataclass
// directly, and identical in shape to AgentCostReportRowSchema below (both `measure` and
// `report` build their rows through the same shared `build_rows()`/`Row` machinery).
// `.passthrough()` rather than `.strict()`: this crosses a subprocess/version boundary
// (design.md §4.1), so an agent-cost version that adds a field must not make lane
// suddenly reject its output.
export const AgentCostRowSchema = z
  .object({
    month: z.string().nullable(),
    agent: z.enum(["claude", "codex"]).nullable(),
    model: z.string().nullable(),
    token_kind: z.string().nullable(),
    tokens: z.number().nonnegative(),
    priced_tokens: z.number().nonnegative(),
    unpriced_tokens: z.number().nonnegative(),
    estimated_cost_usd: z.number().nonnegative(),
    credits: z.number().nonnegative(),
    pricing_status: z.enum(["unpriced", "lower_bound", "priced"]),
  })
  .passthrough();
export type AgentCostRow = z.infer<typeof AgentCostRowSchema>;

const AgentCostSessionEntrySchema = z.object({
  matched: z.boolean(),
  rows: z.array(AgentCostRowSchema),
  totals: AgentCostTotalsSchema,
});

export const AgentCostMeasureResultSchema = z.object({
  protocol_version: z.string(),
  generated_at: z.string(),
  window: z.object({
    since: z.string().nullable(),
    until: z.string().nullable(),
  }),
  timezone: z.string(),
  agent: z.array(z.enum(["claude", "codex"])),
  rates: z.object({
    catalog_version: z.string(),
    sha256: z.string(),
  }),
  session_ids: z.array(z.string()),
  sessions: z.record(z.string(), AgentCostSessionEntrySchema),
  total: z.object({
    rows: z.array(AgentCostRowSchema),
    totals: AgentCostTotalsSchema,
  }),
  data_quality: z.object({
    malformed_events: z.number().int().nonnegative(),
    skipped_files: z.number().int().nonnegative(),
    negative_deltas: z.number().int().nonnegative(),
    unpriced_tokens: z.number().nonnegative(),
    source_quality: z.record(z.string(), z.number()),
  }),
});
export type AgentCostMeasureResult = z.infer<typeof AgentCostMeasureResultSchema>;

// design.md §4.2/M3 — CodexBudgetAdapter needs an *aggregate* usage query (total credits
// consumed in a budget period), which `measure` cannot provide (it is session-id keyed,
// per the comment above). agent-cost's `report --format json` is the real subcommand for
// this (verified against the actual CLI, 2026-07-31): unlike `measure`, its rows carry
// their own `pricing_status` per aggregation bucket, matching agent_cost/aggregate.py's
// literal ranking values (unpriced < lower_bound < priced) — not the 3-value
// "priced"/"unpriced"/"stale" set CalibrationObservation.actual uses (a lane-invented
// concept unrelated to this one; the two must not be confused).
const AgentCostReportRowSchema = z
  .object({
    month: z.string().nullable(),
    agent: z.enum(["claude", "codex"]).nullable(),
    model: z.string().nullable(),
    token_kind: z.string().nullable(),
    tokens: z.number().nonnegative(),
    priced_tokens: z.number().nonnegative(),
    unpriced_tokens: z.number().nonnegative(),
    estimated_cost_usd: z.number().nonnegative(),
    credits: z.number().nonnegative(),
    pricing_status: z.enum(["unpriced", "lower_bound", "priced"]),
  })
  .passthrough();
export type AgentCostReportRow = z.infer<typeof AgentCostReportRowSchema>;

export const AgentCostReportResultSchema = z.object({
  schema_version: z.string(),
  generated_at: z.string(),
  window: z.object({
    since: z.string().nullable(),
    until: z.string().nullable(),
  }),
  timezone: z.string(),
  rates: z.object({
    catalog_version: z.string(),
    sha256: z.string(),
  }),
  group_by: z.array(z.string()),
  data_quality: z.object({
    malformed_events: z.number().int().nonnegative(),
    skipped_files: z.number().int().nonnegative(),
    negative_deltas: z.number().int().nonnegative(),
    unpriced_tokens: z.number().nonnegative(),
  }),
  rows: z.array(AgentCostReportRowSchema),
});
export type AgentCostReportResult = z.infer<typeof AgentCostReportResultSchema>;
