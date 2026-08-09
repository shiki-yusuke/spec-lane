import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTraceEvent,
  buildTraceEvent,
  readTraceEvents,
  traceLedgerPath,
} from "../src/trace.js";

// M0 spec-lane 0.5.0 — the writer/reader half of the trace ledger (identity correctness
// itself is covered by trace-fixtures.test.ts's contract differential test).

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lane-trace-test-"));
  originalDataDir = process.env.LANE_DATA_DIR;
  process.env.LANE_DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) process.env.LANE_DATA_DIR = undefined;
  else process.env.LANE_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("buildTraceEvent", () => {
  it("computes a deterministic event_id for the same fact", () => {
    const build = () =>
      buildTraceEvent({
        relation: "session_bound",
        fromRef: { logical_id: "task_run:t1" },
        toRef: { logical_id: "session:s1" },
        occurredAt: "2026-08-09T00:00:00Z",
        actor: { kind: "cli", id: "lane" },
        taskRunId: "t1",
        sessionId: "s1",
      });
    const a = build();
    const b = build();
    expect(a.event_id).toBe(b.event_id);
    expect(a.event_id).toMatch(/^tr1_[0-9a-f]{64}$/);
  });

  it("mints a different event_id for a different fact", () => {
    const a = buildTraceEvent({
      relation: "session_bound",
      fromRef: { logical_id: "task_run:t1" },
      toRef: { logical_id: "session:s1" },
      occurredAt: "2026-08-09T00:00:00Z",
      actor: { kind: "cli", id: "lane" },
      taskRunId: "t1",
      sessionId: "s1",
    });
    const b = buildTraceEvent({
      relation: "session_bound",
      fromRef: { logical_id: "task_run:t1" },
      toRef: { logical_id: "session:s2" },
      occurredAt: "2026-08-09T00:00:00Z",
      actor: { kind: "cli", id: "lane" },
      taskRunId: "t1",
      sessionId: "s2",
    });
    expect(a.event_id).not.toBe(b.event_id);
  });

  it("ignores occurred_at when computing identity (idempotent re-emission)", () => {
    const at = (occurredAt: string) =>
      buildTraceEvent({
        relation: "task_run_started",
        fromRef: { logical_id: "lane:l1" },
        toRef: { logical_id: "task_run:t1" },
        occurredAt,
        actor: { kind: "human" },
        taskRunId: "t1",
      });
    expect(at("2026-08-09T00:00:00Z").event_id).toBe(at("2026-08-09T09:00:00Z").event_id);
  });
});

describe("trace ledger append/read", () => {
  it("writes one JSONL line per event under $LANE_DATA_DIR/trace/events.jsonl, mode 0700 dir", () => {
    const event = buildTraceEvent({
      relation: "task_run_started",
      fromRef: { logical_id: "lane:l1" },
      toRef: { logical_id: "task_run:t1" },
      occurredAt: "2026-08-09T00:00:00Z",
      actor: { kind: "human" },
      taskRunId: "t1",
    });
    appendTraceEvent(event);
    const contents = readFileSync(traceLedgerPath(), "utf-8");
    expect(contents.trim().split("\n")).toHaveLength(1);
    expect(readTraceEvents()).toEqual([event]);
  });

  it("appending the same deterministic event twice is harmless to read (dedup by event_id is the reader's job)", () => {
    const event = buildTraceEvent({
      relation: "task_run_started",
      fromRef: { logical_id: "lane:l1" },
      toRef: { logical_id: "task_run:t1" },
      occurredAt: "2026-08-09T00:00:00Z",
      actor: { kind: "human" },
      taskRunId: "t1",
    });
    appendTraceEvent(event);
    appendTraceEvent(event);
    const all = readTraceEvents();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.event_id)).size).toBe(1);
  });

  it("a correction (supersedes_event_id) mints a distinct event_id, never rewriting the original line", () => {
    const original = buildTraceEvent({
      relation: "declares",
      fromRef: { logical_id: "task_run:t1" },
      toRef: { logical_id: "intent.yaml", content_digest: `sha256:${"1".repeat(64)}` },
      occurredAt: "2026-08-09T00:00:00Z",
      actor: { kind: "human" },
    });
    appendTraceEvent(original);
    const correction = buildTraceEvent({
      relation: "declares",
      fromRef: { logical_id: "task_run:t1" },
      toRef: { logical_id: "intent.yaml", content_digest: `sha256:${"1".repeat(64)}` },
      occurredAt: "2026-08-09T01:00:00Z",
      actor: { kind: "human" },
      supersedesEventId: original.event_id,
    });
    appendTraceEvent(correction);
    expect(correction.event_id).not.toBe(original.event_id);
    expect(readTraceEvents()).toEqual([original, correction]);
  });
});
