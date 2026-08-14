import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalVerificationContent, computeDigest } from "@lane/core";
import type { Verification } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runStart } from "../src/commands/start.js";
import { runStatus } from "../src/commands/status.js";
import { runValidate } from "../src/commands/validate.js";
import { intentPath, readIntent, writeIntent } from "../src/intent-store.js";
import { writeSpecMd } from "../src/spec-store.js";
import { writeVerification } from "../src/verification-store.js";

describe("CLI commands (direct, no subprocess)", () => {
  let specDir: string;
  let dataDir: string;
  const intentId = "I-2026-07-31-unit-flow";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-cli-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-cli-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // `process.env.X = undefined` does NOT delete the var — Node's env proxy coerces the
    // assigned value to the string "undefined", which resolveDataDir() would then read
    // back as a truthy (bogus) path. `delete` is required for real removal.
    // biome-ignore lint/performance/noDelete: see comment above
    delete process.env.LANE_DATA_DIR;
  });

  it("start -> status -> advance -> status happy path", () => {
    expect(runStart(intentId, { specDir }).exitCode).toBe(0);
    expect(runStatus(intentId, { specDir }).message).toContain("current_phase: 1_intent");

    const advanceResult = runAdvance(intentId, "2_spec", { specDir });
    expect(advanceResult.exitCode).toBe(0);
    expect(runStatus(intentId, { specDir }).message).toContain("current_phase: 2_spec");
  });

  // #52 regression: the guide must survive every writer that re-stringifies intent.yaml
  // (terra review must-1: `lane estimate --adopt` calls writeIntent, which would have
  // silently dropped a start-time-only appended comment), and must disappear once the
  // field is actually recorded so a completed lane doesn't carry stale scaffolding.
  it("premise_evidence guide comment is scaffolded, survives re-writes while unrecorded, and drops once recorded", () => {
    runStart(intentId, { specDir });
    const path = intentPath(specDir, intentId);
    expect(readFileSync(path, "utf-8")).toContain("# premise_evidence:");

    const intent = readIntent(specDir, intentId);
    writeIntent(specDir, intentId, intent);
    expect(readFileSync(path, "utf-8")).toContain("# premise_evidence:");

    writeIntent(specDir, intentId, {
      ...intent,
      premise_evidence: { required: false, reason: "docs-only change" },
    });
    expect(readFileSync(path, "utf-8")).not.toContain("# premise_evidence:");
  });

  it("start twice for the same intent_id is rejected", () => {
    runStart(intentId, { specDir });
    const second = runStart(intentId, { specDir });
    expect(second.exitCode).toBe(2);
  });

  it("advance rejects a skip transition", () => {
    runStart(intentId, { specDir });
    const result = runAdvance(intentId, "4_verify", { specDir });
    expect(result.exitCode).toBe(2);
  });

  it("advance against a lane that was never started fails with a lane-state error", () => {
    const result = runAdvance("I-2026-07-31-never-started", "2_spec", { specDir });
    expect(result.exitCode).toBe(2);
  });

  it("validate passes on a freshly started lane (intent-only, no verification.yaml yet)", () => {
    runStart(intentId, { specDir });
    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(0);
  });

  it("status on a lane that does not exist fails", () => {
    const result = runStatus("I-2026-07-31-missing", { specDir });
    expect(result.exitCode).toBe(2);
  });
});

type Deviation = NonNullable<Verification["spec_consensus"]>["deviations"][number];

/** Builds a Verification whose spec_consensus digests genuinely match `specMdContent`. */
function buildVerificationWithValidAck(
  intentId: string,
  specMdContent: string,
  overrides: { deviations?: Deviation[]; ackedBy?: "self" | "human" | "independent_agent" } = {},
): Verification {
  const withoutConsensus: Verification = {
    schema_version: "1.0",
    intent_id: intentId,
    test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
    test_gaps: [],
    manual_verification: [],
    goal_stopping_condition: [],
  };
  const specDigest = computeDigest(specMdContent);
  const verificationDigest = computeDigest(canonicalVerificationContent(withoutConsensus));
  return {
    ...withoutConsensus,
    spec_consensus: {
      spec_ssot_ref: "spec.md",
      spec_digest: specDigest,
      verification_digest: verificationDigest,
      deviations: overrides.deviations ?? [],
      reviewer_ack: {
        reviewer_kind: overrides.ackedBy ?? "self",
        reviewer_id: "tester",
        acked_at: "2026-07-31T09:00:00+09:00",
        spec_sha256: specDigest,
        verification_sha256: verificationDigest,
      },
    },
  };
}

describe("spec_consensus gate wiring (Codex M1 review, must-1/must-2/must-3/should-5)", () => {
  let specDir: string;
  let dataDir: string;
  const intentId = "I-2026-07-31-gate-flow";
  const specMdContent = "# Spec\n\nRule 1: does the thing.\n";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-cli-gate-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-cli-gate-data-"));
    process.env.LANE_DATA_DIR = dataDir;
    runStart(intentId, { specDir });
    for (const phase of ["2_spec", "3_implement", "4_verify"] as const) {
      expect(runAdvance(intentId, phase, { specDir }).exitCode).toBe(0);
    }
  });

  afterEach(() => {
    // `process.env.X = undefined` does NOT delete the var — Node's env proxy coerces the
    // assigned value to the string "undefined", which resolveDataDir() would then read
    // back as a truthy (bogus) path. `delete` is required for real removal.
    // biome-ignore lint/performance/noDelete: see comment above
    delete process.env.LANE_DATA_DIR;
  });

  it("must-1: advance --phase 5_done is blocked when verification.yaml has no spec_consensus at all", () => {
    const result = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-07-31T10:30:00+09:00",
    });
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/Gate failed/);
  });

  it("must-1: advance --phase 5_done is blocked by an unresolved deviation", () => {
    writeSpecMd(specDir, intentId, specMdContent);
    const verification = buildVerificationWithValidAck(intentId, specMdContent, {
      deviations: [{ spec_ref: "spec.md#1", actual: "differs", action: "fix", status: "pending" }],
    });
    writeVerification(specDir, intentId, verification);

    const result = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-07-31T10:30:00+09:00",
    });
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/unresolved deviation/);
  });

  it("must-1: advance --phase 5_done succeeds once spec_consensus is fully satisfied", () => {
    writeSpecMd(specDir, intentId, specMdContent);
    writeVerification(specDir, intentId, buildVerificationWithValidAck(intentId, specMdContent));

    const result = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-07-31T10:30:00+09:00",
    });
    expect(result.exitCode).toBe(0);
  });

  it("should-5: advance --phase 5_done without --merged-at is rejected", () => {
    writeSpecMd(specDir, intentId, specMdContent);
    writeVerification(specDir, intentId, buildVerificationWithValidAck(intentId, specMdContent));

    const result = runAdvance(intentId, "5_done", { specDir });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/--merged-at/);
  });

  it("must-2: validate detects a spec.md edit made after the ack (digest mismatch)", () => {
    writeSpecMd(specDir, intentId, specMdContent);
    writeVerification(specDir, intentId, buildVerificationWithValidAck(intentId, specMdContent));

    expect(runValidate(intentId, { specDir }).exitCode).toBe(0);

    // spec.md changes after the ack was recorded; verification.yaml (and its recorded
    // digest) is left untouched.
    writeSpecMd(specDir, intentId, `${specMdContent}\nRule 2: does another thing.\n`);

    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/digest mismatch/);
  });
});
