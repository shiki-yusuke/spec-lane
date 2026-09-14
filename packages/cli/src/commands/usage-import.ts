import { AgentCostTelemetryAdapter, TelemetryImportFailed } from "@lane/adapters";
import {
  type WorkActiveEntry,
  appendTraceEvent,
  buildAttributionAuditResult,
  buildAttributionProjection,
  buildPhaseScopedLedgerEntries,
  buildTraceEvent,
  effectiveLedger,
  isDoneOverlayGuarded,
  normalizeEntryBasis,
  planBasisSupersession,
  readTraceEvents,
  recomputeIncludedInKpi,
  upsertLedgerEntry,
  upsertOverlayLedgerEntry,
} from "@lane/core";
import type { AgentCostMeasureResult, LedgerEntry, TraceEvent } from "@lane/schemas";
import { effectiveLedgerSessionIds } from "../attribution-store.js";
import { intentExists } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, readLaneState, writeLaneState } from "../state-store.js";
import type { CommandResult } from "./start.js";
import { listActiveTaskRunsForIntent } from "./work.js";

export interface UsageImportOptions {
  specDir?: string;
  agentCostBin?: string;
  toolVersion?: string;
  cwd?: string;
  /** I-2026-09-10-agent-cost-v2-basis-gate (RULE-16/17) -- explicit opt-in to record a
   * re-measurement under a different accounting_basis as a superseding entry (basis_history
   * appended) instead of refusing the whole run. */
  supersedeBasis?: boolean;
}

/** Every distinct session_id ever bound to `taskRunId` (any binding_method, regardless of
 * later supersession -- usage-import still measures a session that was later rebound
 * elsewhere; `lane attribution audit` is what judges that as "mixed"). */
function boundSessionIdsForTaskRun(taskRunId: string): string[] {
  const ids = new Set<string>();
  for (const e of readTraceEvents()) {
    if (e.relation === "session_bound" && e.task_run_id === taskRunId && e.session_id) {
      ids.add(e.session_id);
    }
  }
  return [...ids];
}

function recordUsageImportedAndAttributedTo(
  taskRunId: string,
  sessionId: string,
  since: Date,
  until: Date,
  tokens: number,
  matched: boolean,
  toolVersion: string,
): TraceEvent {
  const usageImported = buildTraceEvent({
    relation: "usage_imported",
    fromRef: { logical_id: `session:${sessionId}` },
    toRef: { logical_id: `task_run:${taskRunId}` },
    occurredAt: new Date().toISOString(),
    actor: { kind: "cli", id: "lane", version: toolVersion },
    taskRunId,
    sessionId,
    payload: {
      window: { since: since.toISOString(), until: until.toISOString() },
      tokens,
      matched,
    },
  });
  appendTraceEvent(usageImported);

  const usageLogicalId = `usage:${sessionId}:${since.toISOString()}..${until.toISOString()}`;
  appendTraceEvent(
    buildTraceEvent({
      relation: "attributed_to",
      fromRef: { logical_id: usageLogicalId },
      toRef: { logical_id: `task_run:${taskRunId}` },
      occurredAt: new Date().toISOString(),
      actor: { kind: "cli", id: "lane", version: toolVersion },
      taskRunId,
    }),
  );
  return usageImported;
}

// I-2026-09-10-agent-cost-v2-basis-gate (D8) -- the preflight step (2) only needs a
// provisional entry's ledger_entry_id/accounting_basis/producer_version, none of which
// depend on the attribution projection; its (wrong, discarded) reasons never leave this
// module. A shared empty projection avoids rebuilding one per phase for that purpose.
const EMPTY_ATTRIBUTION_PROJECTION = buildAttributionProjection({
  usageImportedEvents: [],
  sessionBoundEvents: [],
});

interface StagedPhase {
  phase: string;
  taskRunsInPhase: WorkActiveEntry[];
  sessionIdsByTaskRun: Map<string, string[]>;
  taskRunIdsLabel: string;
  since: Date;
  until: Date;
  measurement: AgentCostMeasureResult;
}

interface FailedPhase {
  phase: string;
  taskRunsInPhase: WorkActiveEntry[];
  sessionIdsByTaskRun: Map<string, string[]>;
  taskRunIdsLabel: string;
  sessionCount: number;
  since: Date;
  until: Date;
  detail: string;
}

/**
 * `lane usage-import --intent <id>` (M0 spec §3, the G1 pilot's data-collection entry
 * point) — for every active task_run of this intent, measures every session ever bound to
 * it via agent-cost, records `usage_imported`/`attributed_to` trace events per session,
 * and upserts a `scope:"phase"` ledger entry (in-repo, or the done overlay's ledger_delta
 * post-done) from the aggregate measurement. Never zero-fills a session agent-cost
 * couldn't match -- that session's `usage_imported` event carries `matched:false`, which
 * `lane attribution audit` (run automatically at the end, warnings to stderr) turns into a
 * MEASUREMENT_INCOMPLETE finding.
 *
 * I-2026-09-10-agent-cost-v2-basis-gate (D8, revised -- sol must-3) -- one pass, in this
 * order: (1) measure every phase and stage the results in memory, writing nothing; (2)
 * preflight -- compute every entry id and compare each against the existing entry's
 * normalized accounting_basis, for all phases; (3) if any conflict is unresolved, refuse,
 * with no file touched at all (RULE-16/33/38); (4) otherwise append this run's
 * usage_imported/attributed_to events; (5) derive the attribution projection once,
 * window-independent (RULE-24); (6) build entries with their reasons; (7) write
 * lane-state.json (or the overlay's ledger_delta) once.
 */
export async function runUsageImport(
  intentId: string,
  opts: UsageImportOptions,
): Promise<CommandResult> {
  const specDir = resolveSpecDir({ override: opts.specDir, cwd: opts.cwd });
  if (!laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: `Lane state not found: ${intentId}` };
  }
  if (!intentExists(specDir, intentId)) {
    return { exitCode: 2, message: `intent.yaml not found for ${intentId}` };
  }
  const repoPath = opts.cwd ?? process.cwd();
  const toolVersion = opts.toolVersion ?? "0.0.0";
  const supersedeBasis = opts.supersedeBasis ?? false;

  const taskRuns: WorkActiveEntry[] = listActiveTaskRunsForIntent(repoPath, intentId);
  if (taskRuns.length === 0) {
    return {
      exitCode: 2,
      message: `no active task_run for ${intentId} in this repo -- run \`lane work start\` first`,
    };
  }

  const adapter = new AgentCostTelemetryAdapter({ bin: opts.agentCostBin });
  const state = readLaneState(specDir, intentId);
  const doneGuarded = isDoneOverlayGuarded(specDir, intentId, state);
  const workingLedger: readonly LedgerEntry[] = doneGuarded
    ? effectiveLedger(specDir, intentId, state)
    : state.cost_ledger;

  const lines: string[] = [];
  const now = new Date();

  // gpt-5.4 review must1: computeLedgerEntryId keys only on (lane_id, phase, source,
  // pricing_version) -- never task_run_id (that id contract is frozen, Python parity) --
  // so two concurrent task_runs in the same phase writing their own separate ledger
  // entries would silently overwrite each other (second call wins, first task_run's
  // tokens/session_ids vanish). Aggregating at the phase level instead: one agent-cost
  // measure call per phase, covering the union of every one of that phase's task_runs'
  // bound sessions, producing one ledger entry per agent for the whole phase
  // (session_ids = that union). A rerun -- even after a new concurrent task_run joins the
  // phase -- converges to the same union under the same entry id, so this stays an
  // idempotent upsert; the per-task_run breakdown lives in the trace ledger's
  // usage_imported events (recorded per (task_run, session) pair below), never in the
  // ledger entry itself.
  const taskRunsByPhase = new Map<string, WorkActiveEntry[]>();
  for (const taskRun of taskRuns) {
    const list = taskRunsByPhase.get(taskRun.phase) ?? [];
    list.push(taskRun);
    taskRunsByPhase.set(taskRun.phase, list);
  }

  // Step 1: stage every phase's measurement. Nothing is written yet.
  const staged: StagedPhase[] = [];
  const failedPhases: FailedPhase[] = [];

  for (const [phase, taskRunsInPhase] of taskRunsByPhase) {
    const sessionIdsByTaskRun = new Map<string, string[]>();
    const unionSessionIds = new Set<string>();
    for (const taskRun of taskRunsInPhase) {
      const ids = boundSessionIdsForTaskRun(taskRun.task_run_id);
      sessionIdsByTaskRun.set(taskRun.task_run_id, ids);
      for (const id of ids) unionSessionIds.add(id);
    }
    const taskRunIdsLabel = taskRunsInPhase.map((t) => t.task_run_id).join(", ");
    if (unionSessionIds.size === 0) {
      lines.push(`phase ${phase} (task_run(s) ${taskRunIdsLabel}): no bound sessions yet, skipped`);
      continue;
    }
    const sessionIds = [...unionSessionIds];
    // Earliest of the phase's task_runs -- the union measure call must cover every one of
    // them, not just whichever started last.
    const since = new Date(
      Math.min(...taskRunsInPhase.map((t) => new Date(t.started_at).getTime())),
    );
    // CI flake fix (0.5.1): `since` and the wall-clock `now` captured at the top of this
    // function are two genuinely distinct instants -- work started, then (at least) this
    // function's own setup ran -- but `Date`'s millisecond resolution can round them to the
    // same value on a fast enough run. trace/v1's window_ordering_invalid check (strict
    // since<until, frozen contract) is correct to reject that; nudging `until` forward by
    // the minimum representable step corrects only the resolution artifact.
    const until = now.getTime() > since.getTime() ? now : new Date(since.getTime() + 1);

    try {
      const measurement = await adapter.measure(sessionIds, { since, until });
      staged.push({
        phase,
        taskRunsInPhase,
        sessionIdsByTaskRun,
        taskRunIdsLabel,
        since,
        until,
        measurement,
      });
    } catch (err) {
      const detail = err instanceof TelemetryImportFailed ? err.message : String(err);
      failedPhases.push({
        phase,
        taskRunsInPhase,
        sessionIdsByTaskRun,
        taskRunIdsLabel,
        sessionCount: sessionIds.length,
        since,
        until,
        detail,
      });
    }
  }

  // Step 2: preflight -- compute every entry id for every successfully staged phase and
  // compare its normalized accounting_basis against the existing entry's, if any
  // (RULE-15). D23: a phase whose measurement failed contributes no payload and therefore
  // no conflict.
  const conflictDiagnostics: string[] = [];
  for (const s of staged) {
    const provisionalEntries = buildPhaseScopedLedgerEntries({
      laneId: intentId,
      phase: s.phase as never,
      measurement: s.measurement,
      since: s.since,
      until: s.until,
      importedAt: now.toISOString(),
      attribution: EMPTY_ATTRIBUTION_PROJECTION,
    });
    for (const provisional of provisionalEntries) {
      const existing = workingLedger.find((e) => e.ledger_entry_id === provisional.ledger_entry_id);
      const plan = planBasisSupersession({ existing, incoming: provisional, supersedeBasis });
      if (plan.action === "refuse") {
        conflictDiagnostics.push(`phase ${s.phase}: ${plan.diagnostic}`);
      }
    }
  }

  // Step 3: any unresolved conflict refuses the whole run -- no file touched at all
  // (D11/RULE-16/33/38). The diagnostic also names every phase whose measurement failed
  // in this same run, so the operator sees the full picture in one refusal.
  if (conflictDiagnostics.length > 0) {
    const messageLines = [...conflictDiagnostics];
    if (failedPhases.length > 0) {
      const failedPhaseNames = failedPhases.map((f) => f.phase).join(", ");
      messageLines.push(`measurement also failed in this run for phase(s): ${failedPhaseNames}`);
    }
    return { exitCode: 1, message: messageLines.join("\n") };
  }

  // Step 4: no conflicts -- append this run's trace events. Both the phases whose
  // measurement failed (an honest matched:false record, never a silent zero-fill, exactly
  // as before this lane) and the successfully-measured ones.
  for (const f of failedPhases) {
    for (const taskRun of f.taskRunsInPhase) {
      for (const sessionId of f.sessionIdsByTaskRun.get(taskRun.task_run_id) ?? []) {
        recordUsageImportedAndAttributedTo(
          taskRun.task_run_id,
          sessionId,
          f.since,
          f.until,
          0,
          false,
          toolVersion,
        );
      }
    }
    lines.push(
      `phase ${f.phase} (task_run(s) ${f.taskRunIdsLabel}): agent-cost measure FAILED (${f.detail}) -- ${f.sessionCount} session(s) recorded as measurement-incomplete, no ledger entry written`,
    );
  }

  for (const s of staged) {
    for (const taskRun of s.taskRunsInPhase) {
      for (const sessionId of s.sessionIdsByTaskRun.get(taskRun.task_run_id) ?? []) {
        const sessionResult = s.measurement.sessions[sessionId];
        recordUsageImportedAndAttributedTo(
          taskRun.task_run_id,
          sessionId,
          s.since,
          s.until,
          sessionResult?.totals.tokens ?? 0,
          sessionResult?.matched ?? false,
          toolVersion,
        );
      }
    }
  }

  // Step 5: derive the attribution projection once, after this run's events are appended
  // and before any ledger write (RULE-15) -- window-independent, unfiltered (RULE-24).
  const allTraceEvents = readTraceEvents();
  const attribution = buildAttributionProjection({
    usageImportedEvents: allTraceEvents.filter((e) => e.relation === "usage_imported"),
    sessionBoundEvents: allTraceEvents.filter((e) => e.relation === "session_bound"),
  });

  // Step 6: build the final entries (with correct reasons) and upsert them.
  let nextLedger: LedgerEntry[] = [...workingLedger];
  const writtenEntriesByPhase = new Map<string, LedgerEntry[]>();
  for (const s of staged) {
    const finalEntries = buildPhaseScopedLedgerEntries({
      laneId: intentId,
      phase: s.phase as never,
      measurement: s.measurement,
      since: s.since,
      until: s.until,
      importedAt: now.toISOString(),
      attribution,
    });
    const written: LedgerEntry[] = [];
    for (const entry of finalEntries) {
      const existing = nextLedger.find((e) => e.ledger_entry_id === entry.ledger_entry_id);
      const plan = planBasisSupersession({ existing, incoming: entry, supersedeBasis });
      const toWrite = plan.action === "write" ? plan.entry : entry;
      nextLedger = upsertLedgerEntry(nextLedger, toWrite);
      written.push(toWrite);
    }
    writtenEntriesByPhase.set(s.phase, written);
  }
  nextLedger = recomputeIncludedInKpi(nextLedger);

  for (const s of staged) {
    const written = writtenEntriesByPhase.get(s.phase) ?? [];
    for (const entry of written) {
      const recomputed =
        nextLedger.find((e) => e.ledger_entry_id === entry.ledger_entry_id) ?? entry;
      if (doneGuarded) {
        upsertOverlayLedgerEntry(specDir, intentId, recomputed);
      }
      lines.push(
        `phase ${s.phase} (task_run(s) ${s.taskRunIdsLabel}): ledger entry ${recomputed.ledger_entry_id} ` +
          `agents=${recomputed.agents?.join("+")} tokens=${recomputed.tokens} ` +
          `session_ids=${recomputed.session_ids.length} included_in_kpi=${recomputed.included_in_kpi} ` +
          `accounting_basis=${normalizeEntryBasis(recomputed).accountingBasis}`,
      );
    }
  }

  // Step 7: write lane-state.json once (the overlay's ledger_delta was already written
  // per-entry above, matching its own existing upsert semantics).
  if (!doneGuarded) {
    writeLaneState(specDir, intentId, { ...state, cost_ledger: [...nextLedger] });
  }

  // Auto-run attribution audit (M0 spec §3) -- warnings to stderr, never blocking.
  const finalState = readLaneState(specDir, intentId);
  const { result: audit, diagnostics } = buildAttributionAuditResult({
    generatedAt: new Date().toISOString(),
    traceEvents: readTraceEvents(),
    ledgerSessionIds: effectiveLedgerSessionIds(specDir, intentId, finalState),
  });
  for (const d of diagnostics) process.stderr.write(`${d}\n`);
  if (!audit.research_eligible) {
    process.stderr.write(
      `attribution audit: research_eligible=false (${audit.violations.length} violation(s)) -- run \`lane attribution audit\` for details\n`,
    );
  }

  return { exitCode: 0, message: lines.join("\n") };
}
