import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaneState, LaneStateSchemaV3 } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDoneOverlay,
  doneOverlayPath,
  isDoneOverlayGuarded,
  readDoneOverlay,
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
});
