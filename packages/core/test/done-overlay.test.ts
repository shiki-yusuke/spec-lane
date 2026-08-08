import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaneState, LaneStateSchemaV3, type LedgerEntry } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDoneOverlay,
  doneOverlayPath,
  effectiveLedger,
  isDoneOverlayGuarded,
  readDoneOverlay,
  upsertOverlayLedgerEntry,
} from "../src/done-overlay.js";

describe("done overlay read/write", () => {
  let dataDir: string;
  let specDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lane-data-"));
    specDir = mkdtempSync(join(tmpdir(), "lane-spec-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // `process.env.X = undefined` does NOT delete the var — Node's env proxy coerces the
    // assigned value to the string "undefined", which resolveDataDir() would then read
    // back as a truthy (bogus) path. `delete` is required for real removal.
    // biome-ignore lint/performance/noDelete: see comment above
    delete process.env.LANE_DATA_DIR;
  });

  function buildState(overrides: Partial<LaneState> = {}): LaneState {
    return LaneStateSchemaV3.parse({
      schema_version: "3.0",
      intent_id: "I-2026-07-31-example-feature",
      tracker_url: null,
      pr_url: null,
      owner: null,
      current_phase: "4_verify",
      status: "running",
      created_at: "2026-07-31T09:00:00+09:00",
      usage_import_gate_overrides: [],
      phase_history: [
        {
          phase: "4_verify",
          started_at: "2026-07-31T10:00:00+09:00",
          result: "in_progress",
          retry_count: 0,
        },
      ],
      ...overrides,
    });
  }

  it("round-trips a written overlay", () => {
    const state = buildState();
    createDoneOverlay({
      specDir,
      intentId: state.intent_id,
      state,
      verifyEndedAt: "2026-07-31T10:30:00+09:00",
      prUrl: "https://github.com/example/example/pull/1",
      mergeSha: "abc123",
      toolVersion: "0.1.0",
    });
    const read = readDoneOverlay(specDir, state.intent_id);
    expect(read?.intent_id).toBe(state.intent_id);
    expect(read?.verify_ended_at).toBe("2026-07-31T10:30:00+09:00");
  });

  it("returns null for a mismatched intent_id (no cross-lane leakage)", () => {
    const state = buildState();
    createDoneOverlay({
      specDir,
      intentId: state.intent_id,
      state,
      verifyEndedAt: "2026-07-31T10:30:00+09:00",
      prUrl: null,
      mergeSha: null,
      toolVersion: "0.1.0",
    });
    expect(readDoneOverlay(specDir, "I-2026-07-31-some-other-feature")).toBeNull();
  });

  it("returns null for a file with a naive (non-timezone-aware) verify_ended_at", () => {
    const path = doneOverlayPath(specDir, "I-2026-07-31-bad-ts");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "1.0",
        intent_id: "I-2026-07-31-bad-ts",
        verify_ended_at: "2026-07-31T10:30:00", // no tz offset
        done_recorded_at: "2026-07-31T11:00:00+09:00",
        pr_url: null,
        merge_sha: null,
        spec_dir: specDir,
        spec_dir_fingerprint: "x",
        tool_version: "0.1.0",
        done_source: "local_overlay",
        usage_import_gate_overrides: [],
      }),
    );
    expect(readDoneOverlay(specDir, "I-2026-07-31-bad-ts")).toBeNull();
  });

  it("isDoneOverlayGuarded is true only once an overlay exists for a 4_verify lane", () => {
    const state = buildState();
    expect(isDoneOverlayGuarded(specDir, state.intent_id, state)).toBe(false);
    createDoneOverlay({
      specDir,
      intentId: state.intent_id,
      state,
      verifyEndedAt: "2026-07-31T10:30:00+09:00",
      prUrl: null,
      mergeSha: null,
      toolVersion: "0.1.0",
    });
    expect(isDoneOverlayGuarded(specDir, state.intent_id, state)).toBe(true);
  });

  function laneEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
    return {
      ledger_entry_id: "lc_test",
      lane_id: "I-2026-07-31-example-feature",
      scope: "lane",
      phase: null,
      source: "claude_jsonl_auto",
      session_ids: ["sess-1"],
      data_state: "has_usage",
      confidence: "imported_lane",
      included_in_kpi: true,
      tokens: 100,
      turns: null,
      cost_usd: 1,
      cost_credits: null,
      pricing_version: "v1",
      pricing_as_of: "2026-08-08T00:00:00Z",
      imported_at: "2026-08-08T00:00:00Z",
      since: null,
      until: null,
      agents: ["claude"],
      ...overrides,
    } as LedgerEntry;
  }

  describe("effectiveLedger", () => {
    // MP-8 must-2 fix (2026-08-08, Codex review round) — a re-calibrate with a new
    // pricing_version creates a new ledger_entry_id (never upserted in place over the
    // old one), which should supersede -- and exclude -- the older entry. Before this
    // fix, calibrate.ts only ever re-persisted the *newly built* entry, so the older
    // entry's included_in_kpi stayed stale (true) on disk forever, and both entries
    // would double-count toward the KPI population.
    it("recomputes included_in_kpi over the composed ledger rather than trusting a stale persisted flag (superseded re-calibrate)", () => {
      const state = buildState();
      createDoneOverlay({
        specDir,
        intentId: state.intent_id,
        state,
        verifyEndedAt: "2026-07-31T10:30:00+09:00",
        prUrl: null,
        mergeSha: null,
        toolVersion: "0.4.0",
      });

      // First calibrate: pricing_version v1, correctly included_in_kpi=true at the time
      // it was written (nothing else existed yet).
      upsertOverlayLedgerEntry(
        specDir,
        state.intent_id,
        laneEntry({
          ledger_entry_id: "lc_v1",
          pricing_version: "v1",
          pricing_as_of: "2026-08-08T00:00:00Z",
          included_in_kpi: true,
        }),
      );
      // Second calibrate: a new pricing_version, later pricing_as_of -- should
      // retroactively supersede lc_v1, but nothing ever re-persists lc_v1 itself.
      upsertOverlayLedgerEntry(
        specDir,
        state.intent_id,
        laneEntry({
          ledger_entry_id: "lc_v2",
          pricing_version: "v2",
          pricing_as_of: "2026-08-08T01:00:00Z",
          included_in_kpi: true,
        }),
      );

      const overlayBefore = readDoneOverlay(specDir, state.intent_id);
      const staleOnDisk = overlayBefore?.ledger_delta.find((e) => e.ledger_entry_id === "lc_v1");
      expect(staleOnDisk?.included_in_kpi).toBe(true); // confirms the stale flag really is on disk

      const composed = effectiveLedger(specDir, state.intent_id, state);
      expect(composed.find((e) => e.ledger_entry_id === "lc_v1")?.included_in_kpi).toBe(false);
      expect(composed.find((e) => e.ledger_entry_id === "lc_v2")?.included_in_kpi).toBe(true);
    });

    it("does not mutate state.cost_ledger's own entry objects in place (clones before recomputing)", () => {
      const codexPhaseEntry = laneEntry({
        ledger_entry_id: "lc_phase_codex",
        scope: "phase",
        phase: "3_implement",
        source: "codex_sqlite_auto",
        confidence: "imported_windowed",
        included_in_kpi: true,
        session_ids: ["sess-2"],
      });
      const state = buildState({ cost_ledger: [codexPhaseEntry] });
      const before = JSON.parse(JSON.stringify(state.cost_ledger));
      effectiveLedger(specDir, state.intent_id, state);
      expect(state.cost_ledger).toEqual(before);
    });
  });
});
