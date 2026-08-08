import type { LedgerEntry } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { deriveCostCredits } from "../../src/goodhart.js";
import {
  classifyDataState,
  computeLedgerEntryId,
  deriveConfidence,
  deriveIncludedInKpi,
} from "../../src/ledger.js";
import { callPython, isPythonReferenceAvailable } from "./python-harness.js";

// M4 — this whole file needs the private Python reference implementation installed
// locally (see python-harness.ts's isPythonReferenceAvailable doc comment); it isn't
// published anywhere the public can install it, so a fresh clone skips gracefully instead
// of failing, matching this repo's existing describe/describe.skip convention for
// real-subprocess tests.
const describeOrSkip = isPythonReferenceAvailable() ? describe : describe.skip;

// design.md §9 checkpoint 3 / §10 — byte-for-byte parity against the installed Python
// reference implementation package (v0.7.8) for the ledger derivation rules that the
// reference implementation spent 3 review rounds confirming.
//
// derive_included_in_kpi is the one function here whose *field encoding* differs between
// the two sides on purpose: the reference implementation's `phase` field doubled as a
// scope sentinel ("lane_total" meant "this entry covers the whole lane"), which design.md
// §2.5 replaced with a real `scope: "phase" | "lane"` field on LedgerEntrySchema (see
// ledger.ts's deriveIncludedInKpi comment). Each scenario below is therefore expressed
// twice — once in the reference implementation's dict shape (phase: "lane_total") for the
// Python call, once in the LedgerEntrySchema shape (scope: "lane") for the TS call — and
// asserts the two *decisions* agree, not that the two payloads are byte-identical.

describeOrSkip(
  "computeLedgerEntryId matches the Python reference implementation's compute_ledger_entry_id",
  () => {
    const cases: [string | null, string, string, string][] = [
      [null, "1_intent", "manual", "v1"],
      ["L1", "2_spec", "claude_jsonl_auto", "2026-07-01"],
      ["L2", "lane_total", "codex_sqlite_auto", "2026-07-01"],
    ];
    for (const [laneId, phase, source, pricingVersion] of cases) {
      it(`(${laneId}, ${phase}, ${source}, ${pricingVersion})`, () => {
        const expected = callPython<string>("compute_ledger_entry_id", [
          laneId,
          phase,
          source,
          pricingVersion,
        ]);
        expect(computeLedgerEntryId(laneId, phase, source, pricingVersion)).toBe(expected);
      });
    }
  },
);

describeOrSkip(
  "deriveConfidence matches the Python reference implementation's derive_confidence",
  () => {
    const cases: ["claude_jsonl_auto" | "codex_sqlite_auto" | "manual", "phase" | "lane"][] = [
      ["claude_jsonl_auto", "phase"],
      ["claude_jsonl_auto", "lane"],
      ["codex_sqlite_auto", "phase"],
      ["codex_sqlite_auto", "lane"],
      ["manual", "phase"],
    ];
    for (const [source, scope] of cases) {
      it(`(${source}, ${scope})`, () => {
        const expected = callPython<string>("derive_confidence", [source, scope]);
        expect(deriveConfidence(source, scope)).toBe(expected);
      });
    }
  },
);

describeOrSkip(
  "classifyDataState matches the Python reference implementation's classify_data_state",
  () => {
    const cases: [boolean, boolean, number][] = [
      [false, true, 100],
      [true, false, 0],
      [true, true, 0],
      [true, true, 500],
    ];
    for (const [importExitOk, hadEvents, totalTokens] of cases) {
      it(`(${importExitOk}, ${hadEvents}, ${totalTokens})`, () => {
        const expected = callPython<string>("classify_data_state", [
          importExitOk,
          hadEvents,
          totalTokens,
        ]);
        expect(classifyDataState(importExitOk, hadEvents, totalTokens)).toBe(expected);
      });
    }
  },
);

describeOrSkip(
  "deriveCostCredits matches the Python reference implementation's derive_cost_credits",
  () => {
    const cases: [number | null, string][] = [
      [4.0, "codex_sqlite_auto"],
      [0, "codex_sqlite_auto"],
      [4.0, "claude_jsonl_auto"],
      [null, "codex_sqlite_auto"],
    ];
    for (const [costUsd, source] of cases) {
      it(`(${costUsd}, ${source})`, () => {
        const expected = callPython<number | null>("derive_cost_credits", [costUsd, source]);
        expect(deriveCostCredits(costUsd, source)).toBe(expected);
      });
    }
  },
);

function tsEntry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    ledger_entry_id: "e",
    lane_id: "L1",
    phase: "3_implement",
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

function pyEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    lane_id: "L1",
    phase: "3_implement",
    source: "manual",
    pricing_version: "v1",
    data_state: "has_usage",
    pricing_as_of: null,
    imported_at: "2026-01-01T00:00:00+09:00",
    ...overrides,
  };
}

describeOrSkip(
  "deriveIncludedInKpi decisions match the Python reference implementation's derive_included_in_kpi",
  () => {
    it("a lane-total codex entry with no per-phase codex entry is included", () => {
      const pyLedger = [pyEntry({ phase: "lane_total", source: "codex_sqlite_auto" })];
      const [pyEntry0] = pyLedger;
      const pyResult = callPython<boolean>("derive_included_in_kpi", [pyEntry0, pyLedger]);

      const tsLedger = [tsEntry({ phase: null, scope: "lane", source: "codex_sqlite_auto" })];
      expect(deriveIncludedInKpi(tsLedger[0] as LedgerEntry, tsLedger)).toBe(pyResult);
      expect(pyResult).toBe(true);
    });

    it("a lane-total codex entry is excluded once a valid per-phase codex entry exists", () => {
      const pyLaneTotal = pyEntry({ phase: "lane_total", source: "codex_sqlite_auto" });
      const pyPhaseEntry = pyEntry({ phase: "3_implement", source: "codex_sqlite_auto" });
      const pyLedger = [pyLaneTotal, pyPhaseEntry];
      const pyLaneResult = callPython<boolean>("derive_included_in_kpi", [pyLaneTotal, pyLedger]);
      const pyPhaseResult = callPython<boolean>("derive_included_in_kpi", [pyPhaseEntry, pyLedger]);

      const tsLaneEntry = tsEntry({
        phase: null,
        scope: "lane",
        source: "codex_sqlite_auto",
      });
      const tsPhaseEntry = tsEntry({
        phase: "3_implement",
        scope: "phase",
        source: "codex_sqlite_auto",
      });
      const tsLedger = [tsLaneEntry, tsPhaseEntry];

      expect(deriveIncludedInKpi(tsLaneEntry, tsLedger)).toBe(pyLaneResult);
      expect(deriveIncludedInKpi(tsPhaseEntry, tsLedger)).toBe(pyPhaseResult);
      expect(pyLaneResult).toBe(false);
      expect(pyPhaseResult).toBe(true);
    });

    it("an entry superseded by a newer-pricing real-cost entry is excluded, the newer one included", () => {
      const pyOld = pyEntry({
        phase: "2_spec",
        pricing_version: "v1",
        pricing_as_of: "2026-01-01",
      });
      const pyNew = pyEntry({
        phase: "2_spec",
        pricing_version: "v2",
        pricing_as_of: "2026-02-01",
      });
      const pyLedger = [pyOld, pyNew];
      const pyOldResult = callPython<boolean>("derive_included_in_kpi", [pyOld, pyLedger]);
      const pyNewResult = callPython<boolean>("derive_included_in_kpi", [pyNew, pyLedger]);

      const tsOld = tsEntry({
        phase: "2_spec",
        pricing_version: "v1",
        pricing_as_of: "2026-01-01T00:00:00+09:00",
      });
      const tsNew = tsEntry({
        phase: "2_spec",
        pricing_version: "v2",
        pricing_as_of: "2026-02-01T00:00:00+09:00",
      });
      const tsLedger = [tsOld, tsNew];

      expect(deriveIncludedInKpi(tsOld, tsLedger)).toBe(pyOldResult);
      expect(deriveIncludedInKpi(tsNew, tsLedger)).toBe(pyNewResult);
      expect(pyOldResult).toBe(false);
      expect(pyNewResult).toBe(true);
    });

    it("no_data and import_failed entries are always excluded", () => {
      for (const dataState of ["no_data", "import_failed"] as const) {
        const pyE = pyEntry({ phase: "2_spec", data_state: dataState });
        const pyResult = callPython<boolean>("derive_included_in_kpi", [pyE, [pyE]]);
        const tsE = tsEntry({ phase: "2_spec", data_state: dataState });
        expect(deriveIncludedInKpi(tsE, [tsE])).toBe(pyResult);
        expect(pyResult).toBe(false);
      }
    });
  },
);
