import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// M0 spec-lane 0.5.0 — `lane work run`'s wrapper binding (design.md/attribution-v1.md's
// binding-feasibility spike result: hook-based binding was cut, so binding happens by
// wrapping the child process invocation itself). Two, and only two, supported agents in
// v1 -- see attribution-v1.md's binding_method closed set for why each is asymmetric:
//
// - Claude: the wrapper can pre-assign a session_id up front (`claude -p --session-id
//   <uuid>`) -- the nonce it generates IS the session_id, no separate join step.
// - Codex: the wrapper cannot pre-assign one. It reads the session_id (Codex calls it
//   `thread_id`) from the leading `{"type":"thread.started","thread_id":...}` line of
//   `codex exec --json`'s stdout, obtained only after the process has actually started.
//
// Both spawn via `execFile`-family APIs (never a shell) -- `spawn(command, args)` here,
// with no `shell: true` anywhere, so a crafted intent label or agent arg can never be
// interpreted by a shell.

export class WrapperBindTimeoutError extends Error {}
export class WrapperBindConflictError extends Error {}
export class WrapperUnsupportedCommandError extends Error {}

export type WrapperAgent = "claude" | "codex";

/** Exact basename match only (never a `startsWith` heuristic) -- a binary that merely
 * starts with "claude"/"codex" but isn't literally that command must not be silently
 * wrapped as if it were. */
export function detectWrapperAgent(command: string): WrapperAgent | null {
  const base = command.split("/").pop() ?? command;
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  return null;
}

export interface WrapperRunResult {
  sessionId: string;
  bindingMethod: "pre_assigned_session_id" | "self_reported_thread_id";
  agent: WrapperAgent;
  exitCode: Promise<number>;
}

export interface WrapperRunOptions {
  cwd?: string;
  /** Codex-only: how long to wait for the leading thread.started line. Default 30s. */
  bindTimeoutMs?: number;
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 1)));
    child.on("error", () => resolve(1));
  });
}

function runClaudeWrapper(
  command: string,
  args: readonly string[],
  opts: WrapperRunOptions,
): WrapperRunResult {
  if (args.includes("--session-id")) {
    throw new WrapperBindConflictError(
      "lane work run injects --session-id itself for claude -- do not pass it manually (use `lane work bind` for a session you started yourself)",
    );
  }
  const sessionId = randomUUID();
  const child = spawn(command, [...args, "--session-id", sessionId], {
    cwd: opts.cwd,
    stdio: "inherit",
  });
  return {
    sessionId,
    bindingMethod: "pre_assigned_session_id",
    agent: "claude",
    exitCode: waitForExit(child),
  };
}

/**
 * Spawns codex, injecting `--json` if not already present, and races the leading
 * `{"type":"thread.started","thread_id":...}` stdout line against `bindTimeoutMs`. The
 * child's stdout is always forwarded to this process's own stdout in full (M0 spec §2:
 * "透過転送しつつ先頭行のみ解析") -- the control line is not hidden from the user, it is
 * additionally parsed for binding purposes.
 *
 * On a bind timeout, the child is killed and this rejects -- a bind failure is never
 * silently ignored while letting the child keep running unbound (M0 spec §2: "bind 不能を
 * 黙って続行しない").
 */
function runCodexWrapper(
  command: string,
  args: readonly string[],
  opts: WrapperRunOptions,
): { bound: Promise<WrapperRunResult>; child: ChildProcess } {
  const timeoutMs = opts.bindTimeoutMs ?? 30_000;
  const finalArgs = args.includes("--json") ? args : [...args, "--json"];
  const child = spawn(command, finalArgs, { cwd: opts.cwd, stdio: ["inherit", "pipe", "inherit"] });
  const exitCode = waitForExit(child);

  let settled = false;
  let buffer = "";
  const bound = new Promise<WrapperRunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new WrapperBindTimeoutError(
          `codex wrapper: no thread.started line on stdout within ${timeoutMs}ms -- killed the child process rather than continue unbound`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk); // always forwarded, even after binding settles
      if (settled) return;
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      settled = true;
      clearTimeout(timer);
      const firstLine = buffer.slice(0, newlineIdx);
      let parsed: unknown;
      try {
        parsed = JSON.parse(firstLine);
      } catch {
        reject(new Error(`codex wrapper: first stdout line was not valid JSON: ${firstLine}`));
        return;
      }
      const threadId = (parsed as { type?: string; thread_id?: unknown }).thread_id;
      if ((parsed as { type?: string }).type !== "thread.started" || typeof threadId !== "string") {
        reject(
          new Error(
            `codex wrapper: first stdout line was not a thread.started event: ${firstLine}`,
          ),
        );
        return;
      }
      resolve({
        sessionId: threadId,
        bindingMethod: "self_reported_thread_id",
        agent: "codex",
        exitCode,
      });
    });

    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("codex wrapper: process exited before a thread.started line was seen"));
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });

  return { bound, child };
}

/**
 * `lane work run`'s dispatcher: detects claude vs. codex from `command`'s exact basename
 * and returns the matching wrapper's bind result. Declared `async` on purpose (not a
 * plain function returning a `Promise`): every failure mode here -- including
 * WrapperBindConflictError/WrapperUnsupportedCommandError, both raised synchronously
 * before any subprocess is even spawned -- must surface as a *rejected promise*, never a
 * synchronous throw, since every caller treats this as `await runWrapperBind(...)`.
 */
export async function runWrapperBind(
  command: string,
  args: readonly string[],
  opts: WrapperRunOptions = {},
): Promise<WrapperRunResult> {
  const agent = detectWrapperAgent(command);
  if (agent === "claude") return runClaudeWrapper(command, args, opts);
  if (agent === "codex") return runCodexWrapper(command, args, opts).bound;
  throw new WrapperUnsupportedCommandError(
    `lane work run only wraps claude/codex (got: ${command}) -- use \`lane work bind\` for any other agent's manually-started session`,
  );
}
