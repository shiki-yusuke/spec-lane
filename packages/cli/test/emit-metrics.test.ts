import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runEmitMetrics } from "../src/commands/emit-metrics.js";
import { runStart } from "../src/commands/start.js";
import { readLaneState, writeLaneState } from "../src/state-store.js";

// Review round 2026-08-07, must-1's own test requirement: a dedicated fake `gh` for the
// --post success path, in the same style as adapters/test/metrics-github-comment.test.ts
// (not fixtures/fake-cli-recorder.mjs, which only ever returns one static stdout value).
// This one always reports "no existing comments" so every call takes the create/POST path.
function writeFakeGh(dir: string): string {
  const path = join(dir, "gh");
  const script = `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = "-X" ]; then
    echo '{"html_url": "https://github.com/octo-org/spec-lane-demo/pull/1#issuecomment-999"}'
    exit 0
  fi
done
if [[ "$*" == *"comments"* && "$*" != *"-f"* ]]; then
  exit 0 # empty stdout => no existing comments
fi
echo '{"html_url": "https://github.com/octo-org/spec-lane-demo/pull/1#issuecomment-1000"}'
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

// Gate-port/MP-3 review — runEmitMetrics constructs AgentCostTelemetryAdapter directly
// (matching calibrate.ts/next.ts's own no-DI convention), so these tests use a fake
// `agent-cost` script (via --agent-cost-bin) rather than mocking a port interface. The
// script always returns the same fixed measure/v1 response regardless of which session
// ids it's asked about -- fine for these tests since they only vary the *ledger* shape,
// not the measured content.
function writeFakeAgentCost(
  dir: string,
  rows: unknown[],
  opts: { protocolVersion?: string } = {},
): string {
  const path = join(dir, "agent-cost");
  const script = `#!/usr/bin/env bash
cat <<'JSON'
{
  "protocol_version": "${opts.protocolVersion ?? "measure/v1"}",
  "generated_at": "2026-08-07T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude", "codex"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": [],
  "sessions": {},
  "total": {"rows": ${JSON.stringify(rows)}, "totals": {"tokens": 0, "priced_tokens": 0, "unpriced_tokens": 0, "estimated_cost_usd": 0, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "source_quality": {}}
}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function addLedgerEntry(
  specDir: string,
  intentId: string,
  overrides: {
    ledger_entry_id: string;
    phase: string;
    source?: "manual" | "claude_jsonl_auto" | "codex_sqlite_auto";
    session_ids?: string[];
    included_in_kpi?: boolean;
  },
): void {
  const state = readLaneState(specDir, intentId);
  writeLaneState(specDir, intentId, {
    ...state,
    cost_ledger: [
      ...state.cost_ledger,
      {
        ledger_entry_id: overrides.ledger_entry_id,
        lane_id: intentId,
        phase: overrides.phase as never,
        source: overrides.source ?? "claude_jsonl_auto",
        scope: "phase",
        session_ids: overrides.session_ids ?? ["sess-1"],
        data_state: "has_usage",
        confidence: "imported_windowed",
        included_in_kpi: overrides.included_in_kpi ?? true,
        tokens: 100,
        turns: 1,
        cost_usd: 0.0003,
        cost_credits: null,
        pricing_version: "v1",
        pricing_as_of: "2026-08-07T00:00:00Z",
        imported_at: "2026-08-07T00:00:00Z",
      },
    ],
  });
}

describe("runEmitMetrics", () => {
  let specDir: string;
  let fakeBinDir: string;
  const intentId = "I-2026-08-07-emit-metrics-test";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-emit-metrics-spec-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "lane-emit-metrics-bin-"));
    process.env.LANE_DATA_DIR = mkdtempSync(join(tmpdir(), "lane-emit-metrics-data-"));
    runStart(intentId, { specDir });
    runAdvance(intentId, "2_spec", { specDir });
    runAdvance(intentId, "3_implement", { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("fails cleanly for a lane that was never started", async () => {
    const result = await runEmitMetrics("I-2026-08-07-never-started", {
      specDir,
      emitterVersion: "0.3.0",
    });
    expect(result.exitCode).toBe(2);
  });

  it("emits an honest no_data snapshot when the ledger has nothing KPI-eligible", async () => {
    const result = await runEmitMetrics(intentId, {
      specDir,
      repository: "octo-org/spec-lane-demo",
      emitterVersion: "0.3.0",
    });
    expect(result.exitCode).toBe(0);
    const decoded = decodeMarker(result.message);
    expect(decoded.data.coverage.status).toBe("no_data");
    expect(decoded.data.records).toEqual([]);
  });

  it("aborts with ambiguous_session_attribution and prints nothing when a session id spans two activities", async () => {
    addLedgerEntry(specDir, intentId, {
      ledger_entry_id: "a",
      phase: "2_spec",
      session_ids: ["shared"],
    });
    addLedgerEntry(specDir, intentId, {
      ledger_entry_id: "b",
      phase: "3_implement",
      session_ids: ["shared"],
    });
    const result = await runEmitMetrics(intentId, {
      specDir,
      repository: "octo-org/spec-lane-demo",
      emitterVersion: "0.3.0",
    });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("ambiguous_session_attribution");
  });

  it("aborts with unknown_token_kind and prints nothing when agent-cost returns an unrecognized token_kind", async () => {
    addLedgerEntry(specDir, intentId, { ledger_entry_id: "a", phase: "3_implement" });
    const bin = writeFakeAgentCost(fakeBinDir, [
      {
        month: null,
        agent: "claude",
        model: "claude-sonnet-5",
        token_kind: "some_future_kind",
        tokens: 100,
        priced_tokens: 100,
        unpriced_tokens: 0,
        estimated_cost_usd: 0.001,
        credits: 0,
        pricing_status: "priced",
      },
    ]);
    const result = await runEmitMetrics(intentId, {
      specDir,
      repository: "octo-org/spec-lane-demo",
      agentCostBin: bin,
      emitterVersion: "0.3.0",
    });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("unknown_token_kind");
  });

  it("aborts cleanly (nothing printed) when agent-cost reports a measure protocol other than measure/v1", async () => {
    addLedgerEntry(specDir, intentId, { ledger_entry_id: "a", phase: "3_implement" });
    const bin = writeFakeAgentCost(fakeBinDir, [], { protocolVersion: "measure/v2" });
    const result = await runEmitMetrics(intentId, {
      specDir,
      repository: "octo-org/spec-lane-demo",
      agentCostBin: bin,
      emitterVersion: "0.3.0",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("telemetry measurement failed");
  });

  it("emits a complete snapshot with a real record when agent-cost returns a matching row", async () => {
    addLedgerEntry(specDir, intentId, { ledger_entry_id: "a", phase: "3_implement" });
    const bin = writeFakeAgentCost(fakeBinDir, [
      {
        month: null,
        agent: "claude",
        model: "claude-sonnet-5",
        token_kind: "output",
        tokens: 500,
        priced_tokens: 500,
        unpriced_tokens: 0,
        estimated_cost_usd: 0.01,
        credits: 0,
        pricing_status: "priced",
      },
    ]);
    const result = await runEmitMetrics(intentId, {
      specDir,
      repository: "octo-org/spec-lane-demo",
      agentCostBin: bin,
      emitterVersion: "0.3.0",
    });
    expect(result.exitCode).toBe(0);
    const decoded = decodeMarker(result.message);
    expect(decoded.data.coverage.status).toBe("complete");
    expect(decoded.data.records).toEqual([
      {
        activity: { namespace: "spec-lane", name: "3_implement" },
        agent: "claude",
        model: "claude-sonnet-5",
        token_kind: "output",
        tokens: 500,
        priced_tokens: 500,
        unpriced_tokens: 0,
        estimated_cost_usd: 0.01,
        credits: 0,
        pricing_status: "priced",
      },
    ]);
  });

  it("records a manual-source entry as an omission, never fabricating a record for it", async () => {
    addLedgerEntry(specDir, intentId, {
      ledger_entry_id: "m1",
      phase: "3_implement",
      source: "manual",
      session_ids: [],
    });
    const result = await runEmitMetrics(intentId, {
      specDir,
      repository: "octo-org/spec-lane-demo",
      emitterVersion: "0.3.0",
    });
    expect(result.exitCode).toBe(0);
    const decoded = decodeMarker(result.message);
    expect(decoded.data.records).toEqual([]);
    expect(decoded.data.coverage.omissions).toEqual([
      { entry_id: "m1", reason: "manual_source_no_breakdown", detail: expect.any(String) },
    ]);
  });

  it("aborts with measure_protocol_violation and prints nothing when agent-cost returns a row with a null agent/model/token_kind", async () => {
    addLedgerEntry(specDir, intentId, { ledger_entry_id: "a", phase: "3_implement" });
    const bin = writeFakeAgentCost(fakeBinDir, [
      {
        month: null,
        agent: null,
        model: "claude-sonnet-5",
        token_kind: "output",
        tokens: 500,
        priced_tokens: 500,
        unpriced_tokens: 0,
        estimated_cost_usd: 0.01,
        credits: 0,
        pricing_status: "priced",
      },
    ]);
    const result = await runEmitMetrics(intentId, {
      specDir,
      repository: "octo-org/spec-lane-demo",
      agentCostBin: bin,
      emitterVersion: "0.3.0",
    });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("measure_protocol_violation");
  });

  // Review round 2026-08-07, must-1: --post's every precondition must be checked *before*
  // anything reaches stdout -- a failed --post must leave stdout completely empty (the
  // marker text must never leak there even though it was already built).
  it("--post fails cleanly (marker still built, nothing printed to stdout) when there is no PR number to post to", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runEmitMetrics(intentId, {
        specDir,
        repository: "octo-org/spec-lane-demo",
        post: true,
        emitterVersion: "0.3.0",
      });
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("--post requires a PR number");
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  // Review round 2026-08-07, must-1: on a successful --post, stdout must carry the marker
  // and *only* the marker -- the "created <url>" status text belongs on stderr.
  it("--post prints only the marker to stdout on success; the created/updated status goes to stderr", async () => {
    addLedgerEntry(specDir, intentId, { ledger_entry_id: "a", phase: "3_implement" });
    const agentCostBin = writeFakeAgentCost(fakeBinDir, []); // no rows => no_data, and fast
    const ghBin = writeFakeGh(fakeBinDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runEmitMetrics(intentId, {
        specDir,
        repository: "octo-org/spec-lane-demo",
        agentCostBin,
        post: true,
        pr: 1,
        ghBin,
        emitterVersion: "0.3.0",
      });
      expect(result.exitCode).toBe(0);
      expect(decodeMarker(result.message).data.coverage.status).toBe("no_data");
      // console.log is never called directly by runEmitMetrics itself -- the marker
      // reaches stdout only via main.ts's report(), which this test doesn't exercise, so
      // the assertion that matters here is that logSpy stayed silent (no premature/extra
      // stdout write) and the status text landed on stderr instead.
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("issuecomment-1000");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("--post fails cleanly (nothing printed) when the gh publish call itself fails", async () => {
    addLedgerEntry(specDir, intentId, { ledger_entry_id: "a", phase: "3_implement" });
    const agentCostBin = writeFakeAgentCost(fakeBinDir, []); // no rows => no_data, and fast
    const brokenGhBin = join(fakeBinDir, "broken-gh");
    writeFileSync(brokenGhBin, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(brokenGhBin, 0o755);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runEmitMetrics(intentId, {
        specDir,
        repository: "octo-org/spec-lane-demo",
        agentCostBin,
        post: true,
        pr: 1,
        ghBin: brokenGhBin,
        emitterVersion: "0.3.0",
      });
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("posting failed");
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails cleanly when repository cannot be determined and was not given", async () => {
    const result = await runEmitMetrics(intentId, {
      specDir,
      cwd: "/",
      emitterVersion: "0.3.0",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("could not determine repository");
  });
});

function decodeMarker(marker: string): {
  data: { records: unknown[]; coverage: { status: string; omissions?: unknown[] } };
} {
  const m = marker.match(/<!--\s*agent-metrics:v1\s+([\s\S]*?)\s*-->/);
  const body = m?.[1] ?? "";
  const fields = Object.fromEntries(
    [...body.matchAll(/([a-z_][a-z0-9_]*)=(\S+)/g)].map(([, k, v]) => [k, v]),
  );
  const bytes = Buffer.from(fields.payload_b64 as string, "base64");
  return JSON.parse(bytes.toString("utf-8"));
}
