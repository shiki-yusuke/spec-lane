import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LANE_VERSION } from "../../src/version.js";

// I-2026-11-20-pre-merge-bind-gap-warning -- shared subprocess harness for the
// `lane work check` tests. Follows cli-argv-agent-cost-timeout.test.ts's own
// subprocess-against-dist/main.js convention (skipped when dist has not been built).

const __dirname = dirname(fileURLToPath(import.meta.url));
export const distMainPath = join(__dirname, "..", "..", "dist", "main.js");
export const hasDist = existsSync(distMainPath);

export interface LaneRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface LaneRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. Omitted -> an immediately-closed empty stdin. */
  input?: string;
}

/** A clean env for a `lane` subprocess: no inherited LANE_* overrides, plus the given ones. */
export function laneEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("LANE_")) continue;
    env[k] = v;
  }
  return { ...env, ...overrides };
}

export function runLaneCli(args: readonly string[], opts: LaneRunOptions): LaneRun {
  const result = spawnSync(process.execPath, [distMainPath, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input ?? "",
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs `lane` with a stdin pipe that is deliberately never written to or closed. Resolves with
 * `timedOut: true` (after killing the child) if the process has not exited within `timeoutMs`.
 */
export function runLaneCliOpenStdin(
  args: readonly string[],
  opts: Omit<LaneRunOptions, "input"> & { timeoutMs: number },
): Promise<LaneRun & { timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distMainPath, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf-8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf-8").on("data", (d: string) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

/** Rewrites one lane's persisted lane-state.json (test fixture setup only). */
export function patchLaneState(
  specDir: string,
  intentId: string,
  patch: Record<string, unknown>,
): void {
  const path = join(specDir, intentId, "lane-state.json");
  const state = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...state, ...patch }, null, 2));
}

/**
 * Every path under `roots` (relative to the given label) with its type, mode and exact
 * bytes -- two snapshots are equal only if no path was created, removed, or changed.
 */
export function snapshotTrees(roots: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (label: string, root: string, dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const key = `${label}:${relative(root, full)}`;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        out[key] = `link:${readlinkSync(full)}`;
      } else if (st.isDirectory()) {
        out[key] = `dir:${st.mode.toString(8)}`;
        walk(label, root, full);
      } else {
        let bytes: string;
        try {
          bytes = readFileSync(full).toString("base64");
        } catch {
          // an unreadable fixture file (chmod 000): its size and mtime still prove no write
          bytes = `unreadable:${st.size}:${st.mtimeMs}`;
        }
        out[key] = `file:${st.mode.toString(8)}:${bytes}`;
      }
    }
  };
  for (const [label, root] of Object.entries(roots)) {
    out[`${label}:`] = existsSync(root) ? "root" : "absent";
    if (existsSync(root)) walk(label, root, root);
  }
  return out;
}

/** Stable text for output that contains generated ids, timestamps, temp paths and the version. */
export function normalizeOutput(text: string, tmpRoots: readonly string[]): string {
  let out = text;
  const roots = new Set<string>();
  for (const r of tmpRoots) {
    roots.add(r);
    try {
      roots.add(realpathSync(r));
    } catch {
      // root already gone
    }
  }
  for (const r of [...roots].sort((a, b) => b.length - a.length)) {
    out = out.split(r).join("<TMP>");
  }
  return out
    .replace(/\b(twr|pwr)-[0-9a-f-]{36}\b/g, "$1-<UUID>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TS>")
    .split(LANE_VERSION)
    .join("<VERSION>");
}
