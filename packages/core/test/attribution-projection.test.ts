import type { TraceEvent } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  buildAttributionProjection,
  pairKey,
  resolveLatestUsageImportedByPair,
} from "../src/attribution.js";

// I-2026-09-10-agent-cost-v2-basis-gate — D14/D16/D7/RULE-23/24/29 pin the "latest
// usage_imported projection" that decides per-(task_run,session) matched/unmatched state
// and the six-state session classification built on top of it. Expected values below are
// derived from spec.md's Decisions (D14/D16/D7) and Requirements (RULE-23/24/29), not from
// reading attribution.ts's implementation.

const TASK_RUN = "9f2c9c2e-6b4b-4d0a-9a3d-6a2f7a1c9e10";
const SESSION = "11111111-1111-4111-8111-111111111111";

function usageImportedEvent(overrides: Partial<TraceEvent> & { event_id: string }): TraceEvent {
  return {
    schema_version: "trace/v1",
    relation: "usage_imported",
    from_ref: { logical_id: `session:${SESSION}` },
    to_ref: { logical_id: `task_run:${TASK_RUN}` },
    occurred_at: "2026-08-01T10:00:00Z",
    actor: { kind: "cli", id: "lane", version: "0.4.0" },
    task_run_id: TASK_RUN,
    session_id: SESSION,
    payload: {
      window: { since: "2026-08-01T09:00:00Z", until: "2026-08-01T10:00:00Z" },
      matched: true,
    },
    ...overrides,
  } as TraceEvent;
}

function sessionBoundEvent(overrides: Partial<TraceEvent> & { event_id: string }): TraceEvent {
  return {
    schema_version: "trace/v1",
    relation: "session_bound",
    from_ref: { logical_id: `task_run:${TASK_RUN}` },
    to_ref: { logical_id: `session:${SESSION}` },
    occurred_at: "2026-08-01T09:00:00Z",
    actor: { kind: "agent", id: "claude-code", version: "1.0.0" },
    task_run_id: TASK_RUN,
    session_id: SESSION,
    payload: { binding_method: "pre_assigned_session_id" },
    ...overrides,
  } as TraceEvent;
}

describe("buildAttributionProjection / resolveLatestUsageImportedByPair (D14/D16/D7)", () => {
  // D14 (revised — sol must-4): recovery is real -- a later matched:true supersedes an
  // earlier matched:false for the same (task_run_id, session_id) pair. TEST-35 must fail
  // against an any-unmatched-in-window derivation.
  it("recovers to exactly_attributed when a later matched:true follows an earlier matched:false (D14, TEST-35)", () => {
    const projection = buildAttributionProjection({
      usageImportedEvents: [
        usageImportedEvent({
          event_id: "e1",
          occurred_at: "2026-08-01T10:00:00Z",
          payload: { matched: false },
        }),
        usageImportedEvent({
          event_id: "e2",
          occurred_at: "2026-08-01T11:00:00Z",
          payload: { matched: true },
        }),
      ],
      sessionBoundEvents: [sessionBoundEvent({ event_id: "b1" })],
    });
    expect(projection.classify(SESSION)).toBe("exactly_attributed");
  });

  // D14.1: usage_imported's identity is (task_run_id, session_id, window); the same
  // window replayed produces the same event_id, so a duplicate event_id is one fact
  // recorded twice and counted once -- the first ledger position for that event_id wins,
  // a later duplicate does not overwrite it.
  it("de-duplicates by event_id, keeping the first occurrence's content (D14.1)", () => {
    const map = resolveLatestUsageImportedByPair([
      usageImportedEvent({
        event_id: "dup",
        occurred_at: "2026-08-01T10:00:00Z",
        payload: { matched: true },
      }),
      usageImportedEvent({
        event_id: "dup",
        occurred_at: "2026-08-01T12:00:00Z",
        payload: { matched: false },
      }),
    ]);
    expect(map.size).toBe(1);
    expect(map.get(pairKey(TASK_RUN, SESSION))?.matched).toBe(true);
  });

  // D14.3: an identical-timestamp tie breaks on ledger order -- the later line in
  // events.jsonl (the later position in the input array) wins.
  it("breaks an identical-timestamp tie by ledger order, later position wins (D14.3)", () => {
    const sameTimestamp = "2026-08-01T10:00:00Z";
    const map = resolveLatestUsageImportedByPair([
      usageImportedEvent({
        event_id: "e1",
        occurred_at: sameTimestamp,
        payload: { matched: true },
      }),
      usageImportedEvent({
        event_id: "e2",
        occurred_at: sameTimestamp,
        payload: { matched: false },
      }),
    ]);
    expect(map.get(pairKey(TASK_RUN, SESSION))?.matched).toBe(false);
  });

  // D14.4: an event whose supersedes_event_id names another event retires that event
  // regardless of timestamp -- the retired event is never the latest, even when it has a
  // later occurred_at than the superseding event.
  it("lets supersedes_event_id retire a later-timestamped event regardless of occurred_at (D14.4)", () => {
    const map = resolveLatestUsageImportedByPair([
      usageImportedEvent({
        event_id: "e1",
        occurred_at: "2026-08-01T12:00:00Z",
        payload: { matched: true },
      }),
      usageImportedEvent({
        event_id: "e2",
        occurred_at: "2026-08-01T09:00:00Z",
        supersedes_event_id: "e1",
        payload: { matched: false },
      }),
    ]);
    expect(map.get(pairKey(TASK_RUN, SESSION))?.matched).toBe(false);
  });

  // D16/RULE-29: a session bound to two or more task_runs is "mixed" without evaluating
  // any usage_imported state -- the per-pair fold never runs, so disagreeing per-pair
  // matched states (one true, one false) must not surface as anything but "mixed".
  // TEST-43 must fail against a fold-first implementation.
  it("classifies a session bound to two task_runs as mixed, ignoring disagreeing per-pair states (D16/RULE-29, TEST-43)", () => {
    const otherTaskRun = "aaaaaaaa-0000-4000-8000-000000000000";
    const projection = buildAttributionProjection({
      usageImportedEvents: [
        usageImportedEvent({ event_id: "e1", task_run_id: TASK_RUN, payload: { matched: true } }),
        usageImportedEvent({
          event_id: "e2",
          task_run_id: otherTaskRun,
          from_ref: { logical_id: `session:${SESSION}` },
          to_ref: { logical_id: `task_run:${otherTaskRun}` },
          payload: { matched: false },
        }),
      ],
      sessionBoundEvents: [
        sessionBoundEvent({ event_id: "b1", task_run_id: TASK_RUN }),
        sessionBoundEvent({
          event_id: "b2",
          task_run_id: otherTaskRun,
          from_ref: { logical_id: `task_run:${otherTaskRun}` },
          to_ref: { logical_id: `session:${SESSION}` },
        }),
      ],
    });
    expect(projection.classify(SESSION)).toBe("mixed");
  });

  // D7: "orphan_usage" (in the ledger, never bound) / "unbound" (usage recorded, no
  // session_bound event) / "never_imported" (bound, but no usage_imported event at all
  // for that pair -- D7's "in no bucket at all" case) are three distinct not-exactly-
  // attributed outcomes.
  it("classifies a session with no binding and no usage_imported event as orphan_usage (D7)", () => {
    const projection = buildAttributionProjection({
      usageImportedEvents: [],
      sessionBoundEvents: [],
    });
    expect(projection.classify(SESSION)).toBe("orphan_usage");
  });

  it("classifies an unbound session with a usage_imported event as unbound (D7, T-6)", () => {
    const projection = buildAttributionProjection({
      usageImportedEvents: [usageImportedEvent({ event_id: "e1" })],
      sessionBoundEvents: [],
    });
    expect(projection.classify(SESSION)).toBe("unbound");
  });

  it("classifies a bound session with no usage_imported event as never_imported (D7)", () => {
    const projection = buildAttributionProjection({
      usageImportedEvents: [],
      sessionBoundEvents: [sessionBoundEvent({ event_id: "b1" })],
    });
    expect(projection.classify(SESSION)).toBe("never_imported");
  });

  // RULE-24: the eligibility derivation applies no time window, so a given trace ledger
  // and entry yields the same reasons regardless of when the command runs -- classification
  // must not depend on wall-clock time or on how "old" occurred_at looks. TEST-36.
  it("classifies identically across repeated calls and regardless of how old occurred_at is (RULE-24, TEST-36)", () => {
    const input = {
      usageImportedEvents: [
        usageImportedEvent({
          event_id: "e1",
          occurred_at: "2019-01-01T00:00:00Z",
          payload: { matched: true },
        }),
      ],
      sessionBoundEvents: [sessionBoundEvent({ event_id: "b1" })],
    };
    const first = buildAttributionProjection(input).classify(SESSION);
    const second = buildAttributionProjection(input).classify(SESSION);
    expect(first).toBe("exactly_attributed");
    expect(second).toBe("exactly_attributed");
  });
});
