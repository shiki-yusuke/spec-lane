import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry, Verification } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runConsensus } from "../src/commands/consensus.js";
import { runEvidenceExport } from "../src/commands/evidence-export.js";
import { runStart } from "../src/commands/start.js";
import { readIntent, writeIntent } from "../src/intent-store.js";
import { writeSpecMd } from "../src/spec-store.js";
import { readLaneState, writeLaneState } from "../src/state-store.js";
import { writeVerification } from "../src/verification-store.js";

// I-2026-09-10-agent-cost-v2-basis-gate (RULE-35) -- a minimal, schema-valid scope="lane"
// ledger entry, included_in_kpi by default (summarizeLedger only sums included entries,
// per spec.md's own "the normalized bases of the summed entries" wording), for exercising
// the evidence-export ledger summary's accounting_bases/accounting_basis_status fields
// directly, without needing a real usage-import/calibrate call.
function makeLedgerEntry(
  overrides: Partial<LedgerEntry> & { ledger_entry_id: string },
): LedgerEntry {
  return {
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

  // issue #46 — a lane that finished via the local done overlay stays `4_verify` in-repo
  // by design (design.md §3.6); evidence-export must go through the same overlay-applied
  // effective view status/list/stats already use, and surface the 5_done-time audit
  // records (effective_risk_log's own entry) that never reach in-repo state at all.
  it("a lane done via the local overlay reports the effective 5_done phase and its state_delta", () => {
    runStart(intentId, { specDir });

    const started = readIntent(specDir, intentId);
    writeIntent(specDir, intentId, {
      ...started,
      premise_evidence: {
        required: true,
        method: "live",
        reproduced: true,
        evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
      },
    });
    runAdvance(intentId, "2_spec", { specDir });
    runAdvance(intentId, "3_implement", { specDir });

    const verification: Verification = {
      schema_version: "1.0",
      intent_id: intentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
      success_criteria_matrix: [
        {
          criterion: started.intent.success[0] ?? "ok",
          covered_by: "test",
          evidence: "Rule 1 unit test covers this.",
        },
      ],
    };
    writeVerification(specDir, intentId, verification);
    runAdvance(intentId, "4_verify", { specDir });

    writeSpecMd(specDir, intentId, "# Spec\n\nRule 1: does the thing.\n");
    runConsensus(intentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" });
    runConsensus(intentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } });

    const advanced = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-24T10:00:00+09:00",
    });
    expect(advanced.exitCode).toBe(0);
    // Sanity: the in-repo file really did stay at 4_verify (issue #46's own fix).
    expect(readLaneState(specDir, intentId).current_phase).toBe("4_verify");

    const result = runEvidenceExport(intentId, { specDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.message);

    expect(parsed.current_phase).toBe("5_done");
    expect(parsed.artifacts.done_overlay).not.toBeNull();
    expect(parsed.artifacts.state_delta).not.toBeNull();
    expect(parsed.artifacts.state_delta.effective_risk_log.length).toBeGreaterThan(0);
    expect(parsed.artifacts.state_delta.ruleset_migrations).toEqual([]);
    expect(parsed.artifacts.state_delta.weakening_acknowledgements).toEqual([]);
  });

  // Architect review follow-up (issue #46) — the previous test above only exercised the
  // always-present effective_risk_log entry; R5 (--ack-ruleset-migration) and R8
  // (--weakening-rationale) are conditional on the lane hitting the matching gate finding,
  // so they need their own scenarios (mirrors
  // packages/cli/test/done-overlay-no-in-repo-write.test.ts's own setup for the same two
  // findings) to prove those records actually reach the export output too, not just the
  // done overlay's state_delta.
  it("surfaces the R5 ruleset_migrations entry and gate_ruleset_version through evidence-export", () => {
    const migrationIntentId = "I-2026-09-24-evidence-export-r5";
    runStart(migrationIntentId, { specDir });

    const started = readIntent(specDir, migrationIntentId);
    writeIntent(specDir, migrationIntentId, {
      ...started,
      premise_evidence: {
        required: true,
        method: "live",
        reproduced: true,
        evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
      },
    });
    runAdvance(migrationIntentId, "2_spec", { specDir });
    runAdvance(migrationIntentId, "3_implement", { specDir });

    const verification: Verification = {
      schema_version: "1.0",
      intent_id: migrationIntentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
      success_criteria_matrix: [
        {
          criterion: started.intent.success[0] ?? "ok",
          covered_by: "test",
          evidence: "Rule 1 unit test covers this.",
        },
      ],
    };
    writeVerification(specDir, migrationIntentId, verification);
    runAdvance(migrationIntentId, "4_verify", { specDir });

    writeSpecMd(specDir, migrationIntentId, "# Spec\n\nRule 1: does the thing.\n");
    runConsensus(migrationIntentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" });
    runConsensus(migrationIntentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } });

    // Simulate a lane recorded under a stale gate_ruleset_version, as if started before
    // the installed binary's CURRENT_GATE_RULESET_VERSION ("1.0") moved on.
    const staleState = readLaneState(specDir, migrationIntentId);
    writeLaneState(specDir, migrationIntentId, { ...staleState, gate_ruleset_version: "0.9" });

    const advanced = runAdvance(migrationIntentId, "5_done", {
      specDir,
      mergedAt: "2026-09-24T10:00:00+09:00",
      ackRulesetMigration: true,
    });
    expect(advanced.exitCode).toBe(0);

    const result = runEvidenceExport(migrationIntentId, { specDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.message);

    expect(parsed.artifacts.state_delta).not.toBeNull();
    expect(parsed.artifacts.state_delta.gate_ruleset_version).toBe("1.0");
    expect(parsed.artifacts.state_delta.ruleset_migrations).toHaveLength(1);
    expect(parsed.artifacts.state_delta.ruleset_migrations[0]).toMatchObject({
      from: "0.9",
      to: "1.0",
    });
  });

  it("surfaces the R8 weakening_acknowledgements entry through evidence-export", () => {
    const weakeningIntentId = "I-2026-09-24-evidence-export-r8";
    runStart(weakeningIntentId, { specDir });

    const started = readIntent(specDir, weakeningIntentId);
    writeIntent(specDir, weakeningIntentId, {
      ...started,
      premise_evidence: {
        required: true,
        method: "live",
        reproduced: true,
        evidence: "Ran the reported repro steps against a live checkout and observed the bug.",
      },
    });
    runAdvance(weakeningIntentId, "2_spec", { specDir });
    runAdvance(weakeningIntentId, "3_implement", { specDir });

    const verification: Verification = {
      schema_version: "1.0",
      intent_id: weakeningIntentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
      success_criteria_matrix: [
        {
          criterion: started.intent.success[0] ?? "ok",
          covered_by: "test",
          evidence: "Rule 1 unit test covers this.",
        },
      ],
    };
    writeVerification(specDir, weakeningIntentId, verification);
    runAdvance(weakeningIntentId, "4_verify", { specDir });

    writeSpecMd(specDir, weakeningIntentId, "# Spec\n\nRule 1: does the thing.\n");
    runConsensus(weakeningIntentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" });
    runConsensus(weakeningIntentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } });

    // Still passes premiseEvidenceGate outright (method is valid, reproduced stays true --
    // only a "weak_evidence" warning), but promotionWeakeningGate's own strength table
    // treats live -> code-only as a genuine downgrade, requiring --weakening-rationale.
    const preDone = readIntent(specDir, weakeningIntentId);
    writeIntent(specDir, weakeningIntentId, {
      ...preDone,
      premise_evidence: {
        required: true,
        method: "code-only",
        reproduced: true,
        evidence: "Re-derived from a static read of the code rather than a fresh live repro.",
      },
    });

    const advanced = runAdvance(weakeningIntentId, "5_done", {
      specDir,
      mergedAt: "2026-09-24T10:00:00+09:00",
      weakeningRationale: "Live repro unavailable post-merge; telemetry re-derivation is adequate.",
    });
    expect(advanced.exitCode).toBe(0);

    const result = runEvidenceExport(weakeningIntentId, { specDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.message);

    expect(parsed.artifacts.state_delta).not.toBeNull();
    expect(parsed.artifacts.state_delta.weakening_acknowledgements).toHaveLength(1);
    expect(parsed.artifacts.state_delta.weakening_acknowledgements[0]).toMatchObject({
      rationale: "Live repro unavailable post-merge; telemetry re-derivation is adequate.",
    });
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
