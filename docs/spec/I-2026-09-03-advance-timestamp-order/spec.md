# I-2026-09-03-advance-timestamp-order — spec

Fix spec-lane issue #38: `lane advance` stamps `updated_at` and the phase boundaries with a `now`
captured *before* the gates run, while the external_verify snapshot records the verifier child's
own completion time. Whenever the command takes any time, the snapshot is stamped after the
transition it belongs to and `updated_at` stops meaning "last change". First observed on the
artifact PR #37 wrote (`docs/spec/I-2026-09-02-dd-gate-registration/lane-state.json` @ a316d36:
updated_at 06:24:07.496Z vs external_verify.recorded_at 06:24:07.710Z).

## Decisions

- **D1. Issue option 1: capture `now` after every gate has passed.** Nothing is written until the
  gate block returns without errors, so the write timestamp can be taken at that point too. One
  instant then covers `updated_at`, `phase_history[from].ended_at`, `phase_history[to].started_at`,
  the premise_evidence / success_criteria snapshot `recorded_at`, and the 5_done overlay's
  `acknowledged_at` fields. Options 2 (max over snapshots) and 3 (document the inversion) rejected:
  both keep two clocks for one write.
- **D2. `effective_risk_log[].evaluated_at` stays pre-gate.** `recordEffectiveRiskEvaluation` runs
  before the gates because the gates consume the evaluated state; its stamp is the evaluation
  instant, not the write instant. After the fix it precedes `updated_at` by the gate duration. This is
  the one intentional behaviour change beyond the ordering and is listed in intent.yaml
  `known_affected_behavior`.
- **D3. `gate_snapshots.external_verify.recorded_at` keeps meaning the runner's `finishedAt`.** It is
  the verifier's completion time (I-2026-08-29 architect review 9-8) and is now guaranteed to be
  `<= updated_at` because the write instant is taken after the runner returned.
- **D4. The regression test uses a real child process that runs long enough to be observable.** The
  existing external-verify tests deliberately spawn real processes rather than fake runners; the new
  test does the same with a child that waits ≥ 20 ms before exiting 0, so the pre-fix code fails on
  millisecond ISO strings without a mocked clock. The fixture also writes a verification.yaml whose
  success_criteria_matrix matches intent.success, so the same advance writes the success_criteria
  snapshot and EARS-02 is asserted on a gate snapshot as well as on the phase boundaries (2026-09-03
  design review, sol: the one BLOCKER).
- **D5. dd gate is this lane's external_verify, and the code edits are made from a lane-cwd
  session.** First attempt (2026-09-03) tried to skip this: a tester subagent's `Edit` into this
  checkout from the deterministic-discipline session was blocked twice by dd's scope-edit guard
  (ledger ordinals 47/62), while a Bash-scripted write of advance.ts from the same session slipped
  past the guard unchecked. The operator chose to redo the work properly: re-pin
  `.claude/settings.local.json` to this intent id and allowed_paths (I-2026-09-02 spec.md L2, first
  realization), authorize the new argv digest, `dd run open`, then apply the test and the fix from a
  headless Claude Code session whose cwd is this checkout (no commit inside it). The Bash-written
  advance.ts was restored to HEAD before that. The guard blind spot (Bash-mediated writes are not
  scope-checked) is recorded as a dd issue candidate in ~/ai_bus/tasks.md.

## Requirements (EARS)

- EARS-01: When a 3_implement -> 4_verify advance passes with external_verify configured, the written
  lane-state.json shall satisfy `updated_at >= gate_snapshots.external_verify.recorded_at`.
- EARS-02: When an advance passes, `updated_at`, `phase_history[from].ended_at`,
  `phase_history[to].started_at`, and any premise_evidence / success_criteria snapshot `recorded_at`
  written by that advance shall be one identical ISO 8601 instant.
- EARS-03: When any gate reports an error, `lane advance` shall leave lane-state.json byte-identical
  (unchanged from today; the capture point moves inside the region that already writes nothing).
- EARS-04: The external_verify snapshot's `recorded_at` shall remain the runner's `finishedAt`, not
  the write instant.

## Scenarios

```gherkin
Scenario: snapshot never postdates the transition it belongs to
  Given a lane at 3_implement whose intent configures an authorized external_verify command
  And the command waits at least 20 ms before exiting 0
  When lane advance --phase 4_verify runs
  Then lane-state.json.updated_at >= gate_snapshots.external_verify.recorded_at
  And phase_history[3_implement].ended_at == phase_history[4_verify].started_at == updated_at
  And gate_snapshots.success_criteria.recorded_at == updated_at (the fixture supplies a matching
  success_criteria_matrix so that snapshot is written on the same edge)

Scenario: gate error still writes nothing
  Given the same lane but the command exits 3
  When lane advance --phase 4_verify runs
  Then the exit code is 3 and lane-state.json is byte-identical to before

Scenario: the verifier's own completion time is preserved
  Given a passing advance as above
  Then gate_snapshots.external_verify.recorded_at is a timestamp taken by the runner, not updated_at
```

## Dependency and path cross-check

Applicability: (a) no new dependency, state, guard, or completion condition is introduced — one local
variable's capture point moves. (b) lane-state.json timestamps are written by several commands, so the
writers were enumerated (`grep -rn "updated_at\|writeLaneState(" packages/*/src`) to confirm no path
outside the diff must change:

| # | path (writer of lane-state.json) | stamps written | reads `now` from advance? | DEP-01 (post-gate write instant) |
|---|---|---|---|---|
| PATH-01 | `packages/cli/src/commands/advance.ts` (phase transition) | updated_at, phase boundaries, gate_snapshots | yes (the diff) | implements |
| PATH-02 | `advance.ts` 5_done overlay branch | acknowledged_at ×2, done overlay | yes, downstream of the gate block | inherits (already post-gate) |
| PATH-03 | `commands/start.ts` | created/updated_at at 1_intent | no | not affected (no snapshots exist yet) |
| PATH-04 | `commands/validate.ts` | effective_risk_log only | no | not affected (does not touch updated_at) |
| PATH-05 | `commands/calibrate.ts`, `commands/usage-import.ts` | cost_ledger only | no | not affected |
| PATH-06 | `core/src/done-overlay.ts` | updated_at = verify_ended_at (5_done view) | no | not affected (only moves updated_at forward) |

Only PATH-01 writes `gate_snapshots`, so the EARS-01 invariant is local to the diff. Human-review band
(cross-cutting): **not applicable** — no cell is "does not" or "unknown"; the table exists as evidence
for that conclusion. TEST-01 (regression, EARS-01/02) and the existing TEST-05/TEST-41 (EARS-03) are the
required tests.

## Limits

- L1. The fix orders two reads of the same wall clock. A clock step backwards between the runner's
  `finishedAt` and the write instant could still invert them; not defended (nothing in lane is).
- L2. ISO 8601 millisecond resolution means `recorded_at == updated_at` is possible for a fast
  verifier; EARS-01 is therefore `>=`, and the test's child sleeps so the pre-fix code fails strictly.
