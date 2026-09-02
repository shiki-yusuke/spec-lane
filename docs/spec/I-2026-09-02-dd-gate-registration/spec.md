# I-2026-09-02-dd-gate-registration — spec

Register deterministic-discipline (dd) as this checkout's `external_verify` verifier and make the
checkout tolerate dd's ledger directory. This is the second repository to reference dd's built
artifact (`dist/src/cli.js`) and rule catalog (`fixtures/rules`) in place; design-v1 §0-1 of dd needs
that state to exist before update duplication or version drift can be observed at all.

## Decisions

- **D1. Tracked change = one `.gitignore` rule (`.dd/`).** dd gate's authoritative scope-edit detector
  scans `git status --porcelain --untracked-files=all` (ignored paths excluded). Without the rule, the
  ledger dd itself writes would be reported as an out-of-scope untracked path and every gate run would
  refuse. `.git/info/exclude` was rejected because it does not travel with the repository.
- **D2. Nothing dd-specific enters lane's docs/code.** The 2026-09-02 design review (sol) held that a
  README pointer to dd as "the verifier this repository uses" contradicts I-2026-08-29's non_goal
  ("no project-specific knowledge of dd's CLI surface in lane itself"). argv, hook registration, and
  the ledger layout stay documented on the dd side (`docs/hook-setup.md`).
- **D3. Hook registration stays local.** `.claude/settings.local.json` is matched by the operator's
  global gitignore. The registered command uses absolute paths for node, dd's CLI, and dd's rules; the
  `--task-id` is this intent id, so the ledger rows are attributable to this lane.
- **D4. The edit is made by a Claude Code session whose cwd is this checkout**, driven headlessly
  (`claude -p`) from the orchestrating session, so the registered hooks fire on the edit. This is a
  controlled real-environment canary, not a claim about day-to-day interactive use. The session does
  not commit; the operator commits afterwards with the repository's noreply identity.
- **D5. base is fixed by dd, not by this lane.** dd gate takes the authoritative range base from the
  first `session_start` marker under the run; the branch is created before `dd run open`, so that
  commit is an ancestor of the gate-time HEAD.

## Requirements (EARS)

- EARS-01: When `.dd/ledger.jsonl` or `.dd/current-run.json` exists in this checkout, `git status
  --porcelain --untracked-files=all` shall not list any path under `.dd/`.
- EARS-02: When this lane advances 3_implement -> 4_verify, lane shall spawn the authorized `dd gate`
  argv and the transition shall succeed only if that process exits 0.
- EARS-03: The `.dd/ledger.jsonl` produced during 3_implement shall contain a `session_start` marker
  with `task_id: I-2026-09-02-dd-gate-registration` and at least one `PreToolUse` observation from the
  editing session.
- EARS-04: No file outside `.gitignore` and `docs/**` shall be modified, added, or left untracked and
  non-ignored at gate time (this is exactly the predicate dd gate re-evaluates).

## Scenarios

```gherkin
Scenario: ledger present, status clean
  Given dd hooks wrote .dd/ledger.jsonl in this checkout
  When git status --porcelain --untracked-files=all runs
  Then no .dd/ path is listed

Scenario: gate decides the transition
  Given the argv digest is listed in ~/.config/lane/external-verify.yaml
  And .dd/current-run.json names a run whose sessions are all complete
  When lane advance --phase 4_verify runs from this checkout
  Then dd gate exits 0 and lane-state.json records gate_snapshots.external_verify

Scenario: unauthorized argv is refused before running
  Given the digest is not yet listed
  When lane validate runs at 3_implement
  Then the refusal names the digest and dd gate is not spawned
```

## Dependency and path cross-check

| # | dependency / path | owner | touched by this lane | checked how |
|---|---|---|---|---|
| DEP-01 | `.gitignore` | this repo | yes (one line) | diff |
| DEP-02 | `docs/spec/I-2026-09-02-dd-gate-registration/**` | this repo | yes (lane artifacts) | in allowed_paths |
| DEP-03 | `.claude/settings.local.json` | operator, local | yes, untracked+ignored | `git check-ignore -v` |
| DEP-04 | `~/.config/lane/external-verify.yaml` | operator HOME | created (first real-HOME entry) | lane refusal digest |
| DEP-05 | dd `dist/src/cli.js`, `fixtures/rules` (absolute paths) | dd repo @ 44d3ca1 | referenced, not modified | hashes recorded in verification.yaml |
| DEP-06 | `README.md`, `skills/**`, `profiles/**`, `packages/**` | this repo | **not touched** (D2) | diff |

## Limits

- L1. The digest binds argv + timeout + cwd, not the bytes behind `dist/src/cli.js` or `fixtures/rules`.
  A rebuild of dd changes what this gate does without changing what was authorized. Recorded, not fixed
  here; it is one of the drift candidates the §0-1 ledger watches.
- L2. `--task-id` in the local hook registration is per intent; the next lane in this checkout requires
  a human edit of `.claude/settings.local.json`.
