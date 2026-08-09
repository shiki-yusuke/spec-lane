import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTraceEvent, buildTraceEvent } from "@lane/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAttributionAudit } from "../src/commands/attribution.js";
import { runStart } from "../src/commands/start.js";

// M0 spec-lane 0.5.0 — `lane attribution audit`, direct (no subprocess) CLI-command test.

describe("runAttributionAudit", () => {
  let specDir: string;
  let dataDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-attribution-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-attribution-data-"));
    process.env.LANE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: see commands.test.ts's own comment
    delete process.env.LANE_DATA_DIR;
  });

  it("an empty ledger + empty trace audits clean (research_eligible=true, null tokens)", () => {
    const result = runAttributionAudit({ specDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.message);
    expect(parsed.research_eligible).toBe(true);
    expect(parsed.tokens.exact_attributed).toBeNull();
  });

  it("a bound + measured session across a real intent is exactly_attributed", () => {
    runStart("I-2026-08-09-attr-cli", { specDir });
    appendTraceEvent(
      buildTraceEvent({
        relation: "session_bound",
        fromRef: { logical_id: "task_run:t1" },
        toRef: { logical_id: "session:s1" },
        occurredAt: "2026-08-09T00:00:00Z",
        actor: { kind: "cli", id: "lane" },
        taskRunId: "t1",
        sessionId: "s1",
      }),
    );
    appendTraceEvent(
      buildTraceEvent({
        relation: "usage_imported",
        fromRef: { logical_id: "session:s1" },
        toRef: { logical_id: "task_run:t1" },
        occurredAt: "2026-08-09T01:00:00Z",
        actor: { kind: "cli", id: "lane" },
        taskRunId: "t1",
        sessionId: "s1",
        payload: {
          window: { since: "2026-08-09T00:00:00Z", until: "2026-08-09T01:00:00Z" },
          tokens: 42,
          matched: true,
        },
      }),
    );

    const result = runAttributionAudit({ specDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.message);
    expect(parsed.sessions.exactly_attributed).toEqual([{ session_id: "s1", tokens: 42 }]);
  });

  it("--require-coverage 1.0 exits 3 when a violation exists, still printing the JSON result", () => {
    appendTraceEvent(
      buildTraceEvent({
        relation: "usage_imported",
        fromRef: { logical_id: "session:s-unbound" },
        toRef: { logical_id: "task_run:t-unknown" },
        occurredAt: "2026-08-09T01:00:00Z",
        actor: { kind: "cli", id: "lane" },
        taskRunId: "t-unknown",
        sessionId: "s-unbound",
        payload: {
          window: { since: "2026-08-09T00:00:00Z", until: "2026-08-09T01:00:00Z" },
          tokens: 10,
          matched: true,
        },
      }),
    );
    const result = runAttributionAudit({ specDir, requireCoverage: 1.0 });
    expect(result.exitCode).toBe(3);
    const parsed = JSON.parse(result.message);
    expect(parsed.research_eligible).toBe(false);
    expect(parsed.sessions.unbound).toEqual(["s-unbound"]);
  });

  it("an invalid --since is rejected before any audit runs", () => {
    const result = runAttributionAudit({ specDir, since: "not-a-date" });
    expect(result.exitCode).toBe(1);
  });
});
