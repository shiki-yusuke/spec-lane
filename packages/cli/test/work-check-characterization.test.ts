import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkActiveFile } from "@lane/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listActiveTaskRunsForIntent } from "../src/commands/work.js";
import { emptyAgentCostHome } from "./helpers/agent-cost-home.js";
import {
  type LaneRun,
  hasDist,
  laneEnv,
  normalizeOutput,
  runLaneCli,
} from "./helpers/work-check-harness.js";

const describeIfDist = hasDist ? describe : describe.skip;
// I-2026-11-20-pre-merge-bind-gap-warning -- TEST-06 (RULE-04, D6, PATH-03): differential
// characterization. The EXPECTED table below was captured from the pre-feature build
// (v0.14.0, before `lane work check` existed) by running this exact fixture sequence against
// dist/main.js; the feature must leave every row's stdout, stderr and exit status unchanged.
// Generated ids, timestamps, temp paths and the version string are normalized.

interface Row {
  status: number | null;
  stdout: string;
  stderr: string;
}

const INTENT = "I-2026-01-01-char-fixture";

const EXPECTED: Record<string, Row> = {
  "work start (no active, ok)": {
    status: 0,
    stdout:
      "Started task_run twr-<UUID> (phase_run pwr-<UUID>) for I-2026-01-01-char-fixture @ 3_implement\nNext: `lane work run --intent <id> --phase <phase> -- <agent-cmd...>` to spawn a wrapped claude/codex session,\nor `lane work bind --intent <id> --session-id <id> --agent <claude|codex>` for a session you started yourself.\n",
    stderr: "",
  },
  "work start (bad phase)": {
    status: 1,
    stdout: "",
    stderr:
      "--phase must be one of 1_intent, 2_spec, 3_implement, 4_verify, 5_done (got: 9_bogus)\n",
  },
  "work start (missing intent)": {
    status: 2,
    stdout: "",
    stderr: "intent.yaml not found for I-2026-01-01-missing\n",
  },
  "work bind (ok)": {
    status: 0,
    stdout: "Bound session s-char-1 to task_run twr-<UUID> (manual_bind)\n",
    stderr: "",
  },
  "work bind (bad agent)": {
    status: 1,
    stdout: "",
    stderr: "--agent must be one of claude|codex (got: gemini)\n",
  },
  "work bind (wrong intent)": {
    status: 2,
    stdout: "",
    stderr:
      "active task_run twr-<UUID> belongs to intent I-2026-01-01-char-fixture, not I-2026-01-01-other -- pass --task-run to select the right one\n",
  },
  "work bind (unknown task run)": {
    status: 2,
    stdout: "",
    stderr: "task_run twr-none is not an active task_run in this repo\n",
  },
  "work run (non-agent)": {
    status: 1,
    stdout: "",
    stderr:
      "lane work run only wraps claude/codex (got: notanagent) -- use `lane work bind` for any other agent's manually-started session\n",
  },
  "work run (phase mismatch)": {
    status: 2,
    stdout: "",
    stderr:
      "active task_run twr-<UUID> was started at phase 3_implement, not 2_spec -- pass --task-run to select the right one\n",
  },
  validate: {
    status: 0,
    stdout:
      "intent.yaml is valid (phase=1_intent).\n[premise_evidence] premise_evidence is not recorded. If this change is AI-originated or the symptom was never directly observed, and it introduces a new guard/branch/completion condition, confirm the premise against a real system or data before writing the spec (design.md §3.9 gate 1) and record it here.\n[success_criteria] success_criteria_matrix is not recorded. Cross-check each line of intent.intent.success against the final diff one at a time and record how it is covered, with a negation test, before publishing a PR (design.md §3.9 gate 2).\n",
    stderr: "",
  },
  advance: {
    status: 0,
    stdout:
      "Advanced I-2026-01-01-char-fixture: 1_intent -> 2_spec\n[premise_evidence] premise_evidence is not recorded. If this change is AI-originated or the symptom was never directly observed, and it introduces a new guard/branch/completion condition, confirm the premise against a real system or data before writing the spec (design.md §3.9 gate 1) and record it here.\n",
    stderr: "",
  },
  "calibrate (missing agent-cost)": {
    status: 2,
    stdout: "",
    stderr:
      "telemetry measurement failed: agent-cost measure failed (bin=<TMP>/missing-agent-cost): spawn <TMP>/missing-agent-cost ENOENT\n",
  },
  "usage-import (missing agent-cost)": {
    status: 0,
    stdout:
      "phase 3_implement (task_run(s) twr-<UUID>): agent-cost measure FAILED (agent-cost measure failed (bin=<TMP>/missing-agent-cost): spawn <TMP>/missing-agent-cost ENOENT) -- 1 session(s) recorded as measurement-incomplete, no ledger entry written\n",
    stderr:
      "coverage_scope: orphan_usage detection is limited to this lane's own cost_ledger session_ids vs. session_bound trace events -- agent-cost has no session-enumeration API, so a session agent-cost knows about but that never touched this lane's ledger or trace ledger cannot be detected as orphan by this command (M0 spec §4).\nattribution audit: research_eligible=false (1 violation(s)) -- run `lane attribution audit` for details\n",
  },
  "attribution audit": {
    status: 0,
    stdout:
      '{\n  "schema_version": "attribution/v1",\n  "generated_at": "<TS>",\n  "window": {\n    "since": "<TS>",\n    "until": "<TS>"\n  },\n  "sessions": {\n    "exactly_attributed": [],\n    "unbound": [],\n    "mixed": [],\n    "orphan_usage": [],\n    "measurement_incomplete": [\n      "s-char-1"\n    ]\n  },\n  "tokens": {\n    "exact_attributed": 0,\n    "total_measured": 0\n  },\n  "research_eligible": false,\n  "violations": [\n    {\n      "reason_code": "MEASUREMENT_INCOMPLETE",\n      "session_id": "s-char-1",\n      "task_run_id": "twr-<UUID>",\n      "detail": "agent-cost could not match session s-char-1 for at least one usage-import window"\n    }\n  ]\n}\n',
    stderr:
      "coverage_scope: orphan_usage detection is limited to this lane's own cost_ledger session_ids vs. session_bound trace events -- agent-cost has no session-enumeration API, so a session agent-cost knows about but that never touched this lane's ledger or trace ledger cannot be detected as orphan by this command (M0 spec §4).\n",
  },
  "work bind (second, ambiguous)": {
    status: 2,
    stdout: "",
    stderr:
      "more than one active task_run in this repo -- pass --task-run to disambiguate. Active: twr-<UUID> (intent=I-2026-01-01-char-fixture phase=3_implement), twr-<UUID> (intent=I-2026-01-01-char-fixture phase=2_spec)\n",
  },
};

describeIfDist("TEST-06: start/bind/run/validate/advance/calibrate output is unchanged", () => {
  let root: string;
  let repo: string;
  let dataDir: string;
  let configDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lane-check-char-")));
    repo = join(root, "repo");
    dataDir = join(root, "data");
    configDir = join(root, "config");
    mkdirSync(repo);
    env = laneEnv({ LANE_DATA_DIR: dataDir, LANE_CONFIG_DIR: configDir, ...emptyAgentCostHome() });
  });

  afterEach(() => {
    // temp dirs are left to the OS, matching the other subprocess tests
  });

  function lane(args: string[]): Row {
    const r: LaneRun = runLaneCli(args, { cwd: repo, env });
    return {
      status: r.status,
      stdout: normalizeOutput(r.stdout, [root]),
      stderr: normalizeOutput(r.stderr, [root]),
    };
  }

  it("TEST-06: fixed fixture sequence matches the pre-feature snapshot byte for byte", () => {
    const actual: Record<string, Row> = {};
    lane(["start", INTENT]);
    actual["work start (no active, ok)"] = lane([
      "work",
      "start",
      "--intent",
      INTENT,
      "--phase",
      "3_implement",
    ]);
    actual["work start (bad phase)"] = lane([
      "work",
      "start",
      "--intent",
      INTENT,
      "--phase",
      "9_bogus",
    ]);
    actual["work start (missing intent)"] = lane([
      "work",
      "start",
      "--intent",
      "I-2026-01-01-missing",
      "--phase",
      "2_spec",
    ]);
    actual["work bind (ok)"] = lane([
      "work",
      "bind",
      "--intent",
      INTENT,
      "--session-id",
      "s-char-1",
      "--agent",
      "claude",
    ]);
    actual["work bind (bad agent)"] = lane([
      "work",
      "bind",
      "--intent",
      INTENT,
      "--session-id",
      "s-char-1",
      "--agent",
      "gemini",
    ]);
    actual["work bind (wrong intent)"] = lane([
      "work",
      "bind",
      "--intent",
      "I-2026-01-01-other",
      "--session-id",
      "s-char-2",
      "--agent",
      "codex",
    ]);
    actual["work bind (unknown task run)"] = lane([
      "work",
      "bind",
      "--intent",
      INTENT,
      "--task-run",
      "twr-none",
      "--session-id",
      "s-char-2",
      "--agent",
      "codex",
    ]);
    actual["work run (non-agent)"] = lane([
      "work",
      "run",
      "--intent",
      INTENT,
      "--phase",
      "3_implement",
      "--",
      "notanagent",
    ]);
    actual["work run (phase mismatch)"] = lane([
      "work",
      "run",
      "--intent",
      INTENT,
      "--phase",
      "2_spec",
      "--",
      "claude",
    ]);
    actual.validate = lane(["validate", INTENT]);
    actual.advance = lane(["advance", INTENT, "--phase", "2_spec"]);
    actual["calibrate (missing agent-cost)"] = lane([
      "calibrate",
      INTENT,
      "--session-id",
      "s-char-1",
      "--agent-cost-bin",
      join(root, "missing-agent-cost"),
    ]);
    actual["usage-import (missing agent-cost)"] = lane([
      "usage-import",
      "--intent",
      INTENT,
      "--agent-cost-bin",
      join(root, "missing-agent-cost"),
    ]);
    actual["attribution audit"] = lane(["attribution", "audit", "--spec-dir", "docs/spec"]);
    actual["work bind (second, ambiguous)"] = (() => {
      lane(["work", "start", "--intent", INTENT, "--phase", "2_spec"]);
      return lane([
        "work",
        "bind",
        "--intent",
        INTENT,
        "--session-id",
        "s-char-3",
        "--agent",
        "claude",
      ]);
    })();

    expect(actual).toEqual(EXPECTED);
  });

  it("TEST-06: listActiveTaskRunsForIntent (usage-import/audit caller) still returns every entry for the intent", () => {
    lane(["start", INTENT]);
    lane(["start", "I-2026-01-01-char-other"]);
    lane(["work", "start", "--intent", INTENT, "--phase", "3_implement"]);
    lane(["work", "start", "--intent", "I-2026-01-01-char-other", "--phase", "2_spec"]);
    lane(["work", "start", "--intent", INTENT, "--phase", "2_spec"]);
    const previous = process.env.LANE_DATA_DIR;
    process.env.LANE_DATA_DIR = dataDir;
    try {
      const all = readWorkActiveFile(repo).entries;
      const listed = listActiveTaskRunsForIntent(repo, INTENT);
      expect(all).toHaveLength(3);
      expect(listed).toEqual(all.filter((e) => e.intent_id === INTENT));
      expect(listed.map((e) => e.phase)).toEqual(["3_implement", "2_spec"]);
    } finally {
      if (previous === undefined) {
        // biome-ignore lint/performance/noDelete: see commands.test.ts's own comment
        delete process.env.LANE_DATA_DIR;
      } else {
        process.env.LANE_DATA_DIR = previous;
      }
    }
  });
});
