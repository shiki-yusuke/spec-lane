import { describe, expect, it } from "vitest";
import { DesignTrackSchema, LaneStateSchemaV3 } from "../src/lane-state.js";

// I-2026-08-18-design-critic-injection R1/R2. Gherkin: "a lane started without --design is
// unaffected" (R1, partial -- this file covers the schema-shape half; the CLI-level
// byte-identical-output half is exercised by packages/cli/test/start.design.test.ts) and
// "the design track records who activated it and when" (R2).

const baseState = {
  schema_version: "3.0" as const,
  intent_id: "I-x",
  tracker_url: null,
  pr_url: null,
  pr_provenance: null,
  owner: null,
  current_phase: "1_intent" as const,
  status: "running" as const,
  created_at: "2026-08-19T00:00:00Z",
  phase_history: [],
  halt_info: null,
  retry_log: [],
  effective_risk_log: [],
  mode_resolution_log: [],
  cost_ledger: [],
  usage_import_attempts: [],
  usage_import_gate_overrides: [],
};

describe("LaneState.design_track (R1/R2)", () => {
  it("a state with no design_track key serializes with the key genuinely absent (R1)", () => {
    const parsed = LaneStateSchemaV3.parse(baseState);
    expect("design_track" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("design_track");
  });

  it("accepts a design_track recording who activated it and when (R2)", () => {
    const withTrack = {
      ...baseState,
      design_track: {
        activated: true,
        activated_by: "shiki",
        activated_at: "2026-08-19T00:00:00Z",
      },
    };
    const parsed = LaneStateSchemaV3.parse(withTrack);
    expect(parsed.design_track).toEqual({
      activated: true,
      activated_by: "shiki",
      activated_at: "2026-08-19T00:00:00Z",
    });
  });

  it("DesignTrackSchema rejects activated: false (only true is expressible, matching R20's null-not-zero style)", () => {
    const result = DesignTrackSchema.safeParse({
      activated: false,
      activated_by: "shiki",
      activated_at: "2026-08-19T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});
