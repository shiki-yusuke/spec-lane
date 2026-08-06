import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCostRow, LedgerEntry } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  AgentMetricsPayloadTooLarge,
  buildAgentMetricsMarker,
  buildCoverage,
  buildTokenUsagePayload,
  decodeAndVerifyAgentMetricsMarker,
  detectAmbiguousSessionAttribution,
  groupLedgerForMetrics,
  parseAgentMetricsMarkerFields,
  tokenUsageRecordsFromRows,
} from "../src/application/metrics-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "agent-metrics", "v1", "fixtures");

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}

function ledgerEntry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    ledger_entry_id: "led-1",
    lane_id: null,
    phase: "3_implement",
    source: "claude_jsonl_auto",
    scope: "phase",
    session_ids: ["sess-1"],
    data_state: "has_usage",
    confidence: "imported_windowed",
    included_in_kpi: true,
    tokens: 100,
    turns: 1,
    cost_usd: 0.0003,
    cost_credits: null,
    pricing_version: "v1",
    pricing_as_of: "2026-08-07T00:00:00Z",
    imported_at: "2026-08-07T00:00:00Z",
    ...overrides,
  };
}

function row(overrides: Partial<AgentCostRow>): AgentCostRow {
  return {
    month: null,
    agent: "claude",
    model: "claude-sonnet-5",
    token_kind: "cache_write_5m",
    tokens: 100,
    priced_tokens: 100,
    unpriced_tokens: 0,
    estimated_cost_usd: 0.0003,
    credits: 0,
    pricing_status: "priced",
    ...overrides,
  };
}

describe("groupLedgerForMetrics", () => {
  it("groups by phase, dedupes session_ids, and excludes non-KPI entries silently", () => {
    const { groups, structuralOmissions } = groupLedgerForMetrics([
      ledgerEntry({ ledger_entry_id: "a", phase: "3_implement", session_ids: ["s1", "s2"] }),
      ledgerEntry({ ledger_entry_id: "b", phase: "3_implement", session_ids: ["s2", "s3"] }),
      ledgerEntry({ ledger_entry_id: "c", phase: "2_spec", session_ids: ["s4"] }),
      ledgerEntry({ ledger_entry_id: "d", included_in_kpi: false }),
    ]);
    expect(structuralOmissions).toHaveLength(0);
    expect(groups).toHaveLength(2);
    const implementGroup = groups.find((g) => g.activityName === "3_implement");
    expect(implementGroup?.sessionIds.sort()).toEqual(["s1", "s2", "s3"]);
    expect(implementGroup?.ledgerEntryIds.sort()).toEqual(["a", "b"]);
  });

  it("reports manual-source entries as structural omissions, never fabricating a breakdown", () => {
    const { groups, structuralOmissions } = groupLedgerForMetrics([
      ledgerEntry({ ledger_entry_id: "m1", source: "manual", session_ids: [] }),
    ]);
    expect(groups).toHaveLength(0);
    expect(structuralOmissions).toEqual([
      { entry_id: "m1", reason: "manual_source_no_breakdown", detail: expect.any(String) },
    ]);
  });

  it("reports an automated entry with no session_ids as a structural omission", () => {
    const { structuralOmissions } = groupLedgerForMetrics([
      ledgerEntry({ ledger_entry_id: "e1", session_ids: [] }),
    ]);
    expect(structuralOmissions).toEqual([
      { entry_id: "e1", reason: "no_session_ids", detail: expect.any(String) },
    ]);
  });
});

describe("detectAmbiguousSessionAttribution", () => {
  it("returns empty when no session id is shared across activities", () => {
    const { groups } = groupLedgerForMetrics([
      ledgerEntry({ ledger_entry_id: "a", phase: "2_spec", session_ids: ["s1"] }),
      ledgerEntry({ ledger_entry_id: "b", phase: "3_implement", session_ids: ["s2"] }),
    ]);
    expect(detectAmbiguousSessionAttribution(groups)).toEqual([]);
  });

  it("flags a session id that appears in more than one activity (fail-closed)", () => {
    const { groups } = groupLedgerForMetrics([
      ledgerEntry({ ledger_entry_id: "a", phase: "2_spec", session_ids: ["shared"] }),
      ledgerEntry({ ledger_entry_id: "b", phase: "3_implement", session_ids: ["shared"] }),
    ]);
    expect(detectAmbiguousSessionAttribution(groups)).toEqual(["shared"]);
  });
});

describe("tokenUsageRecordsFromRows", () => {
  it("maps a well-formed row into a token-usage record", () => {
    const { records, unknownTokenKinds } = tokenUsageRecordsFromRows("3_implement", [row({})]);
    expect(unknownTokenKinds).toHaveLength(0);
    expect(records).toEqual([
      {
        activity: { namespace: "spec-lane", name: "3_implement" },
        agent: "claude",
        model: "claude-sonnet-5",
        token_kind: "cache_write_5m",
        tokens: 100,
        priced_tokens: 100,
        unpriced_tokens: 0,
        estimated_cost_usd: 0.0003,
        credits: 0,
        pricing_status: "priced",
      },
    ]);
  });

  it("drops zero-token rows (they carry no information)", () => {
    const { records } = tokenUsageRecordsFromRows("3_implement", [row({ tokens: 0 })]);
    expect(records).toHaveLength(0);
  });

  it("never collapses cache_write_5m/1h/unknown into one bucket (rejected design, protocol doc section 9)", () => {
    const { records } = tokenUsageRecordsFromRows("3_implement", [
      row({ token_kind: "cache_write_5m", tokens: 100 }),
      row({ token_kind: "cache_write_1h", tokens: 50 }),
      row({ token_kind: "cache_write_unknown", tokens: 25 }),
    ]);
    expect(records.map((r) => r.token_kind).sort()).toEqual([
      "cache_write_1h",
      "cache_write_5m",
      "cache_write_unknown",
    ]);
  });

  it("collects (never silently drops) an unrecognized token_kind for the caller to hard-fail on", () => {
    const { records, unknownTokenKinds } = tokenUsageRecordsFromRows("3_implement", [
      row({ token_kind: "some_future_kind" }),
    ]);
    expect(records).toHaveLength(0);
    expect(unknownTokenKinds).toEqual(["some_future_kind"]);
  });

  it("maps agent-cost's report-side lower_bound pricing_status down to the protocol's unpriced (measure's own rows never actually emit lower_bound, but this keeps the mapping total)", () => {
    const { records } = tokenUsageRecordsFromRows("3_implement", [
      row({ pricing_status: "lower_bound" }),
    ]);
    expect(records[0]?.pricing_status).toBe("unpriced");
  });

  // Review round 2026-08-07, should-3: measure/v1 rows are documented as always
  // pre-grouped by (agent, model, token_kind), so a null here is a protocol violation the
  // caller must fail the whole emit closed on -- not a "nothing to report" shape to
  // silently drop the same way a zero-token row is.
  it.each([
    ["agent", { agent: null }],
    ["model", { model: null }],
    ["token_kind", { token_kind: null }],
  ] as const)("collects (never silently drops) a row with a null %s", (_field, overrides) => {
    const nonZeroRow = row(overrides);
    const { records, nullFieldRows } = tokenUsageRecordsFromRows("3_implement", [nonZeroRow]);
    expect(records).toHaveLength(0);
    expect(nullFieldRows).toEqual([nonZeroRow]);
  });

  it("still drops a zero-token row even if it also has a null field (no information either way)", () => {
    const { records, nullFieldRows } = tokenUsageRecordsFromRows("3_implement", [
      row({ tokens: 0, agent: null }),
    ]);
    expect(records).toHaveLength(0);
    expect(nullFieldRows).toHaveLength(0);
  });
});

describe("buildCoverage", () => {
  it("is 'complete' when nothing was excluded", () => {
    expect(buildCoverage({ eligibleEntries: 2, measuredEntries: 2, omissions: [] }).status).toBe(
      "complete",
    );
  });
  it("is 'partial' when some but not all entries were excluded", () => {
    expect(buildCoverage({ eligibleEntries: 2, measuredEntries: 1, omissions: [] }).status).toBe(
      "partial",
    );
  });
  it("is 'no_data' when nothing was measured at all, even if some entries were eligible", () => {
    expect(buildCoverage({ eligibleEntries: 3, measuredEntries: 0, omissions: [] }).status).toBe(
      "no_data",
    );
  });
});

describe("buildTokenUsagePayload / buildAgentMetricsMarker", () => {
  const baseInput = {
    emitter: { name: "spec-lane", version: "0.3.0" },
    subject: { namespace: "spec-lane", type: "delivery-run", id: "I-2026-08-07-test" },
    repository: { provider: "github", id: "octo-org/spec-lane-demo" },
    generatedAt: "2026-08-07T00:00:00Z",
  };

  it("rejects (schema-level) a record smuggling a personal-dimension key -- the `.strict()` additionalProperties:false already catches this today", () => {
    // Defense in depth (protocol doc section 7's own design note on invalid-personal-
    // dimension: "caught independently by both the dedicated scan and, in this fixture,
    // also by additionalProperties:false"). Since every object here is already `.strict()`,
    // this specific case is caught by TokenUsagePayloadSchema.parse before
    // assertNoAgentMetricsPersonalDimensions ever runs -- see the next test for the
    // Goodhart scan exercised directly, independent of schema validation, which is the
    // actual backstop this scan exists for (a future optional-field addition reopening
    // the door).
    const poisoned = [
      {
        activity: { namespace: "spec-lane", name: "3_implement" },
        agent: "claude",
        model: "claude-sonnet-5",
        token_kind: "output" as const,
        tokens: 1,
        pricing_status: "priced" as const,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately smuggling a forbidden key past the type
        reviewer: "someone" as any,
      },
    ];
    expect(() =>
      buildTokenUsagePayload({
        ...baseInput,
        records: poisoned,
        coverage: buildCoverage({ eligibleEntries: 1, measuredEntries: 1, omissions: [] }),
      }),
    ).toThrow(); // ZodError today; would be AgentMetricsGoodhartViolationError if the schema ever loosened
  });

  it("rejects (throws) rather than truncates when the encoded payload exceeds the 64 KB limit", () => {
    const hugeRecords = Array.from({ length: 500 }, (_, i) => ({
      activity: { namespace: "spec-lane", name: `phase-${i}` },
      agent: "claude",
      model: "claude-sonnet-5-a-very-long-model-identifier-string-padding".repeat(5),
      token_kind: "output" as const,
      tokens: i + 1,
      pricing_status: "priced" as const,
    }));
    const payload = buildTokenUsagePayload({
      ...baseInput,
      records: hugeRecords,
      coverage: buildCoverage({ eligibleEntries: 500, measuredEntries: 500, omissions: [] }),
    });
    expect(() => buildAgentMetricsMarker(payload)).toThrow(AgentMetricsPayloadTooLarge);
  });

  it("golden reproduction: a fixture ledger + fake measure/v1 rows reproduce valid-minimum.json's own data shape field-for-field", () => {
    const { groups } = groupLedgerForMetrics([
      ledgerEntry({ ledger_entry_id: "led-1", phase: "3_implement", session_ids: ["sess-1"] }),
    ]);
    expect(detectAmbiguousSessionAttribution(groups)).toEqual([]);
    const group = groups[0];
    if (!group) throw new Error("expected exactly one activity group");
    const { records, unknownTokenKinds } = tokenUsageRecordsFromRows(group.activityName, [row({})]);
    expect(unknownTokenKinds).toHaveLength(0);
    const coverage = buildCoverage({ eligibleEntries: 1, measuredEntries: 1, omissions: [] });

    const payload = buildTokenUsagePayload({
      emitter: { name: "spec-lane", version: "0.2.0" },
      subject: {
        namespace: "spec-lane",
        type: "delivery-run",
        id: "intent-2026-0417-telemetry-export",
      },
      repository: { provider: "github", id: "octo-org/spec-lane-demo" },
      change: {
        type: "pull_request",
        number: 42,
        url: "https://github.com/octo-org/spec-lane-demo/pull/42",
        head_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      },
      generatedAt: "2026-08-07T00:00:00Z",
      records,
      coverage,
    });

    const golden = readFixture("valid-minimum.json");
    expect(payload.data).toEqual(golden.data);
    expect(payload.upsert_key).toBe(golden.upsert_key);
  });

  it("round-trips through buildAgentMetricsMarker / decodeAndVerifyAgentMetricsMarker", () => {
    const payload = buildTokenUsagePayload({
      ...baseInput,
      records: [],
      coverage: buildCoverage({ eligibleEntries: 0, measuredEntries: 0, omissions: [] }),
    });
    const marker = buildAgentMetricsMarker(payload);
    expect(parseAgentMetricsMarkerFields(marker)).toBeDefined();
    const decoded = decodeAndVerifyAgentMetricsMarker(marker);
    expect(decoded).toEqual(payload);
  });

  it("decodeAndVerifyAgentMetricsMarker rejects a tampered marker (sha256 no longer matches)", () => {
    const payload = buildTokenUsagePayload({
      ...baseInput,
      records: [],
      coverage: buildCoverage({ eligibleEntries: 0, measuredEntries: 0, omissions: [] }),
    });
    const marker = buildAgentMetricsMarker(payload);
    const tampered = marker.replace(/sha256=[0-9a-f]+/, `sha256=${"0".repeat(64)}`);
    expect(decodeAndVerifyAgentMetricsMarker(tampered)).toBeUndefined();
  });

  // Review round 2026-08-07, must-2: Node's Buffer.from(str, "base64") is a *lenient*
  // decoder -- it silently skips characters outside the base64 alphabet, so appending a
  // stray "!" to an otherwise-valid payload_b64 still decodes to the exact same bytes,
  // which still hashes to the same (correctly-declared) sha256. Before the fix, this was
  // wrongly accepted as valid even though the contract requires rejecting malformed
  // base64 on format grounds alone (mirrored from verify-fixtures.mjs's own BASE64_RE +
  // `length % 4` check).
  it("decodeAndVerifyAgentMetricsMarker rejects a payload_b64 with a stray trailing character, even though it decodes to the same bytes and matches the declared sha256", () => {
    const payload = buildTokenUsagePayload({
      ...baseInput,
      records: [],
      coverage: buildCoverage({ eligibleEntries: 0, measuredEntries: 0, omissions: [] }),
    });
    const marker = buildAgentMetricsMarker(payload);
    const malformed = marker.replace(/payload_b64=(\S+)/, "payload_b64=$1!");
    expect(decodeAndVerifyAgentMetricsMarker(malformed)).toBeUndefined();
  });
});
