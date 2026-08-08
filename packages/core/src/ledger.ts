import { createHash } from "node:crypto";
import type { LedgerEntry, Phase, PhaseHistoryEntry } from "@lane/schemas";

// design.md §3.6 — ported unchanged (logic-wise) from the reference implementation's
// orchestrator.py (lines 508-696): compute_ledger_entry_id / derive_confidence /
// classify_data_state / _is_superseded / derive_included_in_kpi / recompute_included_in_kpi.
// These rules were confirmed over 3 Claude+Codex review rounds in the Python reference
// implementation and design.md explicitly calls for byte-for-byte parity, verified by
// test/ledger.differential.test.ts against the actual installed reference implementation
// package (v0.7.8).

const LEDGER_ENTRY_ID_SCHEMA = "lane-cost:v1";
export const VALID_DATA_STATES = [
  "no_data",
  "zero_tokens",
  "has_usage",
  "import_failed",
  "superseded",
] as const;
// Only entries carrying a real cost can supersede another entry of the same key.
const REAL_COST_DATA_STATES = new Set(["has_usage", "zero_tokens"]);

/**
 * Stable primary key for a ledger entry (upsert key). Deliberately excludes
 * timestamp/token/cost so re-importing the same (lane, phase, source, pricing_version)
 * updates the existing entry rather than duplicating it. sha256 (not the repo's other
 * sha1-based slug hashing) because this key is used for external upsert and collision
 * would silently merge two unrelated entries.
 */
export function computeLedgerEntryId(
  laneId: string | null,
  phase: string,
  source: string,
  pricingVersion: string,
): string {
  const kind = source === "manual" ? "manual" : "imported";
  const key = `${LEDGER_ENTRY_ID_SCHEMA}|${kind}|${laneId ?? ""}|${phase}|${source}|${pricingVersion}`;
  const digest = createHash("sha256").update(key, "utf-8").digest("hex").slice(0, 12);
  return `lc_${digest}`;
}

// MP-8 (2026-08-08) — a scope:"lane" entry has no single `phase` to key off; this
// sentinel stands in for the `phase` position of the same hash so the identity/upsert
// semantics stay identical to a phase-scoped entry's: same (lane, source,
// pricing_version) -> same id -> a re-run upserts in place; a new pricing_version ->
// a new id, and isSuperseded()/recomputeIncludedInKpi() retire the old one. Never stored
// on disk as a `phase` value (LedgerEntry.phase is `null` for scope:"lane" per
// @lane/schemas' discriminated union) -- this string exists only inside the hash.
const LANE_SCOPE_ID_KEY = "__lane__";

export function computeLaneScopeLedgerEntryId(
  laneId: string | null,
  source: string,
  pricingVersion: string,
): string {
  return computeLedgerEntryId(laneId, LANE_SCOPE_ID_KEY, source, pricingVersion);
}

export type LedgerSource = "manual" | "claude_jsonl_auto" | "codex_sqlite_auto";
export type LedgerScope = "phase" | "lane";
export type LedgerConfidence = "imported_windowed" | "imported_lane" | "estimated" | "manual";

/**
 * - claude_jsonl_auto x phase -> imported_windowed (measured within the phase window)
 * - claude_jsonl_auto x lane  -> imported_lane (measured for the whole lane, no phase window)
 * - codex_sqlite_auto x phase -> imported_windowed (rollout events measured within the window)
 * - codex_sqlite_auto x lane  -> estimated (last cumulative value for the whole lane)
 * - manual                    -> manual
 */
export function deriveConfidence(source: LedgerSource, scope: LedgerScope): LedgerConfidence {
  if (source === "claude_jsonl_auto")
    return scope === "phase" ? "imported_windowed" : "imported_lane";
  if (source === "codex_sqlite_auto") return scope === "phase" ? "imported_windowed" : "estimated";
  return "manual";
}

export type DataState = (typeof VALID_DATA_STATES)[number];

/**
 * - import itself did not succeed      -> import_failed
 * - succeeded, no events in the window -> no_data (never treated as zero cost)
 * - succeeded, events but 0 tokens     -> zero_tokens
 * - otherwise                          -> has_usage
 */
export function classifyDataState(
  importExitOk: boolean,
  hadEvents: boolean,
  totalTokens: number,
): DataState {
  if (!importExitOk) return "import_failed";
  if (!hadEvents) return "no_data";
  if (totalTokens <= 0) return "zero_tokens";
  return "has_usage";
}

/**
 * Parses an ISO 8601 timestamp to epoch milliseconds for ordering comparisons.
 * schemas' Iso8601Schema (common.ts) accepts both "+09:00"-offset and "Z"-suffixed
 * timestamps, so two otherwise-equal instants can have different string representations
 * (e.g. "2026-01-01T23:00:00+09:00" vs "2026-01-01T14:00:00Z"); lexical string comparison
 * would silently produce the wrong ordering between them, so every "is this newer than
 * that" comparison in this module goes through this parse first (team review, 2026-07-31).
 */
function toEpochMs(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Whether another entry with the same (lane_id, phase, source) key but a newer pricing
 * exists and carries a real cost — i.e. whether `entry` has been superseded by a
 * re-pricing. Same-basis comparison only: if both entries have pricing_as_of, compare
 * that; otherwise fall back to imported_at (never compare as_of against imported_at,
 * which would be an apples-to-oranges timestamp comparison).
 */
export function isSuperseded(entry: LedgerEntry, ledger: readonly LedgerEntry[]): boolean {
  for (const other of ledger) {
    if (other === entry) continue;
    if (
      other.lane_id !== entry.lane_id ||
      other.phase !== entry.phase ||
      other.source !== entry.source
    )
      continue;
    if (other.pricing_version === entry.pricing_version) continue;
    if (!REAL_COST_DATA_STATES.has(other.data_state)) continue;
    if (entry.pricing_as_of && other.pricing_as_of) {
      if (toEpochMs(other.pricing_as_of) > toEpochMs(entry.pricing_as_of)) return true;
    } else if (toEpochMs(other.imported_at) > toEpochMs(entry.imported_at)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `entry` counts toward the KPI population. This is the single source of truth —
 * callers recompute it on every ledger mutation rather than trusting a cached value.
 *
 * the Python reference implementation orchestrator.py (line 627) keyed the "prefer per-phase Codex over lane-total"
 * rule off `phase === "lane_total"`, a sentinel value the Python reference implementation's `phase` field could hold
 * to mean "this entry covers the whole lane". design.md's LedgerEntrySchema replaces that
 * overload with a real `scope: "phase" | "lane"` field (§2.5), so the check below reads
 * `scope === "lane"` instead — same rule, expressed through the field that now actually
 * carries that meaning.
 */
export function deriveIncludedInKpi(entry: LedgerEntry, ledger: readonly LedgerEntry[]): boolean {
  if (
    entry.data_state === "no_data" ||
    entry.data_state === "import_failed" ||
    entry.data_state === "superseded"
  ) {
    return false;
  }
  // Python-parity rule, unchanged (do not generalize away): a codex_sqlite_auto
  // lane-total defers to *any* valid per-phase codex entry, regardless of session
  // overlap -- this is the reference implementation's own, simpler rule, byte-for-byte
  // ported (test/differential/ledger.differential.test.ts). session_ids didn't exist as
  // a signal when this rule was designed.
  if (entry.source === "codex_sqlite_auto" && entry.scope === "lane") {
    const hasValidCodexPhaseEntry = ledger.some(
      (e) =>
        e.source === "codex_sqlite_auto" &&
        e.scope === "phase" &&
        (e.data_state === "has_usage" || e.data_state === "zero_tokens"),
    );
    if (hasValidCodexPhaseEntry) return false;
  }
  // MP-8 (2026-08-08, sol ruling point 5) — a scope:"lane" entry (any source) whose
  // session_ids are *fully* covered by KPI-eligible scope:"phase" entries is redundant
  // with the per-phase breakdown, not a distinct measurement: exclude it from KPI rather
  // than double-count the same underlying sessions at both scopes. A *partial* overlap
  // (neither fully covered nor fully disjoint) is genuinely ambiguous and is
  // deliberately NOT resolved here -- core/application/metrics-service.ts's
  // detectAmbiguousSessionAttribution catches that case at emit time and fails the whole
  // emit closed instead of guessing which side is authoritative.
  if (entry.scope === "lane" && entry.session_ids.length > 0) {
    const phaseSessionIds = new Set<string>();
    for (const other of ledger) {
      if (other === entry || other.scope !== "phase") continue;
      if (!REAL_COST_DATA_STATES.has(other.data_state)) continue;
      for (const id of other.session_ids) phaseSessionIds.add(id);
    }
    if (entry.session_ids.every((id) => phaseSessionIds.has(id))) return false;
  }
  if (isSuperseded(entry, ledger)) return false;
  return true;
}

/**
 * Upserts `entry` into `ledger` by `ledger_entry_id` (replace in place if found, append
 * otherwise). MP-8 (2026-08-08) — the primitive both the in-repo cost_ledger write and
 * the done-overlay ledger_delta write (calibrate.ts) share, so "re-running calibrate
 * upserts, never duplicates" (spec.md Rule 1) holds identically on either path. Does not
 * itself call recomputeIncludedInKpi -- callers do that once, after the upsert, over the
 * whole resulting ledger (a single entry's own included_in_kpi can depend on siblings).
 */
export function upsertLedgerEntry(
  ledger: readonly LedgerEntry[],
  entry: LedgerEntry,
): LedgerEntry[] {
  const idx = ledger.findIndex((e) => e.ledger_entry_id === entry.ledger_entry_id);
  if (idx === -1) return [...ledger, entry];
  const next = [...ledger];
  next[idx] = entry;
  return next;
}

/** Recomputes and overwrites included_in_kpi for every entry. Idempotent. */
export function recomputeIncludedInKpi(ledger: LedgerEntry[]): LedgerEntry[] {
  for (const entry of ledger) {
    entry.included_in_kpi = deriveIncludedInKpi(entry, ledger);
  }
  return ledger;
}

export interface PhaseWindow {
  start: Date;
  end: Date;
}

/**
 * design.md §3.6 — the one intentional behavior change from the Python reference implementation: when a phase is
 * re-entered after a rework (差し戻し), each occurrence's [start, end) window is kept as a
 * disjoint interval rather than being collapsed into a single [firstStart, lastEnd) span
 * (which would double-count time spent in a *different* phase in between, e.g.
 * 3_implement -> 2_spec -> 3_implement). The Python reference implementation had exactly
 * this bug from v0.7.1 to v0.7.2; this TS port starts from the fixed behavior instead of
 * reproducing the regression.
 * Open-ended occurrences (endedAt: null, i.e. still in_progress) are dropped — an
 * unfinished window has no defined end and must not be unioned into cost/telemetry
 * measurement.
 */
export function unionPhaseWindows(
  occurrences: readonly { startedAt: Date; endedAt: Date | null }[],
): PhaseWindow[] {
  const closed = occurrences
    .filter((o): o is { startedAt: Date; endedAt: Date } => o.endedAt !== null)
    .map((o) => ({ start: o.startedAt, end: o.endedAt }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: PhaseWindow[] = [];
  for (const window of closed) {
    const last = merged.at(-1);
    if (last && window.start.getTime() <= last.end.getTime()) {
      if (window.end.getTime() > last.end.getTime()) last.end = window.end;
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * Extracts every occurrence of `phase` from a lane's phase_history and unions their
 * windows (design.md §3.6). This is the one place LaneState.phase_history's ISO 8601
 * strings (started_at/ended_at, Iso8601Schema — "+09:00" or "Z", team review 2026-07-31)
 * get parsed into Date before any ordering/merging happens; unionPhaseWindows itself only
 * ever sees instants, never strings, so a re-entered phase spanning a JST-vs-UTC-recorded
 * boundary still merges/sorts correctly.
 */
export function phaseWindowsForPhase(
  phaseHistory: readonly PhaseHistoryEntry[],
  phase: Phase,
): PhaseWindow[] {
  const occurrences = phaseHistory
    .filter((entry) => entry.phase === phase)
    .map((entry) => ({
      startedAt: new Date(entry.started_at),
      endedAt: entry.ended_at ? new Date(entry.ended_at) : null,
    }));
  return unionPhaseWindows(occurrences);
}
