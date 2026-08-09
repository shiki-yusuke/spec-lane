import { AgentCostTelemetryAdapter, TelemetryImportFailed } from "@lane/adapters";
import {
  type WorkActiveEntry,
  appendTraceEvent,
  buildAttributionAuditResult,
  buildPhaseScopedLedgerEntries,
  buildTraceEvent,
  effectiveLedger,
  isDoneOverlayGuarded,
  readTraceEvents,
  recomputeIncludedInKpi,
  upsertLedgerEntry,
  upsertOverlayLedgerEntry,
} from "@lane/core";
import type { LedgerEntry, TraceEvent } from "@lane/schemas";
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

/**
 * `lane usage-import --intent <id>` (M0 spec §3, the G1 pilot's data-collection entry
 * point) — for every active task_run of this intent, measures every session ever bound to
 * it via agent-cost, records `usage_imported`/`attributed_to` trace events per session,
 * and upserts a `scope:"phase"` ledger entry (in-repo, or the done overlay's ledger_delta
 * post-done) from the aggregate measurement. Never zero-fills a session agent-cost
 * couldn't match -- that session's `usage_imported` event carries `matched:false`, which
 * `lane attribution audit` (run automatically at the end, warnings to stderr) turns into a
 * MEASUREMENT_INCOMPLETE finding.
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
  let workingLedger: readonly LedgerEntry[] = doneGuarded
    ? effectiveLedger(specDir, intentId, state)
    : state.cost_ledger;

  const lines: string[] = [];
  const now = new Date();

  for (const taskRun of taskRuns) {
    const sessionIds = boundSessionIdsForTaskRun(taskRun.task_run_id);
    if (sessionIds.length === 0) {
      lines.push(
        `task_run ${taskRun.task_run_id} (phase ${taskRun.phase}): no bound sessions yet, skipped`,
      );
      continue;
    }
    const since = new Date(taskRun.started_at);

    let measurement: Awaited<ReturnType<AgentCostTelemetryAdapter["measure"]>>;
    try {
      measurement = await adapter.measure(sessionIds, { since, until: now });
    } catch (err) {
      // Rule: agent-cost being unable to measure this task_run's sessions is never
      // silently zero-filled into the ledger. Each session still gets an honest
      // usage_imported record (matched:false) so `lane attribution audit` can surface it
      // as MEASUREMENT_INCOMPLETE -- but no ledger entry is written for this task_run.
      for (const sessionId of sessionIds) {
        recordUsageImportedAndAttributedTo(
          taskRun.task_run_id,
          sessionId,
          since,
          now,
          0,
          false,
          toolVersion,
        );
      }
      const detail = err instanceof TelemetryImportFailed ? err.message : String(err);
      lines.push(
        `task_run ${taskRun.task_run_id} (phase ${taskRun.phase}): agent-cost measure FAILED (${detail}) -- ${sessionIds.length} session(s) recorded as measurement-incomplete, no ledger entry written`,
      );
      continue;
    }

    for (const sessionId of sessionIds) {
      const sessionResult = measurement.sessions[sessionId];
      recordUsageImportedAndAttributedTo(
        taskRun.task_run_id,
        sessionId,
        since,
        now,
        sessionResult?.totals.tokens ?? 0,
        sessionResult?.matched ?? false,
        toolVersion,
      );
    }

    const ledgerEntries = buildPhaseScopedLedgerEntries({
      laneId: intentId,
      phase: taskRun.phase as never,
      measurement,
      since,
      until: now,
      importedAt: now.toISOString(),
    });
    for (const entry of ledgerEntries) workingLedger = upsertLedgerEntry(workingLedger, entry);
    workingLedger = recomputeIncludedInKpi([...workingLedger]);
    for (const entry of ledgerEntries) {
      const recomputed =
        workingLedger.find((e) => e.ledger_entry_id === entry.ledger_entry_id) ?? entry;
      if (doneGuarded) {
        upsertOverlayLedgerEntry(specDir, intentId, recomputed);
      }
      lines.push(
        `task_run ${taskRun.task_run_id} (phase ${taskRun.phase}): ledger entry ${recomputed.ledger_entry_id} agents=${recomputed.agents?.join("+")} tokens=${recomputed.tokens} included_in_kpi=${recomputed.included_in_kpi}`,
      );
    }
  }

  if (!doneGuarded) {
    writeLaneState(specDir, intentId, { ...state, cost_ledger: [...workingLedger] });
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
