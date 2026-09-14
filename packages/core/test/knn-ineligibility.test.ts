import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_ACCOUNTING_BASIS } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import type { DeriveKnnIneligibilityInput } from "../src/application/calibrate-service.js";
import { deriveKnnIneligibility } from "../src/application/calibrate-service.js";
import type { AttributionProjection, SessionAttributionDetail } from "../src/attribution.js";

// I-2026-09-10-agent-cost-v2-basis-gate — deriveKnnIneligibility (D6, RULE-05..12,
// RULE-39/D27's detail-string templates). Expected reason codes/strings are taken
// verbatim from spec.md's "Detail string templates" table (T-1..T-11) and its Requirements
// (RULE-06/07/09/10/39), never copied from calibrate-service.ts's implementation.

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/basis-gate");
const realMeasurePayload = JSON.parse(
  readFileSync(join(fixturesDir, "measure-0.2.0-real-8b283624.json"), "utf-8"),
) as {
  accounting_basis: string;
  producer_version: string;
  session_ids: string[];
  data_quality: {
    conflicting_duplicate_groups: number;
    missing_dedup_identity_rows: number;
    source_quality: Record<string, number>;
  };
};

const CLEAN_DATA_QUALITY = {
  conflicting_duplicate_groups: 0,
  missing_dedup_identity_rows: 0,
  source_quality: { identity_missing: 0 },
};

/** A stub AttributionProjection whose classify()/describe() answers come from a fixed
 * map -- lets each test pin one session's attribution state without building a trace
 * ledger (D7's projection is reused, never re-derived, so the predicate under test must
 * only ever consult it through this interface). */
function stubAttribution(states: Record<string, SessionAttributionDetail>): AttributionProjection {
  return {
    classify: (sessionId: string) => states[sessionId]?.state ?? "never_imported",
    describe: (sessionId: string) => states[sessionId] ?? { state: "never_imported" },
  };
}

const exactlyAttributed = stubAttribution({});
function exactlyAttributedAll(sessionIds: readonly string[]): AttributionProjection {
  const states: Record<string, SessionAttributionDetail> = {};
  for (const id of sessionIds) states[id] = { state: "exactly_attributed" };
  return stubAttribution(states);
}

describe("deriveKnnIneligibility (D6, RULE-05..12, RULE-39/D27)", () => {
  // TEST-06 / S2: current basis, clean counters, exactly-attributed sessions -> reasons [].
  it("returns empty reasons for the real 0.2.0 payload with all sessions exactly attributed", () => {
    const result = deriveKnnIneligibility({
      measurement: {
        accounting_basis: realMeasurePayload.accounting_basis,
        data_quality: realMeasurePayload.data_quality,
      },
      sessionIds: realMeasurePayload.session_ids,
      attribution: exactlyAttributedAll(realMeasurePayload.session_ids),
    });
    expect(result.reasons).toEqual([]);
    expect(result.detail).toEqual([]);
  });

  // RULE-06 / T-1: the payload declared no basis at all.
  it("flags TOKEN_BASIS_MISMATCH with the T-1 template when accounting_basis is absent", () => {
    const result = deriveKnnIneligibility({
      measurement: { data_quality: CLEAN_DATA_QUALITY },
      sessionIds: [],
      attribution: exactlyAttributed,
    });
    expect(result.reasons).toEqual(["TOKEN_BASIS_MISMATCH"]);
    expect(result.detail).toEqual([
      `accounting basis is "unknown" (the measurement declared none); the current basis is "${CURRENT_ACCOUNTING_BASIS}"`,
    ]);
  });

  // RULE-06 / T-2: the payload declared a basis that is not the current one.
  it("flags TOKEN_BASIS_MISMATCH with the T-2 template when accounting_basis differs", () => {
    const result = deriveKnnIneligibility({
      measurement: {
        accounting_basis: "agent-cost-raw-total/v1",
        data_quality: CLEAN_DATA_QUALITY,
      },
      sessionIds: [],
      attribution: exactlyAttributed,
    });
    expect(result.reasons).toEqual(["TOKEN_BASIS_MISMATCH"]);
    expect(result.detail).toEqual([
      `accounting basis "agent-cost-raw-total/v1" is not the current basis "${CURRENT_ACCOUNTING_BASIS}"`,
    ]);
  });

  // RULE-07 / TEST-09: conflicting_duplicate_groups > 0 -> T-3.
  it("flags MIXED_OR_UNATTRIBUTED_USAGE with T-3 when conflicting_duplicate_groups is non-zero (TEST-09)", () => {
    const result = deriveKnnIneligibility({
      measurement: {
        accounting_basis: CURRENT_ACCOUNTING_BASIS,
        data_quality: {
          conflicting_duplicate_groups: 3,
          missing_dedup_identity_rows: 0,
          source_quality: { identity_missing: 0 },
        },
      },
      sessionIds: [],
      attribution: exactlyAttributed,
    });
    expect(result.reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(result.detail).toEqual(["data_quality.conflicting_duplicate_groups is 3, expected 0"]);
  });

  // RULE-07 / TEST-10: missing_dedup_identity_rows > 0 -> T-3.
  it("flags MIXED_OR_UNATTRIBUTED_USAGE with T-3 when missing_dedup_identity_rows is non-zero (TEST-10)", () => {
    const result = deriveKnnIneligibility({
      measurement: {
        accounting_basis: CURRENT_ACCOUNTING_BASIS,
        data_quality: {
          conflicting_duplicate_groups: 0,
          missing_dedup_identity_rows: 2,
          source_quality: { identity_missing: 0 },
        },
      },
      sessionIds: [],
      attribution: exactlyAttributed,
    });
    expect(result.reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(result.detail).toEqual(["data_quality.missing_dedup_identity_rows is 2, expected 0"]);
  });

  // RULE-07 / TEST-11: source_quality.identity_missing > 0 -> T-3.
  it("flags MIXED_OR_UNATTRIBUTED_USAGE with T-3 when source_quality.identity_missing is non-zero (TEST-11)", () => {
    const result = deriveKnnIneligibility({
      measurement: {
        accounting_basis: CURRENT_ACCOUNTING_BASIS,
        data_quality: {
          conflicting_duplicate_groups: 0,
          missing_dedup_identity_rows: 0,
          source_quality: { identity_missing: 1 },
        },
      },
      sessionIds: [],
      attribution: exactlyAttributed,
    });
    expect(result.reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(result.detail).toEqual([
      "data_quality.source_quality.identity_missing is 1, expected 0",
    ]);
  });

  // RULE-07 negation / TEST-46: a counter absent (not an explicit 0) -> T-4.
  it("flags MIXED_OR_UNATTRIBUTED_USAGE with T-4 when conflicting_duplicate_groups is absent", () => {
    const result = deriveKnnIneligibility({
      measurement: {
        accounting_basis: CURRENT_ACCOUNTING_BASIS,
        data_quality: { missing_dedup_identity_rows: 0, source_quality: { identity_missing: 0 } },
      },
      sessionIds: [],
      attribution: exactlyAttributed,
    });
    expect(result.reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(result.detail).toEqual([
      "data_quality.conflicting_duplicate_groups is absent; an explicit 0 is required",
    ]);
  });

  // RULE-07 negation / TEST-47: negative, fractional and non-finite values each -> T-5.
  for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`flags MIXED_OR_UNATTRIBUTED_USAGE with T-5 when missing_dedup_identity_rows is ${value} (TEST-47)`, () => {
      const result = deriveKnnIneligibility({
        measurement: {
          accounting_basis: CURRENT_ACCOUNTING_BASIS,
          data_quality: {
            conflicting_duplicate_groups: 0,
            missing_dedup_identity_rows: value,
            source_quality: { identity_missing: 0 },
          },
        },
        sessionIds: [],
        attribution: exactlyAttributed,
      });
      expect(result.reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
      expect(result.detail).toEqual([
        "data_quality.missing_dedup_identity_rows is not a finite non-negative integer",
      ]);
    });
  }

  // RULE-08 / TEST-12: duplicate_rows_skipped produces no reason at any value, including absent
  // -- it is not part of DeriveKnnIneligibilityInput.measurement.data_quality at all, so a
  // payload carrying it alongside clean dedup counters must still yield [].
  it("ignores duplicate_rows_skipped entirely (RULE-08)", () => {
    const result = deriveKnnIneligibility({
      measurement: {
        accounting_basis: CURRENT_ACCOUNTING_BASIS,
        data_quality: {
          ...CLEAN_DATA_QUALITY,
          duplicate_rows_skipped: 999,
        } as DeriveKnnIneligibilityInput["measurement"]["data_quality"],
      },
      sessionIds: [],
      attribution: exactlyAttributed,
    });
    expect(result.reasons).toEqual([]);
  });

  // RULE-09 / T-6..T-10: each non-exact attribution state, one session, current basis and
  // clean counters otherwise.
  it("flags T-6 for an unbound session", () => {
    const result = deriveKnnIneligibility({
      measurement: { accounting_basis: CURRENT_ACCOUNTING_BASIS, data_quality: CLEAN_DATA_QUALITY },
      sessionIds: ["s1"],
      attribution: stubAttribution({ s1: { state: "unbound" } }),
    });
    expect(result.reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(result.detail).toEqual([
      "session s1 is unbound (usage recorded, no session_bound event)",
    ]);
  });

  it("flags T-7 for a mixed session, naming its binding count", () => {
    const result = deriveKnnIneligibility({
      measurement: { accounting_basis: CURRENT_ACCOUNTING_BASIS, data_quality: CLEAN_DATA_QUALITY },
      sessionIds: ["s1"],
      attribution: stubAttribution({ s1: { state: "mixed", bindingCount: 3 } }),
    });
    expect(result.detail).toEqual(["session s1 is bound to 3 task_runs"]);
  });

  it("flags T-8 for an orphan_usage session", () => {
    const result = deriveKnnIneligibility({
      measurement: { accounting_basis: CURRENT_ACCOUNTING_BASIS, data_quality: CLEAN_DATA_QUALITY },
      sessionIds: ["s1"],
      attribution: stubAttribution({ s1: { state: "orphan_usage" } }),
    });
    expect(result.detail).toEqual(["session s1 is orphan usage (in the ledger, never bound)"]);
  });

  it("flags T-9 for a measurement_incomplete session, naming its task_run", () => {
    const result = deriveKnnIneligibility({
      measurement: { accounting_basis: CURRENT_ACCOUNTING_BASIS, data_quality: CLEAN_DATA_QUALITY },
      sessionIds: ["s1"],
      attribution: stubAttribution({ s1: { state: "measurement_incomplete", taskRunId: "tr-1" } }),
    });
    expect(result.detail).toEqual(["session s1 is measurement-incomplete for task_run tr-1"]);
  });

  it("flags T-10 for a never_imported session", () => {
    const result = deriveKnnIneligibility({
      measurement: { accounting_basis: CURRENT_ACCOUNTING_BASIS, data_quality: CLEAN_DATA_QUALITY },
      sessionIds: ["s1"],
      attribution: stubAttribution({ s1: { state: "never_imported" } }),
    });
    expect(result.detail).toEqual(["session s1 has never been usage-imported"]);
  });

  // TEST-64 / RULE-39 Ordering: reason-code order (TOKEN_BASIS_MISMATCH before
  // MIXED_OR_UNATTRIBUTED_USAGE per ESTIMATE_V2_REASON_CODES), then within
  // MIXED_OR_UNATTRIBUTED_USAGE: counter templates first in the closed-set order
  // (conflicting_duplicate_groups, missing_dedup_identity_rows, source_quality.identity_missing),
  // then session templates ordered by session_id ascending.
  it("orders reasons by declaration order and detail by counter-then-session-id (TEST-64)", () => {
    const result = deriveKnnIneligibility({
      measurement: {
        accounting_basis: "agent-cost-raw-total/v1",
        data_quality: {
          conflicting_duplicate_groups: 1,
          missing_dedup_identity_rows: 0,
          source_quality: { identity_missing: 2 },
        },
      },
      sessionIds: ["zzz-session", "aaa-session"],
      attribution: stubAttribution({
        "zzz-session": { state: "unbound" },
        "aaa-session": { state: "orphan_usage" },
      }),
    });
    expect(result.reasons).toEqual(["TOKEN_BASIS_MISMATCH", "MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(result.detail).toEqual([
      `accounting basis "agent-cost-raw-total/v1" is not the current basis "${CURRENT_ACCOUNTING_BASIS}"`,
      "data_quality.conflicting_duplicate_groups is 1, expected 0",
      "data_quality.source_quality.identity_missing is 2, expected 0",
      "session aaa-session is orphan usage (in the ledger, never bound)",
      "session zzz-session is unbound (usage recorded, no session_bound event)",
    ]);
  });

  // TEST-55: S2's "any session" -- one exactly-attributed session plus one non-exact
  // session is still enough to make the whole measurement ineligible.
  it("flags MIXED_OR_UNATTRIBUTED_USAGE when one of two sessions is non-exact (TEST-55)", () => {
    const result = deriveKnnIneligibility({
      measurement: { accounting_basis: CURRENT_ACCOUNTING_BASIS, data_quality: CLEAN_DATA_QUALITY },
      sessionIds: ["exact-session", "unbound-session"],
      attribution: stubAttribution({
        "exact-session": { state: "exactly_attributed" },
        "unbound-session": { state: "unbound" },
      }),
    });
    expect(result.reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(result.detail).toEqual([
      "session unbound-session is unbound (usage recorded, no session_bound event)",
    ]);
  });

  // RULE-39/D24: no payload-derived free text besides the (length/charset-bounded)
  // accounting_basis appears in a detail string -- producer_version and every other
  // payload field (rates.catalog_version's sha256, model names, etc.) from the real
  // fixture must not leak into the detail array.
  it("never embeds payload strings other than accounting_basis in a detail (RULE-39)", () => {
    const result = deriveKnnIneligibility({
      measurement: {
        accounting_basis: "agent-cost-raw-total/v1",
        data_quality: realMeasurePayload.data_quality,
      },
      sessionIds: [],
      attribution: exactlyAttributed,
    });
    const joined = result.detail.join("\n");
    expect(joined).not.toContain(realMeasurePayload.producer_version);
    expect(joined).not.toContain("claude-fable-5-1");
    expect(joined).not.toContain(
      "30b0f4a9f133a519533b443db5cbf15f9e5128a1a7d4d3d55c51b78062a077bb",
    );
  });
});
