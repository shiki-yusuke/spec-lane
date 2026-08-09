import { describe, expect, it } from "vitest";
import { buildAttributionAuditResult, deriveBindingRecordsFromTrace } from "../src/attribution.js";
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
