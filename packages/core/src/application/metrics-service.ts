import { createHash } from "node:crypto";
import type {
  AgentCostRow,
  Coverage,
  LedgerEntry,
  Omission,
  TokenKind,
  TokenUsagePayload,
  TokenUsageRecord,
} from "@lane/schemas";
import { TokenKindSchema, TokenUsagePayloadSchema } from "@lane/schemas";
import { assertNoAgentMetricsPersonalDimensions } from "../agent-metrics-goodhart.js";
import { computeAgentMetricsUpsertKey } from "../jcs.js";

// design.md §4.5/§5.5 — pure snapshot-building logic for `lane emit-metrics`
// (agent-metrics:v1 / token-usage/v1). This module never calls the telemetry adapter
// itself (design.md §3.8's own convention: application-layer logic is pure, the CLI does
// I/O orchestration and calls these functions in sequence — mirrors calibrate-service.ts's
// buildObservationFromMeasurement, which is likewise handed an already-fetched
// AgentCostMeasureResult rather than fetching it itself).

/** spec.md Rule 4 — the activity name a scope:"lane" ledger entry always groups under. */
export const WHOLE_DELIVERY_ACTIVITY_NAME = "whole-delivery";

/** The exact agent-cost query selector a scope:"lane" entry recorded (spec.md Rule 6). */
export interface LedgerActivitySelector {
  since: string | null;
  until: string | null;
  agents: readonly ("claude" | "codex")[] | null;
}

export interface LedgerActivityGroup {
  /** The ledger entry's own `phase`, or WHOLE_DELIVERY_ACTIVITY_NAME for a scope:"lane" group. */
  activityName: string;
  /** Deduplicated session ids to pass to one `telemetry.measure()` call for this activity. */
  sessionIds: string[];
  ledgerEntryIds: string[];
  /**
   * Present only for the whole-delivery group, carried from whichever contributing
   * scope:"lane" entry set it last (in practice there is exactly one non-superseded,
   * KPI-eligible lane-scope entry at a time). `undefined` for every phase-scoped group —
   * those replay no selector, matching their pre-MP-8 behavior exactly.
   */
  selector?: LedgerActivitySelector;
}

/**
 * Groups KPI-eligible ledger entries by activity (phase, or WHOLE_DELIVERY_ACTIVITY_NAME
 * for a scope:"lane" entry — spec.md Rule 4) and dedupes session_ids within each activity
 * (spec.md Rule 3). Entries this can't honestly attribute a breakdown to (manual source,
 * or an automated-source entry with an empty session_ids array) are reported as
 * omissions here rather than silently dropped — spec.md Rule 5 / the protocol's own
 * valid-no-data fixture's reason vocabulary (manual_source_no_breakdown /
 * no_session_ids). A scope:"lane" entry that ledger.ts's deriveIncludedInKpi already
 * excluded (fully redundant with phase coverage) never reaches here at all —
 * included_in_kpi is checked first, same as any other exclusion, intentionally silent.
 */
export function groupLedgerForMetrics(ledger: readonly LedgerEntry[]): {
  groups: LedgerActivityGroup[];
  structuralOmissions: Omission[];
} {
  const byActivity = new Map<string, LedgerActivityGroup>();
  const structuralOmissions: Omission[] = [];

  for (const entry of ledger) {
    if (entry.included_in_kpi !== true) continue; // intentional exclusion, not a gap
    if (entry.source === "manual") {
      structuralOmissions.push({
        entry_id: entry.ledger_entry_id,
        reason: "manual_source_no_breakdown",
        detail: "manual-source ledger entries carry no session_ids to attribute a breakdown to",
      });
      continue;
    }
    if (entry.session_ids.length === 0) {
      structuralOmissions.push({
        entry_id: entry.ledger_entry_id,
        reason: "no_session_ids",
        detail: "entry has no session_ids recorded",
      });
      continue;
    }
    const activityKey = entry.scope === "lane" ? WHOLE_DELIVERY_ACTIVITY_NAME : entry.phase;
    const selector: LedgerActivitySelector | undefined =
      entry.scope === "lane"
        ? { since: entry.since, until: entry.until, agents: entry.agents }
        : undefined;
    const existing = byActivity.get(activityKey);
    if (existing) {
      existing.sessionIds = [...new Set([...existing.sessionIds, ...entry.session_ids])];
      existing.ledgerEntryIds.push(entry.ledger_entry_id);
      if (selector) existing.selector = selector;
    } else {
      byActivity.set(activityKey, {
        activityName: activityKey,
        sessionIds: [...new Set(entry.session_ids)],
        ledgerEntryIds: [entry.ledger_entry_id],
        selector,
      });
    }
  }

  return { groups: [...byActivity.values()], structuralOmissions };
}

/**
 * spec.md Rule 4: if the same session id appears in more than one activity's
 * (deduplicated) session_ids, the whole emit must fail closed with
 * ambiguous_session_attribution — never a partial snapshot that silently picks one
 * activity over the other. Returns the offending session ids (empty = no ambiguity).
 */
export function detectAmbiguousSessionAttribution(
  groups: readonly LedgerActivityGroup[],
): string[] {
  const seenIn = new Map<string, Set<string>>(); // sessionId -> set of activityNames
  for (const group of groups) {
    for (const sessionId of group.sessionIds) {
      const activities = seenIn.get(sessionId) ?? new Set<string>();
      activities.add(group.activityName);
      seenIn.set(sessionId, activities);
    }
  }
  return [...seenIn.entries()].filter(([, activities]) => activities.size > 1).map(([id]) => id);
}

const KNOWN_TOKEN_KINDS = new Set<string>(TokenKindSchema.options);

export interface RecordsFromRowsResult {
  records: TokenUsageRecord[];
  unknownTokenKinds: string[];
  /**
   * Rows with a null `agent`/`model`/`token_kind` (review round 2026-08-07, must-3): a
   * `measure/v1` row is documented as always pre-grouped by (agent, model, token_kind), so
   * a null here is a protocol violation from agent-cost, not a legitimate "nothing to
   * report" shape. Previously these were silently dropped (same as a zero-token row),
   * which let a measure/v1 contract deviation produce a coverage.status="complete"
   * snapshot with quietly-missing records. The caller must fail the whole emit closed on
   * these, the same as an unrecognized token_kind.
   */
  nullFieldRows: AgentCostRow[];
}

/**
 * Maps one activity's agent-cost measure rows into token-usage records (spec.md Rule 6 /
 * Rule 8: zero-token rows are dropped — they carry no information — and both an
 * unrecognized token_kind and a null agent/model/token_kind are collected for the caller
 * to hard-fail on, never silently skipped).
 */
export function tokenUsageRecordsFromRows(
  activityName: string,
  rows: readonly AgentCostRow[],
): RecordsFromRowsResult {
  const records: TokenUsageRecord[] = [];
  const unknownTokenKinds: string[] = [];
  const nullFieldRows: AgentCostRow[] = [];
  for (const row of rows) {
    if (row.tokens <= 0) continue;
    if (!row.agent || !row.model || !row.token_kind) {
      nullFieldRows.push(row);
      continue;
    }
    if (!KNOWN_TOKEN_KINDS.has(row.token_kind)) {
      unknownTokenKinds.push(row.token_kind);
      continue;
    }
    records.push({
      activity: { namespace: "spec-lane", name: activityName },
      agent: row.agent,
      model: row.model,
      token_kind: row.token_kind as TokenKind,
      tokens: row.tokens,
      priced_tokens: row.priced_tokens,
      unpriced_tokens: row.unpriced_tokens,
      estimated_cost_usd: row.estimated_cost_usd,
      credits: row.credits,
      pricing_status: row.pricing_status === "lower_bound" ? "unpriced" : row.pricing_status,
    });
  }
  return { records, unknownTokenKinds, nullFieldRows };
}

export interface BuildCoverageInput {
  eligibleEntries: number;
  measuredEntries: number;
  omissions: Omission[];
}

/** spec.md Rule 8: status reflects whether anything was measurable at all, not just whether the emit itself ran. */
export function buildCoverage(input: BuildCoverageInput): Coverage {
  const excluded = input.eligibleEntries - input.measuredEntries;
  const status: Coverage["status"] =
    input.measuredEntries === 0 ? "no_data" : excluded > 0 ? "partial" : "complete";
  return {
    status,
    eligible_entries: input.eligibleEntries,
    measured_entries: input.measuredEntries,
    excluded_entries: excluded,
    omissions: input.omissions,
  };
}

export interface BuildTokenUsagePayloadInput {
  emitter: { name: string; version: string };
  subject: { namespace: string; type: string; id: string };
  repository: { provider: string; id: string };
  change?: { type: string; number: number; url: string; head_sha: string };
  generatedAt: string;
  records: TokenUsageRecord[];
  coverage: Coverage;
}

/**
 * Assembles the full envelope, computes upsert_key (RFC 8785 JCS, jcs.ts), schema-validates
 * the result, and runs the agent-metrics-specific personal-dimension scan (spec.md Rule 6 /
 * critic.yaml security lens) before returning. Throws on any violation — never returns a
 * non-conformant payload for the caller to serialize by mistake.
 */
export function buildTokenUsagePayload(input: BuildTokenUsagePayloadInput): TokenUsagePayload {
  const upsertKey = computeAgentMetricsUpsertKey({
    schema: "token-usage/v1",
    repository: input.repository,
    subject: input.subject,
  });
  const payload: TokenUsagePayload = {
    protocol_version: "agent-metrics/v1",
    schema: "token-usage/v1",
    upsert_key: upsertKey,
    emitter: input.emitter,
    subject: input.subject,
    repository: input.repository,
    ...(input.change ? { change: input.change } : {}),
    generated_at: input.generatedAt,
    data: {
      mode: "snapshot",
      records: input.records,
      coverage: input.coverage,
    },
  };
  const validated = TokenUsagePayloadSchema.parse(payload);
  assertNoAgentMetricsPersonalDimensions(validated);
  return validated;
}

const MAX_PAYLOAD_BYTES = 64 * 1024;

export class AgentMetricsPayloadTooLarge extends Error {}

/**
 * `<!-- agent-metrics:v1 payload_b64=... sha256=... -->` (protocol doc section 2).
 * Rejects (throws) rather than truncating if the encoded payload exceeds the protocol's
 * 64 KB limit (section 8) — silent truncation would produce a snapshot that looks
 * complete but isn't.
 */
export function buildAgentMetricsMarker(payload: TokenUsagePayload): string {
  const bytes = Buffer.from(JSON.stringify(payload), "utf-8");
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new AgentMetricsPayloadTooLarge(
      `payload is ${bytes.length} bytes, exceeding the protocol's ${MAX_PAYLOAD_BYTES}-byte limit`,
    );
  }
  const payloadB64 = bytes.toString("base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return `<!-- agent-metrics:v1 payload_b64=${payloadB64} sha256=${sha256} -->`;
}

/** Extracts {payload_b64, sha256} from a marker string, mirroring the contract's own field regex. */
export function parseAgentMetricsMarkerFields(
  marker: string,
): { payload_b64: string; sha256: string } | undefined {
  const m = marker.match(/<!--\s*agent-metrics:v1\s+([\s\S]*?)\s*-->/);
  const body = m?.[1];
  if (!body) return undefined;
  const fields = Object.fromEntries(
    [...body.matchAll(/([a-z_][a-z0-9_]*)=(\S+)/g)].map(([, k, v]) => [k, v]),
  );
  if (!fields.payload_b64 || !fields.sha256) return undefined;
  return { payload_b64: fields.payload_b64, sha256: fields.sha256 };
}

// Mirrors the contract's own verify-fixtures.mjs BASE64_RE + `length % 4` check
// byte-for-byte (review round 2026-08-07, must-2). Node's `Buffer.from(str, "base64")` is
// a *lenient* decoder: it silently skips characters outside the base64 alphabet (and
// tolerates malformed padding) rather than erroring, so e.g. appending a stray `!` to an
// otherwise-valid payload_b64 still decodes to the exact same bytes -- which would also
// still match the declared sha256, since the hash is computed over those same decoded
// bytes. Without this explicit format check first, such a malformed-but-hash-matching
// marker was silently accepted as valid, when the contract's own fixture-level test
// (invalid-base64) requires it to be rejected on format grounds alone, not merely as a
// side effect of some other check happening to also fail on a given fixture.
const AGENT_METRICS_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes+verifies a marker's payload_b64/sha256 (protocol doc section 2: sha256 covers
 * the decoded bytes, not the base64 text) and recomputes its upsert_key. Used by the
 * GithubCommentMetricsPublisher adapter to find an existing comment to upsert over,
 * independently of trusting either the comment's declared upsert_key or its origin.
 */
export function decodeAndVerifyAgentMetricsMarker(marker: string): TokenUsagePayload | undefined {
  const fields = parseAgentMetricsMarkerFields(marker);
  if (!fields) return undefined;
  if (fields.payload_b64.length % 4 !== 0 || !AGENT_METRICS_BASE64_RE.test(fields.payload_b64)) {
    return undefined;
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(fields.payload_b64, "base64");
  } catch {
    return undefined;
  }
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== fields.sha256.toLowerCase()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch {
    return undefined;
  }
  const validated = TokenUsagePayloadSchema.safeParse(parsed);
  if (!validated.success) return undefined;
  const recomputed = computeAgentMetricsUpsertKey({
    schema: validated.data.schema,
    repository: validated.data.repository,
    subject: validated.data.subject,
  });
  if (recomputed !== validated.data.upsert_key) return undefined;
  return validated.data;
}
