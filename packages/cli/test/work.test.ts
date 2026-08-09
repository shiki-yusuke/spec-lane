import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveBindingRecordsFromTrace, readTraceEvents } from "@lane/core";
import { BindingRecordSchema } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStart } from "../src/commands/start.js";
import { runWorkBind, runWorkRun, runWorkStart } from "../src/commands/work.js";

// M0 spec-lane 0.5.0 — `lane work` start/bind/run, direct (no subprocess) CLI-command
// tests, matching commands.test.ts's own convention.

describe("lane work", () => {
  let specDir: string;
  let dataDir: string;
  let repoDir: string;
  const intentId = "I-2026-08-09-work-unit";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-work-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-work-data-"));
    repoDir = mkdtempSync(join(tmpdir(), "lane-work-repo-"));
    process.env.LANE_DATA_DIR = dataDir;
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: see commands.test.ts's own comment
    delete process.env.LANE_DATA_DIR;
  });

  it("start issues a task_run and records task_run_started", () => {
    const result = runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/twr-/);

    const events = readTraceEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.relation).toBe("task_run_started");
    expect(events[0]?.lane_id).toBe(intentId);
  });

  it("start against a nonexistent intent fails", () => {
    const result = runWorkStart("I-2026-08-09-does-not-exist", "3_implement", {
      specDir,
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(2);
  });

  it("bind resolves the sole active task_run and records session_bound (manual_bind)", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const result = runWorkBind(intentId, {
      specDir,
      sessionId: "s-manual-1",
      agent: "claude",
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(0);

    const events = readTraceEvents();
    const bound = events.find((e) => e.relation === "session_bound");
    expect(bound?.session_id).toBe("s-manual-1");
    expect(bound?.actor.kind).toBe("human");
    expect(bound?.lane_id).toBe(intentId);
  });

  // gpt-5.4 review must2: session_bound events must carry lane_id so a contract-
  // conformant attribution/v1 binding-record can actually be derived from real `lane
  // work bind`/`lane work run` output -- not just from synthetic fixtures.
  it("a contract-conformant binding-record can be derived from a real `lane work bind` trace event", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s-derivable-1", agent: "claude", cwd: repoDir });

    const records = deriveBindingRecordsFromTrace(readTraceEvents());
    const record = records.find((r) => r.session_id === "s-derivable-1");
    expect(record).toBeDefined();
    expect(record?.lane_id).toBe(intentId);
    expect(record?.intent_id).toBe(intentId);
    const parsed = BindingRecordSchema.safeParse(record);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("a contract-conformant binding-record can be derived from a real `lane work run` (claude) trace event", async () => {
    const claudeBin = join(repoDir, "claude");
    writeFileSync(claudeBin, "#!/bin/sh\nexit 0\n");
    chmodSync(claudeBin, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${repoDir}:${originalPath}`;
    try {
      runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
      const runResult = await runWorkRun(intentId, "3_implement", ["claude", "-p", "hi"], {
        specDir,
        cwd: repoDir,
      });
      expect(runResult.exitCode).toBe(0);

      const records = deriveBindingRecordsFromTrace(readTraceEvents());
      expect(records).toHaveLength(1);
      const parsed = BindingRecordSchema.safeParse(records[0]);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(
        true,
      );
      expect(records[0]?.lane_id).toBe(intentId);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("bind fails closed when more than one task_run is active, without --task-run", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkStart(intentId, "4_verify", { specDir, cwd: repoDir });
    const result = runWorkBind(intentId, {
      specDir,
      sessionId: "s-ambiguous",
      agent: "claude",
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/--task-run/);
  });

  it("bind disambiguates via --task-run", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const secondStart = runWorkStart(intentId, "4_verify", { specDir, cwd: repoDir });
    const secondTaskRunId = secondStart.message.match(/twr-[0-9a-f-]+/)?.[0] as string;

    const result = runWorkBind(intentId, {
      specDir,
      sessionId: "s-disambiguated",
      agent: "codex",
      taskRunId: secondTaskRunId,
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(0);
    const bound = readTraceEvents().find((e) => e.session_id === "s-disambiguated");
    expect(bound?.task_run_id).toBe(secondTaskRunId);
  });

  it("bind warns (but does not block) on MULTI_TASK_BINDING", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s-shared", agent: "claude", cwd: repoDir });

    // A second, distinct task_run binding the SAME session_id.
    const second = runWorkStart(intentId, "4_verify", { specDir, cwd: repoDir });
    const secondTaskRunId = second.message.match(/twr-[0-9a-f-]+/)?.[0] as string;
    const result = runWorkBind(intentId, {
      specDir,
      sessionId: "s-shared",
      agent: "claude",
      taskRunId: secondTaskRunId,
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("MULTI_TASK_BINDING");
    // Append-only: both session_bound facts are on the ledger, judgment is audit's job.
    expect(readTraceEvents().filter((e) => e.session_id === "s-shared")).toHaveLength(2);
  });

  it("run spawns a wrapped claude session and records session_bound (pre_assigned_session_id)", async () => {
    const claudeBin = join(repoDir, "claude");
    writeFileSync(claudeBin, "#!/bin/sh\nexit 0\n");
    chmodSync(claudeBin, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${repoDir}:${originalPath}`;

    try {
      runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
      const result = await runWorkRun(intentId, "3_implement", ["claude", "-p", "hi"], {
        specDir,
        cwd: repoDir,
      });
      expect(result.exitCode).toBe(0);
      const bound = readTraceEvents().find((e) => e.relation === "session_bound");
      expect(bound?.payload?.binding_method).toBe("pre_assigned_session_id");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("run rejects a non-claude/codex command without spawning anything observable", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const result = await runWorkRun(intentId, "3_implement", ["bash", "-c", "true"], {
      specDir,
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(1);
    expect(readTraceEvents().some((e) => e.relation === "session_bound")).toBe(false);
  });
});
