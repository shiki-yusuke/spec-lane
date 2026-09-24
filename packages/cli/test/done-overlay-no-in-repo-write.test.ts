import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStateWithOverlay, readDoneOverlay } from "@lane/core";
import type { Verification } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runConsensus } from "../src/commands/consensus.js";
import { runStart } from "../src/commands/start.js";
import { readIntent, writeIntent } from "../src/intent-store.js";
import { writeSpecMd } from "../src/spec-store.js";
import { laneStatePath, readLaneState, writeLaneState } from "../src/state-store.js";
import { writeVerification } from "../src/verification-store.js";

// issue #46 — `advance --phase 5_done` documented (design.md §3.6, done-overlay.ts's own
// header comment) that it never touches in-repo lane-state.json, but still called
// writeLaneState(specDir, intentId, stateForDone) on the success path -- persisting the
// 5_done-time effective_risk_log entry, and (when triggered) an R5 ruleset_migrations
// entry / R8 weakening_acknowledgements entry. This suite pins the actual contract: the
// in-repo file's bytes are unchanged across a successful `advance --phase 5_done`, in
// every case that used to mutate it, and the same information is still visible through
// the overlay-applied effective view (status/list/stats/evidence-export's read path).

const specMdContent = "# Spec\n\nRule 1: does the thing.\n";

function buildVerification(overrides: { successCriterion?: string } = {}): Verification {
  return {
    schema_version: "1.0",
    intent_id: "placeholder",
    test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
    test_gaps: [],
    manual_verification: [],
    goal_stopping_condition: [],
    success_criteria_matrix: [
      {
        criterion: overrides.successCriterion ?? "Describe at least one success criterion.",
        covered_by: "test",
        evidence: "Rule 1 unit test covers this.",
      },
    ],
  };
}

/**
 * Drives a fresh lane from 1_intent to 4_verify with every gate genuinely satisfied
 * (real premise evidence, a matching success_criteria_matrix, a valid spec_consensus
 * ack) -- copied from promotion-invariants.test.ts's own helper, which this suite is a
 * sibling of (same "reach a clean 4_verify, then do something at 5_done" shape).
 */
function advanceToVerify(
  specDir: string,
  intentId: string,
  opts: { successCriterion?: string } = {},
): void {
  expect(runStart(intentId, { specDir }).exitCode).toBe(0);

  const started = readIntent(specDir, intentId);
  writeIntent(specDir, intentId, {
    ...started,
    intent: {
      ...started.intent,
      success: [opts.successCriterion ?? started.intent.success[0] ?? "ok"],
    },
    premise_evidence: {
      required: true,
      method: "live",
      reproduced: true,
      evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
    },
  });
  expect(runAdvance(intentId, "2_spec", { specDir }).exitCode).toBe(0);
  expect(runAdvance(intentId, "3_implement", { specDir }).exitCode).toBe(0);

  writeVerification(specDir, intentId, {
    ...buildVerification({ successCriterion: opts.successCriterion }),
    intent_id: intentId,
  });
  expect(runAdvance(intentId, "4_verify", { specDir }).exitCode).toBe(0);

  writeSpecMd(specDir, intentId, specMdContent);
  expect(
    runConsensus(intentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" }).exitCode,
  ).toBe(0);
  expect(
    runConsensus(intentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } }).exitCode,
  ).toBe(0);
}

describe("advance --phase 5_done never touches in-repo lane-state.json (issue #46)", () => {
  let specDir: string;
  let dataDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-done-no-write-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-done-no-write-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` would stringify to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  it("plain 5_done: in-repo bytes are byte-identical, but the risk evaluation is visible via the overlay-applied view", () => {
    const intentId = "I-2026-09-24-done-no-write-plain";
    advanceToVerify(specDir, intentId);

    const before = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    const rawStateBefore = readLaneState(specDir, intentId);

    const result = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-24T10:00:00+09:00",
    });
    expect(result.exitCode).toBe(0);

    const after = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    expect(after).toBe(before);

    const rawStateAfter = readLaneState(specDir, intentId);
    expect(rawStateAfter.current_phase).toBe("4_verify");
    expect(rawStateAfter.effective_risk_log).toEqual(rawStateBefore.effective_risk_log);

    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.state_delta.effective_risk_log.length).toBeGreaterThan(0);

    const [effectiveState] = loadStateWithOverlay(specDir, intentId, rawStateAfter);
    expect(effectiveState.current_phase).toBe("5_done");
    expect(effectiveState.effective_risk_log).toEqual([
      ...rawStateBefore.effective_risk_log,
      ...(overlay?.state_delta.effective_risk_log ?? []),
    ]);
  });

  it("--ack-ruleset-migration on a version mismatch: in-repo bytes are byte-identical, migration visible via the overlay-applied view", () => {
    const intentId = "I-2026-09-24-done-no-write-migration";
    advanceToVerify(specDir, intentId);

    // Simulate a lane recorded under a stale gate_ruleset_version, as if started before
    // the installed binary's CURRENT_GATE_RULESET_VERSION ("1.0") moved on.
    const staleState = readLaneState(specDir, intentId);
    writeLaneState(specDir, intentId, { ...staleState, gate_ruleset_version: "0.9" });

    const before = readFileSync(laneStatePath(specDir, intentId), "utf-8");

    // Without the ack, this must still refuse (sanity: the mismatch really is wired up).
    const blocked = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-24T10:00:00+09:00",
    });
    expect(blocked.exitCode).not.toBe(0);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(before);

    const result = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-24T10:00:00+09:00",
      ackRulesetMigration: true,
    });
    expect(result.exitCode).toBe(0);

    const after = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    expect(after).toBe(before);

    const rawStateAfter = readLaneState(specDir, intentId);
    expect(rawStateAfter.gate_ruleset_version).toBe("0.9");
    expect(rawStateAfter.ruleset_migrations).toBeUndefined();

    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.state_delta.gate_ruleset_version).toBe("1.0");
    expect(overlay?.state_delta.ruleset_migrations).toHaveLength(1);
    expect(overlay?.state_delta.ruleset_migrations[0]).toMatchObject({ from: "0.9", to: "1.0" });

    const [effectiveState] = loadStateWithOverlay(specDir, intentId, rawStateAfter);
    expect(effectiveState.gate_ruleset_version).toBe("1.0");
    expect(effectiveState.ruleset_migrations).toEqual(overlay?.state_delta.ruleset_migrations);
  });

  it("--weakening-rationale on a weakening finding: in-repo bytes are byte-identical, acknowledgement visible via the overlay-applied view", () => {
    const intentId = "I-2026-09-24-done-no-write-weakening";
    advanceToVerify(specDir, intentId);

    const goodIntent = readIntent(specDir, intentId);
    // Still passes premiseEvidenceGate outright (method is valid, reproduced stays true --
    // only a "weak_evidence" warning), but promotionWeakeningGate's own strength table
    // (gate.ts: live/data=2, code-only=1) treats this as a genuine downgrade.
    writeIntent(specDir, intentId, {
      ...goodIntent,
      premise_evidence: {
        required: true,
        method: "code-only",
        reproduced: true,
        evidence: "Re-derived from a static read of the code rather than a fresh live repro.",
      },
    });

    const before = readFileSync(laneStatePath(specDir, intentId), "utf-8");

    // Without the rationale, this must still refuse (sanity: the weakening gate really
    // fires here).
    const blocked = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-24T10:00:00+09:00",
    });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.message).toContain("[promotion_weakening]");
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(before);

    const result = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-24T10:00:00+09:00",
      weakeningRationale: "Live repro unavailable post-merge; telemetry re-derivation is adequate.",
    });
    expect(result.exitCode).toBe(0);

    const after = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    expect(after).toBe(before);

    const rawStateAfter = readLaneState(specDir, intentId);
    expect(rawStateAfter.weakening_acknowledgements).toBeUndefined();

    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.state_delta.weakening_acknowledgements).toHaveLength(1);
    expect(overlay?.state_delta.weakening_acknowledgements[0]).toMatchObject({
      rationale: "Live repro unavailable post-merge; telemetry re-derivation is adequate.",
    });

    const [effectiveState] = loadStateWithOverlay(specDir, intentId, rawStateAfter);
    expect(effectiveState.weakening_acknowledgements).toEqual(
      overlay?.state_delta.weakening_acknowledgements,
    );
  });
});
