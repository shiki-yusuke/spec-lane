import { describe, expect, it } from "vitest";
import {
  MalformedBindingRecordCaptureError,
  buildAttributionAuditResult,
  deriveBindingRecordsFromTrace,
} from "../src/attribution.js";
import { buildTraceEvent } from "../src/trace.js";

// M0 spec-lane 0.5.0 — unit coverage for the trace -> attribution/v1 derivation logic
// itself (contract-shape conformance is covered separately by attribution-fixtures.test.ts).

function sessionBound(sessionId: string, taskRunId: string, occurredAt: string, agent = "claude") {
  return buildTraceEvent({
    relation: "session_bound",
    fromRef: { logical_id: `task_run:${taskRunId}` },
    toRef: { logical_id: `session:${sessionId}` },
    occurredAt,
    actor: { kind: "cli", id: "lane" },
    taskRunId,
    sessionId,
    laneId: "I-2026-08-09-attr",
    payload: { binding_method: "pre_assigned_session_id", agent },
  });
}

function sessionBoundV2(
  sessionId: string,
  taskRunId: string,
  occurredAt: string,
  capture: {
    requested_model: string | null;
    requested_reasoning_effort: string | null;
    capture_status: "captured" | "absent" | "unsupported_syntax" | "ambiguous";
  },
  agent = "claude",
) {
  return buildTraceEvent({
    relation: "session_bound",
    fromRef: { logical_id: `task_run:${taskRunId}` },
    toRef: { logical_id: `session:${sessionId}` },
    occurredAt,
    actor: { kind: "cli", id: "lane" },
    taskRunId,
    sessionId,
    laneId: "I-2026-08-09-attr",
    payload: { binding_method: "pre_assigned_session_id", agent, ...capture },
  });
}

/** Like sessionBoundV2, but accepts an arbitrary (possibly malformed) capture payload --
 * used to construct the must-3 "partial/invalid v2 capture data" cases that a typed
 * `capture` parameter on sessionBoundV2 couldn't express. */
function sessionBoundRawCapture(
  sessionId: string,
  taskRunId: string,
  occurredAt: string,
  capture: Record<string, unknown>,
  agent = "claude",
) {
  return buildTraceEvent({
    relation: "session_bound",
    fromRef: { logical_id: `task_run:${taskRunId}` },
    toRef: { logical_id: `session:${sessionId}` },
    occurredAt,
    actor: { kind: "cli", id: "lane" },
    taskRunId,
    sessionId,
    laneId: "I-2026-08-09-attr",
    payload: { binding_method: "pre_assigned_session_id", agent, ...capture },
  });
}

function usageImported(
  sessionId: string,
  taskRunId: string,
  occurredAt: string,
  tokens: number,
  matched = true,
) {
  return buildTraceEvent({
    relation: "usage_imported",
    fromRef: { logical_id: `session:${sessionId}` },
    toRef: { logical_id: `task_run:${taskRunId}` },
    occurredAt,
    actor: { kind: "cli", id: "lane" },
    taskRunId,
    sessionId,
    payload: {
      window: { since: "2026-08-01T00:00:00Z", until: occurredAt },
      tokens,
      matched,
    },
  });
}

describe("deriveBindingRecordsFromTrace", () => {
  it("a single session_bound event yields one bound record", () => {
    const records = deriveBindingRecordsFromTrace([
      sessionBound("s1", "t1", "2026-08-09T00:00:00Z"),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      session_id: "s1",
      task_run_id: "t1",
      binding_status: "bound",
    });
  });

  it("re-binding the same session to a different task_run supersedes the earlier one", () => {
    const records = deriveBindingRecordsFromTrace([
      sessionBound("s1", "t1", "2026-08-09T00:00:00Z"),
      sessionBound("s1", "t2", "2026-08-09T01:00:00Z"),
    ]);
    expect(records).toHaveLength(2);
    const byTaskRun = new Map(records.map((r) => [r.task_run_id, r]));
    expect(byTaskRun.get("t1")?.binding_status).toBe("superseded");
    expect(byTaskRun.get("t2")?.binding_status).toBe("bound");
  });

  it("re-binding to the SAME task_run is an idempotent replay, not two records", () => {
    const records = deriveBindingRecordsFromTrace([
      sessionBound("s1", "t1", "2026-08-09T00:00:00Z"),
      sessionBound("s1", "t1", "2026-08-09T00:00:01Z"),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.binding_status).toBe("bound");
  });

  // cohort-3 measurement fix (2026-08-29): requested_model/requested_reasoning_effort/
  // capture_status projection. A session_bound event whose payload predates this feature
  // (no capture_status at all -- sessionBound() above) still derives as attribution/v1,
  // exactly as before; only a payload that actually carries a recognized capture_status is
  // projected as attribution/v2.
  describe("v2 projection (requested_model/requested_reasoning_effort/capture_status)", () => {
    it("a payload without capture_status at all (pre-existing data) still derives as attribution/v1", () => {
      const records = deriveBindingRecordsFromTrace([
        sessionBound("s1", "t1", "2026-08-09T00:00:00Z"),
      ]);
      expect(records[0]?.schema_version).toBe("attribution/v1");
      expect(records[0] && "requested_model" in records[0]).toBe(false);
    });

    it("a payload with capture_status='captured' derives as attribution/v2 with both values", () => {
      const records = deriveBindingRecordsFromTrace([
        sessionBoundV2("s1", "t1", "2026-08-09T00:00:00Z", {
          requested_model: "claude-sonnet-5",
          requested_reasoning_effort: "high",
          capture_status: "captured",
        }),
      ]);
      expect(records[0]).toMatchObject({
        schema_version: "attribution/v2",
        requested_model: "claude-sonnet-5",
        requested_reasoning_effort: "high",
        capture_status: "captured",
      });
    });

    it("a manual_bind-shaped payload with capture_status='absent' derives as attribution/v2 with both values null", () => {
      const records = deriveBindingRecordsFromTrace([
        sessionBoundV2("s1", "t1", "2026-08-09T00:00:00Z", {
          requested_model: null,
          requested_reasoning_effort: null,
          capture_status: "absent",
        }),
      ]);
      expect(records[0]).toMatchObject({
        schema_version: "attribution/v2",
        requested_model: null,
        requested_reasoning_effort: null,
        capture_status: "absent",
      });
    });

    // must-2 (sol review, 2026-08-29): capture_status="captured" requires both values
    // non-null; every other status requires at least one null (BindingRecordSchema's own
    // superRefine enforces this -- see below for what happens when a payload disagrees).
    it("every recognized capture_status value round-trips through the v2 projection", () => {
      const CAPTURE_BY_STATUS = {
        captured: { requested_model: "claude-sonnet-5", requested_reasoning_effort: "high" },
        absent: { requested_model: null, requested_reasoning_effort: null },
        unsupported_syntax: { requested_model: null, requested_reasoning_effort: null },
        ambiguous: { requested_model: null, requested_reasoning_effort: null },
      } as const;
      for (const capture_status of [
        "captured",
        "absent",
        "unsupported_syntax",
        "ambiguous",
      ] as const) {
        const records = deriveBindingRecordsFromTrace([
          sessionBoundV2(`s-${capture_status}`, "t1", "2026-08-09T00:00:00Z", {
            ...CAPTURE_BY_STATUS[capture_status],
            capture_status,
          }),
        ]);
        expect(records[0]?.schema_version).toBe("attribution/v2");
        expect(records[0]).toMatchObject({ capture_status });
      }
    });
  });

  // sol review (2026-08-29, must 3): a payload that carries at least one of the three v2
  // capture keys but doesn't form a schema-valid attribution/v2 record must never be
  // silently downgraded to a "clean" v1 record -- it must surface loudly instead.
  describe("must 3: partial/invalid v2 capture data is never silently downgraded to v1", () => {
    it("throws when capture_status is present but misspelled ('caputred')", () => {
      const events = [
        sessionBoundRawCapture("s1", "t1", "2026-08-09T00:00:00Z", {
          requested_model: "opus",
          requested_reasoning_effort: "high",
          capture_status: "caputred",
        }),
      ];
      expect(() => deriveBindingRecordsFromTrace(events)).toThrow(
        MalformedBindingRecordCaptureError,
      );
    });

    it("throws when capture_status is missing but requested_model is present", () => {
      const events = [
        sessionBoundRawCapture("s1", "t1", "2026-08-09T00:00:00Z", {
          requested_model: "opus",
        }),
      ];
      expect(() => deriveBindingRecordsFromTrace(events)).toThrow(
        MalformedBindingRecordCaptureError,
      );
    });

    it("throws when capture_status='captured' is present but a value has the wrong type", () => {
      const events = [
        sessionBoundRawCapture("s1", "t1", "2026-08-09T00:00:00Z", {
          requested_model: 42,
          requested_reasoning_effort: "high",
          capture_status: "captured",
        }),
      ];
      expect(() => deriveBindingRecordsFromTrace(events)).toThrow(
        MalformedBindingRecordCaptureError,
      );
    });

    it("throws when capture_status='captured' is present but both values are null (must-2 invariant)", () => {
      const events = [
        sessionBoundRawCapture("s1", "t1", "2026-08-09T00:00:00Z", {
          requested_model: null,
          requested_reasoning_effort: null,
          capture_status: "captured",
        }),
      ];
      expect(() => deriveBindingRecordsFromTrace(events)).toThrow(
        MalformedBindingRecordCaptureError,
      );
    });

    it("the thrown error names the offending session/task_run", () => {
      const events = [
        sessionBoundRawCapture("s-bad", "t-bad", "2026-08-09T00:00:00Z", {
          capture_status: "caputred",
        }),
      ];
      expect(() => deriveBindingRecordsFromTrace(events)).toThrowError(/s-bad/);
      expect(() => deriveBindingRecordsFromTrace(events)).toThrowError(/t-bad/);
    });
  });
});

describe("buildAttributionAuditResult", () => {
  it("a cleanly bound + measured session is exactly_attributed", () => {
    const { result } = buildAttributionAuditResult({
      generatedAt: "2026-08-09T02:00:00Z",
      traceEvents: [
        sessionBound("s1", "t1", "2026-08-09T00:00:00Z"),
        usageImported("s1", "t1", "2026-08-09T01:00:00Z", 500),
      ],
      ledgerSessionIds: [],
    });
    expect(result.sessions.exactly_attributed).toEqual([{ session_id: "s1", tokens: 500 }]);
    expect(result.tokens.exact_attributed).toBe(500);
    expect(result.tokens.total_measured).toBe(500);
    expect(result.research_eligible).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("a session bound to two task_runs is mixed with a MULTI_TASK_BINDING violation", () => {
    const { result } = buildAttributionAuditResult({
      generatedAt: "2026-08-09T03:00:00Z",
      traceEvents: [
        sessionBound("s1", "t1", "2026-08-09T00:00:00Z"),
        sessionBound("s1", "t2", "2026-08-09T00:30:00Z"),
        usageImported("s1", "t1", "2026-08-09T01:00:00Z", 300),
      ],
      ledgerSessionIds: [],
    });
    expect(result.sessions.mixed).toEqual(["s1"]);
    expect(result.research_eligible).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ reason_code: "MULTI_TASK_BINDING", session_id: "s1" }),
    ]);
  });

  it("a measured but unbound session is UNBOUND_SESSION", () => {
    const { result } = buildAttributionAuditResult({
      generatedAt: "2026-08-09T03:00:00Z",
      traceEvents: [usageImported("s1", "t1", "2026-08-09T01:00:00Z", 300)],
      ledgerSessionIds: [],
    });
    expect(result.sessions.unbound).toEqual(["s1"]);
    expect(result.violations[0]?.reason_code).toBe("UNBOUND_SESSION");
  });

  it("agent-cost's matched:false surfaces as MEASUREMENT_INCOMPLETE, not a zero-fill", () => {
    const { result } = buildAttributionAuditResult({
      generatedAt: "2026-08-09T03:00:00Z",
      traceEvents: [
        sessionBound("s1", "t1", "2026-08-09T00:00:00Z"),
        usageImported("s1", "t1", "2026-08-09T01:00:00Z", 0, false),
      ],
      ledgerSessionIds: [],
    });
    expect(result.sessions.measurement_incomplete).toEqual(["s1"]);
    expect(result.sessions.exactly_attributed).toEqual([]);
  });

  it("a ledger session_id with no session_bound event at all is ORPHAN_USAGE", () => {
    const { result, diagnostics } = buildAttributionAuditResult({
      generatedAt: "2026-08-09T03:00:00Z",
      traceEvents: [],
      ledgerSessionIds: ["s-orphan"],
    });
    expect(result.sessions.orphan_usage).toEqual(["s-orphan"]);
    expect(diagnostics.some((d) => d.includes("coverage_scope"))).toBe(true);
  });

  it("an empty window reports null, not 0, token totals", () => {
    const { result } = buildAttributionAuditResult({
      generatedAt: "2026-08-09T03:00:00Z",
      traceEvents: [],
      ledgerSessionIds: [],
    });
    expect(result.tokens.exact_attributed).toBeNull();
    expect(result.tokens.total_measured).toBeNull();
    expect(result.research_eligible).toBe(true);
  });

  it("--require-coverage-style gating: research_eligible is false whenever any violation exists", () => {
    const { result } = buildAttributionAuditResult({
      generatedAt: "2026-08-09T03:00:00Z",
      traceEvents: [usageImported("s1", "t1", "2026-08-09T01:00:00Z", 10)],
      ledgerSessionIds: [],
    });
    expect(result.research_eligible).toBe(false);
  });
});
