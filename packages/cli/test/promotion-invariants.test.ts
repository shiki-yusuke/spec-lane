import { mkdtempSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doneOverlayPath } from "@lane/core";
import type { Verification } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runConsensus } from "../src/commands/consensus.js";
import { runStart } from "../src/commands/start.js";
import { readIntent, writeIntent } from "../src/intent-store.js";
import { writeSpecMd } from "../src/spec-store.js";
import { laneStatePath, readLaneState } from "../src/state-store.js";
import { writeVerification } from "../src/verification-store.js";

// I-2026-08-20-promotion-invariants — M5 acceptance test, the "cheapest proof" the
// architect (gpt-5.6-sol) specified: this is the chain-probe
// (~/dev/ai-agent-lab/oss-growth/probes/chain-probe-2026-08-20/) run in reverse, as a fast
// CLI-level test (no packed binary, matching gate-port-acceptance.test.ts's own rationale
// for calling runAdvance directly). The probe showed a lane could reach 5_done with
// premise_evidence weakened *after* it passed the 1_intent->2_spec gate that required it.
// These tests weaken a value after its gate passed, assert `advance --phase 5_done` now
// refuses (non-zero, no done overlay, phase untouched), then restore the correct value and
// assert the identical command succeeds.

const specMdContent = "# Spec\n\nRule 1: does the thing.\n";

function buildVerification(overrides: {
  successCriterion?: string;
  ackedAt?: string;
}): Verification {
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
 * Drives a fresh lane from 1_intent all the way to 4_verify with every gate genuinely
 * satisfied (real premise evidence, a matching success_criteria_matrix, a valid
 * spec_consensus ack) -- i.e. exactly the state the chain-probe started from before
 * tampering. `successCriterion` lets a caller align intent.intent.success with the
 * matrix's `criterion` (they must match verbatim, normalizeCriterion()'d).
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

describe("M5 acceptance: promotion refuses a lane weakened after its own gate passed, and accepts it once restored", () => {
  let specDir: string;
  let dataDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-promotion-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-promotion-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` would stringify to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  it("premise_evidence weakened after 1_intent->2_spec blocks 5_done with no side effects, then restoring it succeeds", () => {
    const intentId = "I-2026-08-20-promo-premise";
    advanceToVerify(specDir, intentId);

    const goodIntent = readIntent(specDir, intentId);
    expect(goodIntent.premise_evidence).toEqual({
      required: true,
      method: "live",
      reproduced: true,
      evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
    });

    // The chain-probe's exact tamper: gate-failing values written back after the gate that
    // required good ones already passed.
    writeIntent(specDir, intentId, {
      ...goodIntent,
      premise_evidence: {
        required: true,
        method: "code-only",
        reproduced: false,
        evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
      },
    });

    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    const overlayPath = doneOverlayPath(specDir, intentId);

    const blocked = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-08-20T10:00:00+09:00",
    });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.message).toContain("[premise_evidence]");
    expect(blocked.message).toMatch(/not_reproduced|reproduced=false/i);
    expect(existsSync(overlayPath)).toBe(false);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(readLaneState(specDir, intentId).current_phase).toBe("4_verify");

    // Restore the correct evidence -- the *only* way M5 expects this to unblock, not a
    // rationale/override.
    writeIntent(specDir, intentId, goodIntent);
    const restored = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-08-20T10:00:00+09:00",
    });
    expect(restored.exitCode).toBe(0);
    expect(existsSync(overlayPath)).toBe(true);
  });

  it("a success criterion deleted after 3_implement->4_verify blocks 5_done with no side effects, then restoring it succeeds", () => {
    const intentId = "I-2026-08-20-promo-criteria";
    const criterion = "Users see the new setting in the settings page.";
    advanceToVerify(specDir, intentId, { successCriterion: criterion });

    const goodIntent = readIntent(specDir, intentId);
    expect(goodIntent.intent.success).toEqual([criterion]);

    // Delete the only success criterion -- intent.intent.success is required non-empty by
    // schema, so this is simulated as "criterion no longer transcribed" by swapping it for
    // unrelated text (the matrix still holds the original wording, so the bidirectional
    // cross-check in successCriteriaGate now finds an uncovered intent.success line, the
    // same "criterion silently dropped from the SSOT" shape the chain-probe's own
    // consequence section calls out for this gate).
    writeIntent(specDir, intentId, {
      ...goodIntent,
      intent: { ...goodIntent.intent, success: ["Some unrelated, never-verified criterion."] },
    });

    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    const overlayPath = doneOverlayPath(specDir, intentId);

    const blocked = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-08-20T10:00:00+09:00",
    });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.message).toContain("[success_criteria]");
    expect(existsSync(overlayPath)).toBe(false);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(readLaneState(specDir, intentId).current_phase).toBe("4_verify");

    writeIntent(specDir, intentId, goodIntent);
    const restored = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-08-20T10:00:00+09:00",
    });
    expect(restored.exitCode).toBe(0);
    expect(existsSync(overlayPath)).toBe(true);
  });

  it("spec.md edited after the reviewer ack invalidates spec_consensus and blocks 5_done with no side effects, then restoring it succeeds", () => {
    const intentId = "I-2026-08-20-promo-consensus";
    advanceToVerify(specDir, intentId);

    const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    const overlayPath = doneOverlayPath(specDir, intentId);

    // spec.md changes after the ack; verification.yaml's recorded digest is untouched.
    writeSpecMd(specDir, intentId, `${specMdContent}\nRule 2: an undocumented behavior change.\n`);

    const blocked = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-08-20T10:00:00+09:00",
    });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.message).toContain("[spec_consensus]");
    expect(blocked.message).toMatch(/digest mismatch/);
    expect(existsSync(overlayPath)).toBe(false);
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    expect(readLaneState(specDir, intentId).current_phase).toBe("4_verify");

    writeSpecMd(specDir, intentId, specMdContent);
    const restored = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-08-20T10:00:00+09:00",
    });
    expect(restored.exitCode).toBe(0);
    expect(existsSync(overlayPath)).toBe(true);
  });

  // The negation side of success-condition 5: the weakening gate must NOT fire on an edit that is
  // not a weakening. Without this, "requires a rationale only when weakened" is an untested claim
  // -- and a gate that demanded a rationale for every benign edit would be routed around by
  // re-acking reflexively, which is the failure mode the architect review warned about.
  it("an edit that weakens nothing needs no rationale: promotion still succeeds", () => {
    const intentId = "I-2026-08-20-promo-benign";
    advanceToVerify(specDir, intentId);

    const goodIntent = readIntent(specDir, intentId);
    // Benign: the evidence prose is rewritten (no bearing on any gate predicate) while method and
    // reproduced stay exactly where they were.
    writeIntent(specDir, intentId, {
      ...goodIntent,
      premise_evidence: {
        // Built explicitly rather than spread: premise_evidence is a discriminated union, so
        // spreading it widens the type and the discriminant is no longer narrowed.
        required: true,
        method: "live",
        reproduced: true,
        evidence:
          "Reworded after the fact: same live repro, more detail about which checkout was used.",
      },
    });

    const promoted = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-08-20T10:00:00+09:00",
    });
    expect(promoted.exitCode).toBe(0);
    expect(promoted.message ?? "").not.toContain("[promotion_weakening]");
    expect(existsSync(doneOverlayPath(specDir, intentId))).toBe(true);
  });
});
