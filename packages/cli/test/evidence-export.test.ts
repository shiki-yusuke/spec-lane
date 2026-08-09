import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runEvidenceExport } from "../src/commands/evidence-export.js";
import { runStart } from "../src/commands/start.js";

// M0 spec-lane 0.5.0 — `lane evidence export`, direct (no subprocess) CLI-command tests.

describe("runEvidenceExport", () => {
  let specDir: string;
  let dataDir: string;
  const intentId = "I-2026-08-09-evidence-export";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-evidence-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-evidence-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("fails closed on a nonexistent intent", () => {
    const result = runEvidenceExport("I-2026-08-09-does-not-exist", { specDir });
    expect(result.exitCode).toBe(2);
  });

  it("rejects an unsupported --format", () => {
    runStart(intentId, { specDir });
    const result = runEvidenceExport(intentId, { specDir, format: "lane-evidence:v2" });
    expect(result.exitCode).toBe(1);
  });

  it("exports a schema-conformant bundle for a freshly started lane (no spec/verification yet)", () => {
    runStart(intentId, { specDir });
    const result = runEvidenceExport(intentId, { specDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.message);
    expect(parsed.schema_version).toBe("lane-evidence:v1");
    expect(parsed.intent_id).toBe(intentId);
    expect(parsed.current_phase).toBe("1_intent");
    expect(parsed.artifacts.intent.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.artifacts.spec).toBeNull();
    expect(parsed.artifacts.verification).toBeNull();
    expect(parsed.artifacts.done_overlay).toBeNull();
    expect(parsed.artifacts.ledger_summary).toEqual({
      entry_count: 0,
      included_in_kpi_count: 0,
      total_tokens: null,
      total_cost_usd: null,
      sources: [],
    });
  });

  it("reflects a later phase's current_phase once advanced", () => {
    runStart(intentId, { specDir });
    runAdvance(intentId, "2_spec", { specDir });
    const result = runEvidenceExport(intentId, { specDir });
    const parsed = JSON.parse(result.message);
    expect(parsed.current_phase).toBe("2_spec");
  });
});
