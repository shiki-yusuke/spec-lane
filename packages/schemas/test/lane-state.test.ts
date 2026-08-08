import { describe, expect, it } from "vitest";
import { LaneStateSchemaV2, LaneStateSchemaV3, parseLaneState } from "../src/lane-state.js";

const v1Fixture = {
  intent_id: "I-2026-07-31-example-feature",
  current_phase: "2_spec",
  status: "running",
  created_at: "2026-07-31T09:00:00+09:00",
  phase_history: [
    {
      phase: "1_intent",
      started_at: "2026-07-31T09:00:00+09:00",
      ended_at: "2026-07-31T09:05:00+09:00",
      result: "completed",
      retry_count: 0,
    },
  ],
};

// MP-8 (2026-08-08, sol ruling / team-lead confirmation): a real, already-existing v2
// lane-state.json — non-empty scope="phase" ledger entry with real usage numbers, at
// 4_verify — must keep reading transparently with no explicit migrate step (Rule 8b),
// the same way a v1 file already did before this bump. This is deliberately *not* the
// empty-cost_ledger v2 fixture below; it exercises the actual LedgerEntry migration path.
const v2RealShapedFixture = {
  schema_version: "2.0",
  intent_id: "I-2026-07-31-example-feature",
  tracker_url: null,
  pr_url: "https://github.com/example/repo/pull/42",
  pr_provenance: "advance",
  owner: "example-owner",
  current_phase: "4_verify",
  status: "running",
  created_at: "2026-07-31T09:00:00+09:00",
  updated_at: "2026-07-31T10:00:00+09:00",
  phase_history: [
    {
      phase: "1_intent",
      started_at: "2026-07-31T09:00:00+09:00",
      ended_at: "2026-07-31T09:05:00+09:00",
      result: "completed",
      retry_count: 0,
    },
  ],
  halt_info: null,
  retry_log: [],
  effective_risk_log: [],
  mode_resolution_log: [],
  cost_ledger: [
    {
      ledger_entry_id: "lc_realphaseentry01",
      lane_id: "I-2026-07-31-example-feature",
      phase: "3_implement",
      source: "claude_jsonl_auto",
      scope: "phase",
      session_ids: ["sess-real-1", "sess-real-2"],
      data_state: "has_usage",
      confidence: "imported_windowed",
      included_in_kpi: true,
      tokens: 52000,
      turns: 14,
      cost_usd: 3.21,
      cost_credits: null,
      pricing_version: "v1",
      pricing_as_of: "2026-07-31T09:30:00+09:00",
      imported_at: "2026-07-31T09:35:00+09:00",
      // pre-3.0 shape: no since/until/agents at all.
    },
  ],
  usage_import_attempts: [],
  usage_import_gate_overrides: [],
};

describe("parseLaneState version dispatch", () => {
  it("parses a v3 file directly", () => {
    const v3 = LaneStateSchemaV3.parse({
      schema_version: "3.0",
      intent_id: "I-2026-07-31-example-feature",
      tracker_url: null,
      pr_url: null,
      owner: null,
      current_phase: "1_intent",
      status: "pending",
      created_at: "2026-07-31T09:00:00+09:00",
    });
    const result = parseLaneState(v3);
    expect(result.schema_version).toBe("3.0");
  });

  it("migrates a v2 file (empty cost_ledger) to v3 shape", () => {
    const v2 = LaneStateSchemaV2.parse({
      schema_version: "2.0",
      intent_id: "I-2026-07-31-example-feature",
      tracker_url: null,
      pr_url: null,
      owner: null,
      current_phase: "1_intent",
      status: "pending",
      created_at: "2026-07-31T09:00:00+09:00",
    });
    const result = parseLaneState(v2);
    expect(result.schema_version).toBe("3.0");
    expect(result.cost_ledger).toEqual([]);
  });

  // MP-8 Rule 8b / TEST-02b: the real-shaped fixture, not just an empty one.
  it("migrates a real-shaped v2 file (non-empty scope=phase ledger entry) to v3, preserving values and defaulting since/until/agents to null", () => {
    const result = parseLaneState(v2RealShapedFixture);
    expect(result.schema_version).toBe("3.0");
    expect(result.current_phase).toBe("4_verify");
    expect(result.cost_ledger).toHaveLength(1);
    const entry = result.cost_ledger[0];
    expect(entry).toMatchObject({
      ledger_entry_id: "lc_realphaseentry01",
      scope: "phase",
      phase: "3_implement",
      tokens: 52000,
      cost_usd: 3.21,
      session_ids: ["sess-real-1", "sess-real-2"],
      since: null,
      until: null,
      agents: null,
    });
  });

  it("migrates a pre-rev2 (v1, no schema_version) file all the way to v3 shape", () => {
    const migrated = parseLaneState(v1Fixture);
    expect(migrated.schema_version).toBe("3.0");
    expect(migrated.pr_provenance).toBeNull();
    expect(migrated.effective_risk_log).toEqual([]);
    expect(migrated.mode_resolution_log).toEqual([]);
    expect(migrated.phase_history).toHaveLength(1);
  });

  it("is idempotent: migrating twice yields the same result as migrating once", () => {
    const once = parseLaneState(v1Fixture);
    const twice = parseLaneState(once);
    expect(twice).toEqual(once);
  });

  it("is idempotent for the real-shaped v2 fixture too", () => {
    const once = parseLaneState(v2RealShapedFixture);
    const twice = parseLaneState(once);
    expect(twice).toEqual(once);
  });
});
