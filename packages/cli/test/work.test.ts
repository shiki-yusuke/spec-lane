import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAttributionProjection,
  deriveBindingRecordsFromTrace,
  deriveKnnIneligibility,
  doneOverlayPath,
  readTraceEvents,
  readWorkActiveFile,
  writeWorkActiveFile,
} from "@lane/core";
import {
  BindingRecordSchema,
  CURRENT_ACCOUNTING_BASIS,
  type TraceEvent,
  TraceEventSchema,
} from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  // cohort-3 measurement fix (2026-08-29): requested_model/requested_reasoning_effort/
  // capture_status recorded on every new binding, both for `lane work bind` (manual_bind,
  // always null/absent -- there is no argv to inspect) and `lane work run` (extracted from
  // the actual argv this call spawns).
  describe("requested-model/effort capture on new bindings", () => {
    it("bind (manual_bind) always records v2 with both requested values null, capture_status=absent", () => {
      runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
      runWorkBind(intentId, {
        specDir,
        sessionId: "s-manual-capture",
        agent: "claude",
        cwd: repoDir,
      });

      const bound = readTraceEvents().find((e) => e.session_id === "s-manual-capture");
      expect(bound?.payload).toMatchObject({
        requested_model: null,
        requested_reasoning_effort: null,
        capture_status: "absent",
      });

      const record = deriveBindingRecordsFromTrace(readTraceEvents()).find(
        (r) => r.session_id === "s-manual-capture",
      );
      expect(record).toMatchObject({
        schema_version: "attribution/v2",
        requested_model: null,
        requested_reasoning_effort: null,
        capture_status: "absent",
      });
      expect(BindingRecordSchema.safeParse(record).success).toBe(true);
    });

    it("run with no --model/--effort flags still records v2 (capture_status=absent), not v1", async () => {
      const claudeBin = join(repoDir, "claude");
      writeFileSync(claudeBin, "#!/bin/sh\nexit 0\n");
      chmodSync(claudeBin, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${repoDir}:${originalPath}`;
      try {
        runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
        await runWorkRun(intentId, "3_implement", ["claude", "-p", "hi"], {
          specDir,
          cwd: repoDir,
        });

        const record = deriveBindingRecordsFromTrace(readTraceEvents())[0];
        expect(record).toMatchObject({
          schema_version: "attribution/v2",
          requested_model: null,
          requested_reasoning_effort: null,
          capture_status: "absent",
        });
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it("run with --model/--effort flags captures them into the derived binding-record", async () => {
      const claudeBin = join(repoDir, "claude");
      writeFileSync(claudeBin, "#!/bin/sh\nexit 0\n");
      chmodSync(claudeBin, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${repoDir}:${originalPath}`;
      try {
        runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
        await runWorkRun(
          intentId,
          "3_implement",
          ["claude", "-p", "hi", "--model", "claude-sonnet-5", "--effort", "high"],
          { specDir, cwd: repoDir },
        );

        const record = deriveBindingRecordsFromTrace(readTraceEvents())[0];
        expect(record).toMatchObject({
          schema_version: "attribution/v2",
          requested_model: "claude-sonnet-5",
          requested_reasoning_effort: "high",
          capture_status: "captured",
        });
        expect(BindingRecordSchema.safeParse(record).success).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it("run with a duplicated --model flag records ambiguous (null, never a guessed value) and warns", async () => {
      const claudeBin = join(repoDir, "claude");
      writeFileSync(claudeBin, "#!/bin/sh\nexit 0\n");
      chmodSync(claudeBin, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${repoDir}:${originalPath}`;
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
        await runWorkRun(
          intentId,
          "3_implement",
          ["claude", "-p", "hi", "--model", "opus", "--model", "sonnet"],
          { specDir, cwd: repoDir },
        );

        const record = deriveBindingRecordsFromTrace(readTraceEvents())[0];
        expect(record).toMatchObject({
          schema_version: "attribution/v2",
          requested_model: null,
          capture_status: "ambiguous",
        });
        const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(warned).toContain("AMBIGUOUS_MODEL_EFFORT_CAPTURE");
      } finally {
        process.env.PATH = originalPath;
        stderrSpy.mockRestore();
      }
    });
  });
});

// I-2026-11-09 design 3 -- done-gated `lane work start|bind`, and the audit-only
// `--retroactive --reason <code>` path.
describe("lane work after done (retroactive)", () => {
  let specDir: string;
  let dataDir: string;
  let repoDir: string;
  const intentId = "I-2026-11-09-work-retro";

  function markDone(): void {
    const path = doneOverlayPath(specDir, intentId);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "1.0",
        intent_id: intentId,
        verify_ended_at: "2026-11-08T10:00:00Z",
        done_recorded_at: "2026-11-08T10:05:00Z",
        pr_url: null,
        merge_sha: null,
        spec_dir: realpathSync(specDir),
        spec_dir_fingerprint: "0000000000000000",
        tool_version: "0.11.0",
        done_source: "local_overlay",
        usage_import_gate_overrides: [],
      }),
    );
  }

  function matchedUsageImported(taskRunId: string, sessionId: string): TraceEvent {
    return {
      schema_version: "trace/v1",
      event_id: `tr1_${"a".repeat(64)}`,
      relation: "usage_imported",
      from_ref: { logical_id: `session:${sessionId}` },
      to_ref: { logical_id: `task_run:${taskRunId}` },
      occurred_at: "2026-11-09T10:00:00Z",
      actor: { kind: "cli", id: "lane" },
      task_run_id: taskRunId,
      session_id: sessionId,
      payload: {
        window: { since: "2026-11-08T09:00:00Z", until: "2026-11-08T10:00:00Z" },
        matched: true,
      },
    };
  }

  function knnFor(sessionId: string, taskRunId: string) {
    const events = readTraceEvents();
    return deriveKnnIneligibility({
      measurement: {
        accounting_basis: CURRENT_ACCOUNTING_BASIS,
        data_quality: {
          conflicting_duplicate_groups: 0,
          missing_dedup_identity_rows: 0,
          source_quality: { identity_missing: 0 },
        },
      },
      sessionIds: [sessionId],
      attribution: buildAttributionProjection({
        usageImportedEvents: [matchedUsageImported(taskRunId, sessionId)],
        sessionBoundEvents: events.filter((e) => e.relation === "session_bound"),
      }),
    });
  }

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-work-retro-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-work-retro-data-"));
    repoDir = mkdtempSync(join(tmpdir(), "lane-work-retro-repo-"));
    process.env.LANE_DATA_DIR = dataDir;
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: see commands.test.ts's own comment
    delete process.env.LANE_DATA_DIR;
  });

  it("refuses a plain start after done, pointing at --retroactive, and writes nothing", () => {
    markDone();
    const result = runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/already done/);
    expect(result.message).toMatch(/--retroactive --reason/);
    expect(readTraceEvents()).toHaveLength(0);
  });

  it("refuses a plain bind after done, even with a task_run started before done", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    markDone();
    const result = runWorkBind(intentId, {
      specDir,
      sessionId: "s-late",
      agent: "codex",
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/--retroactive/);
    expect(readTraceEvents().filter((e) => e.relation === "session_bound")).toHaveLength(0);
  });

  it("refuses a wrapped run after done", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    markDone();
    const result = await runWorkRun(intentId, "3_implement", ["claude", "-p", "hi"], {
      specDir,
      cwd: repoDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/already done/);
  });

  it("requires --retroactive and --reason together, and only a listed reason code", () => {
    markDone();
    const cases: { retroactive?: boolean; reason?: string; pattern: RegExp }[] = [
      { retroactive: true, pattern: /requires --reason/ },
      { reason: "missed_bind", pattern: /only valid together with --retroactive/ },
      {
        retroactive: true,
        reason: "forgot",
        pattern: /must be one of missed_bind\|tooling_failure/,
      },
      { retroactive: true, reason: "MISSED_BIND", pattern: /must be one of/ },
    ];
    for (const c of cases) {
      const start = runWorkStart(intentId, "3_implement", {
        specDir,
        cwd: repoDir,
        retroactive: c.retroactive,
        reason: c.reason,
      });
      expect(start.exitCode).toBe(2);
      expect(start.message).toMatch(c.pattern);
      const bind = runWorkBind(intentId, {
        specDir,
        sessionId: "s-x",
        agent: "codex",
        cwd: repoDir,
        retroactive: c.retroactive,
        reason: c.reason,
      });
      expect(bind.exitCode).toBe(2);
      expect(bind.message).toMatch(c.pattern);
    }
    expect(readTraceEvents()).toHaveLength(0);
  });

  it("refuses --retroactive against an intent that is not done", () => {
    const start = runWorkStart(intentId, "3_implement", {
      specDir,
      cwd: repoDir,
      retroactive: true,
      reason: "missed_bind",
    });
    expect(start.exitCode).toBe(2);
    expect(start.message).toMatch(/not done/);
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const bind = runWorkBind(intentId, {
      specDir,
      sessionId: "s-x",
      agent: "codex",
      cwd: repoDir,
      retroactive: true,
      reason: "tooling_failure",
    });
    expect(bind.exitCode).toBe(2);
    expect(bind.message).toMatch(/not done/);
  });

  it("records a retroactive start+bind with the marker in the payload and occurred_at = record time", () => {
    markDone();
    const before = Date.now();
    const start = runWorkStart(intentId, "3_implement", {
      specDir,
      cwd: repoDir,
      retroactive: true,
      reason: "missed_bind",
    });
    expect(start.exitCode).toBe(0);
    const bind = runWorkBind(intentId, {
      specDir,
      sessionId: "s-retro",
      agent: "codex",
      cwd: repoDir,
      retroactive: true,
      reason: "missed_bind",
    });
    expect(bind.exitCode).toBe(0);

    const events = readTraceEvents();
    for (const e of events) expect(TraceEventSchema.safeParse(e).success).toBe(true);
    const started = events.find((e) => e.relation === "task_run_started");
    expect(started?.payload).toEqual({ retroactive: true, retroactive_reason_code: "missed_bind" });
    const bound = events.find((e) => e.relation === "session_bound");
    expect(bound?.payload).toMatchObject({
      binding_method: "manual_bind",
      retroactive: true,
      retroactive_reason_code: "missed_bind",
    });
    expect(Date.parse(bound?.occurred_at ?? "")).toBeGreaterThanOrEqual(before);

    // the binding-record projection still reads it (attribution/v2, unchanged shape)
    const records = deriveBindingRecordsFromTrace(events);
    expect(records).toHaveLength(1);
    expect(BindingRecordSchema.safeParse(records[0]).success).toBe(true);

    // matched usage does not make a retroactive binding k-NN eligible
    const knn = knnFor("s-retro", bound?.task_run_id ?? "");
    expect(knn.reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(knn.detail).toEqual(["session s-retro is retroactively bound"]);
  });

  it("an ordinary (pre-done) bind with matched usage stays eligible and carries no retroactive keys", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const bind = runWorkBind(intentId, {
      specDir,
      sessionId: "s-normal",
      agent: "claude",
      cwd: repoDir,
    });
    expect(bind.exitCode).toBe(0);
    const bound = readTraceEvents().find((e) => e.relation === "session_bound");
    expect(bound?.payload).not.toHaveProperty("retroactive");
    expect(bound?.payload).not.toHaveProperty("retroactive_reason_code");
    const knn = knnFor("s-normal", bound?.task_run_id ?? "");
    expect(knn.reasons).toEqual([]);
    expect(knn.detail).toEqual([]);
  });

  it("review fix 1: start stores the canonical spec dir on the active entry", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const [entry] = readWorkActiveFile(repoDir).entries;
    expect(entry?.spec_dir).toBe(realpathSync(specDir));
  });

  it("review fix 1: bind/run with a different, empty --spec-dir after done are refused", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    markDone();
    const emptySpecDir = mkdtempSync(join(tmpdir(), "lane-work-retro-empty-spec-"));

    const bind = runWorkBind(intentId, {
      specDir: emptySpecDir,
      sessionId: "s-sneak",
      agent: "codex",
      cwd: repoDir,
    });
    expect(bind.exitCode).toBe(2);
    expect(bind.message).toMatch(/does not match/);

    // a retroactive bind through the wrong dir is refused too (the dir mismatch comes first)
    const retroBind = runWorkBind(intentId, {
      specDir: emptySpecDir,
      sessionId: "s-sneak",
      agent: "codex",
      cwd: repoDir,
      retroactive: true,
      reason: "missed_bind",
    });
    expect(retroBind.exitCode).toBe(2);
    expect(retroBind.message).toMatch(/does not match/);

    // a nonexistent dir cannot canonicalize and is refused as a mismatch
    const missing = runWorkBind(intentId, {
      specDir: join(emptySpecDir, "nope"),
      sessionId: "s-sneak",
      agent: "codex",
      cwd: repoDir,
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.message).toMatch(/does not match/);

    const run = await runWorkRun(intentId, "3_implement", ["claude", "-p", "hi"], {
      specDir: emptySpecDir,
      cwd: repoDir,
    });
    expect(run.exitCode).toBe(2);
    expect(run.message).toMatch(/does not match/);

    expect(readTraceEvents().filter((e) => e.relation === "session_bound")).toHaveLength(0);
  });

  it("review fix 1: a different --spec-dir is refused before done as well (stored value wins)", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const otherSpecDir = mkdtempSync(join(tmpdir(), "lane-work-retro-other-spec-"));
    const bind = runWorkBind(intentId, {
      specDir: otherSpecDir,
      sessionId: "s-x",
      agent: "codex",
      cwd: repoDir,
    });
    expect(bind.exitCode).toBe(2);
    expect(bind.message).toMatch(/does not match/);
    // the same spec dir under its non-canonical spelling is accepted
    const ok = runWorkBind(intentId, {
      specDir: join(specDir, "."),
      sessionId: "s-x",
      agent: "codex",
      cwd: repoDir,
    });
    expect(ok.exitCode).toBe(0);
  });

  it("review fix 1: an active entry without spec_dir (pre-fix) still parses and gates on the caller-resolved dir", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const file = readWorkActiveFile(repoDir);
    writeWorkActiveFile(repoDir, {
      ...file,
      entries: file.entries.map(({ spec_dir: _drop, ...legacy }) => legacy),
    });
    expect(readWorkActiveFile(repoDir).entries[0]).not.toHaveProperty("spec_dir");

    const before = runWorkBind(intentId, {
      specDir,
      sessionId: "s-legacy",
      agent: "codex",
      cwd: repoDir,
    });
    expect(before.exitCode).toBe(0);

    markDone();
    const after = runWorkBind(intentId, {
      specDir,
      sessionId: "s-legacy-2",
      agent: "codex",
      cwd: repoDir,
    });
    expect(after.exitCode).toBe(2);
    expect(after.message).toMatch(/already done/);
  });

  it("review fix 2 (CLI path): ordinary bind before done + retroactive bind after done -> k-NN ineligible", () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    expect(
      runWorkBind(intentId, { specDir, sessionId: "s-both", agent: "codex", cwd: repoDir })
        .exitCode,
    ).toBe(0);
    markDone();
    expect(
      runWorkBind(intentId, {
        specDir,
        sessionId: "s-both",
        agent: "codex",
        cwd: repoDir,
        retroactive: true,
        reason: "missed_bind",
      }).exitCode,
    ).toBe(0);
    const bound = readTraceEvents().filter((e) => e.relation === "session_bound");
    expect(bound).toHaveLength(2);
    const knn = knnFor("s-both", bound[0]?.task_run_id ?? "");
    expect(knn.reasons).toEqual(["MIXED_OR_UNATTRIBUTED_USAGE"]);
    expect(knn.detail).toEqual(["session s-both is retroactively bound"]);
  });

  it("fails closed when the done overlay is unreadable", () => {
    const path = doneOverlayPath(specDir, intentId);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not json");
    const result = runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/unreadable/);
  });
});
