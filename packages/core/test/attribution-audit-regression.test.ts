import { describe, expect, it } from "vitest";
import { buildAttributionAuditResult } from "../src/attribution.js";
import { buildTraceEvent } from "../src/trace.js";

// I-2026-09-10-agent-cost-v2-basis-gate — regression coverage for D14/D15/RULE-34 at the
// buildAttributionAuditResult level (attribution-projection.test.ts already pins D14's
// four rules and D16/RULE-29 at the buildAttributionProjection level directly; this file
// pins that the same rules hold once threaded through the audit's own session buckets and
// token arithmetic, per spec.md's Tests table TEST-38/44/51).

const TASK_RUN = "9f2c9c2e-6b4b-4d0a-9a3d-6a2f7a1c9e10";
const SESSION = "11111111-1111-4111-8111-111111111111";

function sessionBound(sessionId: string, taskRunId: string, occurredAt: string) {
  return buildTraceEvent({
    relation: "session_bound",
    fromRef: { logical_id: `task_run:${taskRunId}` },
    toRef: { logical_id: `session:${sessionId}` },
    occurredAt,
    actor: { kind: "cli", id: "lane" },
    taskRunId,
    sessionId,
    payload: { binding_method: "pre_assigned_session_id" },
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
      window: { since: "2026-01-01T00:00:00Z", until: occurredAt },
      tokens,
      matched,
    },
  });
}

describe("buildAttributionAuditResult regression: D14 recovery / D15 token-sum invariance", () => {
  // TEST-38: "The audit's measurement_incomplete bucket no longer holds a session whose
  // latest event for a pair is matched:true." D14: a later matched:true for the same
  // (task_run, session) pair supersedes an earlier matched:false -- the session must move
  // out of measurement_incomplete and into exactly_attributed.
  it("moves a recovered session out of measurement_incomplete into exactly_attributed (TEST-38)", () => {
    const { result } = buildAttributionAuditResult({
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-01-02T00:00:00Z"),
      generatedAt: "2026-01-02T00:00:00Z",
      traceEvents: [
        sessionBound(SESSION, TASK_RUN, "2026-01-01T00:00:00Z"),
        usageImported(SESSION, TASK_RUN, "2026-01-01T01:00:00Z", 100, false),
        usageImported(SESSION, TASK_RUN, "2026-01-01T02:00:00Z", 100, true),
      ],
      ledgerSessionIds: [],
    });
    expect(result.sessions.measurement_incomplete).toEqual([]);
    expect(result.sessions.exactly_attributed).toEqual([{ session_id: SESSION, tokens: 200 }]);
  });

  // TEST-51 (RULE-34): the latest projection changes classification only -- tokens.total_measured
  // keeps summing every in-window usage_imported event, including both the superseded
  // matched:false event and the recovering matched:true event (100 + 100 = 200), not just
  // the winning one.
  it("still sums tokens from every in-window usage_imported event, including the superseded one (TEST-51, RULE-34)", () => {
    const { result } = buildAttributionAuditResult({
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-01-02T00:00:00Z"),
      generatedAt: "2026-01-02T00:00:00Z",
      traceEvents: [
        sessionBound(SESSION, TASK_RUN, "2026-01-01T00:00:00Z"),
        usageImported(SESSION, TASK_RUN, "2026-01-01T01:00:00Z", 100, false),
        usageImported(SESSION, TASK_RUN, "2026-01-01T02:00:00Z", 100, true),
      ],
      ledgerSessionIds: [],
    });
    expect(result.tokens.exact_attributed).toBe(200);
    expect(result.tokens.total_measured).toBe(200);
  });

  // TEST-44: on a ledger with no recovery in it (one session_bound, one matched:true
  // usage_imported, no duplicate/tie/supersedes case at all), the audit-result JSON is
  // byte-identical before and after D14 -- D15 says classification is the only thing D14
  // changes, and with a single event there is nothing for D14's fold to change. The
  // expected object below is a **pin of this lane's own (post-D14) output** for this
  // fixture, captured by running buildAttributionAuditResult against it (per team-lead's
  // instruction, since a pre-D14 binary is not available to run side-by-side here); its
  // justification is D15's claim that token arithmetic and single-event classification are
  // both unchanged by D14, not a value derived from spec prose alone.
  it("produces a byte-identical audit-result JSON for a trace ledger with no recovery case (TEST-44, D15)", () => {
    const { result } = buildAttributionAuditResult({
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-01-02T00:00:00Z"),
      generatedAt: "2026-01-02T00:00:00Z",
      traceEvents: [
        sessionBound(SESSION, TASK_RUN, "2026-01-01T00:00:00Z"),
        usageImported(SESSION, TASK_RUN, "2026-01-01T01:00:00Z", 500, true),
      ],
      ledgerSessionIds: [],
    });
    const expected = {
      schema_version: "attribution/v1",
      generated_at: "2026-01-02T00:00:00Z",
      window: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" },
      sessions: {
        exactly_attributed: [{ session_id: SESSION, tokens: 500 }],
        unbound: [],
        mixed: [],
        orphan_usage: [],
        measurement_incomplete: [],
      },
      tokens: { exact_attributed: 500, total_measured: 500 },
      research_eligible: true,
      violations: [],
    };
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
  });

  // Copilot review (PR): a session bound only to task_run A but usage_imported only under
  // task_run B has no (A, session) usage_imported event at all, so the projection classifies
  // it "never_imported" -- a state the audit's per-session loop did not expect and was
  // falling through to "exactly_attributed" for. It must land in sessions.mixed (builder's
  // fix in progress) and must not appear in sessions.exactly_attributed.
  it("classifies a session bound to task_run A but usage_imported only under task_run B as mixed, not exactly_attributed", () => {
    const OTHER_TASK_RUN = "aaaaaaaa-0000-4000-8000-000000000000";
    const { result } = buildAttributionAuditResult({
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-01-02T00:00:00Z"),
      generatedAt: "2026-01-02T00:00:00Z",
      traceEvents: [
        sessionBound(SESSION, TASK_RUN, "2026-01-01T00:00:00Z"),
        usageImported(SESSION, OTHER_TASK_RUN, "2026-01-01T01:00:00Z", 100, true),
      ],
      ledgerSessionIds: [],
    });
    expect(result.sessions.mixed).toContain(SESSION);
    expect(result.sessions.exactly_attributed).toEqual([]);
  });
});
