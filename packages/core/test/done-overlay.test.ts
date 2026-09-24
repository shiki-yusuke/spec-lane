import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaneState, LaneStateSchemaV3, type LedgerEntry } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DoneOverlay,
  applyDoneOverlay,
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
      originalState: state,
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
      originalState: state,
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

  it("returns null for a file whose state_delta carries an unknown key (.strict())", () => {
    const path = doneOverlayPath(specDir, "I-2026-07-31-unknown-key");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "1.0",
        intent_id: "I-2026-07-31-unknown-key",
        verify_ended_at: "2026-07-31T10:30:00+09:00",
        done_recorded_at: "2026-07-31T11:00:00+09:00",
        pr_url: null,
        merge_sha: null,
        spec_dir: specDir,
        spec_dir_fingerprint: "x",
        tool_version: "0.1.0",
        done_source: "local_overlay",
        usage_import_gate_overrides: [],
        state_delta: {
          effective_risk_log: [],
          ruleset_migrations: [],
          weakening_acknowledgements: [],
          unexpected_field: "should be rejected",
        },
      }),
    );
    expect(readDoneOverlay(specDir, "I-2026-07-31-unknown-key")).toBeNull();
  });

  it("isDoneOverlayGuarded is true only once an overlay exists for a 4_verify lane", () => {
    const state = buildState();
    expect(isDoneOverlayGuarded(specDir, state.intent_id, state)).toBe(false);
    createDoneOverlay({
      specDir,
      intentId: state.intent_id,
      state,
      originalState: state,
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
        originalState: state,
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

  // issue #46 — the 5_done-time audit records (effective_risk_log/ruleset_migrations/
  // weakening_acknowledgements/gate_ruleset_version) no longer get written back into
  // in-repo lane-state.json; createDoneOverlay captures them into the overlay's
  // state_delta instead, and applyDoneOverlay composes them back in at read time.
  describe("state_delta", () => {
    it("captures only the tail appended since originalState, using originalState (not state) as the diff base", () => {
      const originalState = buildState({
        effective_risk_log: [
          {
            gate_id: "phase_advance",
            effective_risk: "low",
            applied_rule_ids: [],
            profile_digest: "sha256:existing",
            evaluated_at: "2026-07-31T09:30:00+09:00",
          },
        ],
      });
      // stateForDone = originalState + the 5_done-time risk evaluation this advance call
      // appended, exactly like advance.ts's recordEffectiveRiskEvaluation does.
      const stateForDone: LaneState = {
        ...originalState,
        effective_risk_log: [
          ...originalState.effective_risk_log,
          {
            gate_id: "phase_advance",
            effective_risk: "low",
            applied_rule_ids: [],
            profile_digest: "sha256:new",
            evaluated_at: "2026-07-31T10:29:00+09:00",
          },
        ],
      };

      const overlay = createDoneOverlay({
        specDir,
        intentId: originalState.intent_id,
        state: stateForDone,
        originalState,
        verifyEndedAt: "2026-07-31T10:30:00+09:00",
        prUrl: null,
        mergeSha: null,
        toolVersion: "0.11.0",
      });

      // Only the newly-appended entry, not the pre-existing one -- and not lost, which is
      // exactly what using stateWithRisk (not originalState) as the diff base would do.
      expect(overlay.state_delta.effective_risk_log).toHaveLength(1);
      expect(overlay.state_delta.effective_risk_log[0]?.profile_digest).toBe("sha256:new");
    });

    it("records a ruleset migration and a weakening acknowledgement added at 5_done", () => {
      const originalState = buildState({ gate_ruleset_version: "0.9" });
      const stateForDone: LaneState = {
        ...originalState,
        gate_ruleset_version: "1.0",
        ruleset_migrations: [
          { from: "0.9", to: "1.0", acknowledged_at: "2026-07-31T10:29:00+09:00" },
        ],
        weakening_acknowledgements: [
          {
            finding: "premise_evidence.method weakened: live -> data",
            rationale: "intentional downgrade, documented in the PR",
            acknowledged_at: "2026-07-31T10:29:00+09:00",
          },
        ],
      };

      const overlay = createDoneOverlay({
        specDir,
        intentId: originalState.intent_id,
        state: stateForDone,
        originalState,
        verifyEndedAt: "2026-07-31T10:30:00+09:00",
        prUrl: null,
        mergeSha: null,
        toolVersion: "0.11.0",
      });

      expect(overlay.state_delta.gate_ruleset_version).toBe("1.0");
      expect(overlay.state_delta.ruleset_migrations).toEqual([
        { from: "0.9", to: "1.0", acknowledged_at: "2026-07-31T10:29:00+09:00" },
      ]);
      expect(overlay.state_delta.weakening_acknowledgements).toEqual([
        {
          finding: "premise_evidence.method weakened: live -> data",
          rationale: "intentional downgrade, documented in the PR",
          acknowledged_at: "2026-07-31T10:29:00+09:00",
        },
      ]);
    });

    it("applyDoneOverlay appends state_delta's arrays onto the in-repo state", () => {
      const state = buildState();
      const overlay: DoneOverlay = {
        schema_version: "1.0",
        intent_id: state.intent_id,
        verify_ended_at: "2026-07-31T10:30:00+09:00",
        done_recorded_at: "2026-07-31T11:00:00+09:00",
        pr_url: null,
        merge_sha: null,
        spec_dir: specDir,
        spec_dir_fingerprint: "x",
        tool_version: "0.11.0",
        done_source: "local_overlay",
        usage_import_gate_overrides: [],
        ledger_delta: [],
        state_delta: {
          effective_risk_log: [
            {
              gate_id: "phase_advance",
              effective_risk: "low",
              applied_rule_ids: [],
              profile_digest: "sha256:new",
              evaluated_at: "2026-07-31T10:29:00+09:00",
            },
          ],
          ruleset_migrations: [
            { from: "0.9", to: "1.0", acknowledged_at: "2026-07-31T10:29:00+09:00" },
          ],
          weakening_acknowledgements: [
            {
              finding: "premise_evidence.method weakened: live -> data",
              rationale: "documented",
              acknowledged_at: "2026-07-31T10:29:00+09:00",
            },
          ],
          gate_ruleset_version: "1.0",
        },
      };

      const applied = applyDoneOverlay(state, overlay);
      expect(applied.effective_risk_log).toEqual(overlay.state_delta.effective_risk_log);
      expect(applied.ruleset_migrations).toEqual(overlay.state_delta.ruleset_migrations);
      expect(applied.weakening_acknowledgements).toEqual(
        overlay.state_delta.weakening_acknowledgements,
      );
      expect(applied.gate_ruleset_version).toBe("1.0");
    });

    it("issue #47: applyDoneOverlay merges effective_risk_log by evaluated_at rather than plain-appending, so an in-repo entry dated after the delta's own entry still sorts before it", () => {
      const state = buildState({
        effective_risk_log: [
          {
            gate_id: "phase_advance",
            effective_risk: "low",
            applied_rule_ids: [],
            profile_digest: "sha256:old",
            evaluated_at: "2026-07-31T10:00:00+09:00",
          },
          // `lane validate` on the raw in-repo state after this lane was already done via
          // overlay (issue #47's regression) appends an entry dated *after* the overlay's
          // own delta entry below.
          {
            gate_id: "validate",
            effective_risk: "low",
            applied_rule_ids: [],
            profile_digest: "sha256:post-done-validate",
            evaluated_at: "2026-07-31T12:00:00+09:00",
          },
        ],
      });
      const overlay: DoneOverlay = {
        schema_version: "1.0",
        intent_id: state.intent_id,
        verify_ended_at: "2026-07-31T10:30:00+09:00",
        done_recorded_at: "2026-07-31T11:00:00+09:00",
        pr_url: null,
        merge_sha: null,
        spec_dir: specDir,
        spec_dir_fingerprint: "x",
        tool_version: "0.11.0",
        done_source: "local_overlay",
        usage_import_gate_overrides: [],
        ledger_delta: [],
        state_delta: {
          effective_risk_log: [
            {
              gate_id: "phase_advance",
              effective_risk: "low",
              applied_rule_ids: [],
              profile_digest: "sha256:done",
              evaluated_at: "2026-07-31T10:29:00+09:00",
            },
          ],
          ruleset_migrations: [],
          weakening_acknowledgements: [],
        },
      };

      const applied = applyDoneOverlay(state, overlay);
      expect(applied.effective_risk_log.map((e) => e.profile_digest)).toEqual([
        "sha256:old",
        "sha256:done",
        "sha256:post-done-validate",
      ]);
    });

    it("merges by parsed instant rather than lexicographic string order, so a +09:00 offset correctly sorts against a Z entry at an earlier UTC instant", () => {
      const state = buildState({
        effective_risk_log: [
          {
            gate_id: "phase_advance",
            effective_risk: "low",
            applied_rule_ids: [],
            // 2026-07-31T01:00:00Z -- lexicographically this string is *larger* than the
            // delta entry below (because "+09:00" < "Z" isn't how offsets compare in wall
            // clock order), but as an instant it is earlier.
            profile_digest: "sha256:old",
            evaluated_at: "2026-07-31T10:00:00+09:00",
          },
        ],
      });
      const overlay: DoneOverlay = {
        schema_version: "1.0",
        intent_id: state.intent_id,
        verify_ended_at: "2026-07-31T10:30:00+09:00",
        done_recorded_at: "2026-07-31T11:00:00+09:00",
        pr_url: null,
        merge_sha: null,
        spec_dir: specDir,
        spec_dir_fingerprint: "x",
        tool_version: "0.11.0",
        done_source: "local_overlay",
        usage_import_gate_overrides: [],
        ledger_delta: [],
        state_delta: {
          // 2026-07-31T02:00:00Z -- one hour *after* the in-repo entry's instant, even
          // though "2026-07-31T02:00:00Z" sorts before "2026-07-31T10:00:00+09:00" as a
          // plain string.
          effective_risk_log: [
            {
              gate_id: "phase_advance",
              effective_risk: "low",
              applied_rule_ids: [],
              profile_digest: "sha256:done",
              evaluated_at: "2026-07-31T02:00:00Z",
            },
          ],
          ruleset_migrations: [],
          weakening_acknowledgements: [],
        },
      };

      const applied = applyDoneOverlay(state, overlay);
      expect(applied.effective_risk_log.map((e) => e.profile_digest)).toEqual([
        "sha256:old",
        "sha256:done",
      ]);
    });

    it("merges by instant across differing fractional-second precision (.5Z vs .123Z)", () => {
      const state = buildState({
        effective_risk_log: [
          {
            gate_id: "phase_advance",
            effective_risk: "low",
            applied_rule_ids: [],
            profile_digest: "sha256:old",
            // 500ms
            evaluated_at: "2026-07-31T10:00:00.5Z",
          },
        ],
      });
      const overlay: DoneOverlay = {
        schema_version: "1.0",
        intent_id: state.intent_id,
        verify_ended_at: "2026-07-31T10:30:00+09:00",
        done_recorded_at: "2026-07-31T11:00:00+09:00",
        pr_url: null,
        merge_sha: null,
        spec_dir: specDir,
        spec_dir_fingerprint: "x",
        tool_version: "0.11.0",
        done_source: "local_overlay",
        usage_import_gate_overrides: [],
        ledger_delta: [],
        state_delta: {
          effective_risk_log: [
            {
              gate_id: "phase_advance",
              effective_risk: "low",
              applied_rule_ids: [],
              profile_digest: "sha256:done",
              // 123ms -- earlier than the in-repo entry's 500ms, despite ".123" sorting
              // before ".5" only because it's shorter, not because of magnitude.
              evaluated_at: "2026-07-31T10:00:00.123Z",
            },
          ],
          ruleset_migrations: [],
          weakening_acknowledgements: [],
        },
      };

      const applied = applyDoneOverlay(state, overlay);
      expect(applied.effective_risk_log.map((e) => e.profile_digest)).toEqual([
        "sha256:done",
        "sha256:old",
      ]);
    });

    it("an old overlay file with no state_delta key still parses and applies as a no-op delta", () => {
      const intentId = "I-2026-07-31-pre-fix-overlay";
      const path = doneOverlayPath(specDir, intentId);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: "1.0",
          intent_id: intentId,
          verify_ended_at: "2026-07-31T10:30:00+09:00",
          done_recorded_at: "2026-07-31T11:00:00+09:00",
          pr_url: null,
          merge_sha: null,
          spec_dir: specDir,
          spec_dir_fingerprint: "x",
          tool_version: "0.10.1",
          done_source: "local_overlay",
          usage_import_gate_overrides: [],
          ledger_delta: [],
          // no state_delta key at all -- this is exactly the shape a pre-fix overlay file
          // has on disk.
        }),
      );

      const overlay = readDoneOverlay(specDir, intentId);
      expect(overlay?.state_delta).toEqual({
        effective_risk_log: [],
        ruleset_migrations: [],
        weakening_acknowledgements: [],
      });

      const state = buildState({ intent_id: intentId });
      const applied = applyDoneOverlay(state, overlay as DoneOverlay);
      expect(applied.effective_risk_log).toEqual(state.effective_risk_log);
      expect(applied.ruleset_migrations).toBeUndefined();
      expect(applied.weakening_acknowledgements).toBeUndefined();
      expect(applied.gate_ruleset_version).toBeUndefined();
    });
  });
});
