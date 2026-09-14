import type { LedgerEntry } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { normalizeEntryBasis, planBasisSupersession } from "../src/ledger.js";

// I-2026-09-10-agent-cost-v2-basis-gate — planBasisSupersession/normalizeEntryBasis
// (D10/D11/D20, RULE-16/17/19/32). Expected values are taken from spec.md's Decisions and
// Requirements, not copied from ledger.ts's implementation, except where noted: RULE-17
// names the replaced element's fields as {accounting_basis, producer_version, tokens,
// cost_usd, cost_credits, recorded_at} but LedgerEntry itself has no `recorded_at` field,
// so which existing field supplies it is a genuine gap the spec text leaves open --
// ledger.ts:370 was read to confirm it is `imported_at`, and that mapping is asserted
// below as a documented assumption, not derived from the spec text alone.

function baseEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ledger_entry_id: "phase-1_measure_manual_v1",
    lane_id: "lane-42",
    phase: "2_spec",
    source: "manual",
    scope: "phase",
    session_ids: ["s1"],
    data_state: "has_usage",
    confidence: "manual",
    included_in_kpi: false,
    tokens: 100,
    turns: 1,
    cost_usd: 1,
    cost_credits: null,
    pricing_version: "v1",
    pricing_as_of: null,
    imported_at: "2026-08-01T00:00:00Z",
    since: null,
    until: null,
    agents: null,
    accounting_basis: "agent-cost-raw-total/v2",
    producer_version: "0.2.0",
    ...overrides,
  } as LedgerEntry;
}

describe("planBasisSupersession (D10/D11/RULE-16/17/19)", () => {
  // D10: "no existing entry at all: a plain write (first import)."
  it("writes the incoming entry when there is no existing entry", () => {
    const incoming = baseEntry();
    const plan = planBasisSupersession({ existing: undefined, incoming, supersedeBasis: false });
    expect(plan.action).toBe("write");
    expect(plan.action === "write" && plan.entry).toBe(incoming);
  });

  // RULE-19: a re-import under the same normalized accounting_basis remains a plain
  // idempotent upsert and shall not grow basis_history.
  it("writes a plain upsert with no basis_history when the normalized basis is unchanged", () => {
    const existing = baseEntry({ accounting_basis: "agent-cost-raw-total/v2", tokens: 50 });
    const incoming = baseEntry({ accounting_basis: "agent-cost-raw-total/v2", tokens: 100 });
    const plan = planBasisSupersession({ existing, incoming, supersedeBasis: false });
    expect(plan.action).toBe("write");
    if (plan.action === "write") {
      expect(plan.entry.basis_history).toBeUndefined();
      expect(plan.entry.tokens).toBe(100);
    }
  });

  // RULE-16: a basis conflict without --supersede-basis refuses with a diagnostic naming
  // both normalized accounting_basis values and both producer_version values, and (per
  // D11) performs no write.
  it("refuses on a basis conflict without --supersede-basis, naming both bases and both producer_versions", () => {
    const existing = baseEntry({
      accounting_basis: "agent-cost-raw-total/v1",
      producer_version: "0.1.5",
    });
    const incoming = baseEntry({
      accounting_basis: "agent-cost-raw-total/v2",
      producer_version: "0.2.0",
    });
    const plan = planBasisSupersession({ existing, incoming, supersedeBasis: false });
    expect(plan.action).toBe("refuse");
    if (plan.action === "refuse") {
      expect(plan.diagnostic).toContain("agent-cost-raw-total/v1");
      expect(plan.diagnostic).toContain("agent-cost-raw-total/v2");
      expect(plan.diagnostic).toContain("0.1.5");
      expect(plan.diagnostic).toContain("0.2.0");
    }
  });

  // RULE-17: with --supersede-basis, the new entry is written under the unchanged
  // ledger_entry_id and basis_history gains one element preserving the replaced entry's
  // normalized {accounting_basis, producer_version, tokens, cost_usd, cost_credits,
  // recorded_at}, keeping any pre-existing elements.
  it("writes under the unchanged ledger_entry_id and appends the replaced entry to basis_history with --supersede-basis", () => {
    const existing = baseEntry({
      ledger_entry_id: "phase-1_measure_manual_v1",
      accounting_basis: "agent-cost-raw-total/v1",
      producer_version: "0.1.5",
      tokens: 50,
      cost_usd: 5,
      cost_credits: null,
      imported_at: "2026-08-01T00:00:00Z",
    });
    const incoming = baseEntry({
      ledger_entry_id: "phase-1_measure_manual_v1",
      accounting_basis: "agent-cost-raw-total/v2",
      producer_version: "0.2.0",
      tokens: 100,
    });
    const plan = planBasisSupersession({ existing, incoming, supersedeBasis: true });
    expect(plan.action).toBe("write");
    if (plan.action === "write") {
      expect(plan.entry.ledger_entry_id).toBe("phase-1_measure_manual_v1");
      expect(plan.entry.basis_history).toEqual([
        {
          accounting_basis: "agent-cost-raw-total/v1",
          producer_version: "0.1.5",
          tokens: 50,
          cost_usd: 5,
          cost_credits: null,
          recorded_at: "2026-08-01T00:00:00Z",
        },
      ]);
    }
  });

  it("keeps pre-existing basis_history elements when appending a new one", () => {
    const existing = baseEntry({
      accounting_basis: "agent-cost-raw-total/v1",
      producer_version: "0.1.4",
      basis_history: [
        {
          accounting_basis: "unknown",
          producer_version: null,
          tokens: 10,
          cost_usd: null,
          cost_credits: null,
          recorded_at: "2026-07-01T00:00:00Z",
        },
      ],
    });
    const incoming = baseEntry({
      accounting_basis: "agent-cost-raw-total/v2",
      producer_version: "0.2.0",
    });
    const plan = planBasisSupersession({ existing, incoming, supersedeBasis: true });
    expect(plan.action).toBe("write");
    if (plan.action === "write") {
      expect(plan.entry.basis_history).toHaveLength(2);
      expect(plan.entry.basis_history?.[0]).toEqual({
        accounting_basis: "unknown",
        producer_version: null,
        tokens: 10,
        cost_usd: null,
        cost_credits: null,
        recorded_at: "2026-07-01T00:00:00Z",
      });
    }
  });

  // D20/RULE-32/TEST-54: a genuine pre-change entry with no accounting_basis key at all
  // (never a hand-written "unknown") normalizes to "unknown" and no producer_version key
  // to null, in conflict detection and in basis_history alike.
  it("normalizes a legacy entry with no accounting_basis/producer_version key to unknown/null before comparing (D20/RULE-32, TEST-54)", () => {
    const {
      accounting_basis: _legacyBasis,
      producer_version: _legacyProducerVersion,
      ...legacyRest
    } = baseEntry() as LedgerEntry & {
      accounting_basis?: string;
      producer_version?: string | null;
    };
    const legacyExisting = legacyRest as LedgerEntry;
    const incoming = baseEntry({
      accounting_basis: "agent-cost-raw-total/v2",
      producer_version: "0.2.0",
    });

    const refusalPlan = planBasisSupersession({
      existing: legacyExisting,
      incoming,
      supersedeBasis: false,
    });
    expect(refusalPlan.action).toBe("refuse");
    if (refusalPlan.action === "refuse") {
      expect(refusalPlan.diagnostic).toContain('"unknown"');
    }

    const supersedePlan = planBasisSupersession({
      existing: legacyExisting,
      incoming,
      supersedeBasis: true,
    });
    expect(supersedePlan.action).toBe("write");
    if (supersedePlan.action === "write") {
      expect(supersedePlan.entry.basis_history?.[0]).toMatchObject({
        accounting_basis: "unknown",
        producer_version: null,
      });
    }
  });

  // RULE-19 (idempotency): re-planning under the same basis a second time must not grow
  // basis_history further -- the existing element count is carried forward unchanged.
  it("does not grow basis_history on a second same-basis re-plan (idempotent)", () => {
    const existingWithHistory = baseEntry({
      accounting_basis: "agent-cost-raw-total/v2",
      basis_history: [
        {
          accounting_basis: "agent-cost-raw-total/v1",
          producer_version: "0.1.5",
          tokens: 50,
          cost_usd: 5,
          cost_credits: null,
          recorded_at: "2026-08-01T00:00:00Z",
        },
      ],
    });
    const incoming = baseEntry({ accounting_basis: "agent-cost-raw-total/v2", tokens: 200 });
    const plan = planBasisSupersession({
      existing: existingWithHistory,
      incoming,
      supersedeBasis: false,
    });
    expect(plan.action).toBe("write");
    if (plan.action === "write") {
      expect(plan.entry.basis_history).toHaveLength(1);
      expect(plan.entry.tokens).toBe(200);
    }
  });
});

describe("normalizeEntryBasis (D20/RULE-32)", () => {
  it("normalizes present accounting_basis/producer_version unchanged", () => {
    expect(
      normalizeEntryBasis(
        baseEntry({ accounting_basis: "agent-cost-raw-total/v2", producer_version: "0.2.0" }),
      ),
    ).toEqual({
      accountingBasis: "agent-cost-raw-total/v2",
      producerVersion: "0.2.0",
    });
  });

  it('normalizes a missing accounting_basis key to "unknown" and a missing producer_version key to null', () => {
    const {
      accounting_basis: _legacyBasis,
      producer_version: _legacyProducerVersion,
      ...legacy
    } = baseEntry() as LedgerEntry & {
      accounting_basis?: string;
      producer_version?: string | null;
    };
    expect(normalizeEntryBasis(legacy)).toEqual({
      accountingBasis: "unknown",
      producerVersion: null,
    });
  });

  it("normalizes an undefined entry to unknown/null", () => {
    expect(normalizeEntryBasis(undefined)).toEqual({
      accountingBasis: "unknown",
      producerVersion: null,
    });
  });
});
