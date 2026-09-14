import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentCostMeasureResultSchema } from "../src/agent-cost.js";

// I-2026-09-10-agent-cost-v2-basis-gate — TEST-01/02, RULE-01/02, D1.
// `AgentCostMeasureResultSchema` is a plain `z.object()` (zod's default: strip unknown
// keys, not passthrough), so an undeclared field is silently dropped rather than
// rejected. These tests pin that the five new values are *declared* (survive parsing),
// against the real captured 0.2.0 payload named by spec.md's "Falsification conditions"
// (F1/F2 cleared 2026-09-11) rather than a hand-written shape.
const __dirname = dirname(fileURLToPath(import.meta.url));
const realMeasure020: unknown = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "measure-0.2.0-real-8b283624.json"), "utf-8"),
);

describe("AgentCostMeasureResultSchema — RULE-01/02 (D1)", () => {
  it("TEST-01 (spec.md:299-302, 873): a 0.2.0 payload parses and the five new values are present, not stripped", () => {
    const result = AgentCostMeasureResultSchema.safeParse(realMeasure020);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Top-level: producer_version/accounting_basis (RULE-01).
    expect(result.data.producer_version).toBe("0.2.0");
    expect(result.data.accounting_basis).toBe("agent-cost-raw-total/v2");
    // data_quality: the three new counters (RULE-01) — the captured fixture's values,
    // not hand-written ones (spec.md:962-971 "Falsification conditions").
    expect(result.data.data_quality.duplicate_rows_skipped).toBe(195);
    expect(result.data.data_quality.conflicting_duplicate_groups).toBe(0);
    expect(result.data.data_quality.missing_dedup_identity_rows).toBe(0);
  });

  it("TEST-03 (spec.md:875): data_quality.source_quality.identity_missing survives parsing (pre-existing z.record)", () => {
    const result = AgentCostMeasureResultSchema.safeParse(realMeasure020);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.data_quality.source_quality.identity_missing).toBe(0);
  });

  it("TEST-02 (spec.md:304, 874): a 0.1.x payload with none of the five new fields still validates; values read back undefined", () => {
    // Same real shape, with every RULE-01 field this lane added removed — the honest
    // 0.1.x case RULE-02 exists for (agent-cost before 0.2.0 emitted none of these).
    const cloned = JSON.parse(JSON.stringify(realMeasure020)) as Record<string, unknown>;
    const {
      producer_version: _producerVersion,
      accounting_basis: _accountingBasis,
      ...rest
    } = cloned;
    const {
      duplicate_rows_skipped: _duplicateRowsSkipped,
      conflicting_duplicate_groups: _conflictingDuplicateGroups,
      missing_dedup_identity_rows: _missingDedupIdentityRows,
      ...restDataQuality
    } = cloned.data_quality as Record<string, unknown>;
    const payload = { ...rest, data_quality: restDataQuality };

    const result = AgentCostMeasureResultSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.producer_version).toBeUndefined();
    expect(result.data.accounting_basis).toBeUndefined();
    expect(result.data.data_quality.duplicate_rows_skipped).toBeUndefined();
    expect(result.data.data_quality.conflicting_duplicate_groups).toBeUndefined();
    expect(result.data.data_quality.missing_dedup_identity_rows).toBeUndefined();
  });

  it("RULE-07 negation groundwork: a present-but-negative counter is not rejected here (RULE-07 classifies it, this schema does not)", () => {
    // spec.md:93-98 (D1 comment in agent-cost.ts) — `.int().nonnegative()` is
    // deliberately NOT applied to the three new counters, so an out-of-range value
    // reaches core's RULE-07 predicate instead of being rejected at the schema
    // boundary. This is a schema-boundary contract test, not RULE-07 itself (that is
    // core's `deriveKnnIneligibility`, out of this package's scope).
    const payload = JSON.parse(JSON.stringify(realMeasure020)) as Record<string, unknown>;
    (payload.data_quality as Record<string, unknown>).conflicting_duplicate_groups = -1;
    const result = AgentCostMeasureResultSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
