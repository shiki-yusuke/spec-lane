# I-2026-09-17-calibrate-agent-cost-timeout — spec

**Revision 2 (2026-09-17)** — revised against the architect's first review
[`reviews/sol-spec-review-1.md`](reviews/sol-spec-review-1.md) ("修正後可", 5 must). Changes:
D6 rewritten (usage-import keeps its partial-failure contract, exit 0), DEP-05 added
(command-level error propagation), RULE-01 now requires the public `timeoutMs` field, RULE-08
added for intent success 6, TEST-09 added so RULE-07 has a failing negative, SCOPE-2 adopted
(shared module `agent-cost-exec.ts` instead of a cross-directory import), timeout semantics
restated as "SIGTERM after N ms", TEST-03/04 setup hardened per the should items.

**Revision 1 (2026-09-17)** — drafted from issue #42 and the preparation brief
`~/ai_bus/briefs/spec-lane-issue-42-prep-2026-09-17.md`.

**Dependency and path cross-check: applicable.** This change (a) introduces a new shared module
(default timeout constant + failure classifier), a new CLI option with a validation guard, and a
new error branch, and (b) touches an area where four CLI commands and two adapters already handle
the same resource — the agent-cost subprocess and its `timeout` — and convert its failure into
different exit states. Both limbs of the applicability test are met, so the full cross-check table
below is mandatory.

**Human-review band: applies, and is satisfied.** On 2026-09-17 the user approved, in one
three-item decision, (1) the cross-check table and its TEST-ID mappings, (2) the axis/test
strategy (real fake-executable subprocess tests per command, no `node:child_process` mocking), and
(3) SCOPE-1 and SCOPE-2 below (both already in `intent.yaml` `allowed_paths`). `declared_risk:
low`, so no separate intent-approval gate applies.

## Premise (recorded at Phase 1)

`intent.yaml` `premise_evidence`: `required: true`, `method: live`, `reproduced: true`.

| when | session | `agent-cost measure --format json --session-id <sid>` directly | `lane calibrate` (0.10.0, cca0338) |
|---|---|---|---|
| 2026-09-16 | 0be24525 (dd PR #5) | 35 s, exit 0 | `telemetry measurement failed: agent-cost measure failed (bin=agent-cost): Command failed: ...` |
| 2026-09-17 (brief) | 30cf8740 (dd PR #6) | 39 s, exit 0 | same failure |
| 2026-09-17 (this session) | 30cf8740 | 40.9 s, exit 0, 4086-byte payload, 32,695,398 tokens, producer 0.2.0 | not re-run (unchanged binary) |

Code trace confirming the mechanism:

- `packages/adapters/src/telemetry/agent-cost.ts:58` `this.timeoutMs = opts.timeoutMs ?? 30_000`;
  `:78-86` `execFileAsync(this.bin, args, { timeout: this.timeoutMs })` whose `catch` folds every
  rejection into `agent-cost measure failed (bin=...): ${err.message}`. Node's `execFile` rejects a
  timed-out child with `killed: true`, `signal: "SIGTERM"` (the default `killSignal`), `code: null`
  and the message `Command failed: <argv>` — none of the three fields reach the message
  (re-confirmed by the architect on Node 22.23.2).
- `packages/adapters/src/budget/codex-budget.ts:124` `this.timeoutMs = opts.timeoutMs ?? 30_000`;
  `:167-175` the same shape for `agent-cost report`, folded into `CodexBudgetConfigError`.
- `packages/cli/src/main.ts:377/404/430/614` define `--agent-cost-bin` on calibrate, emit-metrics,
  next and usage-import; no command defines a timeout option, and none of the four `run*` option
  types carries one.

## Scope findings (files needed vs. `allowed_paths`) — read before approving

| id | file | why | status |
|---|---|---|---|
| SCOPE-1 | `packages/adapters/src/budget/codex-budget.ts` | `lane next` never constructs `AgentCostTelemetryAdapter`; it reaches agent-cost through `CodexBudgetAdapter.snapshot()` (`next.ts:44-47`), which has its own `30_000` default and its own `Command failed` fold. Without this file the flag on `next` would be accepted and ignored — the one-sided fix k47/k48 forbids. Architect: "必須". | in `intent.yaml` `allowed_paths`, **approved by the user 2026-09-17** |
| SCOPE-2 | `packages/adapters/src/agent-cost-exec.ts` (new) and `packages/adapters/src/index.ts` | The default and the classifier are a subprocess policy shared by telemetry and budget, not a telemetry concern; importing `budget/` → `telemetry/` inverts the dependency direction. The new module holds both, `index.ts` re-exports it (the constant is public API for TEST-01). Architect's recommendation (Q1). | in `intent.yaml` `allowed_paths`, **approved by the user 2026-09-17** |

Every other file this spec names is already inside `allowed_paths`.

## Decisions

- **D1 — default 180_000 ms, one constant.** `DEFAULT_AGENT_COST_TIMEOUT_MS = 180_000` and
  `MAX_AGENT_COST_TIMEOUT_MS = 3_600_000` are exported from `agent-cost-exec.ts` and used by both
  adapters' constructors and by the CLI parser. Rationale: 4.4× the slowest observed scan
  (40.9 s); a measurement command protects no availability requirement. The "survives a day-long
  session" claim is a heuristic — no day-long session has been measured.
- **D2 — one CLI option definition.** `main.ts` gains one helper, `withAgentCostOptions(cmd)`, that
  attaches both `--agent-cost-bin <path>` (moved, text unchanged) and
  `--agent-cost-timeout-ms <n>` to a `Command`; the four commands call it instead of defining
  `--agent-cost-bin` inline. The parser for `<n>` is one function, `parseAgentCostTimeoutMs`,
  that throws commander's `InvalidArgumentError` for anything outside RULE-03; commander 13.1.0
  then prints the usage error naming the option and exits non-zero before the action runs
  (confirmed by the architect).
- **D3 — one classification helper in a shared module (SCOPE-2).**
  `describeAgentCostFailure(verb, bin, timeoutMs, err)` lives in `agent-cost-exec.ts` and is
  used by both adapters' `catch` blocks. It returns the timeout message (RULE-04) when
  `err.killed === true`, else the pre-change text (RULE-05).
- **D4 — range is enforced at the CLI only.** The adapters keep accepting any number the caller
  passes (their only callers are the CLI and tests); `1..3_600_000` inclusive is a CLI usage
  contract. Recorded limit: a non-CLI caller passing `timeoutMs: 0` disables the timeout; promote
  the range to an adapter invariant if such a caller ever appears (knowledge entry at Phase 3).
- **D5 — effective timeout is observable.** Both adapters' `timeoutMs` becomes a public
  `readonly` field so a test can assert the default without mocking `execFile` (repo convention:
  no `node:child_process` mocks; `measure-fixtures.test.ts:24`).
- **D6 — each command keeps its existing failure contract.** The timeout is still a failure; the
  new message only replaces the old one inside the error each command already handles:
  `calibrate` (`calibrate.ts:144-152`), `emit-metrics` (`emit-metrics.ts:85-100`) exit 2 via
  `TelemetryImportFailed`; `next` (`next.ts:49-60`) exit 2 via `CodexBudgetConfigError`;
  `usage-import` (`usage-import.ts:228-249`, `:370-374`, `:422`) records the phase in
  `failedPhases`, writes honest `matched:false` trace events, prints
  `agent-cost measure FAILED (<detail>) -- N session(s) recorded as measurement-incomplete` and
  exits 0. No exit code changes; the `<detail>` in the usage-import line now carries the timeout
  text.
- **D7 — timeout semantics.** `timeoutMs` is when Node sends `killSignal` (default `SIGTERM`) to
  the child; it is not a hard wall-clock bound if the child ignores `SIGTERM`. agent-cost is a
  Python CLI with the default `SIGTERM` disposition (terminate), so this lane keeps `SIGTERM`
  and states the semantics honestly rather than switching to `SIGKILL`.
- **D8 — CHANGELOG under `## Unreleased`.** A new heading above `## 0.10.0`, renamed at release
  time; the version bump is out of scope (intent non-goal 4).

## Requirements (EARS)

- **RULE-01** `AgentCostTelemetryAdapter` and `CodexBudgetAdapter` shall expose their effective
  timeout as a public `readonly timeoutMs: number` field, and when the constructor option
  `timeoutMs` is omitted that field shall equal `DEFAULT_AGENT_COST_TIMEOUT_MS`, whose value shall
  be `180_000`.
- **RULE-02** Each of `lane calibrate`, `lane emit-metrics`, `lane next` and `lane usage-import`
  shall accept `--agent-cost-timeout-ms <n>` and pass its parsed value as `timeoutMs` to the
  adapter that command spawns agent-cost through (`AgentCostTelemetryAdapter` for calibrate,
  emit-metrics, usage-import; `CodexBudgetAdapter` for next).
- **RULE-03** When `--agent-cost-timeout-ms` is given a value that is not an integer in
  `1..3_600_000` inclusive (including `0`, a negative number, a non-integer such as `1.5`, a
  non-numeric string, and `3_600_001`), the command shall exit non-zero with a usage error that
  names `--agent-cost-timeout-ms`, and shall not spawn agent-cost.
- **RULE-04** When the agent-cost child is killed by the adapter's timeout (`err.killed === true`),
  the thrown `TelemetryImportFailed` / `CodexBudgetConfigError` message shall contain
  `agent-cost <verb> timed out after <timeoutMs> ms (killed with <signal>)` and `bin=<bin>`, where
  `<verb>` is `measure` or `report` and `<signal>` is `err.signal` (or `unknown signal` if absent).
- **RULE-05** When agent-cost fails for any reason other than the timeout (non-zero exit, missing
  binary), the thrown message shall be the pre-change `agent-cost <verb> failed (bin=<bin>):
  <original message>` and shall not contain `timed out`.
- **RULE-06** The option name `--agent-cost-timeout-ms`, its parser and its range shall be defined
  once in `main.ts` and attached to all four commands through that single definition.
- **RULE-07** `CHANGELOG.md` shall record the new flag, the new default and the new message under
  `## Unreleased`; `README.md`'s agent-cost paragraph (line ~103) shall document
  `--agent-cost-timeout-ms <n>` and the default `180000` next to `--agent-cost-bin`.
- **RULE-08** On the machine that reproduced issue #42, `lane calibrate
  I-2026-09-17-dd-report-cwd-baseline-append --session-id 30cf8740-bc2f-4f1d-be00-f866aabd5f43`
  run from the deterministic-discipline cwd with the default timeout shall exit 0 and write a
  scope:"lane" cost_ledger entry for that lane (manual verification, recorded with the observed
  wall-clock time).
- **RULE-09** Each command's conversion of the adapter error into an exit state shall be
  unchanged by this lane: calibrate / emit-metrics / next exit 2; usage-import exits 0 and reports
  the phase as measurement-incomplete with the timeout detail in its message line.

## Scenarios

```gherkin
Feature: agent-cost subprocess timeout is generous by default, configurable, and named when it fires

  Background:
    Given a fake agent-cost executable "sleeping" whose script is "#!/bin/sh\nexec sleep 5"
    And a fake agent-cost executable "failing" whose script is "#!/bin/sh\necho boom >&2\nexit 3"

  Scenario: default timeout is the shared constant                                    # TEST-01
    When an AgentCostTelemetryAdapter is constructed without timeoutMs
    And a CodexBudgetAdapter is constructed without timeoutMs
    Then both expose a public timeoutMs equal to DEFAULT_AGENT_COST_TIMEOUT_MS
    And DEFAULT_AGENT_COST_TIMEOUT_MS imported from @lane/adapters is 180000

  Scenario Outline: a timeout kill is named                                            # TEST-02
    Given a <adapter> with bin "sleeping" and timeoutMs 200
    When <call> is awaited
    Then it rejects with <error>
    And the message contains "agent-cost <verb> timed out after 200 ms"
    And the message contains "killed with SIGTERM"
    And the message contains "bin="
    Examples:
      | adapter                   | call       | error                  | verb    |
      | AgentCostTelemetryAdapter | measure    | TelemetryImportFailed  | measure |
      | CodexBudgetAdapter        | snapshot   | CodexBudgetConfigError | report  |

  Scenario Outline: a non-timeout failure keeps the pre-change message                  # TEST-03
    Given a <adapter> with bin <bin> and timeoutMs 5000
    When <call> is awaited
    Then it rejects with <error>
    And the message contains "agent-cost <verb> failed (bin="
    And the message does not contain "timed out"
    Examples:
      | adapter                   | bin                         | call     | error                  | verb    |
      | AgentCostTelemetryAdapter | failing                     | measure  | TelemetryImportFailed  | measure |
      | AgentCostTelemetryAdapter | lane-nonexistent-binary-xyz | measure  | TelemetryImportFailed  | measure |
      | CodexBudgetAdapter        | failing                     | snapshot | CodexBudgetConfigError | report  |
      | CodexBudgetAdapter        | lane-nonexistent-binary-xyz | snapshot | CodexBudgetConfigError | report  |

  Scenario Outline: the flag reaches the adapter through main.ts, each command keeps its contract  # TEST-04
    Given the built dist/main.js and a lane prepared for <command>
    When lane is run as "<argv> --agent-cost-bin sleeping --agent-cost-timeout-ms 200"
    Then the exit code is <exit>
    And the output contains "timed out after 200 ms"
    And the output contains <also>
    Examples:
      | command      | argv                                                                                        | exit | also                                   |
      | calibrate    | calibrate <id> --spec-dir <d> --session-id s1                                               | 2    | "telemetry measurement failed"         |
      | usage-import | usage-import --intent <id> --spec-dir <d>                                                   | 0    | "recorded as measurement-incomplete"   |
      | emit-metrics | emit-metrics <id> --spec-dir <d>                                                            | 2    | "telemetry measurement failed"         |
      | next         | next --spec-dir <d> --config-dir <c> --codex-budget-path <y> --claude-rate-limits-path <nx> | 2    | "codex budget:"                        |

  Scenario Outline: an invalid timeout is a usage error and never spawns agent-cost     # TEST-05
    Given a fake agent-cost "marking" that writes a marker file when invoked
    When lane is run as "calibrate <id> --spec-dir <d> --session-id s1 --agent-cost-bin marking --agent-cost-timeout-ms <value>"
    Then the exit code is non-zero
    And the output contains "--agent-cost-timeout-ms"
    And the marker file does not exist
    Examples:
      | value   |
      | 0       |
      | -5      |
      | 1.5     |
      | abc     |
      | 3600001 |

  Scenario: the boundary values are accepted                                            # TEST-06
    When parseAgentCostTimeoutMs is called with "1" and with "3600000"
    Then it returns 1 and 3600000

  Scenario: the option is defined once                                                  # TEST-07
    When packages/cli/src/main.ts is read as text
    Then the literal "--agent-cost-timeout-ms" occurs exactly once
    And each of the commands calibrate, emit-metrics, next, usage-import calls withAgentCostOptions

  Scenario: the operator docs name the flag and the default                             # TEST-09
    When README.md and CHANGELOG.md are read as text
    Then README.md contains "--agent-cost-timeout-ms" and "180000" in the same paragraph as "--agent-cost-bin"
    And CHANGELOG.md contains "--agent-cost-timeout-ms" under a "## Unreleased" heading placed above "## 0.10.0"
```

## Dependency and path cross-check

### DEP — what this change introduces

| id | dependency / change |
|---|---|
| DEP-01 | `DEFAULT_AGENT_COST_TIMEOUT_MS` (180_000) replaces both literal `30_000` defaults |
| DEP-02 | `describeAgentCostFailure` timeout classification on `err.killed` |
| DEP-03 | `--agent-cost-timeout-ms <n>` option + `parseAgentCostTimeoutMs` range guard |
| DEP-04 | `timeoutMs` threaded through each `run*` options type into the adapter constructor |
| DEP-05 | command-level error propagation: the adapter error keeps its existing conversion into each command's exit state (D6/RULE-09) |

### PATH — existing code that spawns agent-cost, builds an adapter, or converts its failure

| id | path | DEP-01 | DEP-02 | DEP-03 | DEP-04 | DEP-05 | test |
|---|---|---|---|---|---|---|---|
| PATH-01 | `adapters/src/telemetry/agent-cost.ts` constructor + `measure` catch | references | references | n/a | n/a | n/a | TEST-01, 02, 03 |
| PATH-02 | `adapters/src/budget/codex-budget.ts` constructor + `snapshot` catch (SCOPE-1) | references | references | n/a | n/a | n/a | TEST-01, 02, 03 |
| PATH-03 | `cli/src/commands/calibrate.ts:142-152` | via adapter | via adapter | n/a | references | exit 2 unchanged | TEST-04 (calibrate), TEST-05 |
| PATH-04 | `cli/src/commands/emit-metrics.ts:80-100` | via adapter | via adapter | n/a | references | exit 2 unchanged | TEST-04 (emit-metrics) |
| PATH-05 | `cli/src/commands/usage-import.ts:169, 228-249, 370-374, 422` | via adapter | via adapter | n/a | references | exit 0 + measurement-incomplete unchanged | TEST-04 (usage-import) |
| PATH-06 | `cli/src/commands/next.ts:44-60` → `CodexBudgetAdapter` | via adapter | via adapter | n/a | references | exit 2 unchanged | TEST-04 (next) |
| PATH-07 | `cli/src/main.ts` four command definitions | n/a | n/a | references (once) | references | n/a | TEST-04, 05, 06, 07 |
| PATH-08 | `adapters/test/telemetry-agent-cost.test.ts`, `codex-budget.test.ts` (real agent-cost, explicit 60-90 s) | does not (explicit) | n/a | n/a | n/a | n/a | unchanged; Known affected behavior 2 |
| PATH-09 | `cli/test/*.test.ts` calling `run*` in-process without `agentCostTimeoutMs` | via default | n/a | n/a | optional field → default | n/a | existing suites stay green (TEST-08) |
| PATH-10 | `adapters/src/agent-cost-exec.ts` (new, SCOPE-2) | defines | defines | n/a | n/a | n/a | TEST-01, 02 |
| PATH-11 | `adapters/src/index.ts` export surface (SCOPE-2) | re-exports | re-exports | n/a | n/a | n/a | TEST-01 (imports from `@lane/adapters`) |

Independent re-search (test_coverage lens obligation, confirmed by the architect):
`grep -rn "execFile\|spawn" packages/*/src` finds agent-cost spawned only in PATH-01 and PATH-02;
`grep -rn "agentCostBin" packages/cli/src` finds only PATH-03..07. `ClaudeBudgetAdapter` reads a
JSON file and spawns nothing. The DEP-05 axis was missing in revision 1 and let D6 misstate
usage-import's exit code; it is now a column.

Every cell is "references", "defines", or a justified "does not"; no "unknown" remains. TEST-08
is the existing suite run (`pnpm lint && pnpm typecheck && pnpm test`) which the Phase 3 gate
already requires.

## Tests

| id | file | asserts | fails pre-change? |
|---|---|---|---|
| TEST-01 | `packages/adapters/test/agent-cost-timeout.test.ts` | RULE-01 via public `timeoutMs` and the exported constant | yes (30_000, field private, no export) |
| TEST-02 | same | RULE-04 for both adapters with the sleeping fake, `timeoutMs: 200` | yes (`Command failed` only) |
| TEST-03 | same | RULE-05 for both adapters (failing fake + missing binary, 4 rows) | no (regression guard) |
| TEST-04 | `packages/cli/test/cli-argv-agent-cost-timeout.test.ts` (dist subprocess, `describeOrSkip` on `dist/main.js` like `cli-argv-basis-flags.test.ts`) | RULE-02 + RULE-09 per command | yes (unknown option) |
| TEST-05 | same | RULE-03: five invalid values, marker file absent | yes |
| TEST-06 | same or `commands.test.ts` | RULE-03 boundary acceptance | yes |
| TEST-07 | same | RULE-06 source-text: single literal, four `withAgentCostOptions` calls | yes |
| TEST-08 | existing suites | no regression | n/a |
| TEST-09 | `packages/cli/test/agent-cost-timeout-docs.test.ts` (repo-doc text test, precedent `skill-md-examples.test.ts`) | RULE-07 | yes |

Test doubles and setup:

- The sleeping fake uses `exec sleep 5` so SIGTERM reaches the sleeper itself and no orphan
  outlives the test by more than the 5 s ceiling.
- `emit-metrics` (TEST-04) spawns agent-cost only for ledger entries that exist
  (`emit-metrics.ts:58-61`): set one up in-process with a fast fake through `runCalibrate`, then
  run the subprocess with the sleeping fake.
- `next` (TEST-04) spawns agent-cost only when the codex budget YAML exists and passes
  `parseCodexBudgetConfig` (`codex-budget.ts:45-97`, `:127-167`): write a complete, period-consistent
  YAML; pass a nonexistent temp path as `--claude-rate-limits-path` so the test never reads the
  developer's `~/.claude`.
- `usage-import` (TEST-04) needs `runStart` + `runWorkStart` + `runWorkBind` in-process, exactly
  as `cli-argv-basis-flags.test.ts` does.

## intent success ↔ RULE / TEST

| intent success line | RULE | TEST |
|---|---|---|
| 1 (default 180_000, shared constant, exposed) | RULE-01 | TEST-01 |
| 2 (timeout message, fails pre-change) | RULE-04 | TEST-02 |
| 3 (non-timeout message unchanged) | RULE-05 | TEST-03 |
| 4 (flag reaches adapter per command) | RULE-02, RULE-06, RULE-09 | TEST-04, TEST-07 |
| 5 (invalid values rejected, range 1..3_600_000) | RULE-03 | TEST-05, TEST-06 |
| 6 (real `lane calibrate` on session 30cf8740 succeeds) | RULE-08 | manual_verification in verification.yaml (deterministic-discipline cwd) |
| 7 (CHANGELOG / README) | RULE-07 | TEST-09 |

## Falsification conditions

- If Node's `execFile` did **not** set `killed: true` on a timeout kill, RULE-04 would misclassify;
  TEST-02 exercises the real `execFile` path with a real sleeping child, so a false assumption
  here fails the test rather than shipping.
- If `lane next` did not actually spawn agent-cost when a codex budget file exists, the `next` row
  of TEST-04 could not observe a timeout; `codex-budget.ts:126-130` returns early only when the
  config file is absent, so the test writes one.
- If usage-import's partial-failure contract were ever changed to fatal, the `usage-import` row of
  TEST-04 (exit 0) fails and forces that change to be a deliberate, separately specified one.

## Non-goals (restated from intent.yaml)

agent-cost's own speed or contracts; retry / partial acceptance; backfilling the dd lanes (dd
follow-up a32 after merge); the version bump; switching `killSignal` to `SIGKILL` (D7).

## Known affected behavior

1. A genuinely hung agent-cost is sent SIGTERM after 180 s instead of 30 s; if it honors the
   signal the caller fails then, if it ignores it the wait is unbounded as before. The operator
   can lower the deadline with the flag.
2. The two real-agent-cost e2e suites pass explicit 60_000-90_000 and are unaffected.
3. Operator scripts grepping usage-import output for `agent-cost measure FAILED (` keep matching;
   only the parenthesized detail changes.

## Limits and open questions

- Q1 — **resolved**: SCOPE-2 (shared module) adopted on the architect's recommendation.
- Q2 — **resolved**: the user approved SCOPE-1 and SCOPE-2 together with the cross-check table
  and the test strategy on 2026-09-17.
- D4's limit (adapter accepts `timeoutMs: 0`) is recorded as a knowledge entry at Phase 3.
