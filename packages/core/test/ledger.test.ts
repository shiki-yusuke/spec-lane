import type { LedgerEntry, PhaseHistoryEntry } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  deriveIncludedInKpi,
  isSuperseded,
  phaseWindowsForPhase,
  unionPhaseWindows,
} from "../src/ledger.js";

// design.md §12-8 (team review, 2026-07-31): Iso8601Schema accepts both "+09:00"-offset
// and "Z"-suffixed timestamps, so a lexical string comparison between the two can give
// the wrong ordering even though the underlying instants compare correctly. These fixtures
// are deliberately *not* run through the Python differential harness (python_harness.py):
// the Python reference implementation's own _is_superseded does a raw string comparison too, but the Python reference implementation only
// ever produces one offset format (JST "+09:00"), so it never hits this case — this is a
// TS-only regression guard for a scenario the more permissive Iso8601Schema makes possible.

function baseEntry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    ledger_entry_id: "e",
    lane_id: "L1",
    phase: "2_spec",
    source: "manual",
    scope: "phase",
    session_ids: [],
    data_state: "has_usage",
    confidence: "manual",
    included_in_kpi: false,
    tokens: 100,
    turns: 1,
    cost_usd: 1,
    cost_credits: null,
    pricing_version: "v1",
    pricing_as_of: null,
    imported_at: "2026-01-01T00:00:00+09:00",
    since: null,
    until: null,
    agents: null,
    ...overrides,
  } as LedgerEntry;
}

describe("isSuperseded with mixed ISO 8601 offsets", () => {
  it("recognizes a Z-suffixed pricing_as_of as newer than a later-looking +09:00 string, by actual instant", () => {
    // 2026-01-01T23:00:00+09:00 == 2026-01-01T14:00:00Z (same instant).
    // A string comparison of "2026-01-02T00:00:00Z" vs "2026-01-01T23:00:00+09:00" would
    // wrongly call the +09:00 one later (its hour digits sort higher lexically), even
    // though 2026-01-02T00:00:00Z (2026-01-02T09:00 JST) is actually later.
    const older = baseEntry({ pricing_version: "v1", pricing_as_of: "2026-01-01T23:00:00+09:00" });
    const newer = baseEntry({ pricing_version: "v2", pricing_as_of: "2026-01-02T00:00:00Z" });

    expect(isSuperseded(older, [older, newer])).toBe(true);
    expect(isSuperseded(newer, [older, newer])).toBe(false);
  });

  it("falls back to imported_at with the same mixed-offset correctness", () => {
    const older = baseEntry({ pricing_version: "v1", imported_at: "2026-01-01T23:00:00+09:00" });
    const newer = baseEntry({ pricing_version: "v2", imported_at: "2026-01-02T00:00:00Z" });

    expect(isSuperseded(older, [older, newer])).toBe(true);
    expect(isSuperseded(newer, [older, newer])).toBe(false);
  });

  it("deriveIncludedInKpi excludes the superseded entry and includes the superseding one, mixed offsets included", () => {
    const older = baseEntry({ pricing_version: "v1", pricing_as_of: "2026-01-01T23:00:00+09:00" });
    const newer = baseEntry({ pricing_version: "v2", pricing_as_of: "2026-01-02T00:00:00Z" });
    const ledger = [older, newer];

    expect(deriveIncludedInKpi(older, ledger)).toBe(false);
    expect(deriveIncludedInKpi(newer, ledger)).toBe(true);
  });
});

// MP-8 (2026-08-08, sol ruling point 5) — the new, source-agnostic dedup rule, additive
// alongside (never replacing) the existing codex-specific rule tested elsewhere in this
// file's differential parity suite.
describe("deriveIncludedInKpi: lane-vs-phase session de-duplication (MP-8)", () => {
  it("excludes a scope=lane entry whose session_ids are fully covered by a KPI-eligible phase entry", () => {
    const phaseEntry = baseEntry({
      ledger_entry_id: "phase-1",
      scope: "phase",
      phase: "3_implement",
      source: "claude_jsonl_auto",
      session_ids: ["s1", "s2"],
      data_state: "has_usage",
    });
    const laneEntry = baseEntry({
      ledger_entry_id: "lane-1",
      scope: "lane",
      phase: null,
      source: "claude_jsonl_auto",
      session_ids: ["s1"], // fully covered by phaseEntry
      data_state: "has_usage",
    });
    const ledger = [phaseEntry, laneEntry];
    expect(deriveIncludedInKpi(laneEntry, ledger)).toBe(false);
    expect(deriveIncludedInKpi(phaseEntry, ledger)).toBe(true);
  });

  it("includes a scope=lane entry whose session_ids are fully disjoint from any phase entry", () => {
    const phaseEntry = baseEntry({
      ledger_entry_id: "phase-2",
      scope: "phase",
      phase: "3_implement",
      source: "claude_jsonl_auto",
      session_ids: ["s1"],
      data_state: "has_usage",
    });
    const laneEntry = baseEntry({
      ledger_entry_id: "lane-2",
      scope: "lane",
      phase: null,
      source: "claude_jsonl_auto",
      session_ids: ["s2"], // no overlap at all
      data_state: "has_usage",
    });
    const ledger = [phaseEntry, laneEntry];
    expect(deriveIncludedInKpi(laneEntry, ledger)).toBe(true);
    expect(deriveIncludedInKpi(phaseEntry, ledger)).toBe(true);
  });

  it("does NOT exclude a scope=lane entry on a merely-partial overlap (ambiguous case is left to emit-metrics's own fail-closed check, not resolved here)", () => {
    const phaseEntry = baseEntry({
      ledger_entry_id: "phase-3",
      scope: "phase",
      phase: "3_implement",
      source: "claude_jsonl_auto",
      session_ids: ["s1"],
      data_state: "has_usage",
    });
    const laneEntry = baseEntry({
      ledger_entry_id: "lane-3",
      scope: "lane",
      phase: null,
      source: "claude_jsonl_auto",
      session_ids: ["s1", "s2"], // partial overlap: s1 covered, s2 not
      data_state: "has_usage",
    });
    const ledger = [phaseEntry, laneEntry];
    expect(deriveIncludedInKpi(laneEntry, ledger)).toBe(true);
    expect(deriveIncludedInKpi(phaseEntry, ledger)).toBe(true);
  });

  it("a scope=lane entry with no session_ids is unaffected by this rule (falls through to the existing checks)", () => {
    const laneEntry = baseEntry({
      ledger_entry_id: "lane-4",
      scope: "lane",
      phase: null,
      source: "claude_jsonl_auto",
      session_ids: [],
      data_state: "has_usage",
    });
    expect(deriveIncludedInKpi(laneEntry, [laneEntry])).toBe(true);
  });
});

describe("unionPhaseWindows: baseline merge behavior (Codex M1 review, should-6)", () => {
  const d = (iso: string) => new Date(iso);

  it("keeps two disjoint windows separate", () => {
    const windows = unionPhaseWindows([
      { startedAt: d("2026-01-01T09:00:00Z"), endedAt: d("2026-01-01T10:00:00Z") },
      { startedAt: d("2026-01-01T12:00:00Z"), endedAt: d("2026-01-01T13:00:00Z") },
    ]);
    expect(windows).toEqual([
      { start: d("2026-01-01T09:00:00Z"), end: d("2026-01-01T10:00:00Z") },
      { start: d("2026-01-01T12:00:00Z"), end: d("2026-01-01T13:00:00Z") },
    ]);
  });

  it("merges two windows that touch exactly at the boundary (adjacent)", () => {
    const windows = unionPhaseWindows([
      { startedAt: d("2026-01-01T09:00:00Z"), endedAt: d("2026-01-01T10:00:00Z") },
      { startedAt: d("2026-01-01T10:00:00Z"), endedAt: d("2026-01-01T11:00:00Z") },
    ]);
    expect(windows).toEqual([{ start: d("2026-01-01T09:00:00Z"), end: d("2026-01-01T11:00:00Z") }]);
  });

  it("merges two overlapping windows into their union", () => {
    const windows = unionPhaseWindows([
      { startedAt: d("2026-01-01T09:00:00Z"), endedAt: d("2026-01-01T10:30:00Z") },
      { startedAt: d("2026-01-01T10:00:00Z"), endedAt: d("2026-01-01T11:00:00Z") },
    ]);
    expect(windows).toEqual([{ start: d("2026-01-01T09:00:00Z"), end: d("2026-01-01T11:00:00Z") }]);
  });

  it("merges correctly regardless of input order", () => {
    const inOrder = unionPhaseWindows([
      { startedAt: d("2026-01-01T09:00:00Z"), endedAt: d("2026-01-01T10:30:00Z") },
      { startedAt: d("2026-01-01T10:00:00Z"), endedAt: d("2026-01-01T11:00:00Z") },
    ]);
    const reversed = unionPhaseWindows([
      { startedAt: d("2026-01-01T10:00:00Z"), endedAt: d("2026-01-01T11:00:00Z") },
      { startedAt: d("2026-01-01T09:00:00Z"), endedAt: d("2026-01-01T10:30:00Z") },
    ]);
    expect(reversed).toEqual(inOrder);
  });

  it("drops an open (still in_progress) occurrence entirely", () => {
    const windows = unionPhaseWindows([
      { startedAt: d("2026-01-01T09:00:00Z"), endedAt: d("2026-01-01T10:00:00Z") },
      { startedAt: d("2026-01-01T11:00:00Z"), endedAt: null },
    ]);
    expect(windows).toEqual([{ start: d("2026-01-01T09:00:00Z"), end: d("2026-01-01T10:00:00Z") }]);
  });
});

describe("unionPhaseWindows with mixed ISO 8601 offsets", () => {
  it("sorts and merges by instant, not by the order the caller happened to list them in", () => {
    // Two disjoint occurrences, given out of chronological order and in different offset
    // formats. If unionPhaseWindows (or its caller) ever regressed to comparing the
    // *strings* instead of Date instants, this would merge or order them wrongly.
    const windows = unionPhaseWindows([
      { startedAt: new Date("2026-01-02T00:00:00Z"), endedAt: new Date("2026-01-02T01:00:00Z") }, // 09:00-10:00 JST
      {
        startedAt: new Date("2026-01-01T23:00:00+09:00"),
        endedAt: new Date("2026-01-01T23:30:00+09:00"),
      }, // 14:00-14:30 UTC, earlier
    ]);

    expect(windows).toHaveLength(2);
    expect(windows[0]?.start.getTime()).toBe(new Date("2026-01-01T23:00:00+09:00").getTime());
    expect(windows[1]?.start.getTime()).toBe(new Date("2026-01-02T00:00:00Z").getTime());
  });

  it("merges an overlap that only exists once both sides are parsed to the same instant basis", () => {
    // 2026-01-01T23:00:00+09:00 == 2026-01-01T14:00:00Z: these two occurrences actually
    // overlap (second starts exactly when the first ends), which a naive string
    // comparison of "14:00:00Z" vs "23:00:00+09:00" would never recognize as adjacent.
    const windows = unionPhaseWindows([
      {
        startedAt: new Date("2026-01-01T22:00:00+09:00"),
        endedAt: new Date("2026-01-01T14:00:00Z"),
      },
      {
        startedAt: new Date("2026-01-01T23:00:00+09:00"),
        endedAt: new Date("2026-01-01T15:00:00Z"),
      },
    ]);
    expect(windows).toHaveLength(1);
  });
});

describe("phaseWindowsForPhase: LaneState.phase_history -> instant-based windows", () => {
  it("parses started_at/ended_at (mixed +09:00 and Z) before unioning, not as strings", () => {
    // A lane whose 3_implement phase was entered, reworked back to 2_spec, then
    // re-entered — recorded with a JST offset the first time and a UTC "Z" the second
    // (e.g. a session that ran across an environment/timezone change).
    const phaseHistory: PhaseHistoryEntry[] = [
      {
        phase: "1_intent",
        started_at: "2026-01-01T09:00:00+09:00",
        ended_at: "2026-01-01T09:30:00+09:00",
        result: "completed",
        retry_count: 0,
      },
      {
        phase: "2_spec",
        started_at: "2026-01-01T09:30:00+09:00",
        ended_at: "2026-01-01T10:00:00+09:00",
        result: "completed",
        retry_count: 0,
      },
      {
        phase: "3_implement",
        started_at: "2026-01-01T10:00:00+09:00",
        ended_at: "2026-01-01T01:30:00Z",
        result: "completed",
        retry_count: 0,
      }, // 10:00-10:30 JST
      {
        phase: "2_spec",
        started_at: "2026-01-01T01:30:00Z",
        ended_at: "2026-01-01T02:00:00Z",
        result: "needs_revision",
        retry_count: 1,
      },
      {
        phase: "3_implement",
        started_at: "2026-01-01T11:00:00+09:00",
        result: "in_progress",
        retry_count: 0,
      }, // 11:00 JST, still open
    ];

    const windows = phaseWindowsForPhase(phaseHistory, "3_implement");

    // Two disjoint occurrences (§3.6 window union, not collapsed into one span covering
    // the 2_spec rework in between); the still-open second occurrence is dropped.
    expect(windows).toHaveLength(1);
    expect(windows[0]?.start.getTime()).toBe(new Date("2026-01-01T10:00:00+09:00").getTime());
    expect(windows[0]?.end.getTime()).toBe(new Date("2026-01-01T01:30:00Z").getTime());
  });
});
