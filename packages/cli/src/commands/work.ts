import { realpathSync } from "node:fs";
import {
  AmbiguousActiveTaskRunError,
  NoActiveTaskRunError,
  TaskRunNotFoundError,
  type WorkActiveEntry,
  appendTraceEvent,
  appendWorkActiveEntry,
  buildTraceEvent,
  doneOverlayExistsOutside,
  generatePhaseRunId,
  generateTaskRunId,
  inspectDoneOverlay,
  readTraceEvents,
  readWorkActiveFile,
  resolveActiveTaskRun,
} from "@lane/core";
import {
  RETROACTIVE_REASON_CODES,
  type RetroactivePayloadFields,
  RetroactivePayloadFieldsSchema,
  type TraceEvent,
} from "@lane/schemas";
import { extractAgentInvocationCapture } from "../agent-invocation-capture.js";
import { intentExists } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { LANE_VERSION } from "../version.js";
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

/** I-2026-11-09 (design 3) -- the `--retroactive --reason <code>` pair as the CLI passed
 * it, before validation. */
export interface RetroactiveOptions {
  retroactive?: boolean;
  reason?: string;
}

type RetroactiveCheck =
  | { ok: true; fields: RetroactivePayloadFields | null }
  | { ok: false; result: CommandResult };

/**
 * I-2026-11-09 (design 3) -- the done gate for `lane work start|bind`. An intent with a
 * done overlay refuses the ordinary command (a late bind would otherwise read as an
 * ordinary, k-NN-eligible attribution); `--retroactive --reason <code>` records it for
 * audit only. The flag pair is valid only together, only with a listed reason code, and
 * only against a done intent. An unreadable overlay fails closed (never treated as
 * "not done").
 */
/** Flag-pair validation only (no overlay read) -- run before anything else so a bad
 * flag combination fails the same way whatever the active-context state is. */
function parseRetroactiveFlags(opts: RetroactiveOptions): RetroactiveCheck {
  const fail = (message: string): RetroactiveCheck => ({
    ok: false,
    result: { exitCode: 2, message },
  });
  const codes = RETROACTIVE_REASON_CODES.join("|");
  const retroactive = opts.retroactive === true;
  if (retroactive && opts.reason === undefined) {
    return fail(`--retroactive requires --reason <${codes}>`);
  }
  if (!retroactive && opts.reason !== undefined) {
    return fail("--reason is only valid together with --retroactive");
  }
  let fields: RetroactivePayloadFields | null = null;
  if (retroactive) {
    const parsed = RetroactivePayloadFieldsSchema.safeParse({
      retroactive: true,
      retroactive_reason_code: opts.reason,
    });
    if (!parsed.success) {
      return fail(`--reason must be one of ${codes} (got: ${opts.reason})`);
    }
    fields = parsed.data;
  }
  return { ok: true, fields };
}

function checkRetroactive(
  specDir: string,
  intentId: string,
  command: "start" | "bind" | "run",
  opts: RetroactiveOptions,
): RetroactiveCheck {
  const flags = parseRetroactiveFlags(opts);
  if (!flags.ok) return flags;
  const { fields } = flags;
  const retroactive = fields !== null;
  const fail = (message: string): RetroactiveCheck => ({
    ok: false,
    result: { exitCode: 2, message },
  });
  const codes = RETROACTIVE_REASON_CODES.join("|");

  const overlay = inspectDoneOverlay(specDir, intentId);
  if (overlay.kind === "unreadable") {
    return fail(
      `done overlay for ${intentId} is unreadable (${overlay.path}: ${overlay.reason}) -- refusing lane work ${command}`,
    );
  }
  const done = overlay.kind === "valid";
  if (done && !retroactive) {
    const hint =
      command === "run"
        ? `record a session that already ran with lane work start|bind --retroactive --reason <${codes}> (audit only, never k-NN eligible)`
        : `to record a missed binding for audit only (never k-NN eligible), pass --retroactive --reason <${codes}>`;
    return fail(
      `${intentId} is already done -- lane work ${command} after done is refused; ${hint}`,
    );
  }
  if (!done && retroactive) {
    return fail(
      `${intentId} is not done -- --retroactive is only for recording a binding after done; use plain lane work ${command}`,
    );
  }
  return { ok: true, fields };
}

/**
 * I-2026-11-09 (review fix 1) -- which spec dir `lane work bind|run` checks the done gate
 * against. The active entry carries the canonical spec dir `lane work start` resolved;
 * the done gate reads that, never a dir the later caller chose (an empty --spec-dir
 * elsewhere would otherwise hide the done overlay). A caller-resolved spec dir that does
 * not canonicalize to the stored value is refused. Entries written before `spec_dir`
 * existed fall back to the caller-resolved dir (read compatibility), which must contain
 * the intent, and a done overlay for the intent under any other spec dir fails closed.
 */
function doneGateSpecDir(
  entry: WorkActiveEntry,
  command: "bind" | "run",
  opts: { specDir?: string; cwd?: string },
): { ok: true; specDir: string } | { ok: false; result: CommandResult } {
  const requested = resolveSpecDir({ override: opts.specDir, cwd: opts.cwd });
  if (entry.spec_dir === undefined) {
    // Legacy entry: the caller-resolved dir must at least hold this intent, so an empty or
    // unrelated --spec-dir cannot hide the done overlay.
    if (!intentExists(requested, entry.intent_id)) {
      return {
        ok: false,
        result: {
          exitCode: 2,
          message: `spec dir ${requested} does not contain intent ${entry.intent_id} (task_run ${entry.task_run_id} predates spec dir pinning) -- refusing lane work ${command}`,
        },
      };
    }
    if (doneOverlayExistsOutside(requested, entry.intent_id)) {
      return {
        ok: false,
        result: {
          exitCode: 2,
          message: `${entry.intent_id} has a done overlay recorded under a different spec dir than ${requested} (task_run ${entry.task_run_id} predates spec dir pinning) -- refusing lane work ${command}`,
        },
      };
    }
    return { ok: true, specDir: requested };
  }
  let canonical: string | null;
  try {
    canonical = realpathSync(requested);
  } catch {
    canonical = null;
  }
  if (canonical !== entry.spec_dir) {
    return {
      ok: false,
      result: {
        exitCode: 2,
        message: `spec dir ${requested} does not match ${entry.spec_dir}, the spec dir task_run ${entry.task_run_id} was started with -- refusing lane work ${command}`,
      },
    };
  }
  return { ok: true, specDir: entry.spec_dir };
}

/** Idempotent: re-emitting the same task_run_started fact is harmless (deterministic
 * event_id), so this is called unconditionally rather than checked-then-emitted. */
function ensureTaskRunStarted(
  entry: Pick<WorkActiveEntry, "task_run_id" | "intent_id">,
  occurredAt: string,
  toolVersion: string,
  retroactiveFields: RetroactivePayloadFields | null = null,
): TraceEvent {
  const event = buildTraceEvent({
    relation: "task_run_started",
    fromRef: { logical_id: `lane:${entry.intent_id}` },
    toRef: { logical_id: `task_run:${entry.task_run_id}` },
    occurredAt,
    actor: actorWithVersion(toolVersion),
    laneId: entry.intent_id,
    taskRunId: entry.task_run_id,
    ...(retroactiveFields ? { payload: { ...retroactiveFields } } : {}),
  });
  appendTraceEvent(event);
  return event;
}

export interface WorkStartOptions extends RetroactiveOptions {
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
  const retro = checkRetroactive(specDir, intentId, "start", opts);
  if (!retro.ok) return retro.result;
  const repoPath = opts.cwd ?? process.cwd();
  const toolVersion = opts.toolVersion ?? LANE_VERSION;
  const now = new Date().toISOString();

  const entry: WorkActiveEntry = {
    task_run_id: generateTaskRunId(),
    phase_run_id: generatePhaseRunId(),
    intent_id: intentId,
    phase,
    label: opts.label,
    started_at: now,
    repo_path: repoPath,
    // review fix 1: bind/run check done against this, not their own --spec-dir.
    spec_dir: realpathSync(specDir),
  };
  ensureTaskRunStarted(entry, now, toolVersion, retro.fields);
  appendWorkActiveEntry(repoPath, entry);

  return {
    exitCode: 0,
    message: [
      `Started task_run ${entry.task_run_id} (phase_run ${entry.phase_run_id}) for ${intentId} @ ${phase}${retro.fields ? ` (retroactive: ${retro.fields.retroactive_reason_code})` : ""}`,
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

export interface WorkBindOptions extends RetroactiveOptions {
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
  const flags = parseRetroactiveFlags(opts);
  if (!flags.ok) return flags.result;
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
  const gate = doneGateSpecDir(entry, "bind", opts);
  if (!gate.ok) return gate.result;
  const retro = checkRetroactive(gate.specDir, intentId, "bind", opts);
  if (!retro.ok) return retro.result;

  const now = new Date().toISOString();
  const toolVersion = opts.toolVersion ?? LANE_VERSION;
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
      // requested-model/effort capture fix (2026-08-29): a manual_bind session was started
      // by the caller outside `lane work run` -- there is no argv here to inspect, so both
      // values are always null with capture_status="absent" (never a guess).
      requested_model: null,
      requested_reasoning_effort: null,
      capture_status: "absent",
      // I-2026-11-09 (design 3): occurred_at above stays the recording time; the
      // retroactive marker is what tells audit/k-NN this bind came after done.
      ...(retro.fields ?? {}),
    },
  });
  appendTraceEvent(event);

  const lines = [
    `Bound session ${opts.sessionId} to task_run ${entry.task_run_id} (manual_bind${retro.fields ? `, retroactive: ${retro.fields.retroactive_reason_code} -- audit only, never k-NN eligible` : ""})`,
  ];
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
  // I-2026-11-09 (design 3): a wrapped run after done would record an ordinary
  // session_bound for a done intent -- refused like plain start/bind. There is no
  // --retroactive here: a retroactive record is for a session that already happened.
  // The done gate reads the spec dir stored at start (review fix 1).
  const gate = doneGateSpecDir(entry, "run", opts);
  if (!gate.ok) return gate.result;
  const retro = checkRetroactive(gate.specDir, intentId, "run", {});
  if (!retro.ok) return retro.result;

  const toolVersion = opts.toolVersion ?? LANE_VERSION;
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
  // requested-model/effort capture fix (2026-08-29): extracted from the exact argv this
  // call is spawning (agentCmd, not the wrapper's own injected --session-id/--json --
  // those are lane's own flags, never the caller's model/effort choice).
  const capture = extractAgentInvocationCapture(bindResult.agent, agentCmd.slice(1));
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
      requested_model: capture.requestedModel,
      requested_reasoning_effort: capture.requestedReasoningEffort,
      capture_status: capture.captureStatus,
    },
  });
  appendTraceEvent(boundEvent);
  if (warning) process.stderr.write(`${warning}\n`);
  if (capture.warning) process.stderr.write(`${capture.warning}\n`);

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
