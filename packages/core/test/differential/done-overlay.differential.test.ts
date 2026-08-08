import { type LaneState, LaneStateSchemaV3 } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { type DoneOverlay, applyDoneOverlay } from "../../src/done-overlay.js";
import { callPython, isPythonReferenceAvailable } from "./python-harness.js";

// M4 — skips gracefully without the private Python reference implementation installed
// locally (see python-harness.ts's isPythonReferenceAvailable doc comment).
const describeOrSkip = isPythonReferenceAvailable() ? describe : describe.skip;

// design.md §9 checkpoint 3 — apply_done_overlay (orchestrator.py lines 164-191) has the
// same field shape on both sides for this specific function (phase_history entries, and
// current_phase/status/updated_at/pr_url), so the exact same JSON payload can be fed to
// both the Python and TS implementations without translation.

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
    phase_history: [
      {
        phase: "1_intent",
        started_at: "2026-07-31T09:00:00+09:00",
        ended_at: "2026-07-31T09:05:00+09:00",
        result: "completed",
        retry_count: 0,
      },
      {
        phase: "2_spec",
        started_at: "2026-07-31T09:05:00+09:00",
        ended_at: "2026-07-31T09:20:00+09:00",
        result: "completed",
        retry_count: 0,
      },
      {
        phase: "3_implement",
        started_at: "2026-07-31T09:20:00+09:00",
        ended_at: "2026-07-31T10:00:00+09:00",
        result: "completed",
        retry_count: 1,
      },
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

function buildOverlay(overrides: Partial<DoneOverlay> = {}): DoneOverlay {
  return {
    schema_version: "1.0",
    intent_id: "I-2026-07-31-example-feature",
    verify_ended_at: "2026-07-31T10:30:00+09:00",
    done_recorded_at: "2026-07-31T11:00:00+09:00",
    pr_url: "https://github.com/example/example/pull/42",
    merge_sha: "abc1234",
    spec_dir: "/tmp/spec",
    spec_dir_fingerprint: "fingerprint",
    tool_version: "0.1.0",
    done_source: "local_overlay",
    usage_import_gate_overrides: [],
    ledger_delta: [],
    ...overrides,
  };
}

describeOrSkip(
  "applyDoneOverlay matches the Python reference implementation's apply_done_overlay",
  () => {
    it("closes the in_progress 4_verify entry and appends 5_done", () => {
      const state = buildState();
      const overlay = buildOverlay();

      const pyResult = callPython<{
        current_phase: string;
        status: string;
        updated_at: string;
        pr_url: string | null;
        phase_history: { phase: string; result: string; ended_at?: string }[];
      }>("apply_done_overlay", [state, overlay]);

      const tsResult = applyDoneOverlay(state, overlay);

      expect(tsResult.current_phase).toBe(pyResult.current_phase);
      expect(tsResult.status).toBe(pyResult.status);
      expect(tsResult.updated_at).toBe(pyResult.updated_at);
      expect(tsResult.pr_url).toBe(pyResult.pr_url);
      expect(tsResult.phase_history).toHaveLength(pyResult.phase_history.length);
      expect(
        tsResult.phase_history.map((p) => ({
          phase: p.phase,
          result: p.result,
          ended_at: p.ended_at,
        })),
      ).toEqual(
        pyResult.phase_history.map((p) => ({
          phase: p.phase,
          result: p.result,
          ended_at: p.ended_at,
        })),
      );
      // sanity: this is the actual behavior, not just "matches Python" in the abstract
      expect(pyResult.current_phase).toBe("5_done");
      expect(pyResult.status).toBe("completed");
    });

    it("prefers overlay.pr_url over state.pr_url when overlay carries one", () => {
      const state = buildState({ pr_url: "https://github.com/example/example/pull/1" });
      const overlay = buildOverlay({ pr_url: "https://github.com/example/example/pull/42" });

      const pyResult = callPython<{ pr_url: string | null }>("apply_done_overlay", [
        state,
        overlay,
      ]);
      const tsResult = applyDoneOverlay(state, overlay);

      expect(tsResult.pr_url).toBe(pyResult.pr_url);
      expect(pyResult.pr_url).toBe("https://github.com/example/example/pull/42");
    });

    it("falls back to state.pr_url when overlay has none", () => {
      const state = buildState({ pr_url: "https://github.com/example/example/pull/1" });
      const overlay = buildOverlay({ pr_url: null });

      const pyResult = callPython<{ pr_url: string | null }>("apply_done_overlay", [
        state,
        overlay,
      ]);
      const tsResult = applyDoneOverlay(state, overlay);

      expect(tsResult.pr_url).toBe(pyResult.pr_url);
      expect(pyResult.pr_url).toBe("https://github.com/example/example/pull/1");
    });
  },
);
