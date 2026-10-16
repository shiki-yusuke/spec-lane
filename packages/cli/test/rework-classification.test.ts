import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReworkClassificationExistsError,
  doneOverlayPath,
  readDoneOverlay,
  setReworkClassification,
} from "@lane/core";
import type { ReworkClassification, Verification } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runCalibrate } from "../src/commands/calibrate.js";
import { runConsensus } from "../src/commands/consensus.js";
import { runEmitMetrics } from "../src/commands/emit-metrics.js";
import { runEvidenceExport } from "../src/commands/evidence-export.js";
import { runReworkClassify } from "../src/commands/rework-classify.js";
import { runStart } from "../src/commands/start.js";
import { runStatus } from "../src/commands/status.js";
import { runUsageImport } from "../src/commands/usage-import.js";
import { runWorkBind, runWorkStart } from "../src/commands/work.js";
import { readIntent, writeIntent } from "../src/intent-store.js";
import { writeSpecMd } from "../src/spec-store.js";
import { laneStatePath } from "../src/state-store.js";
import { writeVerification } from "../src/verification-store.js";

// 合意 §B3 — rework classification on the done overlay. Fixture setup (advanceToVerify,
// fake agent-cost) mirrors done-overlay-forward-compat.test.ts -- copied, not imported,
// since that file doesn't export its helpers.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MERGED_AT = "2026-10-16T10:00:00+09:00";

const CLASSIFIED: ReworkClassification = {
  classification_status: "classified",
  origin: "spec_gap",
  detection_stage: "4_verify",
  evidence_ref: "https://github.com/octo-org/spec-lane-demo/pull/12#discussion_r1",
  contributing_factors: ["scope_ambiguity"],
};

function buildVerification(intentId: string): Verification {
  return {
    schema_version: "1.0",
    intent_id: intentId,
    test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
    test_gaps: [],
    manual_verification: [],
    goal_stopping_condition: [],
    success_criteria_matrix: [
      {
        criterion: "Describe at least one success criterion.",
        covered_by: "test",
        evidence: "Rule 1 unit test covers this.",
      },
    ],
  };
}

/** Drives a fresh lane from 1_intent to a clean 4_verify (every gate genuinely satisfied). */
function advanceToVerify(specDir: string, intentId: string): void {
  expect(runStart(intentId, { specDir }).exitCode).toBe(0);
  const started = readIntent(specDir, intentId);
  writeIntent(specDir, intentId, {
    ...started,
    intent: { ...started.intent, success: [started.intent.success[0] ?? "ok"] },
    premise_evidence: {
      required: true,
      method: "live",
      reproduced: true,
      evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
    },
  });
  expect(runAdvance(intentId, "2_spec", { specDir }).exitCode).toBe(0);
  expect(runAdvance(intentId, "3_implement", { specDir }).exitCode).toBe(0);
  writeVerification(specDir, intentId, buildVerification(intentId));
  expect(runAdvance(intentId, "4_verify", { specDir }).exitCode).toBe(0);
  writeSpecMd(specDir, intentId, "# Spec\n\nRule 1: does the thing.\n");
  expect(
    runConsensus(intentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" }).exitCode,
  ).toBe(0);
  expect(
    runConsensus(intentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } }).exitCode,
  ).toBe(0);
}

function writeFakeAgentCost(dir: string, sessionId: string): string {
  const path = join(dir, "agent-cost");
  const script = `#!/usr/bin/env bash
cat <<'JSON'
{
  "protocol_version": "measure/v1",
  "generated_at": "2026-10-16T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": ["${sessionId}"],
  "sessions": {"${sessionId}": {"matched": true, "rows": [], "totals": {"tokens": 1000, "priced_tokens": 1000, "unpriced_tokens": 0, "estimated_cost_usd": 0.5, "credits": 0}}},
  "total": {"rows": [{"month": null, "agent": "claude", "model": "claude-sonnet-5", "token_kind": "output", "tokens": 1000, "priced_tokens": 1000, "unpriced_tokens": 0, "estimated_cost_usd": 0.5, "credits": 0, "pricing_status": "priced"}], "totals": {"tokens": 1000, "priced_tokens": 1000, "unpriced_tokens": 0, "estimated_cost_usd": 0.5, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "conflicting_duplicate_groups": 0, "missing_dedup_identity_rows": 0, "source_quality": {"identity_missing": 0}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function rawOverlay(specDir: string, intentId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(doneOverlayPath(specDir, intentId), "utf-8"));
}

describe("rework classification (合意 §B3)", () => {
  let specDir: string;
  let binDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-rework-spec-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-rework-bin-"));
    process.env.LANE_DATA_DIR = mkdtempSync(join(tmpdir(), "lane-rework-data-"));
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` stringifies to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  describe("advance --phase 5_done --rework-*", () => {
    const intentId = "I-2026-10-16-rework-advance";

    it("writes rework_classification into the new overlay", () => {
      advanceToVerify(specDir, intentId);
      const result = runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: MERGED_AT,
        rework: {
          status: "classified",
          origin: "spec_gap",
          detectedAt: "4_verify",
          evidence: CLASSIFIED.evidence_ref as string,
          factors: ["scope_ambiguity"],
        },
      });
      expect(result.exitCode, result.message).toBe(0);
      expect(readDoneOverlay(specDir, intentId)?.rework_classification).toEqual(CLASSIFIED);
    });

    it("unclassified gets an explicit evidence_ref null", () => {
      advanceToVerify(specDir, intentId);
      const result = runAdvance(intentId, "5_done", {
        specDir,
        mergedAt: MERGED_AT,
        rework: { status: "unclassified", origin: "unknown", detectedAt: "unknown", reason: "n/a" },
      });
      expect(result.exitCode, result.message).toBe(0);
      const rc = rawOverlay(specDir, intentId).rework_classification as Record<string, unknown>;
      expect(rc).toHaveProperty("evidence_ref", null);
      expect(rc.unclassified_reason).toBe("n/a");
    });

    it("without rework flags, the overlay has no rework_classification key at all", () => {
      advanceToVerify(specDir, intentId);
      expect(runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT }).exitCode).toBe(0);
      expect(rawOverlay(specDir, intentId)).not.toHaveProperty("rework_classification");
    });

    it.each([
      ["status missing", { origin: "spec_gap", detectedAt: "4_verify", evidence: "PR#1" }],
      [
        "classified without evidence",
        { status: "classified", origin: "spec_gap", detectedAt: "4_verify" },
      ],
      [
        "unclassified without reason",
        { status: "unclassified", origin: "unknown", detectedAt: "unknown" },
      ],
      [
        "unknown detection stage",
        { status: "classified", origin: "spec_gap", detectedAt: "6_x", evidence: "PR#1" },
      ],
      [
        "unknown factor",
        {
          status: "unclassified",
          origin: "unknown",
          detectedAt: "unknown",
          reason: "r",
          factors: ["nope"],
        },
      ],
    ])("invalid flags (%s): exit 2, no overlay, lane-state unchanged", (_label, rework) => {
      advanceToVerify(specDir, intentId);
      const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");
      const result = runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT, rework });
      expect(result.exitCode).toBe(2);
      expect(existsSync(doneOverlayPath(specDir, intentId))).toBe(false);
      expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
    });

    it("rework flag on a non-5_done phase: exit 2, nothing written", () => {
      expect(runStart(intentId, { specDir }).exitCode).toBe(0);
      const stateBefore = readFileSync(laneStatePath(specDir, intentId), "utf-8");
      const result = runAdvance(intentId, "2_spec", { specDir, rework: { origin: "spec_gap" } });
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("--phase 5_done");
      expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).toBe(stateBefore);
      expect(existsSync(doneOverlayPath(specDir, intentId))).toBe(false);
    });

    it("an overlay carrying a malformed rework_classification is unreadable: advance fails closed", () => {
      advanceToVerify(specDir, intentId);
      expect(runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT }).exitCode).toBe(0);
      const path = doneOverlayPath(specDir, intentId);
      writeFileSync(
        path,
        JSON.stringify({
          ...rawOverlay(specDir, intentId),
          rework_classification: { ...CLASSIFIED, evidence_ref: null },
        }),
      );
      expect(readDoneOverlay(specDir, intentId)).toBeNull();
      const result = runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT });
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("unreadable");
    });
  });

  describe("old-format overlay (no rework_classification) stays readable", () => {
    const intentId = "I-2026-10-16-rework-legacy";

    beforeEach(() => {
      advanceToVerify(specDir, intentId);
      expect(runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT }).exitCode).toBe(0);
      expect(rawOverlay(specDir, intentId)).not.toHaveProperty("rework_classification");
    });

    it("advance reads it as done (not unreadable)", () => {
      const result = runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT });
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("already 5_done");
    });

    it("status shows 5_done", () => {
      const result = runStatus(intentId, { specDir });
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain("5_done");
    });

    it("calibrate succeeds", async () => {
      const result = await runCalibrate(intentId, {
        specDir,
        sessionIds: ["sess-legacy"],
        agentCostBin: writeFakeAgentCost(binDir, "sess-legacy"),
      });
      expect(result.exitCode, result.message).toBe(0);
    });

    it("usage-import succeeds", async () => {
      const repoDir = mkdtempSync(join(tmpdir(), "lane-rework-repo-"));
      runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
      runWorkBind(intentId, {
        specDir,
        sessionId: "sess-legacy-ui",
        agent: "claude",
        cwd: repoDir,
      });
      const result = await runUsageImport(intentId, {
        specDir,
        cwd: repoDir,
        agentCostBin: writeFakeAgentCost(binDir, "sess-legacy-ui"),
      });
      expect(result.exitCode, result.message).toBe(0);
    });
  });

  it("a post-done calibrate rewrite (updateDoneOverlay) preserves rework_classification", async () => {
    const intentId = "I-2026-10-16-rework-calibrate";
    advanceToVerify(specDir, intentId);
    expect(runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT }).exitCode).toBe(0);
    expect(
      runReworkClassify(intentId, {
        specDir,
        status: "classified",
        origin: "spec_gap",
        detectedAt: "4_verify",
        evidence: CLASSIFIED.evidence_ref as string,
        factors: ["scope_ambiguity"],
      }).exitCode,
    ).toBe(0);
    const result = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["sess-cal"],
      agentCostBin: writeFakeAgentCost(binDir, "sess-cal"),
    });
    expect(result.exitCode, result.message).toBe(0);
    const overlay = readDoneOverlay(specDir, intentId);
    expect(overlay?.ledger_delta.length).toBeGreaterThan(0);
    expect(overlay?.rework_classification).toEqual(CLASSIFIED);
  });

  describe("lane rework-classify", () => {
    const intentId = "I-2026-10-16-rework-classify";
    const postRelease = {
      status: "classified",
      origin: "implementation_defect",
      detectedAt: "post_release",
      evidence: "https://github.com/octo-org/spec-lane-demo/issues/99",
    };

    it("records a post_release classification on an existing overlay", () => {
      advanceToVerify(specDir, intentId);
      expect(runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT }).exitCode).toBe(0);
      const result = runReworkClassify(intentId, { specDir, ...postRelease });
      expect(result.exitCode, result.message).toBe(0);
      expect(readDoneOverlay(specDir, intentId)?.rework_classification).toEqual({
        classification_status: "classified",
        origin: "implementation_defect",
        detection_stage: "post_release",
        evidence_ref: postRelease.evidence,
      });
    });

    it("second application: exit 3, overlay bytes unchanged", () => {
      advanceToVerify(specDir, intentId);
      expect(runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT }).exitCode).toBe(0);
      expect(runReworkClassify(intentId, { specDir, ...postRelease }).exitCode).toBe(0);
      const before = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
      const result = runReworkClassify(intentId, {
        specDir,
        status: "unclassified",
        origin: "unknown",
        detectedAt: "unknown",
        reason: "trying to overwrite",
      });
      expect(result.exitCode).toBe(3);
      expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(before);
    });

    it("classification recorded at advance time also blocks rework-classify (exit 3, bytes unchanged)", () => {
      advanceToVerify(specDir, intentId);
      expect(
        runAdvance(intentId, "5_done", {
          specDir,
          mergedAt: MERGED_AT,
          rework: { status: "unclassified", origin: "unknown", detectedAt: "unknown", reason: "r" },
        }).exitCode,
      ).toBe(0);
      const before = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
      expect(runReworkClassify(intentId, { specDir, ...postRelease }).exitCode).toBe(3);
      expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(before);
    });

    it("core setReworkClassification throws ReworkClassificationExistsError on a second call", () => {
      advanceToVerify(specDir, intentId);
      expect(runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT }).exitCode).toBe(0);
      setReworkClassification(specDir, intentId, CLASSIFIED, "0.12.1");
      expect(() => setReworkClassification(specDir, intentId, CLASSIFIED, "0.12.1")).toThrow(
        ReworkClassificationExistsError,
      );
    });

    it("no overlay: exit 3, nothing created", () => {
      advanceToVerify(specDir, intentId);
      const result = runReworkClassify(intentId, { specDir, ...postRelease });
      expect(result.exitCode).toBe(3);
      expect(existsSync(doneOverlayPath(specDir, intentId))).toBe(false);
    });

    it("schema violation (classified + --reason): exit 2, overlay bytes unchanged", () => {
      advanceToVerify(specDir, intentId);
      expect(runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT }).exitCode).toBe(0);
      const before = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
      const result = runReworkClassify(intentId, { specDir, ...postRelease, reason: "x" });
      expect(result.exitCode).toBe(2);
      expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(before);
    });

    it("broken overlay: same fail-closed exit (2) as calibrate, bytes unchanged", () => {
      advanceToVerify(specDir, intentId);
      expect(runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT }).exitCode).toBe(0);
      const path = doneOverlayPath(specDir, intentId);
      writeFileSync(
        path,
        JSON.stringify({ ...rawOverlay(specDir, intentId), schema_version: "9.9" }),
      );
      const before = readFileSync(path, "utf-8");
      const result = runReworkClassify(intentId, { specDir, ...postRelease });
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("unreadable");
      expect(result.message).toContain("nothing was recorded");
      expect(readFileSync(path, "utf-8")).toBe(before);
    });

    it("overlay written by a newer binary: same version-guard exit (2) as calibrate, bytes unchanged", () => {
      advanceToVerify(specDir, intentId);
      expect(
        runAdvance(intentId, "5_done", { specDir, mergedAt: MERGED_AT, toolVersion: "5.0.0" })
          .exitCode,
      ).toBe(0);
      const before = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
      const result = runReworkClassify(intentId, { specDir, ...postRelease, toolVersion: "1.0.0" });
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("refusing to write");
      expect(result.message).toContain("nothing was recorded");
      expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(before);
    });
  });

  describe("Goodhart: classification never reaches emit-metrics / export-evidence", () => {
    const intentId = "I-2026-10-16-rework-goodhart";
    const FORBIDDEN = ["rework_classification", "origin", "detection_stage"];

    beforeEach(() => {
      advanceToVerify(specDir, intentId);
      expect(
        runAdvance(intentId, "5_done", {
          specDir,
          mergedAt: MERGED_AT,
          rework: {
            status: "classified",
            origin: "spec_gap",
            detectedAt: "4_verify",
            evidence: CLASSIFIED.evidence_ref as string,
          },
        }).exitCode,
      ).toBe(0);
      expect(readDoneOverlay(specDir, intentId)?.rework_classification).toBeDefined();
    });

    it("export-evidence output contains none of the classification strings", () => {
      const result = runEvidenceExport(intentId, { specDir });
      expect(result.exitCode, result.message).toBe(0);
      for (const s of FORBIDDEN) expect(result.message).not.toContain(s);
    });

    it("emit-metrics output (marker and decoded payload JSON) contains none of them", async () => {
      const result = await runEmitMetrics(intentId, {
        specDir,
        repository: "octo-org/spec-lane-demo",
        emitterVersion: "0.12.1",
      });
      expect(result.exitCode, result.message).toBe(0);
      const m = result.message.match(/payload_b64=(\S+)/);
      expect(m).not.toBeNull();
      const decoded = Buffer.from(m?.[1] as string, "base64").toString("utf-8");
      JSON.parse(decoded);
      for (const s of FORBIDDEN) {
        expect(result.message).not.toContain(s);
        expect(decoded).not.toContain(s);
      }
    });
  });
});

// argv plumbing through main.ts's real commander definitions (same convention as
// cli-argv-basis-flags.test.ts): skipped when dist/main.js hasn't been built.
const distMainPath = join(__dirname, "..", "dist", "main.js");
const describeOrSkip = existsSync(distMainPath) ? describe : describe.skip;

describeOrSkip("rework flags via the built CLI", () => {
  let specDir: string;
  let dataDir: string;
  const intentId = "I-2026-10-16-rework-argv";

  function lane(args: string[]): { status: number; stderr: string } {
    try {
      execFileSync(process.execPath, [distMainPath, ...args], {
        env: { ...process.env, LANE_DATA_DIR: dataDir },
        stdio: "pipe",
      });
      return { status: 0, stderr: "" };
    } catch (err) {
      const e = err as { status: number; stderr: Buffer };
      return { status: e.status, stderr: e.stderr.toString() };
    }
  }

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-rework-argv-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-rework-argv-data-"));
    process.env.LANE_DATA_DIR = dataDir;
    advanceToVerify(specDir, intentId);
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `= undefined` stringifies to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  it("advance with an incomplete rework flag set exits 2 and writes no overlay", () => {
    const r = lane([
      "advance",
      intentId,
      "--phase",
      "5_done",
      "--spec-dir",
      specDir,
      "--merged-at",
      MERGED_AT,
      "--rework-origin",
      "spec_gap",
    ]);
    expect(r.status).toBe(2);
    expect(existsSync(doneOverlayPath(specDir, intentId))).toBe(false);
  });

  it("advance flags and rework-classify reach the overlay; a second rework-classify exits 3", () => {
    const base = ["--spec-dir", specDir];
    expect(
      lane([
        "advance",
        intentId,
        "--phase",
        "5_done",
        ...base,
        "--merged-at",
        MERGED_AT,
        "--rework-status",
        "unclassified",
        "--rework-origin",
        "unknown",
        "--rework-detected-at",
        "unknown",
        "--rework-reason",
        "not triaged yet",
        "--rework-factor",
        "test_missing",
        "--rework-factor",
        "scope_ambiguity",
      ]).status,
    ).toBe(0);
    expect(readDoneOverlay(specDir, intentId)?.rework_classification).toEqual({
      classification_status: "unclassified",
      origin: "unknown",
      detection_stage: "unknown",
      evidence_ref: null,
      unclassified_reason: "not triaged yet",
      contributing_factors: ["test_missing", "scope_ambiguity"],
    });
    const r = lane([
      "rework-classify",
      intentId,
      ...base,
      "--status",
      "classified",
      "--origin",
      "review_miss",
      "--detected-at",
      "post_release",
      "--evidence",
      "issue#1",
    ]);
    expect(r.status).toBe(3);
  });

  it("rework-classify with a missing flag exits 2 (not commander's 1)", () => {
    expect(
      lane([
        "advance",
        intentId,
        "--phase",
        "5_done",
        "--spec-dir",
        specDir,
        "--merged-at",
        MERGED_AT,
      ]).status,
    ).toBe(0);
    const r = lane(["rework-classify", intentId, "--spec-dir", specDir, "--status", "classified"]);
    expect(r.status).toBe(2);
    expect(readDoneOverlay(specDir, intentId)?.rework_classification).toBeUndefined();
  });
});
