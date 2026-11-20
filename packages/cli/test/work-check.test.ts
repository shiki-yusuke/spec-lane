import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type WorkActiveEntry,
  appendTraceEvent,
  buildTraceEvent,
  doneOverlayPath,
  readTraceEvents,
  readWorkActiveFile,
  traceLedgerPath,
  workActivePath,
  writeWorkActiveFile,
} from "@lane/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStart } from "../src/commands/start.js";
import {
  WORK_RUN_TASK_RUN_ENV,
  escapeWorkCheckDisplay,
  runWorkBind,
  runWorkRun,
  runWorkStart,
} from "../src/commands/work.js";
import {
  type LaneRun,
  distMainPath,
  hasDist,
  laneEnv,
  patchLaneState,
  runLaneCli,
  runLaneCliOpenStdin,
  snapshotTrees,
} from "./helpers/work-check-harness.js";

const describeIfDist = hasDist ? describe : describe.skip;
/** Every test below spawns `lane` subprocesses (often in loops); a slow CI runner must not hit
 * vitest's 5 s default, so each describe sets an explicit, generous per-test timeout. */
const SPAWN_TIMEOUT = { timeout: 60_000 };
// I-2026-11-20-pre-merge-bind-gap-warning -- `lane work check` (spec.md RULE-01..03,
// Gherkin §3, TEST-01..05/08/09/11/12/13/15). Fixtures are set up in-process (runStart /
// runWorkStart / runWorkBind against an isolated LANE_DATA_DIR); every check itself runs as a
// real subprocess against dist/main.js so stdout/stderr bytes and the exit status are what an
// installed `lane` binary produces.

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(__dirname, "..", "src", "main.ts"), "utf-8");

const BIND_PREFIX = "lane work bind --";

interface Fixture {
  root: string;
  repo: string;
  specDir: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
}

let fx: Fixture;

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-work-check-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const specDir = join(repo, "docs", "spec");
  const dataDir = join(root, "data");
  process.env.LANE_DATA_DIR = dataDir;
  fx = {
    root,
    repo,
    specDir,
    dataDir,
    env: laneEnv({ LANE_DATA_DIR: dataDir, LANE_CONFIG_DIR: join(root, "config") }),
  };
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: see commands.test.ts's own comment
  delete process.env.LANE_DATA_DIR;
});

/** Creates a lane and moves its persisted state to `phase`/`status`. */
function lane(intentId: string, phase = "2_spec", status = "running", specDir = fx.specDir): void {
  expect(runStart(intentId, { specDir }).exitCode).toBe(0);
  patchLaneState(specDir, intentId, { current_phase: phase, status });
}

/** `lane work start` in-process; returns the issued task_run id. */
function workStart(
  intentId: string,
  phase: string,
  opts: { cwd?: string; specDir?: string } = {},
): string {
  const result = runWorkStart(intentId, phase, {
    specDir: opts.specDir ?? fx.specDir,
    cwd: opts.cwd ?? fx.repo,
  });
  expect(result.exitCode).toBe(0);
  const match = /task_run (twr-[0-9a-f-]+)/.exec(result.message);
  return match?.[1] as string;
}

function bind(intentId: string, sessionId: string, taskRunId: string, cwd = fx.repo): void {
  const result = runWorkBind(intentId, {
    specDir: fx.specDir,
    sessionId,
    agent: "claude",
    taskRunId,
    cwd,
  });
  expect(result.exitCode).toBe(0);
}

/** A session_bound fact for an arbitrary task_run (as `lane work bind` would record it). */
function boundEvent(sessionId: string, taskRunId: string, intentId: string): void {
  appendTraceEvent(
    buildTraceEvent({
      relation: "session_bound",
      fromRef: { logical_id: `task_run:${taskRunId}` },
      toRef: { logical_id: `session:${sessionId}` },
      occurredAt: "2026-11-20T00:00:00.000Z",
      actor: { kind: "human" },
      laneId: intentId,
      taskRunId,
      sessionId,
      payload: {
        binding_method: "manual_bind",
        agent: "claude",
        tool: "lane",
        tool_version: "0.0.0",
        requested_model: null,
        requested_reasoning_effort: null,
        capture_status: "absent",
      },
    }),
  );
}

function check(
  args: string[],
  opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): LaneRun {
  return runLaneCli(["work", "check", ...args], {
    cwd: opts.cwd ?? fx.repo,
    env: opts.env ?? fx.env,
    input: opts.input,
  });
}

function checkFlags(sessionId = "s-1", agent = "claude", extra: string[] = []): LaneRun {
  return check([`--session-id=${sessionId}`, `--agent=${agent}`, ...extra]);
}

function expectSilent(r: LaneRun): void {
  expect(r).toEqual({ status: 0, stdout: "", stderr: "" });
}

/** Exactly one stdout line, nothing on stderr, exit 0; returns the line. */
function expectOneLine(r: LaneRun): string {
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  expect(r.stdout.endsWith("\n")).toBe(true);
  const line = r.stdout.slice(0, -1);
  expect(line.length).toBeGreaterThan(0);
  // one display line: printable ASCII only, so no raw newline/CR/U+2028/control can split it
  expect(line).toMatch(/^[\x20-\x7e]+$/);
  return line;
}

function unboundLine(
  sessionId: string,
  intentId: string,
  taskRunId: string,
  phase: string,
  agent = "claude",
): string {
  return `lane work check: session ${sessionId} is not bound to ${intentId} (task_run ${taskRunId}, phase ${phase}) -- its usage will not count toward calibration; bind it now: lane work bind --intent=${intentId} --task-run=${taskRunId} --session-id=${sessionId} --agent=${agent}\n`;
}

function snapshot(): Record<string, string> {
  return snapshotTrees({ root: fx.root });
}

const INTENT = "I-2026-11-20-check-a";
const INTENT_B = "I-2026-11-20-check-b";

describeIfDist("lane work check", SPAWN_TIMEOUT, () => {
  // ---------------------------------------------------------------- TEST-01 (RULE-01)
  for (const phase of ["2_spec", "3_implement"]) {
    it(`TEST-01: sole unbound candidate at ${phase} prints the exact raw --flag=value bind command`, () => {
      lane(INTENT, phase);
      const taskRun = workStart(INTENT, phase);
      const r = checkFlags("s-1", "claude");
      expect(r).toEqual({
        status: 0,
        stdout: unboundLine("s-1", INTENT, taskRun, phase),
        stderr: "",
      });
      expect(r.stdout).toContain(`--task-run=${taskRun}`);
      expect(r.stdout).not.toMatch(/--(intent|task-run|session-id|agent) /);
      expect(r.stdout).not.toMatch(/['"]/);
    });

    it(`TEST-01: sole candidate at ${phase} already bound to this session is silent`, () => {
      lane(INTENT, phase);
      const taskRun = workStart(INTENT, phase);
      bind(INTENT, "s-1", taskRun);
      expectSilent(checkFlags("s-1", "claude"));
    });
  }

  it("TEST-01: codex agent is carried into the command verbatim", () => {
    lane(INTENT, "3_implement");
    const taskRun = workStart(INTENT, "3_implement");
    expect(checkFlags("s-cx", "codex").stdout).toBe(
      unboundLine("s-cx", INTENT, taskRun, "3_implement", "codex"),
    );
  });

  // ---------------------------------------------------------------- TEST-02 (RULE-03, DEP-07)
  it("TEST-02: zero, one, multiple, malformed and read-failure checks write nothing anywhere", () => {
    // zero candidates, before any data dir exists: no path may be created
    const before0 = snapshot();
    expect(before0["root:data"]).toBeUndefined();
    expectSilent(checkFlags());
    expectSilent(check([], { input: '{"session_id":"s-1","agent":"claude"}' }));
    expect(snapshot()).toEqual(before0);

    // one candidate
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const before1 = snapshot();
    expectOneLine(checkFlags());
    expect(snapshot()).toEqual(before1);

    // multiple candidates
    lane(INTENT_B, "3_implement");
    workStart(INTENT_B, "3_implement");
    const before2 = snapshot();
    expectOneLine(checkFlags());
    expect(snapshot()).toEqual(before2);

    // malformed trace ledger
    writeFileSync(traceLedgerPath(), "{not json\n", { flag: "a" });
    const before3 = snapshot();
    expectSilent(checkFlags());
    expect(snapshot()).toEqual(before3);

    // read failure (unreadable active-work file)
    const active = workActivePath(fx.repo);
    chmodSync(active, 0o000);
    try {
      const before4 = snapshot();
      expectSilent(checkFlags());
      expect(snapshot()).toEqual(before4);
    } finally {
      chmodSync(active, 0o600);
    }
  });

  // ---------------------------------------------------------------- TEST-03 (RULE-02, DEP-01)
  it("TEST-03: identity from flags or hook JSON, flags override JSON", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    // flags only
    expect(checkFlags("s-flag", "claude").stdout).toBe(
      unboundLine("s-flag", INTENT, taskRun, "2_spec"),
    );
    // JSON session_id + --agent flag (the documented hook form)
    expect(check(["--agent", "claude"], { input: '{"session_id":"s-json"}' }).stdout).toBe(
      unboundLine("s-json", INTENT, taskRun, "2_spec"),
    );
    // JSON session_id and agent
    expect(check([], { input: '{"session_id":"s-json","agent":"codex"}' }).stdout).toBe(
      unboundLine("s-json", INTENT, taskRun, "2_spec", "codex"),
    );
    // flag session overrides JSON session; flag agent overrides JSON agent
    expect(
      check(["--session-id", "s-flag", "--agent", "claude"], {
        input: '{"session_id":"s-json","agent":"codex"}',
      }).stdout,
    ).toBe(unboundLine("s-flag", INTENT, taskRun, "2_spec"));
    expect(
      check(["--session-id", "s-flag"], { input: '{"session_id":"s-json","agent":"codex"}' })
        .stdout,
    ).toBe(unboundLine("s-flag", INTENT, taskRun, "2_spec", "codex"));
    // a flag agent overrides an invalid JSON agent
    expect(
      check(["--agent", "claude"], { input: '{"session_id":"s-json","agent":"gemini"}' }).stdout,
    ).toBe(unboundLine("s-json", INTENT, taskRun, "2_spec"));
  });

  it("TEST-03: missing, empty, malformed and invalid input is silent with exit 0", () => {
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const rows: Array<[string, string[], string | undefined]> = [
      ["no flags, empty EOF", [], undefined],
      ["agent only, empty EOF", ["--agent", "claude"], ""],
      ["session only, empty EOF", ["--session-id", "s-1"], ""],
      ["whitespace-only stdin", ["--agent", "claude"], "  \n"],
      ["malformed JSON", ["--agent", "claude"], "{session_id:"],
      ["malformed JSON with both flags missing", [], "not json"],
      ["JSON array", ["--agent", "claude"], '["s-1"]'],
      ["JSON null", ["--agent", "claude"], "null"],
      ["JSON string", ["--agent", "claude"], '"s-1"'],
      ["JSON without session_id", ["--agent", "claude"], '{"cwd":"/"}'],
      ["JSON non-string session_id", ["--agent", "claude"], '{"session_id":42}'],
      ["JSON empty session_id", ["--agent", "claude"], '{"session_id":""}'],
      ["invalid JSON agent", [], '{"session_id":"s-1","agent":"gemini"}'],
      ["JSON without agent", [], '{"session_id":"s-1","source":"startup"}'],
      ["invalid --agent", ["--session-id", "s-1", "--agent", "gemini"], undefined],
      ["empty --session-id", ["--session-id=", "--agent", "claude"], undefined],
      ["missing --session-id value", ["--agent", "claude", "--session-id"], undefined],
      ["missing --agent value", ["--session-id", "s-1", "--agent"], undefined],
      ["unknown option", ["--session-id", "s-1", "--agent", "claude", "--bogus"], undefined],
      ["unknown short option", ["-z"], undefined],
      ["excess positional", ["extra", "--session-id", "s-1", "--agent", "claude"], undefined],
    ];
    for (const [label, args, input] of rows) {
      const r = check(args, { input });
      expect({ label, ...r }).toEqual({ label, status: 0, stdout: "", stderr: "" });
    }
  });

  it("TEST-03: with both identity flags stdin is never read, even when left open", async () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    const r = await runLaneCliOpenStdin(
      ["work", "check", "--session-id", "s-1", "--agent", "claude"],
      {
        cwd: fx.repo,
        env: fx.env,
        timeoutMs: 15_000,
      },
    );
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(unboundLine("s-1", INTENT, taskRun, "2_spec"));
  });

  // ---------------------------------------------------------------- TEST-04 (Q1, D3)
  it("TEST-04: stale, phase-mismatched and non-running lanes never count", () => {
    // phase-advanced stale: started at 2_spec, lane now at 3_implement
    lane("I-2026-11-20-stale", "2_spec");
    workStart("I-2026-11-20-stale", "2_spec");
    patchLaneState(fx.specDir, "I-2026-11-20-stale", { current_phase: "3_implement" });
    // phase-mismatched: entry at 3_implement, lane at 2_spec
    lane("I-2026-11-20-mismatch", "2_spec");
    workStart("I-2026-11-20-mismatch", "3_implement");
    // non-running lane-state statuses at an eligible phase
    for (const status of ["paused", "aborted", "completed", "pending"]) {
      const id = `I-2026-11-20-${status}`;
      lane(id, "2_spec", status);
      workStart(id, "2_spec");
    }
    // ineligible phases even while running
    for (const phase of ["1_intent", "4_verify", "5_done"]) {
      const id = `I-2026-11-20-at-${phase.replace("_", "-")}`;
      lane(id, phase);
      workStart(id, phase);
    }
    expect(readWorkActiveFile(fx.repo).entries).toHaveLength(9);
    expectSilent(checkFlags());
  });

  it("TEST-04: filtering happens before cardinality (eligible + ineligible, same-intent mixed phases)", () => {
    lane(INTENT, "3_implement");
    workStart(INTENT, "2_spec"); // same intent, stale phase
    const current = workStart(INTENT, "3_implement");
    lane(INTENT_B, "2_spec", "paused");
    workStart(INTENT_B, "2_spec");
    expect(checkFlags().stdout).toBe(unboundLine("s-1", INTENT, current, "3_implement"));
  });

  it("TEST-04: two eligible lanes yield one ambiguity line naming both, with no command", () => {
    lane(INTENT, "2_spec");
    const a = workStart(INTENT, "2_spec");
    lane(INTENT_B, "3_implement");
    const b = workStart(INTENT_B, "3_implement");
    const line = expectOneLine(checkFlags());
    expect(line).toContain(INTENT);
    expect(line).toContain(a);
    expect(line).toContain(INTENT_B);
    expect(line).toContain(b);
    expect(line).not.toContain(BIND_PREFIX);
    expect(line).not.toContain("--task-run=");
  });

  it("TEST-04: duplicate task_run ids are multiple entries, hence ambiguity", () => {
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const file = readWorkActiveFile(fx.repo);
    writeWorkActiveFile(fx.repo, {
      ...file,
      entries: [file.entries[0], file.entries[0]] as WorkActiveEntry[],
    });
    const line = expectOneLine(checkFlags());
    expect(line).toContain("2 in-progress task_runs");
    expect(line).not.toContain(BIND_PREFIX);
  });

  // ---------------------------------------------------------------- TEST-05 (Q3, PATH-06)
  it("TEST-05: bad spec_dir / state entries are ignored beside one valid candidate", () => {
    lane(INTENT, "2_spec");
    const valid = workStart(INTENT, "2_spec");
    const file = readWorkActiveFile(fx.repo);
    const base = file.entries[0] as WorkActiveEntry;
    // mismatched identity: lane-state.json under X whose intent_id is Y
    lane("I-2026-11-20-identity", "2_spec");
    patchLaneState(fx.specDir, "I-2026-11-20-identity", { intent_id: INTENT });
    // malformed state
    lane("I-2026-11-20-malformed", "2_spec");
    writeFileSync(join(fx.specDir, "I-2026-11-20-malformed", "lane-state.json"), "{oops");
    // unreadable spec_dir
    const locked = join(fx.root, "locked-spec");
    mkdirSync(join(locked, "I-2026-11-20-locked"), { recursive: true });
    writeFileSync(
      join(locked, "I-2026-11-20-locked", "lane-state.json"),
      readFileSync(join(fx.specDir, INTENT, "lane-state.json")),
    );
    const extra = (intentId: string, specDir: string, n: number): WorkActiveEntry => ({
      ...base,
      intent_id: intentId,
      task_run_id: `twr-extra-${n}`,
      phase_run_id: `pwr-extra-${n}`,
      spec_dir: specDir,
    });
    writeWorkActiveFile(fx.repo, {
      ...file,
      entries: [
        base,
        extra(INTENT, join(fx.root, "absent-spec"), 1), // absent spec_dir
        extra("I-2026-11-20-locked", locked, 2), // unreadable spec_dir
        extra(INTENT, join(fx.root, "repo"), 3), // mismatched spec_dir (no lane there)
        extra("I-2026-11-20-identity", fx.specDir, 4), // state.intent_id !== entry.intent_id
        extra("I-2026-11-20-malformed", fx.specDir, 5), // malformed state
        extra("I-2026-11-20-nostate", fx.specDir, 6), // no lane at all
      ],
    });
    chmodSync(locked, 0o000);
    try {
      expect(checkFlags().stdout).toBe(unboundLine("s-1", INTENT, valid, "2_spec"));
      // all-bad set: drop the valid entry -> silent
      const all = readWorkActiveFile(fx.repo);
      writeWorkActiveFile(fx.repo, { ...all, entries: all.entries.slice(1) });
      expectSilent(checkFlags());
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("TEST-05: legacy entry without spec_dir uses the check-resolved spec dir", () => {
    lane(INTENT, "3_implement");
    const taskRun = workStart(INTENT, "3_implement");
    const file = readWorkActiveFile(fx.repo);
    const { spec_dir: _pinned, ...legacy } = file.entries[0] as WorkActiveEntry;
    writeWorkActiveFile(fx.repo, { ...file, entries: [legacy] });
    expect(checkFlags().stdout).toBe(unboundLine("s-1", INTENT, taskRun, "3_implement"));
  });

  for (const [label, shape] of [
    ["V1 (schema_version 1.0)", { schema_version: "1.0" }],
    ["V1 (missing schema_version)", {}],
    ["V2", { schema_version: "2.0", tracker_url: null, pr_url: null, owner: null }],
  ] as const) {
    it(`TEST-05: ${label} lane-state shape is read like V3`, () => {
      lane(INTENT, "2_spec");
      const taskRun = workStart(INTENT, "2_spec");
      writeFileSync(
        join(fx.specDir, INTENT, "lane-state.json"),
        JSON.stringify({
          ...shape,
          intent_id: INTENT,
          current_phase: "2_spec",
          status: "running",
          created_at: "2026-01-01T00:00:00Z",
        }),
      );
      expect(checkFlags().stdout).toBe(unboundLine("s-1", INTENT, taskRun, "2_spec"));
      patchLaneState(fx.specDir, INTENT, { status: "paused" });
      expectSilent(checkFlags());
    });
  }

  // ---------------------------------------------------------------- TEST-08 (Q3, D4)
  it("TEST-08: active-work identity is the cwd fingerprint, exactly like work start", () => {
    execFileSync("git", ["init", "-q", fx.repo]);
    const child = join(fx.repo, "child");
    mkdirSync(child);
    lane(INTENT, "2_spec");
    const rootRun = workStart(INTENT, "2_spec", { cwd: fx.repo });

    // root start + child hook: different fingerprint -> silent (no git-root normalization,
    // no fallback lookup)
    expectSilent(
      check(["--agent", "claude"], { input: JSON.stringify({ session_id: "s-1", cwd: child }) }),
    );
    expectSilent(check(["--session-id", "s-1", "--agent", "claude"], { cwd: child }));

    // absent hook cwd -> process cwd (the repo root) finds the root entry
    expect(check(["--agent", "claude"], { input: '{"session_id":"s-1"}' }).stdout).toBe(
      unboundLine("s-1", INTENT, rootRun, "2_spec"),
    );

    // child start + child check with the same explicit spec dir warns
    lane(INTENT_B, "3_implement");
    const childRun = workStart(INTENT_B, "3_implement", { cwd: child, specDir: fx.specDir });
    const childEnv = { ...fx.env, LANE_SPEC_DIR: "../docs/spec" };
    expect(
      check(["--session-id", "s-1", "--agent", "claude"], { cwd: child, env: childEnv }).stdout,
    ).toBe(unboundLine("s-1", INTENT_B, childRun, "3_implement"));
    // an explicit --spec-dir also finds it, but the printed command would carry no --spec-dir,
    // so it is a warning without a command (Q2 default-spec-dir gate)
    const flagged = expectOneLine(
      check(["--session-id", "s-1", "--agent", "claude", "--spec-dir", "../docs/spec"], {
        cwd: child,
      }),
    );
    expect(flagged).toContain(childRun);
    expect(flagged).not.toContain(BIND_PREFIX);
    // a supplied but unusable hook cwd is a silent read failure, not a root fallback
    expectSilent(
      check(["--agent", "claude"], {
        input: JSON.stringify({ session_id: "s-1", cwd: join(fx.root, "does-not-exist") }),
      }),
    );
  });

  // ---------------------------------------------------------------- TEST-09 (Q4, PATH-01)
  it("TEST-09: CLI byte capture -- one warning line, zero bytes for every silent result", () => {
    expect(Buffer.byteLength(checkFlags().stdout)).toBe(0); // no candidate at all
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    const warn = checkFlags();
    expect(warn.stdout.split("\n")).toEqual([
      unboundLine("s-1", INTENT, taskRun, "2_spec").slice(0, -1),
      "",
    ]);
    bind(INTENT, "s-1", taskRun);
    const bound = checkFlags();
    expect(Buffer.byteLength(bound.stdout)).toBe(0);
    expect(Buffer.byteLength(bound.stderr)).toBe(0);
    const bad = check(["--bogus"]);
    expect(Buffer.byteLength(bad.stdout) + Buffer.byteLength(bad.stderr)).toBe(0);
  });

  it("TEST-09: the check registration uses its own reporter, never the generic report()", () => {
    const start = mainSource.indexOf('new Command("check")');
    expect(start).toBeGreaterThan(0);
    const end = mainSource.indexOf("workCommand.addCommand(workCheckCommand);", start);
    expect(end).toBeGreaterThan(start);
    const block = mainSource.slice(start, end);
    expect(block).toContain("reportWorkCheck(");
    expect(block).not.toMatch(/\breport\(/);
    expect(block).toContain(".exitOverride(");
    // containment is exclusive to the check: no other command overrides exit/output
    expect(mainSource.match(/\.exitOverride\(/g)).toHaveLength(1);
    expect(mainSource.match(/\.configureOutput\(/g)).toHaveLength(1);
  });

  it("TEST-09: other commands keep Commander's own parse errors (containment does not leak)", () => {
    for (const args of [
      ["work", "bind", "--intent", INTENT, "--agent", "claude", "--session-id"],
      ["work", "start", "--bogus"],
      ["validate"],
    ]) {
      const r = runLaneCli(args, { cwd: fx.repo, env: fx.env });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^error: /);
    }
  });

  // ---------------------------------------------------------------- TEST-11 (Q2, PATH-08)
  it("TEST-11: allowlisted ids give a byte-exact raw command with no shell quoting", () => {
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const file = readWorkActiveFile(fx.repo);
    const entry = { ...(file.entries[0] as WorkActiveEntry), task_run_id: "twr-A.b:c_d-9" };
    writeWorkActiveFile(fx.repo, { ...file, entries: [entry] });
    const r = checkFlags("S.1:a_b-2", "codex");
    expect(r.stdout).toBe(unboundLine("S.1:a_b-2", INTENT, "twr-A.b:c_d-9", "2_spec", "codex"));
    expect(r.stdout).toContain(
      "lane work bind --intent=I-2026-11-20-check-a --task-run=twr-A.b:c_d-9 --session-id=S.1:a_b-2 --agent=codex\n",
    );
  });

  it("TEST-11: every rejected identifier yields an escaped one-line warning and no command", () => {
    const rejects: Array<[string, string]> = [
      ["space", "a b"],
      ["single quote", "a'b"],
      ["double quote", 'a"b'],
      ["semicolon", "a;b"],
      ["pipe", "a|b"],
      ["dollar", "a$(id)"],
      ["backtick", "a`id`"],
      ["ampersand", "a&b"],
      ["redirect", "a>b"],
      ["glob", "a*b"],
      ["backslash", "a\\b"],
      ["C0 SOH", "a\x01b"],
      ["C0 ESC sequence", "a\x1b[31mb"],
      ["newline", "a\nb"],
      ["carriage return", "a\rb"],
      ["DEL", "a\x7fb"],
      ["C1 NEL", "a\x85b"],
      ["C1 CSI", "a\x9bb"],
      ["bidi RLO", "a\u202eb"],
      ["bidi isolate", "a\u2066b"],
      ["zero-width space", "a\u200bb"],
      ["BOM", "a\ufeffb"],
      ["U+2028", "a\u2028b"],
      ["other Unicode", "caf\u00e9"],
      ["astral", "a\u{1f600}b"],
      ["leading dash", "-rf"],
      ["leading dot", ".hidden"],
    ];
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const file = readWorkActiveFile(fx.repo);
    const base = file.entries[0] as WorkActiveEntry;
    for (const [label, bad] of rejects) {
      // as the session id (through hook JSON, which can carry any code point)
      writeWorkActiveFile(fx.repo, { ...file, entries: [base] });
      const s = check(["--agent", "claude"], { input: JSON.stringify({ session_id: bad }) });
      const sLine = expectOneLine(s);
      expect({ label, cmd: sLine.includes(BIND_PREFIX) }).toEqual({ label, cmd: false });
      expect(sLine).toContain(`session ${escapeWorkCheckDisplay(bad)} `);
      expect(sLine).toContain(INTENT);
      // as the task_run id
      writeWorkActiveFile(fx.repo, { ...file, entries: [{ ...base, task_run_id: bad }] });
      const t = checkFlags();
      const tLine = expectOneLine(t);
      expect({ label, cmd: tLine.includes(BIND_PREFIX) }).toEqual({ label, cmd: false });
      expect(tLine).toContain(`task_run ${escapeWorkCheckDisplay(bad)},`);
    }
  });

  it("TEST-11: rejected intent ids (filesystem-safe subset) get no command either", () => {
    // IntentSchema refuses such ids, so the lane dir and active entry are written directly
    // (an active-work file or spec dir edited by hand can still carry them).
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const base = readWorkActiveFile(fx.repo).entries[0] as WorkActiveEntry;
    const state = JSON.parse(readFileSync(join(fx.specDir, INTENT, "lane-state.json"), "utf-8"));
    for (const bad of ["I bad", "I'bad", "-I-lead", "I-caf\u00e9", "I-\u202eevil"]) {
      mkdirSync(join(fx.specDir, bad));
      writeFileSync(
        join(fx.specDir, bad, "lane-state.json"),
        JSON.stringify({ ...state, intent_id: bad }),
      );
      writeWorkActiveFile(fx.repo, {
        schema_version: "1.0",
        entries: [{ ...base, intent_id: bad }],
      });
      const line = expectOneLine(checkFlags());
      expect(line).toContain(escapeWorkCheckDisplay(bad));
      expect(line).not.toContain(BIND_PREFIX);
    }
  });

  it("TEST-11: display escaping is one-line and never shell quoting", () => {
    expect(escapeWorkCheckDisplay("plain-ID_1.2:3")).toBe("plain-ID_1.2:3");
    expect(escapeWorkCheckDisplay("a\\b")).toBe("a\\\\b");
    expect(escapeWorkCheckDisplay("a\x01\n\x7f\x85b")).toBe("a\\x01\\x0a\\x7f\\x85b");
    expect(escapeWorkCheckDisplay("\u202e\u2028\u00e9\u{1f600}")).toBe(
      "\\u{202e}\\u{2028}\\xe9\\u{1f600}",
    );
    expect(escapeWorkCheckDisplay('it\'s "x"')).toBe('it\'s "x"');
  });

  // ---------------------------------------------------------------- TEST-12 (Q4, DEP-04)
  it("TEST-12: a malformed or unreadable active-work file silences the whole check", () => {
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const active = workActivePath(fx.repo);
    const good = readFileSync(active, "utf-8");
    const parsed = JSON.parse(good) as { entries: unknown[] };

    // valid candidate + schema-invalid sibling row: no valid-row isolation
    writeFileSync(
      active,
      JSON.stringify({ ...parsed, entries: [...parsed.entries, { task_run_id: "twr-broken" }] }),
    );
    let before = snapshot();
    expectSilent(checkFlags());
    expect(snapshot()).toEqual(before);

    // not JSON at all
    writeFileSync(active, `${good.slice(0, -5)}`);
    before = snapshot();
    expectSilent(checkFlags());
    expect(snapshot()).toEqual(before);

    // unreadable
    writeFileSync(active, good);
    chmodSync(active, 0o000);
    try {
      before = snapshot();
      expectSilent(checkFlags());
      expect(snapshot()).toEqual(before);
    } finally {
      chmodSync(active, 0o600);
    }
    // the same file restored warns again (the fixture itself is valid)
    expectOneLine(checkFlags());
  });

  it("TEST-12: a malformed or unreadable trace ledger silences the whole check", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    boundEvent("s-1", "twr-elsewhere", INTENT_B); // a conflicting fact that would print a diagnostic
    const ledger = traceLedgerPath();
    const good = readFileSync(ledger, "utf-8");
    expectOneLine(checkFlags());

    writeFileSync(ledger, `${good}{"relation":"session_bound","truncated\n`);
    let before = snapshot();
    expectSilent(checkFlags());
    expect(snapshot()).toEqual(before);

    writeFileSync(ledger, `${good}{"relation":"session_bound"}\n`); // schema-invalid row
    expectSilent(checkFlags());

    writeFileSync(ledger, good);
    bind(INTENT, "s-2", taskRun);
    const withMatch = readFileSync(ledger, "utf-8");
    writeFileSync(ledger, `${withMatch}garbage\n`); // matching binding + malformed row
    expectSilent(checkFlags("s-3"));

    writeFileSync(ledger, good);
    chmodSync(ledger, 0o000);
    try {
      before = snapshot();
      expectSilent(checkFlags());
      expect(snapshot()).toEqual(before);
    } finally {
      chmodSync(ledger, 0o600);
    }
    expect(readTraceEvents().length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- TEST-13 (Q4, D2)
  it("TEST-13: matching binding suppresses; duplicate matching facts stay silent without writes", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    bind(INTENT, "s-1", taskRun);
    bind(INTENT, "s-1", taskRun);
    expect(readTraceEvents().filter((e) => e.relation === "session_bound")).toHaveLength(2);
    const before = snapshot();
    expectSilent(checkFlags());
    expect(snapshot()).toEqual(before);
    // another session is still warned
    expect(checkFlags("s-other").stdout).toBe(unboundLine("s-other", INTENT, taskRun, "2_spec"));
  });

  it("TEST-13: a binding to another task_run gives a diagnostic without a command", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    // the same session bound to a task_run in another repo
    const repo2 = join(fx.root, "repo2");
    mkdirSync(repo2);
    lane(INTENT_B, "3_implement");
    const other = workStart(INTENT_B, "3_implement", { cwd: repo2 });
    bind(INTENT_B, "s-1", other, repo2);
    const line = expectOneLine(checkFlags());
    expect(line).toContain(other);
    expect(line).toContain(INTENT);
    expect(line).toContain(taskRun);
    expect(line).toContain("mixed");
    expect(line).not.toContain(BIND_PREFIX);
  });

  it("TEST-13: matching plus conflicting facts -> the different-task diagnostic wins", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    bind(INTENT, "s-1", taskRun);
    boundEvent("s-1", "twr-other-\u202e", INTENT_B);
    const line = expectOneLine(checkFlags());
    expect(line).toContain("already bound to a different task_run (twr-other-\\u{202e})");
    expect(line).not.toContain(BIND_PREFIX);
  });

  // ---------------------------------------------------------------- TEST-15 (PATH-11, DEP-08)
  it("TEST-15: executing the exact printed command from the check cwd binds the session", () => {
    lane(INTENT, "3_implement");
    const taskRun = workStart(INTENT, "3_implement");
    const r = check(["--agent", "claude"], { input: '{"session_id":"s-e2e","source":"startup"}' });
    const line = expectOneLine(r);
    const marker = "bind it now: ";
    const command = line.slice(line.indexOf(marker) + marker.length);
    expect(command).toBe(
      `lane work bind --intent=${INTENT} --task-run=${taskRun} --session-id=s-e2e --agent=claude`,
    );
    const argv = command.split(" ");
    expect(argv[0]).toBe("lane");
    const bound = runLaneCli(argv.slice(1), { cwd: fx.repo, env: fx.env });
    expect(bound.status).toBe(0);
    expect(bound.stdout).toContain(`Bound session s-e2e to task_run ${taskRun}`);
    const events = readTraceEvents().filter(
      (e) => e.relation === "session_bound" && e.session_id === "s-e2e",
    );
    expect(events.map((e) => e.task_run_id)).toEqual([taskRun]);
    expectSilent(check(["--agent", "claude"], { input: '{"session_id":"s-e2e"}' }));
  });

  it("TEST-15: a hook cwd that differs from the process cwd warns without a command", () => {
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const elsewhere = join(fx.root, "elsewhere");
    mkdirSync(elsewhere);
    const r = check(["--agent", "claude"], {
      cwd: elsewhere,
      input: JSON.stringify({ session_id: "s-1", cwd: fx.repo }),
    });
    const line = expectOneLine(r);
    expect(line).toContain(INTENT);
    expect(line).not.toContain(BIND_PREFIX);
    // the would-be command really is unusable from that cwd
    const attempted = runLaneCli(
      ["work", "bind", `--intent=${INTENT}`, "--session-id=s-1", "--agent=claude"],
      { cwd: elsewhere, env: fx.env },
    );
    expect(attempted.status).not.toBe(0);
  });

  it("TEST-15: a task started with an explicit --spec-dir unlike the default warns without a command", () => {
    const altSpec = join(fx.repo, "alt-spec");
    lane(INTENT, "2_spec", "running", altSpec);
    const taskRun = workStart(INTENT, "2_spec", { specDir: altSpec });
    const line = expectOneLine(checkFlags());
    expect(line).toContain(INTENT);
    expect(line).toContain(taskRun);
    expect(line).not.toContain(BIND_PREFIX);
    const attempted = runLaneCli(
      [
        "work",
        "bind",
        `--intent=${INTENT}`,
        `--task-run=${taskRun}`,
        "--session-id=s-1",
        "--agent=claude",
      ],
      { cwd: fx.repo, env: fx.env },
    );
    expect(attempted.status).toBe(2);
    expect(attempted.stderr).toContain("does not match");
  });
});

// Review follow-ups: TEST-16 (bounded stdin), TEST-17 (`lane work run` child env),
// TEST-18 (a command is printed only when `lane work bind` would accept it), TEST-19 (wrapper
// env is consulted only after cardinality and conflicting bindings), TEST-21 (the printed
// command must select the candidate's own active-work entry).
describeIfDist("lane work check (review follow-ups)", SPAWN_TIMEOUT, () => {
  /** A minimal valid done overlay for `intentId` under `specDir` (as `lane advance 5_done`). */
  function writeDoneOverlay(specDir: string, intentId: string, body?: string): void {
    const path = doneOverlayPath(specDir, intentId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      body ??
        JSON.stringify({
          schema_version: "1.0",
          intent_id: intentId,
          verify_ended_at: "2026-11-19T10:00:00Z",
          done_recorded_at: "2026-11-19T10:05:00Z",
          pr_url: null,
          merge_sha: null,
          spec_dir: realpathSync(specDir),
          spec_dir_fingerprint: "0000000000000000",
          tool_version: "0.14.0",
          done_source: "local_overlay",
          usage_import_gate_overrides: [],
        }),
    );
  }

  function attemptBind(taskRun: string): LaneRun {
    return runLaneCli(
      [
        "work",
        "bind",
        `--intent=${INTENT}`,
        `--task-run=${taskRun}`,
        "--session-id=s-1",
        "--agent=claude",
      ],
      { cwd: fx.repo, env: fx.env },
    );
  }

  // ---------------------------------------------------------------- TEST-16 (RULE-02)
  it("TEST-16: one identity flag + a never-closing stdin pipe exits 0 silently and promptly", async () => {
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const before = snapshot();
    const started = Date.now();
    const r = await runLaneCliOpenStdin(["work", "check", "--agent", "claude"], {
      cwd: fx.repo,
      env: fx.env,
      timeoutMs: 15_000,
    });
    const elapsed = Date.now() - started;
    expect(r.timedOut).toBe(false);
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(elapsed).toBeLessThan(5_000);
    expect(snapshot()).toEqual(before);
  });

  it("TEST-16: a payload over the 64 KiB cap is no input (silent), a small one still warns", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    const big = JSON.stringify({ session_id: "s-1", pad: "x".repeat(70 * 1024) });
    expectSilent(check(["--agent", "claude"], { input: big }));
    expect(check(["--agent", "claude"], { input: '{"session_id":"s-1"}' }).stdout).toBe(
      unboundLine("s-1", INTENT, taskRun, "2_spec"),
    );
  });

  // ---------------------------------------------------------------- TEST-17 (wrapped child)
  it("TEST-17: LANE_WORK_TASK_RUN naming the candidate silences the check; other values do not", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    expect(WORK_RUN_TASK_RUN_ENV).toBe("LANE_WORK_TASK_RUN");
    const withEnv = (value: string) =>
      check(["--session-id=s-1", "--agent=claude"], {
        env: { ...fx.env, LANE_WORK_TASK_RUN: value },
      });
    expectSilent(withEnv(taskRun));
    expect(withEnv("").stdout).toBe(unboundLine("s-1", INTENT, taskRun, "2_spec"));
    expect(withEnv("twr-not-this-one").stdout).toBe(unboundLine("s-1", INTENT, taskRun, "2_spec"));
  });

  it("TEST-17: LANE_WORK_TASK_RUN naming one of several candidates keeps the ambiguity line", () => {
    lane(INTENT, "2_spec");
    lane(INTENT_B, "3_implement");
    const a = workStart(INTENT, "2_spec");
    workStart(INTENT_B, "3_implement");
    const plain = checkFlags();
    expect(expectOneLine(plain)).toContain("2 in-progress task_runs");
    const wrapped = check(["--session-id=s-1", "--agent=claude"], {
      env: { ...fx.env, LANE_WORK_TASK_RUN: a },
    });
    expect(wrapped).toEqual(plain);
  });

  it("TEST-17: a codex child's SessionStart check before thread.started stays silent under lane work run", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    const bin = join(fx.root, "bin");
    const out = join(fx.root, "out");
    mkdirSync(bin);
    mkdirSync(out);
    // control: without the wrapper env the same session would be told to bind manually
    expect(check(["--session-id=th-1", "--agent=codex"]).stdout).toBe(
      unboundLine("th-1", INTENT, taskRun, "2_spec", "codex"),
    );
    const codex = join(bin, "codex");
    writeFileSync(
      codex,
      [
        "#!/bin/sh",
        `printf '%s' "$LANE_WORK_TASK_RUN" > '${join(out, "env.txt")}'`,
        `'${process.execPath}' '${distMainPath}' work check --session-id=th-1 --agent=codex > '${join(out, "check.out")}' 2> '${join(out, "check.err")}' </dev/null`,
        `echo '{"type":"thread.started","thread_id":"th-1"}'`,
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(codex, 0o755);
    const run = runLaneCli(
      ["work", "run", "--intent", INTENT, "--phase", "2_spec", "--", "codex", "exec", "hi"],
      {
        cwd: fx.repo,
        env: { ...fx.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      `{"type":"thread.started","thread_id":"th-1"}\nsession th-1 bound to task_run ${taskRun} (self_reported_thread_id); child exited 0\n`,
    );
    expect(readFileSync(join(out, "env.txt"), "utf-8")).toBe(taskRun);
    expect(readFileSync(join(out, "check.out"), "utf-8")).toBe("");
    expect(readFileSync(join(out, "check.err"), "utf-8")).toBe("");
    // after the wrapper recorded its bind, the plain check is silent too
    expectSilent(check(["--session-id=th-1", "--agent=codex"]));
  });

  it("TEST-17: runWorkRun restores the parent's LANE_WORK_TASK_RUN after spawning", async () => {
    lane(INTENT, "2_spec");
    workStart(INTENT, "2_spec");
    const bin = join(fx.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "claude"), 0o755);
    const originalPath = process.env.PATH;
    const originalEnv = process.env[WORK_RUN_TASK_RUN_ENV];
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      delete process.env[WORK_RUN_TASK_RUN_ENV];
      const first = await runWorkRun(INTENT, "2_spec", ["claude", "-p", "hi"], { cwd: fx.repo });
      expect(first.exitCode).toBe(0);
      expect(process.env[WORK_RUN_TASK_RUN_ENV]).toBeUndefined();
      process.env[WORK_RUN_TASK_RUN_ENV] = "twr-outer";
      const second = await runWorkRun(INTENT, "2_spec", ["claude", "-p", "hi"], { cwd: fx.repo });
      expect(second.exitCode).toBe(0);
      expect(process.env[WORK_RUN_TASK_RUN_ENV]).toBe("twr-outer");
    } finally {
      process.env.PATH = originalPath;
      if (originalEnv === undefined) {
        delete process.env[WORK_RUN_TASK_RUN_ENV];
      } else {
        process.env[WORK_RUN_TASK_RUN_ENV] = originalEnv;
      }
    }
  });

  // ---------------------------------------------------------------- TEST-19 (wrapper env order)
  // Cardinality and conflicting bindings are decided before LANE_WORK_TASK_RUN is consulted;
  // it silences only the sole candidate whose task_run it names exactly.
  function checkWrapped(value: string, sessionId = "s-1"): LaneRun {
    return check([`--session-id=${sessionId}`, "--agent=claude"], {
      env: { ...fx.env, LANE_WORK_TASK_RUN: value },
    });
  }

  it("TEST-19: wrapper env + two candidates -> the ambiguity line, whichever task_run it names", () => {
    lane(INTENT, "2_spec");
    lane(INTENT_B, "3_implement");
    const a = workStart(INTENT, "2_spec");
    const b = workStart(INTENT_B, "3_implement");
    const plain = checkFlags();
    const line = expectOneLine(plain);
    expect(line).toContain("2 in-progress task_runs");
    expect(line).toContain(a);
    expect(line).toContain(b);
    expect(line).not.toContain(BIND_PREFIX);
    expect(checkWrapped(a)).toEqual(plain);
    expect(checkWrapped(b)).toEqual(plain);
  });

  it("TEST-19: wrapper env naming the candidate + a conflicting binding -> the different-task diagnostic", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    boundEvent("s-1", "twr-elsewhere", INTENT_B);
    const plain = checkFlags();
    const line = expectOneLine(plain);
    expect(line).toContain("already bound to a different task_run (twr-elsewhere)");
    expect(line).toContain(`task_run ${taskRun}`);
    expect(line).not.toContain(BIND_PREFIX);
    expect(checkWrapped(taskRun)).toEqual(plain);
  });

  it("TEST-19: wrapper env naming a different task_run -> the normal warning with its command", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    const expected = {
      status: 0,
      stdout: unboundLine("s-1", INTENT, taskRun, "2_spec"),
      stderr: "",
    };
    expect(checkWrapped("twr-some-other-run")).toEqual(expected);
    expect(checkWrapped(`${taskRun}x`)).toEqual(expected);
    // control: naming the sole, unconflicted candidate exactly is the one silent case
    expectSilent(checkWrapped(taskRun));
  });

  // ---------------------------------------------------------------- TEST-21 (bind entry replay)
  it("TEST-21: an ineligible entry with the same task_run id ahead of the candidate -> no command", () => {
    lane(INTENT, "3_implement");
    const taskRun = workStart(INTENT, "3_implement");
    const file = readWorkActiveFile(fx.repo);
    const eligible = file.entries[0] as WorkActiveEntry;
    // phase-mismatched (state is 3_implement) -> filtered out of the candidates, but
    // `lane work bind --task-run=<id>` resolves the first entry with that id: this one.
    const ineligible: WorkActiveEntry = { ...eligible, phase: "2_spec" };
    writeWorkActiveFile(fx.repo, { ...file, entries: [ineligible, eligible] });
    const before = snapshot();
    const line = expectOneLine(checkFlags());
    expect(line).toBe(
      `lane work check: session s-1 is not bound to ${INTENT} (task_run ${taskRun}, phase 3_implement) -- its usage will not count toward calibration; no bind command is printed because lane work bind would resolve task_run ${taskRun} from this cwd to a different active-work entry -- bind it manually`,
    );
    expect(line).not.toContain(BIND_PREFIX);
    expect(snapshot()).toEqual(before);
  });

  it("TEST-21: control -- the same entries with the candidate first still print the command", () => {
    lane(INTENT, "3_implement");
    const taskRun = workStart(INTENT, "3_implement");
    const file = readWorkActiveFile(fx.repo);
    const eligible = file.entries[0] as WorkActiveEntry;
    const ineligible: WorkActiveEntry = { ...eligible, phase: "2_spec" };
    writeWorkActiveFile(fx.repo, { ...file, entries: [eligible, ineligible] });
    expect(checkFlags().stdout).toBe(unboundLine("s-1", INTENT, taskRun, "3_implement"));
  });

  // ---------------------------------------------------------------- TEST-18 (bind would refuse)
  it("TEST-18: an unreadable done overlay -> warning without a command (bind refuses it too)", () => {
    lane(INTENT, "3_implement");
    const taskRun = workStart(INTENT, "3_implement");
    writeDoneOverlay(fx.specDir, INTENT, "{not json");
    const before = snapshot();
    const line = expectOneLine(checkFlags());
    expect(line).toContain(`is not bound to ${INTENT} (task_run ${taskRun}`);
    expect(line).toContain("lane work bind would refuse it here");
    expect(line).toContain("unreadable");
    expect(line).not.toContain(BIND_PREFIX);
    expect(snapshot()).toEqual(before);
    const attempted = attemptBind(taskRun);
    expect(attempted.status).toBe(2);
    expect(attempted.stderr).toContain("unreadable");
  });

  it("TEST-18: a valid done overlay beside running state -> warning without a command", () => {
    lane(INTENT, "2_spec");
    const taskRun = workStart(INTENT, "2_spec");
    writeDoneOverlay(fx.specDir, INTENT);
    const line = expectOneLine(checkFlags());
    expect(line).toContain("already done");
    expect(line).not.toContain(BIND_PREFIX);
    expect(attemptBind(taskRun).status).toBe(2);
  });

  it("TEST-18: a legacy entry whose spec dir lacks intent.yaml -> warning without a command", () => {
    lane(INTENT, "3_implement");
    const taskRun = workStart(INTENT, "3_implement");
    const file = readWorkActiveFile(fx.repo);
    const { spec_dir: _pinned, ...legacy } = file.entries[0] as WorkActiveEntry;
    writeWorkActiveFile(fx.repo, { ...file, entries: [legacy] });
    rmSync(join(fx.specDir, INTENT, "intent.yaml"));
    const line = expectOneLine(checkFlags());
    expect(line).toContain("does not contain intent");
    expect(line).not.toContain(BIND_PREFIX);
    expect(attemptBind(taskRun).status).toBe(2);
  });

  it("TEST-18: a legacy entry with a done overlay under another spec dir -> warning without a command", () => {
    lane(INTENT, "3_implement");
    const taskRun = workStart(INTENT, "3_implement");
    const file = readWorkActiveFile(fx.repo);
    const { spec_dir: _pinned, ...legacy } = file.entries[0] as WorkActiveEntry;
    writeWorkActiveFile(fx.repo, { ...file, entries: [legacy] });
    const otherSpec = join(fx.root, "other-spec");
    mkdirSync(otherSpec);
    writeDoneOverlay(otherSpec, INTENT);
    const line = expectOneLine(checkFlags());
    expect(line).toContain("different spec dir");
    expect(line).not.toContain(BIND_PREFIX);
    expect(attemptBind(taskRun).status).toBe(2);
  });
});
