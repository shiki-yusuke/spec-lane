import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaneState, LaneStateSchemaV3, type LedgerEntry } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DoneOverlay,
  DoneOverlayVersionError,
  applyDoneOverlay,
  assertDoneOverlayWritable,
  createDoneOverlay,
  doneOverlayPath,
  effectiveLedger,
  inspectDoneOverlay,
  isDoneOverlayGuarded,
  readDoneOverlay,
  updateDoneOverlay,
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

  // issue #50 (spec S1 / A1, issue50-spec.md lines 10, 25) — the outer schema and
  // state_delta are both now `.passthrough()` (was `.strict()` on state_delta): an unknown
  // key inside state_delta must survive a read, not be rejected/dropped, so a future
  // binary's state_delta addition round-trips through an 0.11.x read/rewrite.
  it("reads a file whose state_delta carries an unknown key, preserving it (passthrough, issue #50)", () => {
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
          unexpected_field: "should be preserved",
        },
      }),
    );
    const overlay = readDoneOverlay(specDir, "I-2026-07-31-unknown-key");
    expect(overlay).not.toBeNull();
    expect((overlay?.state_delta as Record<string, unknown>).unexpected_field).toBe(
      "should be preserved",
    );
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
      // issue #50 (S4/S9) — upsertOverlayLedgerEntry now takes a toolVersion (routed
      // through updateDoneOverlay's forward-compat guard); "0.4.0" matches the overlay's
      // own tool_version (createDoneOverlay above), i.e. an equal-version rewrite, which
      // assertDoneOverlayWritable must allow through.
      upsertOverlayLedgerEntry(
        specDir,
        state.intent_id,
        laneEntry({
          ledger_entry_id: "lc_v1",
          pricing_version: "v1",
          pricing_as_of: "2026-08-08T00:00:00Z",
          included_in_kpi: true,
        }),
        "0.4.0",
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
        "0.4.0",
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

// issue #50 (S4/S5, issue50-spec.md lines 13-17) — the forward-compat write guard itself:
// assertDoneOverlayWritable / updateDoneOverlay / inspectDoneOverlay / upsertOverlayLedgerEntry.
describe("issue #50: done overlay forward-compat guard", () => {
  let dataDir: string;
  let specDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lane-data-"));
    specDir = mkdtempSync(join(tmpdir(), "lane-spec-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` stringifies to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  function buildState(overrides: Partial<LaneState> = {}): LaneState {
    return LaneStateSchemaV3.parse({
      schema_version: "3.0",
      intent_id: "I-2026-09-25-guard-example",
      tracker_url: null,
      pr_url: null,
      owner: null,
      current_phase: "4_verify",
      status: "running",
      created_at: "2026-09-25T09:00:00+09:00",
      usage_import_gate_overrides: [],
      phase_history: [
        {
          phase: "4_verify",
          started_at: "2026-09-25T10:00:00+09:00",
          result: "in_progress",
          retry_count: 0,
        },
      ],
      ...overrides,
    });
  }

  function makeOverlay(intentId: string, toolVersion: string): DoneOverlay {
    const state = buildState({ intent_id: intentId });
    return createDoneOverlay({
      specDir,
      intentId,
      state,
      originalState: state,
      verifyEndedAt: "2026-09-25T10:30:00+09:00",
      prUrl: null,
      mergeSha: null,
      toolVersion,
    });
  }

  // A2 (issue50-spec.md line 26): equal/older running version is allowed through silently.
  it("assertDoneOverlayWritable allows an equal running version", () => {
    const overlay = makeOverlay("I-2026-09-25-a2-equal", "0.11.0");
    expect(() => assertDoneOverlayWritable(overlay, "0.11.0")).not.toThrow();
  });

  it("assertDoneOverlayWritable allows a newer running version (overlay is older)", () => {
    const overlay = makeOverlay("I-2026-09-25-a2-older", "0.10.0");
    expect(() => assertDoneOverlayWritable(overlay, "0.11.0")).not.toThrow();
  });

  // A2: overlay tool_version newer than the running binary refuses.
  it("assertDoneOverlayWritable throws DoneOverlayVersionError when tool_version is newer than the running binary", () => {
    const overlay = makeOverlay("I-2026-09-25-a2-newer", "0.12.0");
    expect(() => assertDoneOverlayWritable(overlay, "0.11.0")).toThrow(DoneOverlayVersionError);
  });

  // A2: last_writer_tool_version (not just tool_version) newer than the running binary
  // also refuses -- max(tool_version, last_writer_tool_version) is the effective version.
  it("assertDoneOverlayWritable throws when last_writer_tool_version is newer than the running binary, even if tool_version itself is older", () => {
    const overlay = {
      ...makeOverlay("I-2026-09-25-a2-lastwriter", "0.9.0"),
      last_writer_tool_version: "0.12.0",
    };
    expect(() => assertDoneOverlayWritable(overlay, "0.11.0")).toThrow(DoneOverlayVersionError);
  });

  // A3: an unparseable version on either side is fail-closed (throws), never silently
  // treated as comparable.
  it("assertDoneOverlayWritable fail-closes (throws) when the overlay's tool_version is not valid SemVer", () => {
    const overlay = { ...makeOverlay("I-2026-09-25-a3-malformed", "dev") };
    expect(() => assertDoneOverlayWritable(overlay, "0.11.0")).toThrow(DoneOverlayVersionError);
  });

  // Copilot review on #51: the error names the overlay field that failed to parse, not a
  // valid last-writer value sitting next to a malformed creator version.
  it("names the malformed tool_version, not a valid last_writer_tool_version, in the refusal", () => {
    const overlay = {
      ...makeOverlay("I-2026-09-25-a3-malformed-creator", "dev"),
      last_writer_tool_version: "0.10.0",
    };
    let caught: unknown;
    try {
      assertDoneOverlayWritable(overlay, "0.11.0");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DoneOverlayVersionError);
    expect((caught as DoneOverlayVersionError).overlayVersion).toBe("dev");
  });

  it("assertDoneOverlayWritable fail-closes (throws) when the running toolVersion is not valid SemVer", () => {
    const overlay = makeOverlay("I-2026-09-25-a3-running-malformed", "0.11.0");
    expect(() => assertDoneOverlayWritable(overlay, "not-a-version")).toThrow(
      DoneOverlayVersionError,
    );
  });

  // A2: updateDoneOverlay stamps last_writer_tool_version with the running version on
  // success, and never touches tool_version (the creating binary's own version).
  it("updateDoneOverlay stamps last_writer_tool_version with the running version and leaves tool_version untouched", () => {
    const intentId = "I-2026-09-25-update-stamps";
    const overlay = makeOverlay(intentId, "0.10.0");
    const updated = updateDoneOverlay(specDir, intentId, "0.11.0", overlay);
    expect(updated.last_writer_tool_version).toBe("0.11.0");
    expect(updated.tool_version).toBe("0.10.0");
    const reread = readDoneOverlay(specDir, intentId);
    expect(reread?.last_writer_tool_version).toBe("0.11.0");
    expect(reread?.tool_version).toBe("0.10.0");
  });

  // A2: updateDoneOverlay refuses (throws) against a newer-written overlay, and does not
  // touch the file on disk.
  it("updateDoneOverlay throws DoneOverlayVersionError and does not write when the overlay is newer than the running binary", () => {
    const intentId = "I-2026-09-25-update-refuses";
    const overlay = makeOverlay(intentId, "0.12.0");
    const before = readDoneOverlay(specDir, intentId);
    expect(() => updateDoneOverlay(specDir, intentId, "0.11.0", overlay)).toThrow(
      DoneOverlayVersionError,
    );
    const after = readDoneOverlay(specDir, intentId);
    expect(after).toEqual(before);
  });

  // A2: upsertOverlayLedgerEntry (routed through updateDoneOverlay) throws the same way on
  // a newer overlay.
  it("upsertOverlayLedgerEntry throws when the overlay is newer than the running toolVersion", () => {
    const intentId = "I-2026-09-25-upsert-refuses";
    makeOverlay(intentId, "0.12.0");
    const entry: LedgerEntry = {
      ledger_entry_id: "lc_guard_test",
      lane_id: intentId,
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
      pricing_as_of: "2026-09-25T00:00:00Z",
      imported_at: "2026-09-25T00:00:00Z",
      since: null,
      until: null,
      agents: ["claude"],
    } as LedgerEntry;
    expect(() => upsertOverlayLedgerEntry(specDir, intentId, entry, "0.11.0")).toThrow(
      DoneOverlayVersionError,
    );
  });

  // A1 (issue50-spec.md line 25): unknown keys, both at the top level and inside
  // state_delta, survive a rewrite through upsertOverlayLedgerEntry (updateDoneOverlay's
  // read-modify-write round trip) -- passthrough, not silently dropped.
  it("upsertOverlayLedgerEntry preserves unknown top-level and state_delta keys across a rewrite", () => {
    const intentId = "I-2026-09-25-a1-passthrough";
    const overlay = makeOverlay(intentId, "0.11.0");
    const path = doneOverlayPath(specDir, intentId);
    const withUnknownKeys = {
      ...overlay,
      future_top_level_field: "unicorn",
      state_delta: { ...overlay.state_delta, future_state_delta_field: "sparkle" },
    };
    writeFileSync(path, JSON.stringify(withUnknownKeys, null, 2));

    const entry: LedgerEntry = {
      ledger_entry_id: "lc_a1_test",
      lane_id: intentId,
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
      pricing_as_of: "2026-09-25T00:00:00Z",
      imported_at: "2026-09-25T00:00:00Z",
      since: null,
      until: null,
      agents: ["claude"],
    } as LedgerEntry;
    upsertOverlayLedgerEntry(specDir, intentId, entry, "0.11.0");

    const rawAfter = JSON.parse(readFileSync(path, "utf-8"));
    expect(rawAfter.future_top_level_field).toBe("unicorn");
    expect(rawAfter.state_delta.future_state_delta_field).toBe("sparkle");
  });

  // A4 (issue50-spec.md line 28): inspectDoneOverlay distinguishes absent from unreadable,
  // and readDoneOverlay still collapses unreadable to null (unchanged read-path behavior).
  it("inspectDoneOverlay: absent when no file exists", () => {
    expect(inspectDoneOverlay(specDir, "I-2026-09-25-absent")).toEqual({ kind: "absent" });
  });

  it("inspectDoneOverlay: unreadable for invalid JSON, and readDoneOverlay still returns null", () => {
    const intentId = "I-2026-09-25-bad-json";
    const path = doneOverlayPath(specDir, intentId);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not valid json");
    const inspection = inspectDoneOverlay(specDir, intentId);
    expect(inspection.kind).toBe("unreadable");
    expect(readDoneOverlay(specDir, intentId)).toBeNull();
  });

  it("inspectDoneOverlay: unreadable for schema_version 9.9 (A4)", () => {
    const intentId = "I-2026-09-25-bad-schema-version";
    const path = doneOverlayPath(specDir, intentId);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "9.9",
        intent_id: intentId,
        verify_ended_at: "2026-09-25T10:30:00+09:00",
        done_recorded_at: "2026-09-25T11:00:00+09:00",
        pr_url: null,
        merge_sha: null,
        spec_dir: specDir,
        spec_dir_fingerprint: "x",
        tool_version: "0.11.0",
        done_source: "local_overlay",
        usage_import_gate_overrides: [],
      }),
    );
    const inspection = inspectDoneOverlay(specDir, intentId);
    expect(inspection.kind).toBe("unreadable");
    expect(readDoneOverlay(specDir, intentId)).toBeNull();
  });

  it("inspectDoneOverlay: unreadable when the file's intent_id does not match the requested one (A4)", () => {
    const intentId = "I-2026-09-25-mismatch-owner";
    makeOverlay(intentId, "0.11.0");
    // The overlay path is keyed by intent id, so the mismatch case is a file sitting at the
    // requested intent's own path whose body names a different intent.
    const requested = "I-2026-09-25-someone-else";
    renameSync(doneOverlayPath(specDir, intentId), doneOverlayPath(specDir, requested));
    const inspection = inspectDoneOverlay(specDir, requested);
    expect(inspection.kind).toBe("unreadable");
  });

  it("inspectDoneOverlay: valid for a well-formed overlay", () => {
    const intentId = "I-2026-09-25-valid";
    makeOverlay(intentId, "0.11.0");
    const inspection = inspectDoneOverlay(specDir, intentId);
    expect(inspection.kind).toBe("valid");
  });
});
