# I-2026-11-20-pre-merge-bind-gap-warning — warn before an unbound active session loses attribution eligibility

**Human-review band: applicable.** This is a read-only SessionStart check. It joins hook input,
the active-work file, persisted lane state, and the trace ledger; its deliberately limited
liveness rule, no-write proof, and TEST-01..15 require approval before Phase 3. It implements
the parent-amended `intent.yaml` success criterion as the SSOT and does not advance the lane.

## 0. Investigation and fixed constraints

### Q1 — active-work liveness is phase-scoped, not a close lifecycle

`lane work start` appends `WorkActiveEntry` records and `task_run_started` events; no close or
status transition exists. `WorkActiveEntrySchema` currently has no `status` field
(`packages/core/src/work.ts:25-42`), and `readWorkActiveFile` returns all appended entries
(`packages/core/src/work.ts:67-72`). This feature **must not add a close transition**.

A candidate is an active-work entry only when all of the following are true:

1. its intent has readable lane state whose `status === "running"` and whose `current_phase` is
   `2_spec` or `3_implement`;
2. `state.intent_id === entry.intent_id` and `entry.phase === state.current_phase`; and
3. the entry belongs to that intent and the complete active-work file is readable.

The required `state.status` predicate makes paused, aborted, and every non-running lane
ineligible. Entry status is not a liveness signal and must not be invented or read as one. An
entry from a lane that advanced to another phase is stale and ignored. A stale entry that is
indistinguishable from a running entry because it has the same eligible phase remains a known
limitation of the append-only store; no heuristic, close write, or inferred timeout is allowed.

`lane work bind` resolves from the whole active file and fails closed whenever it has multiple
entries unless `--task-run` selects one (`packages/core/src/work.ts:128-145`). Therefore every
printed remediation command must select the precise candidate task run.

### Q2 — input, identity, and exact command rendering

The check accepts `session_id` and `cwd` from one JSON stdin object and accepts explicit
`--session-id` and `--agent claude|codex`. Flags override JSON. **When both identity flags are
present, the check must not read stdin at all** (including when stdin remains open); it proceeds
with the flags and `process.cwd()`. Agent identity is never inferred
from `source`, executable name, or missing JSON; a JSON `agent` is accepted only when exactly
`claude` or `codex`. Empty EOF is no input, not an error.

For one eligible, unbound candidate, the promised command has this token form (all option values
use `--flag=<value>`, never a following positional value):

```sh
lane work bind --intent=<intent> --task-run=<task-run> --session-id=<session> --agent=<agent>
```

Every displayed identifier (session, intent, task run, and any identifier in ambiguity output) is
rendered for one human-readable line: printable ASCII other than backslash is displayed as itself;
backslash is `\\`; controls, format characters, separators, and other non-printing code points
are escaped as `\\xNN` or `\\u{...}`. This is display escaping only, never shell quoting.

A command is printed only if **every** command identifier matches the exact ASCII allowlist
`^[A-Za-z0-9][A-Za-z0-9._:-]*$`. The command contains the raw allowlisted values after `=` and
uses no shell quoting at all. If any identifier fails that allowlist (including whitespace,
quotes, shell metacharacters, C0/C1 controls, bidi or other format characters, U+2028, other
Unicode, or a leading dash), the check prints an escaped warning naming the intent without a
command. Ambiguity output never contains a command and escapes every identifier. These rules
prevent terminal/output injection and option confusion without claiming unsafe values are safe to
paste into a shell.

The command has a second, independent eligibility gate: because its execution has no `--cwd` or
`--spec-dir` token, a `runWorkBind` invocation from the check process's own cwd with its default
spec-dir resolution must select the same active-work file and the candidate's effective spec dir.
For a pinned entry, that default spec dir must canonicalize to `entry.spec_dir`; for a legacy
entry without `spec_dir`, it must equal the check-resolved fallback spec dir. A hook payload cwd
may select the candidate for the warning, but it must not make an executable command appear when
the process cwd would select a different active-work file. If either identity differs, the check
prints the escaped warning naming the intent without a command.

### Q3 — repository identity is deliberately cwd-scoped

The check must use exactly the same active-work identity as `lane work start`: `hook.cwd` when it
is supplied as a string, otherwise `process.cwd()`, passed directly to `readWorkActiveFile`. That
helper uses `workActivePath(repoPath)` and the existing `repoFingerprint(repoPath)` (`realpath`
then full SHA-1; `packages/core/src/work.ts:49-71`). It must not substitute `gitWorktreeRoot`,
normalize to a worktree root, add a fallback lookup, or migrate entries. `work start`, `bind`, and
`run` remain unchanged.

This intentionally means a start at repository root and a hook invoked from a subdirectory have
different fingerprints, so the latter sees no former entry. To make a subdirectory hook useful,
operators must start and check from the same cwd; because `resolveSpecDir` is likewise cwd-relative,
a subdirectory start/check normally needs the same explicit `--spec-dir` (or `LANE_SPEC_DIR`).
`entry.spec_dir`, when present, supplies the candidate's state location; a legacy entry without it
uses the check's resolved spec directory, matching the existing bind/run fallback convention.
An entry whose `spec_dir` is missing, unreadable, or whose intent/state cannot be read is ignored;
there is no cross-directory rescue.

### Q4 — output, parsing, and no-write boundary

Add a check-specific reporter, not `main.ts`'s generic `report()`: generic success reporting uses
`console.log` and would write a newline for an empty message. The check reporter writes exactly
the nonempty warning plus one newline, and writes **no bytes** for every no-op. It sends nothing to
stderr and returns exit 0 for normal, malformed, absent, unreadable, and parser-invalid inputs.

Registration must wrap Commander parsing/action errors for this subcommand so missing option
values, invalid `--agent`, and unknown options are swallowed as silent exit 0 rather than letting
Commander print usage or exit nonzero. That containment is exclusive to `lane work check`; other
commands retain their existing parsing and reporter behavior.

The check calls only read helpers: `readWorkActiveFile`, `resolveSpecDir`, `listIntentIds` /
state reads, and `readTraceEvents`. It must not call an append/write helper or create a directory.
The existing active-work and trace readers remain whole-file readers: a malformed or unreadable
active-work file, or a malformed or unreadable trace file, makes this check deterministically
silent (exit 0 and zero bytes), even if another entry or trace row would otherwise yield a warning.
It must not add tolerant reader APIs, selectively retain valid rows, or add allowed paths. A
state/spec-dir failure still makes only that prospective entry ineligible. For the sole candidate, a trace event with
`relation === "session_bound"`, the supplied `session_id`, and its `task_run_id` means the session
is already bound and the check is silent. A `session_bound` event for the supplied session and a
different task run produces one escaped diagnostic and no bind command, **even when matching
binding events also exist**: the different-task fact takes precedence because suggesting another
bind would turn the observation mixed. With no binding event for that session, the check may issue the
allowlist-gated warning and command.

## 1. Design decisions

- **D1 Candidate selection.** Export `runWorkCheck`; read the cwd-fingerprinted active file once
  and the trace ledger once. Each existing reader is whole-file: either reader's malformed or
  unreadable file makes the entire check silently return exit 0 with zero bytes; valid rows are
  never isolated from a malformed sibling. Evaluate each remaining entry under Q1, including
  `state.intent_id === entry.intent_id`; state is read from canonical `entry.spec_dir` where
  present, otherwise the one cwd-resolved check spec directory. Do not deduplicate equal task-run
  IDs silently: duplicate IDs are multiple entries and hence ambiguity if eligible. No tolerant
  reader API or additional allowed path is introduced.
- **D2 Cardinality and binding.** Zero candidates or an already-bound sole candidate are silent.
  Any binding to a different task run takes precedence over matching binding facts: a sole
  candidate with either a conflicting-only or matching-plus-conflicting binding emits one
  diagnostic and no command. One
  unbound candidate produces exactly one line and the Q2 command only when every identifier is
  allowlisted and an unoptioned `runWorkBind` from the check process cwd would resolve the same
  active-work file and effective spec dir. Two or more candidates, including same-intent/mixed-phase
  and duplicate-ID shapes that remain eligible, produce exactly one escaped ambiguity line, no
  command, and no guessed target.
- **D3 Liveness boundary.** Apply `state.status === "running"` and phase equality before
  cardinality. A phase-mismatched, phase-advanced stale, paused, or aborted lane does not count.
  No close transition, timeout, or state mutation is introduced.
- **D4 Cwd identity.** The hook payload cwd is used verbatim as the `work start` cwd would be;
  only an absent/non-string cwd falls back to process cwd. A supplied unusable path is a silent
  read failure, not a root fallback. Spec lookup follows the same cwd semantics and
  does not use git-root normalization. The subdirectory limitation is documented, tested, and
  accepted. Before suggesting a bind, independently resolve the process cwd as `runWorkBind`
  would: its active-work file must equal the hook-cwd candidate file, and its default spec dir
  must equal the candidate's pinned (or legacy-fallback) spec dir. A mismatch is warning-only.
- **D5 Safe non-blocking interface.** Flags override JSON; when both `--session-id` and `--agent`
  are supplied, stdin is never read, including an open stream. Missing identity, empty EOF, malformed
  JSON, invalid agent, missing option value, unknown option, and any read failure are silent
  exit-0 outcomes. An unsafe identifier yields an escaped warning with no command; a conflicting
  binding yields its diagnostic with no command. Only the check-specific reporter owns this
  behavior.
- **D6 Compatibility and release hygiene.** Do not alter start/bind/run/validate/advance/calibrate
  behavior. Add the requested docs and Unreleased CHANGELOG entry; characterization tests compare
  their complete stdout, stderr, and exit status against fixed pre-feature snapshots.

## 2. EARS requirements and acceptance criteria

- **RULE-01 (success 1):** When exactly one Q1-eligible entry has no `session_bound` event for
  the supplied session and every command identifier matches
  `^[A-Za-z0-9][A-Za-z0-9._:-]*$`, and `runWorkBind` from the check process cwd with no
  `--spec-dir` would resolve the candidate's same active-work file and effective spec dir, the
  system shall write one stdout warning naming escaped session and intent and containing the exact
  raw-value Q2 command with `--task-run=<id>`, then exit 0. It shall never shell-quote a command
  value. When that task run is bound to that session and there is no different-task binding, it
  shall write no bytes and exit 0. When the session is bound to a different task run, it shall
  write one escaped diagnostic and no bind command; this different-task result takes precedence
  when matching and conflicting binding facts coexist. When any command identifier is not
  allowlisted, the process-cwd active-work file differs, or the default process-cwd spec dir
  differs from the candidate's pinned/effective spec dir, it shall write an escaped warning naming
  the intent and no command.
- **RULE-02 (success 2):** When complete identity comes from flags or documented JSON, the system
  shall evaluate it; when both `--session-id` and `--agent` are present it shall never read stdin,
  even if that stream is left open. When identity is absent, EOF is empty, JSON is malformed/not an object, JSON
  agent is invalid, flags are malformed, `--agent` is invalid, or an option is unknown, it shall
  emit no stdout/stderr bytes and exit 0.
- **RULE-03 (success 3):** When Q1 yields zero candidates, the system shall be silent. When it
  yields two or more, it shall emit one escaped ambiguity warning naming every candidate intent and
  task run, but no command. It shall write no file.
- **RULE-04 (success 4):** When this command is added, `work start`, `work bind`, `work run`,
  `validate`, `advance`, and `calibrate` shall retain their fixed-fixture stdout, stderr, and exit
  status exactly.
- **RULE-05 (success 5):** The package suites, typecheck, and Biome shall pass; README/docs and
  the Unreleased CHANGELOG shall contain the required hook material and reject negative fixtures
  that omit the command, use a root-normalization claim, or omit `--task-run`.

## 3. Gherkin scenarios

```gherkin
Feature: warn an unbound SessionStart without changing lane state

  Scenario: one current matching-phase task run is unbound
    Given exactly one active entry whose phase equals its running intent's 2_spec state
    And session "s-1" has no session_bound event for that task run
    When lane work check receives session "s-1" and agent "claude"
    Then stdout is one warning with --intent=<id> --task-run=<id> --session-id=s-1 --agent=claude
    And stderr is empty and it exits 0

  Scenario: non-current active entries are not candidates
    Given an entry stale after its lane advanced, an entry with a mismatched phase, and entries
    whose lane state is paused or aborted
    When lane work check receives complete identity
    Then none contributes to cardinality, output, or a bind command

  Scenario: a different task-run binding is never remediated automatically
    Given exactly one Q1-eligible active entry
    And session "s-1" has a session_bound event for a different task run
    When lane work check receives session "s-1" and agent "claude"
    Then stdout is one escaped diagnostic without a bind command

  Scenario: a conflicting binding outranks a matching binding
    Given exactly one Q1-eligible active entry
    And session "s-1" has session_bound events for both that task run and a different task run
    When lane work check receives session "s-1" and agent "claude"
    Then stdout is one escaped diagnostic without a bind command

  Scenario: cwd-scoped work identity is preserved
    Given work start ran at the worktree root and the hook cwd is a child directory
    When lane work check runs from that child directory
    Then it is silent because the fingerprints differ
    And when start and check both run in that child with the same explicit spec dir it finds the entry

  Scenario: the suggested bind command is executable from the check process cwd
    Given exactly one Q1-eligible active entry whose process-cwd active-work file and default spec dir
    match the candidate entry
    When lane work check receives complete identity and prints its command
    Then executing that exact printed command from the check process cwd succeeds and binds the session

  Scenario: a warning is not advertised as an unusable bind command
    Given a hook payload cwd that selects an eligible candidate but differs from the check process cwd
    Or a task run that was started with an explicit --spec-dir different from the process default
    When lane work check receives complete identity
    Then stdout is an escaped warning naming the intent without a bind command

  Scenario: invalid and no-op inputs are invisible
    Given empty EOF, malformed JSON, invalid --agent, a missing option value, or an unknown option
    When lane work check is invoked
    Then stdout and stderr are empty and the exit status is 0

  Scenario: complete flags do not wait for hook input
    Given stdin is open and has no EOF
    When lane work check receives both --session-id and --agent flags
    Then it does not read stdin and completes according to the flags
```

## 4. Dependency × path cross-check (applicable)

Dependencies: **DEP-01** intake and flag/JSON precedence; **DEP-02** cwd fingerprint identity;
**DEP-03** candidate, state, and identity predicates; **DEP-04** whole-file read-fault handling;
**DEP-05** trace binding and safe rendering; **DEP-06** unchanged callers/release material; and
**DEP-07** no writes; and **DEP-08** suggested-bind execution context. This is a full matrix, not a dependency list: **references** means the path
implements or consumes that dependency; **does not (TEST-nn)** means it must not acquire that
dependency and the cited test asserts the boundary; there are no unknown cells. In particular,
the active-work and trace readers remain existing whole-file readers—no tolerant reader or new
allowed path is permitted.

| Path / shape | DEP-01 | DEP-02 | DEP-03 | DEP-04 | DEP-05 | DEP-06 | DEP-07 | DEP-08 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **PATH-01** CLI parser and check-only reporter | references | does not (TEST-03) | does not (TEST-03) | references | does not (TEST-09) | does not (TEST-06) | references | references |
| **PATH-02** `repoFingerprint` / `workActivePath` active-file lookup | does not (TEST-08) | references | does not (TEST-04) | references | does not (TEST-12) | does not (TEST-06) | references | references |
| **PATH-03** unchanged `work start`, `bind`, `run`, and `listActiveTaskRunsForIntent` usage-import/audit caller | does not (TEST-06) | references | does not (TEST-06) | references | does not (TEST-06) | references | does not (TEST-06) | references |
| **PATH-04** lane-state selection: running, phase, and `state.intent_id === entry.intent_id` | does not (TEST-04) | does not (TEST-08) | references | does not (TEST-05) | does not (TEST-13) | does not (TEST-06) | references | does not (TEST-15) |
| **PATH-05** active-file cardinality and duplicate task-run entries | does not (TEST-04) | references | references | references | references | does not (TEST-06) | references | references |
| **PATH-06** spec-state lookup and identity mismatch | does not (TEST-05) | references | references | references | does not (TEST-05) | does not (TEST-06) | references | references |
| **PATH-07** trace lookup: malformed whole file plus matching, conflicting, and combined facts | does not (TEST-13) | does not (TEST-08) | references | references | references | does not (TEST-06) | references | does not (TEST-15) |
| **PATH-08** escaped display, allowlist gate, and command-executability gate | references | references | references | does not (TEST-11) | references | does not (TEST-10) | references | references |
| **PATH-09** no-write boundary for check reads and silent exits | does not (TEST-02) | references | references | references | does not (TEST-02) | does not (TEST-06) | references | does not (TEST-15) |
| **PATH-10** README, docs, CHANGELOG, and negative fixtures | references | references | does not (TEST-10) | references | references | references | references | references |
| **PATH-11** `runWorkCheck` → suggested `runWorkBind` caller interaction: process-cwd active-file lookup and default spec-dir versus stored `entry.spec_dir` | does not (TEST-15) | references | references | references | does not (TEST-15) | references | references | references |

Every `does not` cell above maps to a named TEST-ID. The matrix intentionally has no `unknown`
cell: a newly discovered path/dependency relationship must be added as an explicit row/cell and
its test mapping before Phase 3, rather than being inferred during implementation.

### Test plan

- **TEST-01** (red): one unbound and one same-task-run-bound sole candidate at each eligible phase;
  assert exact raw command, `--task-run`, `--flag=<value>` form, stdout/stderr bytes, and exit 0.
- **TEST-02** (red): snapshot the **entire temporary repository** and an isolated `LANE_DATA_DIR`
  before/after zero, one, multiple, malformed, and read-failure checks; assert identical trees and
  bytes, including no newly created path.
- **TEST-03** (red): cover flags, JSON, precedence, missing identity, empty EOF, malformed JSON,
  invalid JSON agent, invalid `--agent`, missing option value, and unknown option; all invalid or
  incomplete rows assert empty stdout/stderr and exit 0. With both `--session-id` and `--agent`, leave
  stdin deliberately open and assert the check completes without reading it.
- **TEST-04** (red): phase-advanced stale, phase-mismatched, and non-running **lane-state** status
  entries; same-intent mixed-phase entries; eligible plus ineligible entries; duplicate task-run
  IDs; and two eligible lanes. Assert filtering happens before cardinality and no ambiguity command
  is made.
- **TEST-05** (red): absent/unreadable/mismatched `spec_dir`, legacy entry without `spec_dir`,
  V1/V2/missing-version lane-state shapes, `state.intent_id !== entry.intent_id`, and malformed
  state beside one valid candidate. Assert the valid candidate still warns; each bad state entry,
  including the mismatched identity entry, is ignored, with no output on an all-bad set.
- **TEST-06** (green, differential characterization): fixed-fixture snapshots of stdout, stderr,
  and exit status for `work start`, `work bind`, `work run`, `validate`, `advance`, and `calibrate`
  before versus after the feature. Also characterize `listActiveTaskRunsForIntent` through its
  existing `usage-import` / `attribution audit` caller with a valid active file and assert its
  unchanged result; the check does not alter that caller or the active reader's established
  whole-file behavior.
- **TEST-07** (green): `pnpm test`, `pnpm typecheck`, and `pnpm lint` (Biome).
- **TEST-08** (red): prove `repoFingerprint` identity equals `work start` semantics: root start +
  child hook is silent; child start + child hook with the same explicit spec dir warns; absent hook
  cwd uses process cwd. Assert no git-root normalization or fallback lookup.
- **TEST-09** (red): installed-CLI byte capture proves a successful warning is exactly one stdout
  line and every silent check result writes no newline; it also proves generic `report()` is not
  used for check.
- **TEST-10** (red): assert README/docs and Unreleased CHANGELOG contain Claude and Codex examples,
  explicit agent flags, same-cwd/subdirectory limitation, and the safe command form; negative
  fixtures reject omitted `--task-run`, positional-value command forms, and a git-root claim.
- **TEST-11** (red): assert byte-exact raw commands for allowlisted IDs and no shell quoting at all.
  Use reject fixtures for spaces, quotes, POSIX metacharacters, C0 and C1 controls, DEL, bidi and
  other format characters, U+2028, other Unicode, and leading-dash task/session/intent IDs. Assert
  displayed IDs are one-line escaped and every rejected command identifier yields no command.
- **TEST-12** (red): preserve the existing whole-file reader contract. A malformed or unreadable
  active-work file, including one containing an otherwise valid candidate, and a malformed or
  unreadable trace file, including one containing an otherwise matching/conflicting binding, each
  produces exit 0 with zero stdout/stderr bytes and no writes. Assert there is no valid-row
  isolation, tolerant-read fallback, or newly created data path.
- **TEST-13** (red): matching binding suppresses warning; a binding to another task run produces the
  diagnostic without a command; duplicate matching trace facts remain suppressive without a write;
  and matching plus conflicting facts produces the different-task diagnostic without a command.
- **TEST-14** (green): documentation/CHANGELOG assertions include positive required content and
  negative fixtures, independently of implementation output tests.
- **TEST-15** (red): end-to-end caller interaction. In the command-eligible fixture, capture the
  exact printed command and execute it from the check process cwd; assert `lane work bind`
  succeeds and records the binding. In two negative fixtures—payload cwd differing from process
  cwd, and a task started with an explicit `--spec-dir` differing from the process default—assert
  the check emits its warning but no command, so neither unusable command can be executed.

Explicit approval of this cross-check, the append-only same-phase limitation, and TEST-01..15 is
required before Phase 3.

## 5. Scope, risks, and non-goals

This warning never binds, closes, pauses, resumes, migrates, or discovers sessions. It does not
make a finished session eligible, perform a recursive repository search, or change start/bind/run.
The accepted trade-off is that append-only same-phase entries cannot be distinguished from current
ones without a lifecycle fact that is explicitly out of scope. The safety boundary is silent
failure plus no mutation; an operator can still bind manually after validating context.

