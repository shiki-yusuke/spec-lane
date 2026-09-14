import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runEvidenceExport } from "../src/commands/evidence-export.js";
import { runStart } from "../src/commands/start.js";
import { readLaneState, writeLaneState } from "../src/state-store.js";

// I-2026-09-10-agent-cost-v2-basis-gate (RULE-35) -- a minimal, schema-valid scope="lane"
// ledger entry, included_in_kpi by default (summarizeLedger only sums included entries,
// per spec.md's own "the normalized bases of the summed entries" wording), for exercising
// the evidence-export ledger summary's accounting_bases/accounting_basis_status fields
// directly, without needing a real usage-import/calibrate call.
function makeLedgerEntry(
  overrides: Partial<LedgerEntry> & { ledger_entry_id: string },
): LedgerEntry {
  return {
    ledger_entry_id: overrides.ledger_entry_id,
    lane_id: null,
    scope: "lane",
    phase: null,
    source: "manual",
    session_ids: [],
    data_state: "has_usage",
    confidence: "manual",
    included_in_kpi: true,
    tokens: 100,
    turns: null,
    cost_usd: 1,
    cost_credits: null,
    pricing_version: "v1",
    pricing_as_of: "2026-09-14T00:00:00Z",
    imported_at: "2026-09-14T00:00:00Z",
    since: null,
    until: null,
    agents: null,
    ...overrides,
  } as LedgerEntry;
}

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
      // I-2026-09-10-agent-cost-v2-basis-gate (RULE-35) -- "the empty case included": no
      // summed entries at all is "unqualified", not "single".
      accounting_bases: [],
      accounting_basis_status: "unqualified",
    });
  });

  it("reflects a later phase's current_phase once advanced", () => {
    runStart(intentId, { specDir });
    runAdvance(intentId, "2_spec", { specDir });
    const result = runEvidenceExport(intentId, { specDir });
    const parsed = JSON.parse(result.message);
    expect(parsed.current_phase).toBe("2_spec");
  });

  // I-2026-09-10-agent-cost-v2-basis-gate (RULE-35, TEST-69).
  describe("ledger_summary.accounting_bases / accounting_basis_status", () => {
    it("a single-basis ledger reports its one basis and status 'single'", () => {
      runStart(intentId, { specDir });
      const state = readLaneState(specDir, intentId);
      writeLaneState(specDir, intentId, {
        ...state,
        cost_ledger: [
          makeLedgerEntry({ ledger_entry_id: "lc_a", accounting_basis: "agent-cost-raw-total/v2" }),
        ],
      });
      const result = runEvidenceExport(intentId, { specDir });
      const parsed = JSON.parse(result.message);
      expect(parsed.artifacts.ledger_summary.accounting_bases).toEqual(["agent-cost-raw-total/v2"]);
      expect(parsed.artifacts.ledger_summary.accounting_basis_status).toBe("single");
    });

    it("a mixed-basis ledger reports both bases, de-duplicated and lexicographically ascending, status 'unqualified'", () => {
      runStart(intentId, { specDir });
      const state = readLaneState(specDir, intentId);
      writeLaneState(specDir, intentId, {
        ...state,
        cost_ledger: [
          makeLedgerEntry({ ledger_entry_id: "lc_a", accounting_basis: "agent-cost-raw-total/v2" }),
          makeLedgerEntry({ ledger_entry_id: "lc_b", accounting_basis: "unknown" }),
          // duplicate basis value -- must be de-duplicated, not counted twice.
          makeLedgerEntry({ ledger_entry_id: "lc_c", accounting_basis: "agent-cost-raw-total/v2" }),
        ],
      });
      const result = runEvidenceExport(intentId, { specDir });
      const parsed = JSON.parse(result.message);
      // lexicographic ascending: "agent-cost-raw-total/v2" < "unknown"
      expect(parsed.artifacts.ledger_summary.accounting_bases).toEqual([
        "agent-cost-raw-total/v2",
        "unknown",
      ]);
      expect(parsed.artifacts.ledger_summary.accounting_basis_status).toBe("unqualified");
    });

    it("an entry with no accounting_basis key normalizes to 'unknown' in the summary too (D20/RULE-32)", () => {
      runStart(intentId, { specDir });
      const state = readLaneState(specDir, intentId);
      writeLaneState(specDir, intentId, {
        ...state,
        // No accounting_basis key at all on this entry (genuine pre-lane shape) -- distinct
        // from an explicit "unknown" string value.
        cost_ledger: [makeLedgerEntry({ ledger_entry_id: "lc_legacy" })],
      });
      const result = runEvidenceExport(intentId, { specDir });
      const parsed = JSON.parse(result.message);
      expect(parsed.artifacts.ledger_summary.accounting_bases).toEqual(["unknown"]);
      expect(parsed.artifacts.ledger_summary.accounting_basis_status).toBe("single");
    });

    // team-lead review (2026-09-14): included_in_kpi is never a stored value read back
    // as-is -- effectiveLedger() always recomputes it via recomputeIncludedInKpi/
    // deriveIncludedInKpi (core/done-overlay.ts, core/ledger.ts), so writing
    // included_in_kpi:false directly on a fixture entry is overwritten before
    // summarizeLedger ever sees it. A genuinely excluded entry instead needs
    // deriveIncludedInKpi's own exclusion rule: isSuperseded (RULE-22, unchanged by this
    // lane) -- a same-(lane_id, phase, source) entry with an older pricing_version/
    // pricing_as_of than a real-cost-data-state sibling is excluded.
    it("an entry superseded by a newer pricing_version (RULE-22, unchanged) contributes nothing to accounting_bases", () => {
      runStart(intentId, { specDir });
      const state = readLaneState(specDir, intentId);
      writeLaneState(specDir, intentId, {
        ...state,
        cost_ledger: [
          makeLedgerEntry({
            ledger_entry_id: "lc_old",
            source: "manual",
            pricing_version: "v1",
            pricing_as_of: "2026-09-01T00:00:00Z",
            // would show up in accounting_bases if wrongly still included -- distinct from
            // the surviving entry's basis below, so the test would fail loudly, not
            // silently, if isSuperseded's exclusion stopped working.
            accounting_basis: "unknown",
          }),
          makeLedgerEntry({
            ledger_entry_id: "lc_new",
            source: "manual",
            pricing_version: "v2",
            pricing_as_of: "2026-09-14T00:00:00Z",
            accounting_basis: "agent-cost-raw-total/v2",
          }),
        ],
      });
      const result = runEvidenceExport(intentId, { specDir });
      const parsed = JSON.parse(result.message);
      expect(parsed.artifacts.ledger_summary.entry_count).toBe(2);
      // RULE-22/isSuperseded: only the newer-pricing entry counts toward included_in_kpi.
      expect(parsed.artifacts.ledger_summary.included_in_kpi_count).toBe(1);
      expect(parsed.artifacts.ledger_summary.accounting_bases).toEqual(["agent-cost-raw-total/v2"]);
      expect(parsed.artifacts.ledger_summary.accounting_basis_status).toBe("single");
    });
  });
});
