import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveDataDir } from "./xdg.js";

// M0 spec-lane 0.5.0 — `lane work` active-context bookkeeping. One task_run_id/
// phase_run_id pair is issued per `lane work start` call (design.md/M0 spec §2). The
// active-context file is keyed by a fingerprint of the *using* repo (never a cwd-based
// marker file -- attribution-v1.md's "Rejected designs" explicitly cuts a cwd marker for
// exactly the race it would introduce between two concurrent worktrees; this mirrors
// done-overlay.ts's own fingerprint-not-cwd convention). Unlike done-overlay's single
// entry per (specDir, intentId), a repo may have more than one *concurrently active*
// task_run (e.g. two terminals, two intents, or two phases of the same intent in
// parallel) -- so this file holds a list, and `lane work bind`/`lane work run` require
// `--task-run` to disambiguate whenever more than one entry is active (fail-closed, per
// the M0 spec).

export const WORK_ACTIVE_SCHEMA_VERSION = "1.0";

const WorkActiveEntrySchema = z.object({
  task_run_id: z.string().min(1),
  phase_run_id: z.string().min(1),
  intent_id: z.string().min(1),
  phase: z.string().min(1),
  label: z.string().optional(),
  started_at: z.string().min(1),
  repo_path: z.string().min(1),
});
export type WorkActiveEntry = z.infer<typeof WorkActiveEntrySchema>;

const WorkActiveFileSchema = z.object({
  schema_version: z.literal(WORK_ACTIVE_SCHEMA_VERSION),
  entries: z.array(WorkActiveEntrySchema).default([]),
});
export type WorkActiveFile = z.infer<typeof WorkActiveFileSchema>;

/** Full (unsliced) sha1 hex of the repo's realpath -- deliberately not the 16-char slice
 * done-overlay.ts uses for its own fingerprint; this file has no collision-sensitive
 * directory-naming concern that would motivate truncating it. */
export function repoFingerprint(repoPath: string): string {
  const real = realpathSync(repoPath);
  return createHash("sha1").update(real, "utf-8").digest("hex");
}

export function workActiveDir(): string {
  return join(resolveDataDir(), "work", "active");
}

export function workActivePath(repoPath: string): string {
  return join(workActiveDir(), `${repoFingerprint(repoPath)}.json`);
}

export function readWorkActiveFile(repoPath: string): WorkActiveFile {
  const path = workActivePath(repoPath);
  if (!existsSync(path)) return { schema_version: WORK_ACTIVE_SCHEMA_VERSION, entries: [] };
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return WorkActiveFileSchema.parse(raw);
}

/** Atomic write (tmp file + rename), matching done-overlay.ts's own write pattern. */
export function writeWorkActiveFile(repoPath: string, file: WorkActiveFile): void {
  const validated = WorkActiveFileSchema.parse(file);
  const path = workActivePath(repoPath);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort; non-POSIX filesystems may not support chmod
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(validated, null, 2));
  renameSync(tmp, path);
}

export function appendWorkActiveEntry(repoPath: string, entry: WorkActiveEntry): void {
  const file = readWorkActiveFile(repoPath);
  writeWorkActiveFile(repoPath, { ...file, entries: [...file.entries, entry] });
}

export function generateTaskRunId(): string {
  return `twr-${randomUUID()}`;
}

export function generatePhaseRunId(): string {
  return `pwr-${randomUUID()}`;
}

export class AmbiguousActiveTaskRunError extends Error {
  constructor(readonly entries: readonly WorkActiveEntry[]) {
    super(
      `more than one active task_run in this repo -- pass --task-run to disambiguate. Active: ${entries
        .map((e) => `${e.task_run_id} (intent=${e.intent_id} phase=${e.phase})`)
        .join(", ")}`,
    );
    this.name = "AmbiguousActiveTaskRunError";
  }
}

export class NoActiveTaskRunError extends Error {
  constructor() {
    super("no active task_run in this repo -- run `lane work start` first");
    this.name = "NoActiveTaskRunError";
  }
}

export class TaskRunNotFoundError extends Error {
  constructor(readonly taskRunId: string) {
    super(`task_run ${taskRunId} is not an active task_run in this repo`);
    this.name = "TaskRunNotFoundError";
  }
}

/**
 * Resolves which active task_run a `lane work bind`/`lane work run` call targets.
 * Fail-closed (M0 spec §2's "曖昧さは fail-closed"): an explicit `--task-run` is honored
 * (and must match a real active entry); otherwise exactly one active entry must exist.
 */
export function resolveActiveTaskRun(
  repoPath: string,
  opts: { taskRunId?: string } = {},
): WorkActiveEntry {
  const { entries } = readWorkActiveFile(repoPath);
  if (opts.taskRunId) {
    const found = entries.find((e) => e.task_run_id === opts.taskRunId);
    if (!found) throw new TaskRunNotFoundError(opts.taskRunId);
    return found;
  }
  if (entries.length === 0) throw new NoActiveTaskRunError();
  if (entries.length > 1) throw new AmbiguousActiveTaskRunError(entries);
  return entries[0] as WorkActiveEntry;
}
