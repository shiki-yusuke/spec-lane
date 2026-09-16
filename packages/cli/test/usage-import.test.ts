import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  doneOverlayPath,
  effectiveLedger,
  readDoneOverlay,
  readTraceEvents,
  traceLedgerPath,
} from "@lane/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listObservations } from "../src/calibration-store.js";
import { runAdvance } from "../src/commands/advance.js";
import { runCalibrate } from "../src/commands/calibrate.js";
import { runConsensus } from "../src/commands/consensus.js";
import { runStart } from "../src/commands/start.js";
import { runUsageImport } from "../src/commands/usage-import.js";
import { runWorkBind, runWorkStart } from "../src/commands/work.js";
import { readLaneState } from "../src/state-store.js";
import { writeVerification } from "../src/verification-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// I-2026-09-10-agent-cost-v2-basis-gate (D2/RULE-30) -- the current basis literal, as
// declared in spec.md; used only to compose expected detail strings/diagnostics below, not
// read from the implementation.
const CURRENT_BASIS = "agent-cost-raw-total/v2";
// The real captured 0.2.0 measure/v1 payload spec.md's fixtures ship for this lane
// (docs/spec/I-2026-09-10-agent-cost-v2-basis-gate/fixtures). Its own session id is bound
// below wherever this fixture is used, so the measurement is exactly attributed.
const REAL_0_2_0_FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "docs",
  "spec",
  "I-2026-09-10-agent-cost-v2-basis-gate",
  "fixtures",
  "measure-0.2.0-real-8b283624.json",
);
const REAL_0_2_0_SESSION_ID = "8b283624-3697-453f-be36-8aef0ab7f426";

// M0 spec-lane 0.5.0 — `lane usage-import`, direct (no subprocess) CLI-command tests
// against a fake agent-cost binary (execFile-compatible), matching calibrate.test.ts's
// own fixture-generation convention for this exact subprocess boundary.

interface FakeSession {
  matched: boolean;
  tokens: number;
  costUsd: number;
}

// I-2026-09-10-agent-cost-v2-basis-gate -- accountingBasis/producerVersion are omitted by
// default (matching this lane's own "0.1.x payload carries neither field" shape, D20); a
// caller passes them explicitly to simulate a 0.2.0 payload. conflicting_duplicate_groups /
// missing_dedup_identity_rows / source_quality.identity_missing default to 0 (RULE-07
// "clean") so a basis-focused test doesn't accidentally also trip
// MIXED_OR_UNATTRIBUTED_USAGE via a dedup counter.
function buildMeasureJson(
  sessions: Record<string, FakeSession>,
  opts: { accountingBasis?: string; producerVersion?: string } = {},
): string {
  const sessionIds = Object.keys(sessions);
  const totalTokens = Object.values(sessions).reduce((s, v) => s + v.tokens, 0);
  const totalCost = Object.values(sessions).reduce((s, v) => s + v.costUsd, 0);
  const sessionsJson = sessionIds
    .map(
      (id) =>
        `"${id}": {"matched": ${sessions[id]?.matched}, "rows": [], "totals": {"tokens": ${sessions[id]?.tokens}, "priced_tokens": ${sessions[id]?.tokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${sessions[id]?.costUsd}, "credits": 0}}`,
    )
    .join(",");
  const basisFields = [
    opts.accountingBasis !== undefined
      ? `"accounting_basis": ${JSON.stringify(opts.accountingBasis)},`
      : "",
    opts.producerVersion !== undefined
      ? `"producer_version": ${JSON.stringify(opts.producerVersion)},`
      : "",
  ].join("\n  ");
  return `{
  ${basisFields}
  "protocol_version": "measure/v1",
  "generated_at": "2026-08-09T00:00:00Z",
  "window": {"since": null, "until": null},
  "timezone": "UTC",
  "agent": ["claude"],
  "rates": {"catalog_version": "v1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000000000"},
  "session_ids": [${sessionIds.map((s) => `"${s}"`).join(",")}],
  "sessions": {${sessionsJson}},
  "total": {"rows": [{"month": null, "agent": "claude", "model": "claude-sonnet-5", "token_kind": "output", "tokens": ${totalTokens}, "priced_tokens": ${totalTokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${totalCost}, "credits": 0, "pricing_status": "priced"}], "totals": {"tokens": ${totalTokens}, "priced_tokens": ${totalTokens}, "unpriced_tokens": 0, "estimated_cost_usd": ${totalCost}, "credits": 0}},
  "data_quality": {"malformed_events": 0, "skipped_files": 0, "negative_deltas": 0, "unpriced_tokens": 0, "conflicting_duplicate_groups": 0, "missing_dedup_identity_rows": 0, "source_quality": {"identity_missing": 0}}
}`;
}

function writeFakeAgentCost(
  dir: string,
  sessions: Record<string, FakeSession>,
  opts: { accountingBasis?: string; producerVersion?: string } = {},
): string {
  const path = join(dir, "agent-cost");
  const script = `#!/usr/bin/env bash
cat <<'JSON'
${buildMeasureJson(sessions, opts)}
JSON
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function writeFailingAgentCost(dir: string): string {
  const path = join(dir, "agent-cost");
  writeFileSync(path, "#!/usr/bin/env bash\necho 'boom' >&2\nexit 1\n");
  chmodSync(path, 0o755);
  return path;
}

// TEST-01/04/16/17/D1 -- replays spec.md's own real captured 0.2.0 payload verbatim (no
// hand-typed shape), so the fixture's fields (accounting_basis/producer_version/tokens/
// data_quality) are exactly what a real 0.2.0 agent-cost binary emitted, not a fixture this
// test authored from the implementation.
function writeFakeAgentCostFromRealFixture(dir: string): string {
  const path = join(dir, "agent-cost");
  const fixtureRaw = readFileSync(REAL_0_2_0_FIXTURE_PATH, "utf-8");
  writeFileSync(path, `#!/usr/bin/env bash\ncat <<'JSON'\n${fixtureRaw}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
}

type FakeBranch =
  | { matchSessionId: string; kind: "fail" }
  | {
      matchSessionId: string;
      kind: "success";
      sessions: Record<string, FakeSession>;
      opts?: { accountingBasis?: string; producerVersion?: string };
    };

// D8's staged multi-phase measurement calls the *same* agentCostBin once per phase, with a
// different --session-id set each time -- this fake branches on which session id it was
// invoked with ($* substring match) so two phases in the same run can be given two
// different fake measurement outcomes (used by the multi-phase RULE-33/38 tests).
function writeFakeAgentCostBranching(dir: string, branches: FakeBranch[]): string {
  const path = join(dir, "agent-cost");
  const clauses = branches
    .map((b, i) => {
      const kw = i === 0 ? "if" : "elif";
      const body =
        b.kind === "fail"
          ? "echo 'boom' >&2\n  exit 1"
          : `cat <<'JSON'\n${buildMeasureJson(b.sessions, b.opts ?? {})}\nJSON`;
      return `${kw} [[ "$*" == *"${b.matchSessionId}"* ]]; then\n  ${body}`;
    })
    .join("\n");
  const script = `#!/usr/bin/env bash\n${clauses}\nfi\n`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

describe("runUsageImport", () => {
  let specDir: string;
  let dataDir: string;
  let repoDir: string;
  let binDir: string;
  const intentId = "I-2026-08-09-usage-import";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-usage-import-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-usage-import-data-"));
    repoDir = mkdtempSync(join(tmpdir(), "lane-usage-import-repo-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-usage-import-bin-"));
    process.env.LANE_DATA_DIR = dataDir;
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("fails closed when there is no active task_run for this intent", async () => {
    const result = await runUsageImport(intentId, { specDir, cwd: repoDir });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/lane work start/);
  });

  it("imports one bound session, upserts a scope:phase ledger entry, records usage_imported+attributed_to", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });
    const bin = writeFakeAgentCost(binDir, { s1: { matched: true, tokens: 1000, costUsd: 0.5 } });

    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    expect(result.exitCode, result.message).toBe(0);

    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(1);
    expect(state.cost_ledger[0]).toMatchObject({
      scope: "phase",
      phase: "3_implement",
      tokens: 1000,
      included_in_kpi: true,
    });

    const events = readTraceEvents();
    expect(events.some((e) => e.relation === "usage_imported" && e.session_id === "s1")).toBe(true);
    expect(events.some((e) => e.relation === "attributed_to" && e.task_run_id)).toBe(true);
  });

  it("re-running usage-import upserts the same ledger entry rather than duplicating it", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });
    const bin = writeFakeAgentCost(binDir, { s1: { matched: true, tokens: 1000, costUsd: 0.5 } });

    await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });

    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(1);
  });

  it("agent-cost failure never zero-fills the ledger; sessions are recorded as measurement-incomplete", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });
    const bin = writeFailingAgentCost(binDir);

    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/FAILED/);

    const state = readLaneState(specDir, intentId);
    expect(state.cost_ledger).toHaveLength(0);

    const events = readTraceEvents();
    const usageImported = events.find(
      (e) => e.relation === "usage_imported" && e.session_id === "s1",
    );
    expect(usageImported?.payload?.matched).toBe(false);
  });

  // gpt-5.4 review must1: computeLedgerEntryId keys only on (lane_id, phase, source,
  // pricing_version) -- never task_run_id -- so two concurrent task_runs in the same
  // phase used to overwrite each other's ledger entry (second one processed always won,
  // silently discarding the first's tokens/session_ids). usage-import now aggregates at
  // the phase level: both task_runs' bound sessions go into one union measure call and
  // one ledger entry.
  it("two concurrent task_runs in the same phase are aggregated into one ledger entry, not overwritten", async () => {
    const first = runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const firstTaskRunId = first.message.match(/twr-[0-9a-f-]+/)?.[0] as string;
    const second = runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const secondTaskRunId = second.message.match(/twr-[0-9a-f-]+/)?.[0] as string;

    runWorkBind(intentId, {
      specDir,
      sessionId: "s-first",
      agent: "claude",
      taskRunId: firstTaskRunId,
      cwd: repoDir,
    });
    runWorkBind(intentId, {
      specDir,
      sessionId: "s-second",
      agent: "claude",
      taskRunId: secondTaskRunId,
      cwd: repoDir,
    });

    const bin = writeFakeAgentCost(binDir, {
      "s-first": { matched: true, tokens: 1000, costUsd: 0.5 },
      "s-second": { matched: true, tokens: 2000, costUsd: 1.0 },
    });
    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    expect(result.exitCode, result.message).toBe(0);

    const state = readLaneState(specDir, intentId);
    // Exactly one entry for the phase -- not two colliding writes, not one overwriting
    // the other.
    expect(state.cost_ledger).toHaveLength(1);
    expect(state.cost_ledger[0]).toMatchObject({
      scope: "phase",
      phase: "3_implement",
      tokens: 3000, // union: both sessions' tokens summed, neither one lost
    });
    expect(state.cost_ledger[0]?.session_ids.sort()).toEqual(["s-first", "s-second"]);

    // Per-task_run breakdown still lives in the trace ledger, not the ledger entry.
    const events = readTraceEvents();
    const firstUsage = events.find(
      (e) => e.relation === "usage_imported" && e.session_id === "s-first",
    );
    const secondUsage = events.find(
      (e) => e.relation === "usage_imported" && e.session_id === "s-second",
    );
    expect(firstUsage?.task_run_id).toBe(firstTaskRunId);
    expect(firstUsage?.payload?.tokens).toBe(1000);
    expect(secondUsage?.task_run_id).toBe(secondTaskRunId);
    expect(secondUsage?.payload?.tokens).toBe(2000);
  });

  it("a session agent-cost can't match (matched:false) is not silently treated as zero usage", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s-unmatched", agent: "claude", cwd: repoDir });
    const bin = writeFakeAgentCost(binDir, {
      "s-unmatched": { matched: false, tokens: 0, costUsd: 0 },
    });

    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    expect(result.exitCode, result.message).toBe(0);

    const events = readTraceEvents();
    const usageImported = events.find((e) => e.relation === "usage_imported");
    expect(usageImported?.payload?.matched).toBe(false);
  });

  // CI flake fix (0.5.1): `since` (this phase's earliest task_run.started_at) and
  // `until` (the wall-clock instant runUsageImport reads its own `now`) are two distinct
  // real events -- but on a fast enough run they can round to the same millisecond under
  // Date's ms resolution, producing a since==until window that trace/v1's strict
  // window_ordering_invalid check (correctly) rejects. Freezing Date to one fixed instant
  // for both the work-start and the usage-import call forces that exact collision
  // deterministically, rather than relying on the machine being fast enough to hit it by
  // chance (which is what made this a CI-only intermittent flake, not a local failure).
  it("never produces a since==until usage_imported window, even when task_run.started_at and usage-import's own clock read collapse to the same millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
      runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
      runWorkBind(intentId, { specDir, sessionId: "s-samesame", agent: "claude", cwd: repoDir });
      // Clock deliberately left un-advanced: runUsageImport's own `now` must read the exact
      // same frozen instant as the task_run.started_at set just above.
      const bin = writeFakeAgentCost(binDir, {
        "s-samesame": { matched: true, tokens: 500, costUsd: 0.25 },
      });

      const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
      expect(result.exitCode, result.message).toBe(0);

      const events = readTraceEvents();
      const usageImported = events.find(
        (e) => e.relation === "usage_imported" && e.session_id === "s-samesame",
      );
      expect(usageImported?.payload?.matched).toBe(true);
      const window = usageImported?.payload?.window as { since: string; until: string };
      expect(Date.parse(window.since)).toBeLessThan(Date.parse(window.until));

      const state = readLaneState(specDir, intentId);
      expect(state.cost_ledger).toHaveLength(1);
      expect(state.cost_ledger[0]?.tokens).toBe(500);
    } finally {
      vi.useRealTimers();
    }
  });
});

// I-2026-09-10-agent-cost-v2-basis-gate -- `lane usage-import`'s basis gate (D8/D9/D11/D23,
// RULE-15/16/17/33/38).
describe("runUsageImport -- I-2026-09-10-agent-cost-v2-basis-gate basis gate", () => {
  let specDir: string;
  let dataDir: string;
  let repoDir: string;
  let binDir: string;
  const intentId = "I-2026-09-14-usage-import-basis-gate";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-data-"));
    repoDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-repo-"));
    binDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-bin-"));
    process.env.LANE_DATA_DIR = dataDir;
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  // TEST-01/04/16/17 (D1/RULE-03/04/06/12): a real captured 0.2.0 measurement, exactly
  // attributed and clean (RULE-07's counters are all present and 0 in the fixture), yields
  // an empty reasons array and both new values persisted as-is.
  it("TEST-01/04/16/17: a 0.2.0 measurement persists accounting_basis/producer_version and empty reasons for an exactly-attributed, clean session", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, {
      specDir,
      sessionId: REAL_0_2_0_SESSION_ID,
      agent: "claude",
      cwd: repoDir,
    });
    const bin = writeFakeAgentCostFromRealFixture(binDir);

    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    expect(result.exitCode, result.message).toBe(0);

    const state = readLaneState(specDir, intentId);
    const entry = state.cost_ledger[0];
    // RULE-03: the entry's accounting_basis equals the payload's own declared value.
    expect(entry?.accounting_basis).toBe(CURRENT_BASIS);
    // RULE-04: producer_version mirrors the payload's declared value.
    expect(entry?.producer_version).toBe("0.2.0");
    // RULE-06/RULE-09 (negated) + RULE-07 (all three counters present and 0 in the
    // fixture): current basis, clean counters, exactly-attributed session -> no reasons.
    expect(entry?.knn_ineligibility_reasons).toEqual([]);
    // RULE-12: detail is written even when reasons is empty (one string per failing
    // condition -- zero conditions, zero strings).
    expect(entry?.knn_ineligibility_detail).toEqual([]);
  });

  // TEST-16 (D20/RULE-03/04/06, template T-1): a 0.1.x-shaped measurement (no basis fields
  // at all) normalizes to "unknown"/null and records TOKEN_BASIS_MISMATCH with T-1's detail
  // string (spec.md "Detail string templates").
  it("TEST-16: a 0.1.x measurement (no basis fields) persists accounting_basis 'unknown', producer_version null, and TOKEN_BASIS_MISMATCH with template T-1's detail", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });
    const bin = writeFakeAgentCost(binDir, { s1: { matched: true, tokens: 1000, costUsd: 0.5 } });

    const result = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: bin });
    expect(result.exitCode, result.message).toBe(0);

    const state = readLaneState(specDir, intentId);
    const entry = state.cost_ledger[0];
    expect(entry?.accounting_basis).toBe("unknown");
    expect(entry?.producer_version).toBeNull();
    expect(entry?.knn_ineligibility_reasons).toEqual(["TOKEN_BASIS_MISMATCH"]);
    // Template T-1 (spec.md "Detail string templates"): the payload declared no basis.
    expect(entry?.knn_ineligibility_detail).toEqual([
      `accounting basis is "unknown" (the measurement declared none); the current basis is "${CURRENT_BASIS}"`,
    ]);
  });

  // TEST-19/48 (RULE-16/38, D11/D23): a basis conflict without --supersede-basis refuses
  // the whole run, naming both normalized accounting_basis values and both producer_version
  // values, and leaves the trace ledger and lane-state.json byte-identical. "Must fail
  // against pre-change code" (spec.md) -- pre-change code has no conflict detection at all,
  // so it would silently overwrite instead of refusing.
  it("TEST-19/48: a basis conflict without --supersede-basis refuses the whole run, writing nothing", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s-conflict", agent: "claude", cwd: repoDir });
    const firstBin = writeFakeAgentCost(
      binDir,
      { "s-conflict": { matched: true, tokens: 1000, costUsd: 0.5 } },
      { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" },
    );
    const first = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: firstBin });
    expect(first.exitCode, first.message).toBe(0);

    const beforeState = readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8");
    const beforeTrace = readFileSync(traceLedgerPath(), "utf-8");

    const secondBinDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-bin2-"));
    const secondBin = writeFakeAgentCost(secondBinDir, {
      "s-conflict": { matched: true, tokens: 2000, costUsd: 1.0 },
    }); // no basis fields -> normalizes to "unknown", conflicting with the existing v2 entry
    const second = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: secondBin,
    });
    expect(second.exitCode).not.toBe(0);
    // RULE-16: both normalized accounting_basis values and both producer_version values.
    expect(second.message).toContain(CURRENT_BASIS);
    expect(second.message).toContain("unknown");
    expect(second.message).toContain("0.2.0");

    // D11/RULE-38: no file touched at all by the refused run.
    expect(readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8")).toBe(beforeState);
    expect(readFileSync(traceLedgerPath(), "utf-8")).toBe(beforeTrace);
  });

  // TEST-20 (RULE-17): --supersede-basis writes under the unchanged ledger_entry_id and
  // appends one basis_history element preserving the replaced entry's normalized values;
  // earlier basis_history elements are preserved across a second supersession.
  it("TEST-20: --supersede-basis writes a new entry under the same ledger_entry_id and appends to basis_history, preserving earlier elements", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });
    const binV2 = writeFakeAgentCost(
      binDir,
      { s1: { matched: true, tokens: 1000, costUsd: 0.5 } },
      { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" },
    );
    const first = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: binV2 });
    expect(first.exitCode, first.message).toBe(0);
    const beforeEntry = readLaneState(specDir, intentId).cost_ledger[0];
    const entryId = beforeEntry?.ledger_entry_id;

    const binUnknownDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-bin-unknown-"));
    const binUnknown = writeFakeAgentCost(binUnknownDir, {
      s1: { matched: true, tokens: 1200, costUsd: 0.6 },
    }); // no basis fields -> "unknown"
    const second = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: binUnknown,
      supersedeBasis: true,
    });
    expect(second.exitCode, second.message).toBe(0);

    const afterFirstSupersede = readLaneState(specDir, intentId).cost_ledger.find(
      (e) => e.ledger_entry_id === entryId,
    );
    expect(afterFirstSupersede?.ledger_entry_id).toBe(entryId); // RULE-17: unchanged id
    expect(afterFirstSupersede?.accounting_basis).toBe("unknown");
    expect(afterFirstSupersede?.basis_history).toEqual([
      {
        accounting_basis: CURRENT_BASIS,
        producer_version: "0.2.0",
        tokens: 1000,
        cost_usd: 0.5,
        cost_credits: beforeEntry?.cost_credits ?? null,
        recorded_at: beforeEntry?.imported_at,
      },
    ]);

    // A second supersession preserves the earlier basis_history element and appends a new one.
    const binV3Dir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-bin-v3-"));
    const binV3 = writeFakeAgentCost(
      binV3Dir,
      { s1: { matched: true, tokens: 1300, costUsd: 0.7 } },
      { accountingBasis: "some-other-basis/v3", producerVersion: "0.3.0" },
    );
    const third = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: binV3,
      supersedeBasis: true,
    });
    expect(third.exitCode, third.message).toBe(0);

    const finalEntry = readLaneState(specDir, intentId).cost_ledger.find(
      (e) => e.ledger_entry_id === entryId,
    );
    expect(finalEntry?.accounting_basis).toBe("some-other-basis/v3");
    expect(finalEntry?.basis_history).toHaveLength(2);
    expect(finalEntry?.basis_history?.[0]).toMatchObject({ accounting_basis: CURRENT_BASIS });
    expect(finalEntry?.basis_history?.[1]).toMatchObject({ accounting_basis: "unknown" });
  });

  // TEST-49 (RULE-33): two phases in the same run, one conflicting -- the whole run
  // refuses and nothing is written for either phase, not just the conflicting one.
  it("TEST-49: two phases, one conflicting on basis -- nothing is written for either phase", async () => {
    const firstWorkStart = runWorkStart(intentId, "2_spec", { specDir, cwd: repoDir });
    const firstTaskRunId = firstWorkStart.message.match(/twr-[0-9a-f-]+/)?.[0] as string;
    const secondWorkStart = runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const secondTaskRunId = secondWorkStart.message.match(/twr-[0-9a-f-]+/)?.[0] as string;
    runWorkBind(intentId, {
      specDir,
      sessionId: "s-p1",
      agent: "claude",
      taskRunId: firstTaskRunId,
      cwd: repoDir,
    });
    runWorkBind(intentId, {
      specDir,
      sessionId: "s-p2",
      agent: "claude",
      taskRunId: secondTaskRunId,
      cwd: repoDir,
    });

    const firstBin = writeFakeAgentCost(
      binDir,
      {
        "s-p1": { matched: true, tokens: 1000, costUsd: 0.5 },
        "s-p2": { matched: true, tokens: 2000, costUsd: 1.0 },
      },
      { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" },
    );
    const first = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: firstBin });
    expect(first.exitCode, first.message).toBe(0);

    const beforeState = readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8");
    const beforeTrace = readFileSync(traceLedgerPath(), "utf-8");

    // Second call: phase 2_spec (s-p1) re-measures under the SAME basis (no conflict);
    // phase 3_implement (s-p2) re-measures under a different basis (conflict). One
    // agentCostBin serves both phase-scoped measure() calls in this run, branching on
    // which session id it was invoked with.
    const secondBinDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-bin2-"));
    const secondBin = writeFakeAgentCostBranching(secondBinDir, [
      {
        matchSessionId: "s-p2",
        kind: "success",
        sessions: { "s-p2": { matched: true, tokens: 3000, costUsd: 1.5 } },
        // no basis fields -> "unknown", conflicts with the existing v2 entry for 3_implement
      },
      {
        matchSessionId: "s-p1",
        kind: "success",
        sessions: { "s-p1": { matched: true, tokens: 1000, costUsd: 0.5 } },
        opts: { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" }, // matches existing -> no conflict
      },
    ]);
    const second = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: secondBin,
    });
    expect(second.exitCode).not.toBe(0);

    // RULE-33: the whole command refuses -- neither phase's entry is written, not just the
    // conflicting one.
    expect(readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8")).toBe(beforeState);
    expect(readFileSync(traceLedgerPath(), "utf-8")).toBe(beforeTrace);
  });

  // TEST-62 (RULE-38/D23): one phase's measurement fails while another conflicts on basis
  // in the same run -- refuses, writes nothing (including no matched:false event for the
  // failed phase), and names both the conflict and the failed phase in the diagnostic.
  it("TEST-62: one phase's measure fails while another conflicts on basis -- refuses, writes nothing, names both", async () => {
    const baselineWorkStart = runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    const baselineTaskRunId = baselineWorkStart.message.match(/twr-[0-9a-f-]+/)?.[0] as string;
    runWorkBind(intentId, {
      specDir,
      sessionId: "s-conflict",
      agent: "claude",
      taskRunId: baselineTaskRunId,
      cwd: repoDir,
    });
    const baselineBin = writeFakeAgentCost(
      binDir,
      { "s-conflict": { matched: true, tokens: 1000, costUsd: 0.5 } },
      { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" },
    );
    const baseline = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: baselineBin,
    });
    expect(baseline.exitCode, baseline.message).toBe(0);

    const failWorkStart = runWorkStart(intentId, "2_spec", { specDir, cwd: repoDir });
    const failTaskRunId = failWorkStart.message.match(/twr-[0-9a-f-]+/)?.[0] as string;
    runWorkBind(intentId, {
      specDir,
      sessionId: "s-fail",
      agent: "claude",
      taskRunId: failTaskRunId,
      cwd: repoDir,
    });

    const beforeState = readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8");
    const beforeTrace = readFileSync(traceLedgerPath(), "utf-8");

    // The re-measure of the still-active "3_implement" task_run (s-conflict) conflicts;
    // the new "2_spec" task_run's measurement (s-fail) fails outright.
    const secondBinDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-bin3-"));
    const secondBin = writeFakeAgentCostBranching(secondBinDir, [
      { matchSessionId: "s-fail", kind: "fail" },
      {
        matchSessionId: "s-conflict",
        kind: "success",
        sessions: { "s-conflict": { matched: true, tokens: 1500, costUsd: 0.9 } },
        // no basis fields -> "unknown", conflicts with the existing v2 entry
      },
    ]);
    const second = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: secondBin,
    });
    expect(second.exitCode).not.toBe(0);
    // RULE-38: names both the conflict (both bases/producer_versions) and the failed phase.
    expect(second.message).toContain(CURRENT_BASIS);
    expect(second.message).toContain("unknown");
    expect(second.message).toContain("0.2.0");
    expect(second.message).toMatch(/2_spec/);

    // D23/RULE-38: nothing at all is written -- including no matched:false event for
    // s-fail's failed measurement.
    expect(readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8")).toBe(beforeState);
    expect(readFileSync(traceLedgerPath(), "utf-8")).toBe(beforeTrace);
  });

  // TEST-20b: the same two paths (refuse without the flag, write with --supersede-basis)
  // apply post-done through the done overlay's ledger_delta, and effectiveLedger's
  // composed view preserves the new fields -- same post-done setup convention as
  // calibrate.test.ts's "routes a post-done calibrate's ledger entry to the done overlay"
  // test.
  it("TEST-20b: the refusal and --supersede-basis paths apply post-done (overlay ledger_delta), and effectiveLedger preserves the new fields", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s1", agent: "claude", cwd: repoDir });

    runAdvance(intentId, "2_spec", { specDir });
    runAdvance(intentId, "3_implement", { specDir });
    writeVerification(specDir, intentId, {
      schema_version: "1.0",
      intent_id: intentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "existing" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
    });
    runConsensus(intentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" });
    runConsensus(intentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } });
    runAdvance(intentId, "4_verify", { specDir });
    const doneResult = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-14T09:00:00Z",
      prUrl: "https://github.com/octo-org/spec-lane-demo/pull/1",
    });
    expect(doneResult.exitCode, doneResult.message).toBe(0);

    const binV2 = writeFakeAgentCost(
      binDir,
      { s1: { matched: true, tokens: 1000, costUsd: 0.5 } },
      { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" },
    );
    const first = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: binV2 });
    expect(first.exitCode, first.message).toBe(0);

    // D9/known-affected-behavior: in-repo lane-state.json is never touched post-done.
    const inRepoAfterFirst = readLaneState(specDir, intentId);
    expect(inRepoAfterFirst.cost_ledger).toHaveLength(0);

    const overlayAfterFirst = readDoneOverlay(specDir, intentId);
    expect(overlayAfterFirst?.ledger_delta).toHaveLength(1);
    const overlayEntry = overlayAfterFirst?.ledger_delta[0];
    expect(overlayEntry?.accounting_basis).toBe(CURRENT_BASIS);
    expect(overlayEntry?.producer_version).toBe("0.2.0");

    const beforeOverlayRaw = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
    const beforeStateRaw = readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8");
    const binUnknownDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-bin-unknown2-"));
    const binUnknown = writeFakeAgentCost(binUnknownDir, {
      s1: { matched: true, tokens: 1200, costUsd: 0.6 },
    });
    const conflict = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: binUnknown,
    });
    expect(conflict.exitCode).not.toBe(0);
    // D11/RULE-38 applies identically post-done: overlay and lane-state.json untouched.
    expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(beforeOverlayRaw);
    expect(readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8")).toBe(beforeStateRaw);

    const supersede = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: binUnknown,
      supersedeBasis: true,
    });
    expect(supersede.exitCode, supersede.message).toBe(0);

    const overlayAfterSupersede = readDoneOverlay(specDir, intentId);
    const supersededEntry = overlayAfterSupersede?.ledger_delta.find(
      (e) => e.ledger_entry_id === overlayEntry?.ledger_entry_id,
    );
    expect(supersededEntry?.accounting_basis).toBe("unknown");
    expect(supersededEntry?.basis_history).toEqual([
      {
        accounting_basis: CURRENT_BASIS,
        producer_version: "0.2.0",
        tokens: 1000,
        cost_usd: 0.5,
        cost_credits: overlayEntry?.cost_credits ?? null,
        recorded_at: overlayEntry?.imported_at,
      },
    ]);

    // effectiveLedger (in-repo + overlay composed) preserves the new fields.
    const finalState = readLaneState(specDir, intentId);
    const effective = effectiveLedger(specDir, intentId, finalState);
    const effectiveEntry = effective.find(
      (e) => e.ledger_entry_id === overlayEntry?.ledger_entry_id,
    );
    expect(effectiveEntry?.accounting_basis).toBe("unknown");
    expect(effectiveEntry?.basis_history).toHaveLength(1);
  });

  // TEST-52 (D17, applied to a basis-conflict recovery): usage-import's own conflict/
  // --supersede-basis recovery touches ONLY its own phase-scoped entry -- it writes no
  // trace event or ledger write on calibrate's behalf and creates no observation at all
  // (D9: calibrate writes no trace events of its own; usage-import never writes a
  // calibration observation, full stop). A calibrate call under the same recovered basis
  // (same --session-id identity D17 requires) is the second, separate command that
  // actually produces an observation, and its own (independent, scope:"lane") ledger
  // entry, on the new basis -- this is calibrate's *first* call for this identity, so it
  // is a plain write (no conflict of its own to resolve).
  it("TEST-52: usage-import --supersede-basis recovers only its own entry; a fresh calibrate call under the same basis is what produces the observation", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s-recover", agent: "claude", cwd: repoDir });

    const binV2 = writeFakeAgentCost(
      binDir,
      { "s-recover": { matched: true, tokens: 1000, costUsd: 0.5 } },
      { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" },
    );
    const baseline = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: binV2 });
    expect(baseline.exitCode, baseline.message).toBe(0);

    const binV3Dir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-recover-v3-"));
    const binV3 = writeFakeAgentCost(
      binV3Dir,
      { "s-recover": { matched: true, tokens: 1200, costUsd: 0.6 } },
      { accountingBasis: "some-other-basis/v3", producerVersion: "0.3.0" },
    );
    const conflict = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: binV3 });
    expect(conflict.exitCode).not.toBe(0); // refused -- only usage-import's own entry conflicts

    const supersede = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: binV3,
      supersedeBasis: true,
    });
    expect(supersede.exitCode, supersede.message).toBe(0);

    const stateAfterUsageImport = readLaneState(specDir, intentId);
    const phaseEntry = stateAfterUsageImport.cost_ledger.find((e) => e.scope === "phase");
    expect(phaseEntry?.accounting_basis).toBe("some-other-basis/v3"); // usage-import alone recovered its own entry
    expect(phaseEntry?.basis_history).toHaveLength(1);
    expect(phaseEntry?.basis_history?.[0]).toMatchObject({ accounting_basis: CURRENT_BASIS });

    // D17/D9: usage-import's own recovery never creates a calibration observation.
    expect(listObservations()).toHaveLength(0);

    const calibrateBinDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-recover-cal-"));
    const calibrateBin = writeFakeAgentCost(
      calibrateBinDir,
      { "s-recover": { matched: true, tokens: 1200, costUsd: 0.6 } },
      { accountingBasis: "some-other-basis/v3", producerVersion: "0.3.0" },
    );
    const calibrateResult = await runCalibrate(intentId, {
      specDir,
      sessionIds: ["s-recover"],
      agentCostBin: calibrateBin,
    });
    expect(calibrateResult.exitCode, calibrateResult.message).toBe(0);

    // The second command (calibrate) is what returns the observation to the population,
    // on the same (recovered) basis.
    const observations = listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.accounting_basis).toBe("some-other-basis/v3");

    const stateAfterCalibrate = readLaneState(specDir, intentId);
    const calibrateLaneEntry = stateAfterCalibrate.cost_ledger.find((e) => e.scope === "lane");
    expect(calibrateLaneEntry?.accounting_basis).toBe("some-other-basis/v3");
  });

  // sol round 2 (2026-09-15): D8's staged-preflight-before-any-persistence ordering must
  // hold identically when the conflicting entry lives only in the done overlay's own
  // ledger_delta (post-done, D9's own path) -- not just in-repo lane-state.json. Same
  // post-done setup convention as TEST-20b above; unlike TEST-20b this pins the diagnostic
  // content (both normalized bases) explicitly for the overlay-only-conflict case.
  it("post-done: a basis conflict against the overlay's own ledger_delta entry refuses, naming both bases, trace/lane-state/overlay all byte-identical (RULE-16/38 overlay path)", async () => {
    runWorkStart(intentId, "3_implement", { specDir, cwd: repoDir });
    runWorkBind(intentId, { specDir, sessionId: "s-overlay", agent: "claude", cwd: repoDir });

    runAdvance(intentId, "2_spec", { specDir });
    runAdvance(intentId, "3_implement", { specDir });
    writeVerification(specDir, intentId, {
      schema_version: "1.0",
      intent_id: intentId,
      test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "existing" }],
      test_gaps: [],
      manual_verification: [],
      goal_stopping_condition: [],
    });
    runConsensus(intentId, { specDir, refresh: true, specSsotRef: "docs/spec/x.md" });
    runConsensus(intentId, { specDir, ack: { reviewerKind: "human", reviewerId: "r1" } });
    runAdvance(intentId, "4_verify", { specDir });
    const doneResult = runAdvance(intentId, "5_done", {
      specDir,
      mergedAt: "2026-09-15T09:00:00Z",
      prUrl: "https://github.com/octo-org/spec-lane-demo/pull/1",
    });
    expect(doneResult.exitCode, doneResult.message).toBe(0);

    const binV2 = writeFakeAgentCost(
      binDir,
      { "s-overlay": { matched: true, tokens: 1000, costUsd: 0.5 } },
      { accountingBasis: CURRENT_BASIS, producerVersion: "0.2.0" },
    );
    const baseline = await runUsageImport(intentId, { specDir, cwd: repoDir, agentCostBin: binV2 });
    expect(baseline.exitCode, baseline.message).toBe(0);

    // D9/known-affected-behavior: the baseline lands only in the overlay's ledger_delta.
    const inRepoAfterBaseline = readLaneState(specDir, intentId);
    expect(inRepoAfterBaseline.cost_ledger).toHaveLength(0);
    const overlayAfterBaseline = readDoneOverlay(specDir, intentId);
    expect(overlayAfterBaseline?.ledger_delta).toHaveLength(1);

    const beforeOverlayRaw = readFileSync(doneOverlayPath(specDir, intentId), "utf-8");
    const beforeStateRaw = readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8");
    const beforeTrace = readFileSync(traceLedgerPath(), "utf-8");

    const binUnknownDir = mkdtempSync(join(tmpdir(), "lane-usage-import-basis-overlay-bin-"));
    const binUnknown = writeFakeAgentCost(binUnknownDir, {
      "s-overlay": { matched: true, tokens: 1200, costUsd: 0.6 },
    }); // no basis fields -> "unknown", conflicting with the overlay's existing v2 entry
    const conflict = await runUsageImport(intentId, {
      specDir,
      cwd: repoDir,
      agentCostBin: binUnknown,
    });
    expect(conflict.exitCode).not.toBe(0);
    // RULE-16: both normalized accounting_basis values and both producer_version values.
    expect(conflict.message).toContain(CURRENT_BASIS);
    expect(conflict.message).toContain("unknown");
    expect(conflict.message).toContain("0.2.0");

    // D11/RULE-38 applies to the overlay path too: all three files byte-identical.
    expect(readFileSync(doneOverlayPath(specDir, intentId), "utf-8")).toBe(beforeOverlayRaw);
    expect(readFileSync(join(specDir, intentId, "lane-state.json"), "utf-8")).toBe(beforeStateRaw);
    expect(readFileSync(traceLedgerPath(), "utf-8")).toBe(beforeTrace);
  });
});
