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
  workActivePath,
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
import { readLaneState } from "../state-store.js";
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
 * Environment variable `lane work run` sets for its wrapped claude/codex child: the task_run
 * id that child's session is being bound to. `lane work check` stays silent when it names one
 * of the in-progress candidates (the wrapper records the bind itself, possibly only after the
 * child's SessionStart hook has already run, e.g. Codex's thread.started).
 */
export const WORK_RUN_TASK_RUN_ENV = "LANE_WORK_TASK_RUN";

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
  // The child inherits process.env at spawn time: expose the task_run it is being bound to,
  // so a `lane work check` SessionStart hook that runs before this bind is recorded stays
  // silent instead of suggesting a second (manual) bind. Restored once the spawn settles.
  const previousWrapperEnv = process.env[WORK_RUN_TASK_RUN_ENV];
  process.env[WORK_RUN_TASK_RUN_ENV] = entry.task_run_id;
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
  } finally {
    if (previousWrapperEnv === undefined) {
      delete process.env[WORK_RUN_TASK_RUN_ENV];
    } else {
      process.env[WORK_RUN_TASK_RUN_ENV] = previousWrapperEnv;
    }
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

// ---------------------------------------------------------------------------------------
// I-2026-11-20-pre-merge-bind-gap-warning -- `lane work check`: a read-only SessionStart
// check that warns, in one line, when the current session is not bound to this repo's
// in-progress task_run. It never writes (no trace event, no lane-state, no active-work
// file, no directory), never blocks (always exit 0) and is silent on every no-op or
// failure. Spec: docs/spec/I-2026-11-20-pre-merge-bind-gap-warning/spec.md.
// ---------------------------------------------------------------------------------------

/** Only these lane phases count as "in progress" for the check (spec Q1). */
const WORK_CHECK_PHASES: readonly string[] = ["2_spec", "3_implement"];

/** The exact ASCII allowlist every identifier must match for a bind command to be printed
 * (spec Q2). Anything else gets a warning without a command. */
const WORK_CHECK_ID_ALLOWLIST = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const WORK_CHECK_AGENTS: readonly string[] = ["claude", "codex"];

export interface WorkCheckOptions {
  /** `--session-id` flag value; overrides the hook JSON's `session_id`. */
  sessionId?: string;
  /** `--agent` flag value; overrides the hook JSON's `agent`. Must be claude|codex. */
  agent?: string;
  /** Raw stdin text (the SessionStart hook payload). `undefined` = stdin was not read. */
  stdinText?: string;
  /** `--spec-dir`, resolved against the check cwd like `lane work start`'s own. */
  specDir?: string;
  /** The check process's own cwd (defaults to `process.cwd()`); a hook payload `cwd`
   * may select a different repo for the candidate, but a bind command is only printed
   * when running it from this cwd would resolve the same task_run. */
  processCwd?: string;
  /** The `LANE_WORK_TASK_RUN` value `lane work run` gave its wrapped child (main.ts passes
   * the env; never read from process.env here). When it equals an in-progress candidate's
   * task_run the wrapper owns the bind, so the check is silent. Empty/other values are ignored. */
  wrapperTaskRunId?: string;
}

/** `lane work check` always exits 0; `message` is null for every silent outcome. */
export interface WorkCheckResult {
  exitCode: 0;
  message: string | null;
}

/** True unless both identity flags were given -- then stdin must never be read (RULE-02). */
export function workCheckNeedsStdin(opts: { sessionId?: string; agent?: string }): boolean {
  return opts.sessionId === undefined || opts.agent === undefined;
}

/**
 * One-line display escaping (spec Q2): printable ASCII other than backslash as itself,
 * backslash as `\\`, everything else as `\xNN` (code points up to 0xFF) or `\u{...}`.
 * Display only -- never shell quoting.
 */
export function escapeWorkCheckDisplay(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp <= 0xff) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else out += `\\u{${cp.toString(16)}}`;
  }
  return out;
}

const SILENT: WorkCheckResult = { exitCode: 0, message: null };

interface WorkCheckIdentity {
  sessionId: string;
  agent: string;
  hookCwd: string | undefined;
}

function resolveWorkCheckIdentity(opts: WorkCheckOptions): WorkCheckIdentity | null {
  let payload: Record<string, unknown> = {};
  if (opts.stdinText !== undefined && opts.stdinText.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.stdinText);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  }
  const sessionId = opts.sessionId !== undefined ? opts.sessionId : payload.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const agent = opts.agent !== undefined ? opts.agent : payload.agent;
  if (typeof agent !== "string" || !WORK_CHECK_AGENTS.includes(agent)) return null;
  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  return { sessionId, agent, hookCwd };
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * `lane work check [--session-id <id>] [--agent claude|codex] [--spec-dir <path>]` -- see
 * the section comment above. Never throws; every failure is the silent result.
 */
export function runWorkCheck(opts: WorkCheckOptions): WorkCheckResult {
  try {
    return evaluateWorkCheck(opts);
  } catch {
    return SILENT;
  }
}

function evaluateWorkCheck(opts: WorkCheckOptions): WorkCheckResult {
  const identity = resolveWorkCheckIdentity(opts);
  if (identity === null) return SILENT;
  const { sessionId, agent } = identity;
  const processCwd = opts.processCwd ?? process.cwd();
  // Same active-work identity as `lane work start` (spec Q3): the hook cwd verbatim, else the
  // process cwd -- never a git-root normalization or a fallback lookup.
  const checkCwd = identity.hookCwd ?? processCwd;
  const checkSpecDir = resolveSpecDir({ override: opts.specDir, cwd: checkCwd });

  // Whole-file readers (spec Q4/D1): a malformed or unreadable active-work file or trace
  // ledger makes the whole check silent; no valid-row isolation.
  let entries: WorkActiveEntry[];
  let events: TraceEvent[];
  try {
    entries = readWorkActiveFile(checkCwd).entries;
    events = readTraceEvents();
  } catch {
    return SILENT;
  }

  const candidates = entries.filter((entry) => {
    const specDir = entry.spec_dir ?? checkSpecDir;
    try {
      const state = readLaneState(specDir, entry.intent_id);
      return (
        state.status === "running" &&
        WORK_CHECK_PHASES.includes(state.current_phase) &&
        state.intent_id === entry.intent_id &&
        entry.phase === state.current_phase
      );
    } catch {
      return false;
    }
  });

  if (candidates.length === 0) return SILENT;
  // Inside `lane work run`'s wrapped child: the wrapper is binding this session to that
  // task_run itself (perhaps not yet recorded), so suggesting a manual bind would double it.
  const wrapped = opts.wrapperTaskRunId;
  if (
    wrapped !== undefined &&
    wrapped !== "" &&
    candidates.some((c) => c.task_run_id === wrapped)
  ) {
    return SILENT;
  }
  const shownSession = escapeWorkCheckDisplay(sessionId);
  if (candidates.length > 1) {
    const listed = candidates
      .map(
        (c) =>
          `${escapeWorkCheckDisplay(c.intent_id)} task_run ${escapeWorkCheckDisplay(c.task_run_id)} (phase ${escapeWorkCheckDisplay(c.phase)})`,
      )
      .join(", ");
    return {
      exitCode: 0,
      message: `lane work check: session ${shownSession} -- ${candidates.length} in-progress task_runs in this repo, not guessing which one this session belongs to: ${listed}; bind it to the right one by its task_run`,
    };
  }

  const candidate = candidates[0] as WorkActiveEntry;
  const bindings = events.filter(
    (e) => e.relation === "session_bound" && e.session_id === sessionId,
  );
  const otherTaskRuns = [
    ...new Set(
      bindings
        .map((e) => e.task_run_id)
        .filter((id): id is string => typeof id === "string" && id !== candidate.task_run_id),
    ),
  ];
  const shownIntent = escapeWorkCheckDisplay(candidate.intent_id);
  const shownTaskRun = escapeWorkCheckDisplay(candidate.task_run_id);
  if (otherTaskRuns.length > 0) {
    // The different-task fact wins over a matching binding: another bind would turn this
    // session's attribution "mixed" (spec D2).
    return {
      exitCode: 0,
      message: `lane work check: session ${shownSession} is already bound to a different task_run (${otherTaskRuns.map(escapeWorkCheckDisplay).join(", ")}), not ${shownIntent} task_run ${shownTaskRun} -- no bind is suggested: binding it again would make its attribution mixed`,
    };
  }
  if (bindings.length > 0) return SILENT;

  const head = `lane work check: session ${shownSession} is not bound to ${shownIntent} (task_run ${shownTaskRun}, phase ${escapeWorkCheckDisplay(candidate.phase)}) -- its usage will not count toward calibration`;
  const ids = [candidate.intent_id, candidate.task_run_id, sessionId, agent];
  if (!ids.every((id) => WORK_CHECK_ID_ALLOWLIST.test(id))) {
    return {
      exitCode: 0,
      message: `${head}; no bind command is printed because an identifier is outside the safe character set -- bind it manually`,
    };
  }
  if (!bindResolvesSameContext(candidate, checkCwd, checkSpecDir, processCwd)) {
    return {
      exitCode: 0,
      message: `${head}; no bind command is printed because running it from this cwd would not reach that task_run's repo and spec dir -- bind it from where it was started`,
    };
  }
  const refusal = bindRefusal(candidate, processCwd);
  if (refusal !== null) {
    return {
      exitCode: 0,
      message: `${head}; no bind command is printed because lane work bind would refuse it here (${escapeWorkCheckDisplay(refusal)})`,
    };
  }
  return {
    exitCode: 0,
    message: `${head}; bind it now: lane work bind --intent=${candidate.intent_id} --task-run=${candidate.task_run_id} --session-id=${sessionId} --agent=${agent}`,
  };
}

/**
 * The printed command carries no --cwd/--spec-dir, so it is only printed when an unoptioned
 * `runWorkBind` from the process cwd would resolve the candidate's active-work file and its
 * effective spec dir (spec Q2, D4, PATH-11).
 */
function bindResolvesSameContext(
  candidate: WorkActiveEntry,
  checkCwd: string,
  checkSpecDir: string,
  processCwd: string,
): boolean {
  try {
    if (workActivePath(processCwd) !== workActivePath(checkCwd)) return false;
  } catch {
    return false;
  }
  const bindDefaultSpecDir = resolveSpecDir({ cwd: processCwd });
  if (candidate.spec_dir !== undefined) {
    try {
      return realpathSync(bindDefaultSpecDir) === candidate.spec_dir;
    } catch {
      return false;
    }
  }
  return sameRealPath(bindDefaultSpecDir, checkSpecDir);
}

/**
 * Read-only replay of the gates `runWorkBind` applies after resolving the candidate (spec dir
 * pinning / legacy intentExists + done-overlay-elsewhere, then the done overlay itself) from
 * the process cwd with no --spec-dir. Returns bind's refusal message, or null when it would
 * accept the printed command. Any thrown read is a refusal: never print an unusable command.
 */
function bindRefusal(candidate: WorkActiveEntry, processCwd: string): string | null {
  try {
    const gate = doneGateSpecDir(candidate, "bind", { cwd: processCwd });
    if (!gate.ok) return gate.result.message;
    const retro = checkRetroactive(gate.specDir, candidate.intent_id, "bind", {});
    if (!retro.ok) return retro.result.message;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
