import {
  AmbiguousActiveTaskRunError,
  NoActiveTaskRunError,
  TaskRunNotFoundError,
  type WorkActiveEntry,
  appendTraceEvent,
  appendWorkActiveEntry,
  buildTraceEvent,
  generatePhaseRunId,
  generateTaskRunId,
  readTraceEvents,
  readWorkActiveFile,
  resolveActiveTaskRun,
} from "@lane/core";
import type { TraceEvent } from "@lane/schemas";
import { intentExists } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import {
  WrapperBindConflictError,
  WrapperBindTimeoutError,
  WrapperUnsupportedCommandError,
  detectWrapperAgent,
  runWrapperBind,
} from "../wrapper-bind.js";
import type { CommandResult } from "./start.js";

const CLI_ACTOR = { kind: "cli" as const, id: "lane" };

function actorWithVersion(toolVersion: string) {
  return { ...CLI_ACTOR, version: toolVersion };
}

/** Idempotent: re-emitting the same task_run_started fact is harmless (deterministic
 * event_id), so this is called unconditionally rather than checked-then-emitted. */
function ensureTaskRunStarted(
  entry: Pick<WorkActiveEntry, "task_run_id" | "intent_id">,
  occurredAt: string,
  toolVersion: string,
): TraceEvent {
  const event = buildTraceEvent({
    relation: "task_run_started",
    fromRef: { logical_id: `lane:${entry.intent_id}` },
    toRef: { logical_id: `task_run:${entry.task_run_id}` },
    occurredAt,
    actor: actorWithVersion(toolVersion),
    laneId: entry.intent_id,
    taskRunId: entry.task_run_id,
  });
  appendTraceEvent(event);
  return event;
}

export interface WorkStartOptions {
  specDir?: string;
  label?: string;
  toolVersion?: string;
  cwd?: string;
}

/**
 * `lane work start --intent <id> --phase <phase> [--label <text>]` — issues one
 * task_run_id/phase_run_id pair, records `task_run_started` to the trace ledger, and adds
 * this task_run to the repo's active-work-context file (M0 spec §2). Never touches
 * lane-state.json.
 */
export function runWorkStart(
  intentId: string,
  phase: string,
  opts: WorkStartOptions,
): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir, cwd: opts.cwd });
  if (!intentExists(specDir, intentId)) {
    return { exitCode: 2, message: `intent.yaml not found for ${intentId}` };
  }
  const repoPath = opts.cwd ?? process.cwd();
  const toolVersion = opts.toolVersion ?? "0.0.0";
  const now = new Date().toISOString();

  const entry: WorkActiveEntry = {
    task_run_id: generateTaskRunId(),
    phase_run_id: generatePhaseRunId(),
    intent_id: intentId,
    phase,
    label: opts.label,
    started_at: now,
    repo_path: repoPath,
  };
  ensureTaskRunStarted(entry, now, toolVersion);
  appendWorkActiveEntry(repoPath, entry);

  return {
    exitCode: 0,
    message: [
      `Started task_run ${entry.task_run_id} (phase_run ${entry.phase_run_id}) for ${intentId} @ ${phase}`,
      "Next: `lane work run --intent <id> --phase <phase> -- <agent-cmd...>` to spawn a wrapped claude/codex session,",
      "or `lane work bind --intent <id> --session-id <id> --agent <claude|codex>` for a session you started yourself.",
    ].join("\n"),
  };
}

function describeResolveError(err: unknown): CommandResult {
  if (err instanceof NoActiveTaskRunError) return { exitCode: 2, message: err.message };
  if (err instanceof AmbiguousActiveTaskRunError) return { exitCode: 2, message: err.message };
  if (err instanceof TaskRunNotFoundError) return { exitCode: 2, message: err.message };
  throw err;
}

/** Detects a session_id already bound to a *different* task_run_id -- prints a warning
 * (stderr, via the caller) but never blocks the append (M0 spec §2: "bind 自体は追記され
 * る -- append-only、判定は audit の仕事"). */
function detectMultiTaskBinding(sessionId: string, taskRunId: string): string | null {
  const conflicting = readTraceEvents().find(
    (e) =>
      e.relation === "session_bound" && e.session_id === sessionId && e.task_run_id !== taskRunId,
  );
  return conflicting
    ? `MULTI_TASK_BINDING: session ${sessionId} was previously bound to task_run ${conflicting.task_run_id}; now also bound to ${taskRunId}. Both task_runs will be flagged "mixed" by \`lane attribution audit\`.`
    : null;
}

export interface WorkBindOptions {
  specDir?: string;
  sessionId: string;
  agent: "claude" | "codex";
  taskRunId?: string;
  toolVersion?: string;
  cwd?: string;
}

/**
 * `lane work bind --intent <id> --session-id <id> --agent <claude|codex>` — manual bind
 * for a session started outside `lane work run` (binding_method=manual_bind,
 * actor.kind=human per attribution-v1.md's schema-enforced requirement).
 */
export function runWorkBind(intentId: string, opts: WorkBindOptions): CommandResult {
  const repoPath = opts.cwd ?? process.cwd();
  let entry: WorkActiveEntry;
  try {
    entry = resolveActiveTaskRun(repoPath, { taskRunId: opts.taskRunId });
  } catch (err) {
    return describeResolveError(err);
  }
  if (entry.intent_id !== intentId) {
    return {
      exitCode: 2,
      message: `active task_run ${entry.task_run_id} belongs to intent ${entry.intent_id}, not ${intentId} -- pass --task-run to select the right one`,
    };
  }

  const now = new Date().toISOString();
  const toolVersion = opts.toolVersion ?? "0.0.0";
  const warning = detectMultiTaskBinding(opts.sessionId, entry.task_run_id);

  const event = buildTraceEvent({
    relation: "session_bound",
    fromRef: { logical_id: `task_run:${entry.task_run_id}` },
    toRef: { logical_id: `session:${opts.sessionId}` },
    occurredAt: now,
    actor: { kind: "human" },
    laneId: entry.intent_id,
    taskRunId: entry.task_run_id,
    sessionId: opts.sessionId,
    payload: {
      binding_method: "manual_bind",
      agent: opts.agent,
      tool: "lane",
      tool_version: toolVersion,
    },
  });
  appendTraceEvent(event);

  const lines = [`Bound session ${opts.sessionId} to task_run ${entry.task_run_id} (manual_bind)`];
  if (warning) lines.push(warning);
  return { exitCode: 0, message: lines.join("\n") };
}

export interface WorkRunOptions {
  specDir?: string;
  taskRunId?: string;
  toolVersion?: string;
  cwd?: string;
  bindTimeoutMs?: number;
}

/**
 * `lane work run --intent <id> --phase <phase> -- <agent-cmd...>` — spawns the given
 * claude/codex command via the wrapper-binding strategy (design.md/attribution-v1.md's
 * spike result), records `session_bound` once binding is confirmed, and transparently
 * propagates the child's exit code. `phase` (like `intent`) is a disambiguation check
 * against the resolved active task_run, not a fresh `lane work start` -- a task_run's
 * phase is fixed at `lane work start` time.
 */
export async function runWorkRun(
  intentId: string,
  phase: string,
  agentCmd: readonly string[],
  opts: WorkRunOptions,
): Promise<CommandResult> {
  if (agentCmd.length === 0) {
    return { exitCode: 1, message: "lane work run requires an agent command after `--`" };
  }
  if (detectWrapperAgent(agentCmd[0] as string) === null) {
    return {
      exitCode: 1,
      message: `lane work run only wraps claude/codex (got: ${agentCmd[0]}) -- use \`lane work bind\` for any other agent's manually-started session`,
    };
  }

  const repoPath = opts.cwd ?? process.cwd();
  let entry: WorkActiveEntry;
  try {
    entry = resolveActiveTaskRun(repoPath, { taskRunId: opts.taskRunId });
  } catch (err) {
    return describeResolveError(err);
  }
  if (entry.intent_id !== intentId) {
    return {
      exitCode: 2,
      message: `active task_run ${entry.task_run_id} belongs to intent ${entry.intent_id}, not ${intentId} -- pass --task-run to select the right one`,
    };
  }
  if (entry.phase !== phase) {
    return {
      exitCode: 2,
      message: `active task_run ${entry.task_run_id} was started at phase ${entry.phase}, not ${phase} -- pass --task-run to select the right one`,
    };
  }

  const toolVersion = opts.toolVersion ?? "0.0.0";
  ensureTaskRunStarted(entry, new Date().toISOString(), toolVersion);

  let bindResult: Awaited<ReturnType<typeof runWrapperBind>>;
  try {
    bindResult = await runWrapperBind(agentCmd[0] as string, agentCmd.slice(1), {
      cwd: repoPath,
      bindTimeoutMs: opts.bindTimeoutMs,
    });
  } catch (err) {
    if (
      err instanceof WrapperBindTimeoutError ||
      err instanceof WrapperBindConflictError ||
      err instanceof WrapperUnsupportedCommandError
    ) {
      return { exitCode: 2, message: err.message };
    }
    return { exitCode: 2, message: err instanceof Error ? err.message : String(err) };
  }

  const warning = detectMultiTaskBinding(bindResult.sessionId, entry.task_run_id);
  const boundEvent = buildTraceEvent({
    relation: "session_bound",
    fromRef: { logical_id: `task_run:${entry.task_run_id}` },
    toRef: { logical_id: `session:${bindResult.sessionId}` },
    occurredAt: new Date().toISOString(),
    actor: actorWithVersion(toolVersion),
    laneId: entry.intent_id,
    taskRunId: entry.task_run_id,
    sessionId: bindResult.sessionId,
    payload: {
      binding_method: bindResult.bindingMethod,
      agent: bindResult.agent,
      tool: "lane",
      tool_version: toolVersion,
    },
  });
  appendTraceEvent(boundEvent);
  if (warning) process.stderr.write(`${warning}\n`);

  const exitCode = await bindResult.exitCode;
  return {
    exitCode,
    message: `session ${bindResult.sessionId} bound to task_run ${entry.task_run_id} (${bindResult.bindingMethod}); child exited ${exitCode}`,
  };
}

/** Used by `lane usage-import`/`lane attribution audit` to enumerate active task_runs for
 * a given intent (M0 spec §3's "対象 lane の全 task_run × bound sessions"). */
export function listActiveTaskRunsForIntent(repoPath: string, intentId: string): WorkActiveEntry[] {
  return readWorkActiveFile(repoPath).entries.filter((e) => e.intent_id === intentId);
}
