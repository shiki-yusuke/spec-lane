import {
  type AttributionAuditResult,
  type BindingRecord,
  BindingRecordSchema,
} from "@lane/schemas";
import type { TraceEvent } from "@lane/schemas";
import type { ZodIssue } from "zod";

// M0 spec-lane 0.5.0 — attribution/v1 derivation: binding-records and audit-results are
// *derived* from the trace ledger at read time (never a separately maintained, dual-write
// store) -- the trace ledger (trace.ts) is this codebase's one append-only source of
// truth, and a binding-record is, per attribution-v1.md's own Identity section, exactly
// "the durable, queryable projection of a session_bound trace event." Cross-record checks
// (multiple simultaneous active bindings for one session) cannot be expressed inside a
// single BindingRecordSchema.parse() call, so they live here as plain functions over an
// array, mirroring the playbook's own verify-fixtures.mjs "binding-collection" checks.

/**
 * sol review (2026-08-29, must 3): thrown by deriveBindingRecordsFromTrace when a
 * session_bound event's payload carries at least one of the three v2 capture keys
 * (requested_model/requested_reasoning_effort/capture_status) but doesn't form a
 * schema-valid attribution/v2 record (a typo'd capture_status, a wrong-typed value, a
 * capture_status/nullability mismatch, etc.). Deliberately never silently downgraded to
 * attribution/v1 -- v1 is reserved for payloads that predate this feature entirely (none
 * of the three keys present at all); a payload that *attempted* v2 and got it wrong is a
 * data-integrity problem this function surfaces loudly, not one it papers over.
 */
export class MalformedBindingRecordCaptureError extends Error {
  constructor(
    readonly sessionId: string,
    readonly taskRunId: string,
    readonly issues: readonly ZodIssue[],
  ) {
    super(
      `malformed attribution/v2 capture data on session_bound (session=${sessionId}, task_run=${taskRunId}): ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
    this.name = "MalformedBindingRecordCaptureError";
  }
}

/** Dedups to distinct {task_run_id, session_id} pairs before counting (sol
 * architect-review 2nd round must A2): the identical pair recorded twice (e.g. an
 * idempotent wrapper retry) is the same fact recorded twice, not two active bindings. */
/**
 * Key for one (task_run, session) pair (D14/D16). Encodes the pair as a JSON tuple
 * (`JSON.stringify([taskRunId, sessionId])`) rather than joining the two strings with a
 * separator character: neither id's charset is restricted by the trace/v1 schema (a
 * single-character separator could collide, e.g. `("a", "\0b")` vs. `("a\0", "b")` for a
 * NUL separator), and JSON array encoding is unambiguous regardless of what either string
 * contains. Every map that is keyed by a pair must build and look up its keys through
 * this one helper.
 */
export function pairKey(taskRunId: string, sessionId: string): string {
  return JSON.stringify([taskRunId, sessionId]);
}

export function checkBindingCollectionViolations(records: readonly BindingRecord[]): string[] {
  const reasons: string[] = [];
  const distinctPairs = new Map<string, BindingRecord>();
  for (const r of records) {
    if (r.binding_status !== "bound") continue;
    const dedupKeyForThisFunction = pairKey(r.task_run_id, r.session_id);
    distinctPairs.set(dedupKeyForThisFunction, r);
  }
  const byBoundSession = new Map<string, Set<string>>();
  for (const r of distinctPairs.values()) {
    const set = byBoundSession.get(r.session_id) ?? new Set<string>();
    set.add(r.task_run_id);
    byBoundSession.set(r.session_id, set);
  }
  for (const [sessionId, taskRunIds] of byBoundSession) {
    if (taskRunIds.size > 1) {
      reasons.push(
        `multiple_active_bindings_for_session: session ${sessionId} has ${taskRunIds.size} simultaneously "bound" binding-records for distinct task_runs (${[...taskRunIds].join(", ")})`,
      );
    }
  }
  return reasons;
}

/**
 * Projects every `session_bound` trace event into a BindingRecord (attribution-v1.md's
 * Identity section: "a binding-record has no separate event_id of its own -- its identity
 * is the underlying session_bound event's event_id"). A session_id re-bound to a
 * *different* task_run_id retires its earlier record(s) as "superseded"; re-binding to the
 * *same* task_run_id is an idempotent replay, not a new record. Multiple distinct
 * task_run_ids means every one of them ends up "bound" here (this function does not
 * itself decide which "wins" -- see checkBindingCollectionViolations, which is what
 * actually flags that state as a violation).
 */
export function deriveBindingRecordsFromTrace(events: readonly TraceEvent[]): BindingRecord[] {
  const sessionBound = events
    .filter((e) => e.relation === "session_bound")
    .slice()
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));

  const bySession = new Map<string, TraceEvent[]>();
  for (const e of sessionBound) {
    if (!e.session_id) continue;
    const list = bySession.get(e.session_id) ?? [];
    list.push(e);
    bySession.set(e.session_id, list);
  }

  const records: BindingRecord[] = [];
  for (const [sessionId, sessionEvents] of bySession) {
    const distinctTaskRunIds: string[] = [];
    for (const e of sessionEvents) {
      if (e.task_run_id && !distinctTaskRunIds.includes(e.task_run_id)) {
        distinctTaskRunIds.push(e.task_run_id);
      }
    }
    for (const taskRunId of distinctTaskRunIds) {
      const latestForThisTaskRun = [...sessionEvents]
        .reverse()
        .find((e) => e.task_run_id === taskRunId) as TraceEvent;
      // gpt-5.4 review must2: a session_bound event missing lane_id is malformed (every
      // real writer -- lane work bind/run -- always sets it) or predates that fix. Either
      // way, this function never fabricates a "" to satisfy BindingRecordSchema's
      // minLength:1 -- fail-closed by simply not projecting a record for it, rather than
      // emit a contract-violating empty string. The caller sees one fewer binding-record
      // for this session, not a fake one.
      if (!latestForThisTaskRun.lane_id) continue;
      const rawPayload = latestForThisTaskRun.payload as Record<string, unknown> | undefined;
      const payload = rawPayload as { binding_method?: string; agent?: string } | undefined;
      const commonFields = {
        task_run_id: taskRunId,
        lane_id: latestForThisTaskRun.lane_id,
        intent_id: latestForThisTaskRun.lane_id,
        agent: (payload?.agent === "codex" ? "codex" : "claude") as "claude" | "codex",
        binding_method: (payload?.binding_method === "manual_bind" ||
        payload?.binding_method === "self_reported_thread_id"
          ? payload.binding_method
          : "pre_assigned_session_id") as BindingRecord["binding_method"],
        session_id: sessionId,
        bound_at: latestForThisTaskRun.occurred_at,
        binding_status: (taskRunId === distinctTaskRunIds.at(-1)
          ? "bound"
          : "superseded") as BindingRecord["binding_status"],
        actor: { kind: latestForThisTaskRun.actor.kind, id: latestForThisTaskRun.actor.id },
      };
      // sol review (2026-08-29, must 3): v1 is reserved for payloads that predate the
      // requested-model/effort capture feature entirely -- ALL THREE v2 capture keys
      // absent from the payload. If even one of the three is present, this is a v2
      // *candidate* and is validated strictly below; a payload that got partway there
      // (e.g. capture_status present but a typo, or requested_model present but
      // capture_status missing) is never silently downgraded to a "clean" v1 record --
      // that would hide real data corruption behind an apparently-valid old-format record.
      const hasAnyCaptureKey =
        rawPayload !== undefined &&
        ("requested_model" in rawPayload ||
          "requested_reasoning_effort" in rawPayload ||
          "capture_status" in rawPayload);

      if (!hasAnyCaptureKey) {
        records.push({ schema_version: "attribution/v1", ...commonFields });
        continue;
      }

      // must-2 (sol review, 2026-08-29): validate the fully-assembled candidate against
      // BindingRecordSchema itself (not just "is capture_status a recognized string") --
      // this also catches the captured<=>both-non-null invariant BindingRecordSchema's own
      // superRefine enforces, and wrong-typed values (e.g. requested_model as a number).
      const candidate = {
        schema_version: "attribution/v2",
        ...commonFields,
        requested_model: rawPayload.requested_model,
        requested_reasoning_effort: rawPayload.requested_reasoning_effort,
        capture_status: rawPayload.capture_status,
      };
      const parsed = BindingRecordSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new MalformedBindingRecordCaptureError(sessionId, taskRunId, parsed.error.issues);
      }
      records.push(parsed.data);
    }
  }
  return records;
}

interface UsageTotals {
  tokens: number;
  anyUnmatched: boolean;
  eventCount: number;
}

// RULE-34: token arithmetic is untouched by I-2026-09-10-agent-cost-v2-basis-gate -- this
// still sums every in-window usage_imported event exactly as it did before that lane, and
// `anyUnmatched` (used nowhere below anymore) is kept only because removing it would be an
// unrelated cleanup of a field this function's own contract no longer needs to guarantee.
function sumUsageBySession(usageImportedEvents: readonly TraceEvent[]): Map<string, UsageTotals> {
  const bySession = new Map<string, UsageTotals>();
  for (const e of usageImportedEvents) {
    if (!e.session_id) continue;
    const payload = e.payload as { tokens?: number; matched?: boolean } | undefined;
    const cur = bySession.get(e.session_id) ?? { tokens: 0, anyUnmatched: false, eventCount: 0 };
    cur.tokens += typeof payload?.tokens === "number" ? payload.tokens : 0;
    if (payload?.matched === false) cur.anyUnmatched = true;
    cur.eventCount += 1;
    bySession.set(e.session_id, cur);
  }
  return bySession;
}

// I-2026-09-10-agent-cost-v2-basis-gate (D14) -- the one place that decides which single
// usage_imported event speaks for a given (task_run_id, session_id) pair. Exported
// separately from buildAttributionProjection below so a test can pin the four rules in
// isolation (TEST-50) without needing a full trace ledger / binding setup.
export interface LatestUsageImportedEntry {
  event: TraceEvent;
  matched: boolean;
}

/**
 * D14 -- resolves, for every (task_run_id, session_id) pair appearing among
 * usageImportedEvents, the one event that decides that pair's matched/unmatched state:
 * 1. De-duplicate by event_id first (the same window replayed produces the same
 *    event_id -- one fact recorded twice, counted once).
 * 2. The highest occurred_at wins among what remains.
 * 3. An identical-timestamp tie breaks on ledger order -- the later line in
 *    events.jsonl, i.e. the later position in this function's input array.
 * 4. An event whose supersedes_event_id names another event retires that other event
 *    regardless of timestamp; the retired event is never the latest.
 * Deliberately window-independent (RULE-24) -- this function does not filter by time;
 * callers pass whichever usage_imported events they consider in scope.
 */
export function resolveLatestUsageImportedByPair(
  usageImportedEvents: readonly TraceEvent[],
): Map<string, LatestUsageImportedEntry> {
  // D14.1: de-duplicate by event_id, keeping each event_id's first ledger position.
  const byEventId = new Map<string, { event: TraceEvent; ledgerIndex: number }>();
  usageImportedEvents.forEach((event, ledgerIndex) => {
    if (!byEventId.has(event.event_id)) {
      byEventId.set(event.event_id, { event, ledgerIndex });
    }
  });

  // D14.4: an event naming another via supersedes_event_id retires that other event
  // outright -- it can never win the fold below, regardless of its own timestamp.
  const retired = new Set<string>();
  for (const entry of byEventId.values()) {
    const supersedes = entry.event.supersedes_event_id;
    if (supersedes !== undefined) retired.add(supersedes);
  }

  const byPair = new Map<string, { event: TraceEvent; ledgerIndex: number }>();
  for (const entry of byEventId.values()) {
    const event = entry.event;
    const ledgerIndex = entry.ledgerIndex;
    if (retired.has(event.event_id)) continue;
    if (!event.session_id || !event.task_run_id) continue;
    const key = pairKey(event.task_run_id, event.session_id);
    const current = byPair.get(key);
    if (!current) {
      byPair.set(key, { event, ledgerIndex });
      continue;
    }
    const currentTime = Date.parse(current.event.occurred_at);
    const candidateTime = Date.parse(event.occurred_at);
    // D14.2 (highest occurred_at wins) then D14.3 (later ledger line breaks a tie).
    if (
      candidateTime > currentTime ||
      (candidateTime === currentTime && ledgerIndex > current.ledgerIndex)
    ) {
      byPair.set(key, { event, ledgerIndex });
    }
  }

  const result = new Map<string, LatestUsageImportedEntry>();
  for (const pairEntry of byPair.entries()) {
    const key = pairEntry[0];
    const event = pairEntry[1].event;
    const payload = event.payload as { matched?: boolean } | undefined;
    const matched = payload?.matched !== false;
    result.set(key, { event, matched });
  }
  return result;
}

export type SessionAttributionState =
  | "exactly_attributed"
  | "unbound"
  | "mixed"
  | "orphan_usage"
  | "measurement_incomplete"
  | "never_imported";

export interface SessionAttributionDetail {
  state: SessionAttributionState;
  /** The session's one bound task_run_id, when it has exactly one (state is
   * exactly_attributed, measurement_incomplete or never_imported) -- RULE-39's T-9
   * template needs this to name the task_run a measurement is incomplete for. */
  taskRunId?: string;
  /** The number of distinct task_runs the session is bound to, when state is "mixed" --
   * RULE-39's T-7 template needs this count. */
  bindingCount?: number;
}

export interface AttributionProjection {
  /** Classifies one session_id against the projection this instance was built from.
   * "never_imported" is D7's "in no bucket at all" case -- a session bound exactly once
   * whose (task_run, session) pair has no usage_imported event at all in scope. Every
   * state other than "exactly_attributed" counts as not exactly attributed (D7). */
  classify(sessionId: string): SessionAttributionState;
  /** Same classification, plus the extra identifiers RULE-39's detail templates need. */
  describe(sessionId: string): SessionAttributionDetail;
}

/**
 * D7/D9/DEP-05 -- the one attribution projection shared by buildAttributionAuditResult's
 * own classification and the eligibility predicate
 * (core/application/calibrate-service.ts's deriveKnnIneligibility,
 * usage-import-service.ts). Built once from whichever usage_imported/session_bound
 * events the caller passes in -- buildAttributionAuditResult passes its own windowed
 * usage_imported subset (preserving the existing half-open-window regression, TEST-32)
 * and the full, unwindowed session_bound events (binding lookups have always searched
 * the whole ledger, predating this lane); the eligibility predicate passes every
 * usage_imported event on the ledger, unfiltered, so RULE-24 holds -- a given trace
 * ledger and entry classify identically regardless of wall-clock time.
 *
 * D16/RULE-29: a session bound to two or more task_runs is "mixed" without evaluating any
 * usage_imported state at all -- the per-pair fold (D14) only ever runs for a session
 * with exactly one binding.
 */
export function buildAttributionProjection(input: {
  usageImportedEvents: readonly TraceEvent[];
  sessionBoundEvents: readonly TraceEvent[];
}): AttributionProjection {
  const boundTaskRunsBySession = new Map<string, string[]>();
  for (const e of input.sessionBoundEvents) {
    if (!e.session_id || !e.task_run_id) continue;
    const list = boundTaskRunsBySession.get(e.session_id) ?? [];
    if (!list.includes(e.task_run_id)) list.push(e.task_run_id);
    boundTaskRunsBySession.set(e.session_id, list);
  }

  const latestByPair = resolveLatestUsageImportedByPair(input.usageImportedEvents);

  const measuredSessionIds = new Set<string>();
  for (const e of input.usageImportedEvents) {
    if (e.session_id) measuredSessionIds.add(e.session_id);
  }

  function describe(sessionId: string): SessionAttributionDetail {
    const boundTaskRuns = boundTaskRunsBySession.get(sessionId) ?? [];
    if (boundTaskRuns.length > 1) {
      return { state: "mixed", bindingCount: boundTaskRuns.length };
    }
    if (boundTaskRuns.length === 0) {
      const state = measuredSessionIds.has(sessionId) ? "unbound" : "orphan_usage";
      return { state };
    }
    const taskRunId = boundTaskRuns[0];
    if (taskRunId === undefined) {
      // unreachable: length === 1 here; keeps the indexed access type-safe
      return { state: measuredSessionIds.has(sessionId) ? "unbound" : "orphan_usage" };
    }
    const latest = latestByPair.get(pairKey(taskRunId, sessionId));
    if (!latest) return { state: "never_imported", taskRunId };
    const state = latest.matched ? "exactly_attributed" : "measurement_incomplete";
    return { state, taskRunId };
  }

  return {
    describe,
    classify: (sessionId: string) => describe(sessionId).state,
  };
}

export interface AttributionAuditInput {
  since?: Date;
  until?: Date;
  generatedAt: string;
  /** Full, unfiltered trace ledger -- binding lookups deliberately search the whole
   * ledger regardless of `since`/`until` (a binding recorded before the window is still a
   * valid binding); only `usage_imported` classification is windowed. */
  traceEvents: readonly TraceEvent[];
  /** Every session_id present in the lane's own effective cost_ledger (`session_ids` on
   * any scope:"phase"/"lane" entry) -- the only cross-reference v1's orphan detection can
   * make (M0 spec §4: agent-cost has no session-enumeration API to scan against). */
  ledgerSessionIds: readonly string[];
}

export interface AttributionAuditBuildResult {
  result: AttributionAuditResult;
  /** Honesty/coverage notes -- never part of the schema-conformant `result` itself
   * (attribution/v1 is frozen and fully closed); the CLI prints these to stderr. */
  diagnostics: string[];
}

/** Builds an attribution/v1 audit-result from trace events + ledger session_ids, entirely
 * in memory (no filesystem access) so it's usable both by `lane attribution audit` and by
 * `lane usage-import`'s own auto-run step. */
export function buildAttributionAuditResult(
  input: AttributionAuditInput,
): AttributionAuditBuildResult {
  const until = input.until ?? new Date();
  // A default `since` must still be a real, representable 4-digit-year UTC timestamp
  // (attribution/v1's window.since pattern, unlike Date's own min/max range, has no
  // "unbounded" representation) -- the earliest event on the ledger if one exists,
  // otherwise a trivial nonzero window just before `until` so since < until always holds.
  const since =
    input.since ??
    input.traceEvents.reduce<Date | null>((earliest, e) => {
      const at = new Date(e.occurred_at);
      return earliest === null || at < earliest ? at : earliest;
    }, null) ??
    new Date(until.getTime() - 1000);
  const inWindow = (occurredAt: string) => {
    const ms = Date.parse(occurredAt);
    return ms >= since.getTime() && ms < until.getTime();
  };

  const usageImportedInWindow = input.traceEvents.filter(
    (e) => e.relation === "usage_imported" && inWindow(e.occurred_at),
  );
  const usageBySession = sumUsageBySession(usageImportedInWindow);

  const sessionBoundEvents = input.traceEvents.filter((e) => e.relation === "session_bound");
  const boundTaskRunsBySession = new Map<string, string[]>();
  for (const e of sessionBoundEvents) {
    if (!e.session_id || !e.task_run_id) continue;
    const list = boundTaskRunsBySession.get(e.session_id) ?? [];
    if (!list.includes(e.task_run_id)) list.push(e.task_run_id);
    boundTaskRunsBySession.set(e.session_id, list);
  }

  // I-2026-09-10-agent-cost-v2-basis-gate (D14/D15/D16, RULE-34) -- classification alone
  // now goes through the shared projection; token arithmetic above (usageBySession,
  // sumUsageBySession) is untouched, so tokens.exact_attributed/total_measured
  // below keep summing every in-window event exactly as before this lane (TEST-44/51).
  const projection = buildAttributionProjection({
    usageImportedEvents: usageImportedInWindow,
    sessionBoundEvents,
  });

  const exactlyAttributed: { session_id: string; tokens: number }[] = [];
  const unbound: string[] = [];
  const mixed: string[] = [];
  const measurementIncomplete: string[] = [];
  const violations: AttributionAuditResult["violations"] = [];

  for (const entry of usageBySession.entries()) {
    const sessionId = entry[0];
    const totals = entry[1];
    const boundTaskRuns = boundTaskRunsBySession.get(sessionId) ?? [];
    const state = projection.classify(sessionId);
    if (state === "unbound") {
      unbound.push(sessionId);
      violations.push({
        reason_code: "UNBOUND_SESSION",
        session_id: sessionId,
        detail: `session ${sessionId} has usage_imported events in this window but no session_bound trace event`,
      });
    } else if (state === "mixed") {
      mixed.push(sessionId);
      violations.push({
        reason_code: "MULTI_TASK_BINDING",
        session_id: sessionId,
        detail: `session ${sessionId} is bound to ${boundTaskRuns.length} distinct task_runs: ${boundTaskRuns.join(", ")}`,
      });
    } else if (state === "measurement_incomplete") {
      measurementIncomplete.push(sessionId);
      violations.push({
        reason_code: "MEASUREMENT_INCOMPLETE",
        session_id: sessionId,
        task_run_id: boundTaskRuns[0],
        detail: `agent-cost could not match session ${sessionId} for at least one usage-import window`,
      });
    } else {
      // "exactly_attributed" -- the only remaining reachable state here: this loop only
      // visits sessions with >=1 windowed usage_imported event, so "orphan_usage" (no
      // usage at all) and "never_imported" (bound, but no usage_imported event in scope)
      // cannot occur for a session that is a key of usageBySession.
      exactlyAttributed.push({ session_id: sessionId, tokens: totals.tokens });
    }
  }

  const measuredSessionIds = new Set(usageBySession.keys());
  const boundSessionIds = new Set(boundTaskRunsBySession.keys());
  const orphanUsage: string[] = [];
  for (const sessionId of input.ledgerSessionIds) {
    if (measuredSessionIds.has(sessionId) || boundSessionIds.has(sessionId)) continue;
    orphanUsage.push(sessionId);
    violations.push({
      reason_code: "ORPHAN_USAGE",
      session_id: sessionId,
      detail: `session ${sessionId} appears in the lane's cost_ledger but has no session_bound trace event`,
    });
  }

  const allEmpty =
    exactlyAttributed.length === 0 &&
    unbound.length === 0 &&
    mixed.length === 0 &&
    orphanUsage.length === 0 &&
    measurementIncomplete.length === 0;

  const exactSum = exactlyAttributed.reduce((sum, s) => sum + s.tokens, 0);
  const totalMeasured =
    exactSum +
    unbound.reduce((sum, id) => sum + (usageBySession.get(id)?.tokens ?? 0), 0) +
    mixed.reduce((sum, id) => sum + (usageBySession.get(id)?.tokens ?? 0), 0) +
    measurementIncomplete.reduce((sum, id) => sum + (usageBySession.get(id)?.tokens ?? 0), 0);
  // orphanUsage sessions contribute 0 -- their per-session token count is unknowable in
  // v1 without a usage_imported event this codebase never wrote for them (see diagnostics).

  const diagnostics: string[] = [
    "coverage_scope: orphan_usage detection is limited to this lane's own cost_ledger session_ids " +
      "vs. session_bound trace events -- agent-cost has no session-enumeration API, so a session " +
      "agent-cost knows about but that never touched this lane's ledger or trace ledger cannot be " +
      "detected as orphan by this command (M0 spec §4).",
  ];
  if (orphanUsage.length > 0) {
    diagnostics.push(
      `${orphanUsage.length} orphan_usage session(s) contribute 0 to tokens.total_measured -- their per-session token count is not independently known without a usage_imported trace event.`,
    );
  }
  const boundNeverImported = [...boundSessionIds].filter((id) => !measuredSessionIds.has(id));
  if (boundNeverImported.length > 0) {
    diagnostics.push(
      `${boundNeverImported.length} bound session(s) have no usage_imported event in this window and are excluded from this audit's session universe entirely (never yet usage-imported): ${boundNeverImported.join(", ")}`,
    );
  }

  const result: AttributionAuditResult = {
    schema_version: "attribution/v1",
    generated_at: input.generatedAt,
    window: { since: since.toISOString(), until: until.toISOString() },
    sessions: {
      exactly_attributed: exactlyAttributed,
      unbound,
      mixed,
      orphan_usage: orphanUsage,
      measurement_incomplete: measurementIncomplete,
    },
    tokens: {
      exact_attributed: allEmpty ? null : exactSum,
      total_measured: allEmpty ? null : totalMeasured,
    },
    research_eligible: violations.length === 0,
    violations,
  };

  return { result, diagnostics };
}
