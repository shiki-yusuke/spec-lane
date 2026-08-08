import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEstimate } from "../src/commands/estimate.js";
import { runStart } from "../src/commands/start.js";
import { readEstimateIfExists } from "../src/estimate-store.js";
import { readIntent } from "../src/intent-store.js";

// MP-8 (2026-08-08, sol ruling point 7): there is no more silent reference_table
// default -- every test below that doesn't specifically exercise the "no reference table
// given" failure path needs to supply one explicitly to reach exitCode 0 at all.
const REFERENCE_TABLE_OPTS = {
  referenceTokensP50: 50_000,
  referenceTokensP80: 150_000,
  referenceCostP50: 1,
  referenceCostP80: 4,
};

describe("runEstimate", () => {
  let specDir: string;
  let dataDir: string;
  const intentId = "I-2026-07-31-estimate-flow";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-estimate-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-estimate-data-"));
    process.env.LANE_DATA_DIR = dataDir;
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("creates revision r1 via the reference_table fallback when there is no calibration population", () => {
    const result = runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("revision r1");
    expect(result.message).toContain("reference_table");

    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions).toHaveLength(1);
    expect(estimate?.revisions[0]?.revision_id).toBe("r1");
  });

  // MP-8 (2026-08-08, sol ruling point 7) / spec.md Rule 10: the behavior the removed
  // silent default used to paper over.
  it("fails with a clear message naming all four --reference-* flags when the population is too small and none were given", () => {
    const result = runEstimate(intentId, { specDir });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("--reference-tokens-p50");
    expect(result.message).toContain("--reference-tokens-p80");
    expect(result.message).toContain("--reference-cost-p50");
    expect(result.message).toContain("--reference-cost-p80");
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate).toBeNull();
  });

  it("fails cleanly when only some of the four --reference-* flags are given (all-or-none)", () => {
    const result = runEstimate(intentId, { specDir, referenceTokensP50: 10_000 });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("must all be given together, or none");
  });

  it("appends r2 on a second call, never rewriting r1", () => {
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions.map((r) => r.revision_id)).toEqual(["r1", "r2"]);
  });

  it("does not adopt a baseline unless --adopt is passed", () => {
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    const intent = readIntent(specDir, intentId);
    expect(intent.baseline_estimate_revision_id).toBeUndefined();
  });

  it("--adopt sets intent.baseline_estimate_revision_id to the new revision, stamping baseline_adopted_at", () => {
    runEstimate(intentId, { specDir, adopt: true, ...REFERENCE_TABLE_OPTS });
    const intent = readIntent(specDir, intentId);
    expect(intent.baseline_estimate_revision_id).toBe("r1");
    expect(intent.baseline_adopted_at).toBeDefined();
  });

  it("--adopt <revision-id> (must-2): re-points baseline to an existing revision without creating a new one", () => {
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r1
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r2, not adopted

    const result = runEstimate(intentId, { specDir, adopt: "r1" });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("no new revision created");

    const intent = readIntent(specDir, intentId);
    expect(intent.baseline_estimate_revision_id).toBe("r1");
    expect(intent.baseline_adopted_at).toBeDefined();

    // still only r1/r2 -- the adopt-by-id call must not have appended r3
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions.map((r) => r.revision_id)).toEqual(["r1", "r2"]);
  });

  it("--adopt <revision-id> fails cleanly when no estimate.json exists yet", () => {
    const result = runEstimate(intentId, { specDir, adopt: "r1" });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/no estimate\.json/);
  });

  it("--adopt <revision-id> fails cleanly when the revision id doesn't exist", () => {
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r1
    const result = runEstimate(intentId, { specDir, adopt: "r99" });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("r99");
  });

  it("uses --reference-* flags instead of the generic default when given", () => {
    const result = runEstimate(intentId, {
      specDir,
      referenceTokensP50: 10_000,
      referenceTokensP80: 20_000,
      referenceCostP50: 0.5,
      referenceCostP80: 1,
    });
    expect(result.exitCode).toBe(0);
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions[0]?.predicted.tokens).toEqual({ p50: 10_000, p80: 20_000 });
  });

  it("parses an impact-scan:v1 block from --impact-scan-file into the revision's predictors", () => {
    const impactScanPath = join(specDir, "impact-scan-report.md");
    writeFileSync(
      impactScanPath,
      [
        "# Impact Scan",
        "```impact-scan:v1",
        JSON.stringify({
          scan_version: "1.0",
          repo_commit: "abc1234",
          candidate_paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
          candidate_layers: ["ui", "domain"],
        }),
        "```",
      ].join("\n"),
    );
    const result = runEstimate(intentId, {
      specDir,
      impactScanFile: impactScanPath,
      ...REFERENCE_TABLE_OPTS,
    });
    expect(result.exitCode).toBe(0);
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions[0]?.predictors.files_touched_estimate).toBe(3);
    expect(estimate?.revisions[0]?.predictors.layers_crossed).toBe(2);
    expect(estimate?.revisions[0]?.impact_scan_snapshot?.candidate_paths).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("fails with exitCode 1 and a clear message when --impact-scan-file has no valid block", () => {
    const impactScanPath = join(specDir, "bad-report.md");
    writeFileSync(impactScanPath, "# Impact Scan\n\nno block here\n");
    const result = runEstimate(intentId, { specDir, impactScanFile: impactScanPath });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/impact-scan-file/);
  });

  it("fails when the lane was never started", () => {
    const result = runEstimate("I-2026-07-31-never-started", { specDir });
    expect(result.exitCode).toBe(2);
  });
});
