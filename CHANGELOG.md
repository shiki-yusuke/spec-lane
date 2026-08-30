# Changelog

All notable changes to `lane`/`spec-lane` are documented here. This project is pre-1.0
(alpha); breaking changes between minor releases are expected and are not accompanied by a
deprecation period.

## 0.9.0

An opt-in gate that runs a project's own verification command on the
`3_implement -> 4_verify` edge — the first gate that executes anything outside lane (PR #28).

### Added

- **`external_verify`: an opt-in command gate on `3_implement -> 4_verify`.** A lane declares
  a command in `intent.yaml`; `lane advance --phase 4_verify` refuses the transition unless
  that command exits zero. Until now every gate reasoned only about lane's own artifacts, so
  a project's real verification was a step a human or an agent could skip. lane reads nothing
  but the child's exit status.

  ```yaml
  # intent.yaml — declares WHAT
  external_verify:
    argv: ["/usr/local/bin/your-verify", "--some-flag"]   # argv[0] must be ABSOLUTE
    timeout_seconds: 60                                    # 1..600, default 60
  ```

  ```yaml
  # ~/.config/lane/external-verify.yaml — authorizes THAT EXACT command
  allowed_command_digests: ["sha256:..."]
  ```

  Declaring it is not enough to run it. `lane validate` prints the exact digest to add.

- **Authorization is a digest over the whole command** — every argv element, `timeout_seconds`,
  **and the working directory it runs in**. Authorizing `/usr/bin/node script.js` therefore does
  not authorize `node -e '<anything>'`, and an authorization granted in one checkout does not
  carry to another. That last part is not theoretical: only `argv[0]` has to be absolute, so a
  later argument like `scripts/verify.js` resolves against the child's working directory, and an
  authorization held outside any one checkout matched in *any* repository declaring the same
  strings and ran that repository's script.

- **A successful verification is recorded** in `lane-state.json` as
  `gate_snapshots.external_verify` (command digest, exit status, completion time), so "verified"
  stays distinguishable from "nothing was configured". Removing the configuration and re-crossing
  the edge deletes the record rather than leaving it implying something untrue.

- **Source hygiene check**: no tracked file may contain a raw NUL byte (issue #27). One NUL makes
  git treat a file as binary and grep skip it silently — neither says it declined — so the file
  becomes unreviewable and unsearchable while the tooling reports success. Two such bytes in
  `gate-check.ts` had been hiding that file's diffs since before 0.8.0.

### Changed

- `gate_snapshots.external_verify.exit_status` is `0` and `command_digest` is
  `sha256:<64 hex>` at the schema level. The record is only ever written for a passed command,
  so any other value means a hand-edited or corrupted state file asserting a verification that
  did not happen.

### Nothing changes for lanes that do not configure it

The three keys this feature adds — `intent.external_verify`, `profile.external_verify` and
`gate_snapshots.external_verify` — are each `.optional()` with no `.default()`, and the bundled
profile is untouched. `profile_digest` is a digest over the *parsed* profile, so a `.default()`
on any of those keys would have silently changed it for every lane in existence.

(`timeout_seconds` *inside* the command object does default to 60. That is harmless for the same
reason: it can only materialize once `external_verify` is present, and a lane that configures
nothing never parses one.)

The compatibility test anchors on a digest a real `lane-state.json` written by 0.7.0 already
contains, rather than recomputing today's value and comparing it to itself, and it now checks
both copies of the bundled profile — it had been reading the one the CLI does not ship.

### What this gate does not do

This release adds command execution, so the limits matter as much as the feature. All of these
are stated in the README, `skills/lane/SKILL.md`, and `spec.md` §7.

- **If the thing being gated is what invokes lane, the gate does not hold.** An agent that can
  run `HOME=... lane advance` chooses its own authorization store (`os.homedir()` returns `$HOME`
  verbatim when set — measured, not assumed). The boundary exists only when a harness or a human
  invokes lane, or the environment is pinned.
- **What actually protects the authorization store is how the agent's sandbox is scoped, and
  "writes confined to the worktree" is not enough.** Under a path-prefix write filter,
  `link(store, worktree/x)` creates a name inside the worktree and writing through it targets a
  path inside the worktree — both permitted — and the store changes anyway. The property required
  is that no path the adversary can create resolves to the store's inode, which is a
  mount/filesystem-view property. lane verifies none of it.
- **The check that refuses a store overlapping the gated repository detects a misconfiguration;
  it is not a barrier.** It catches `~/.config` symlinked into a dotfiles repo that then gets
  gated (stow, chezmoi), where nobody is evading anything. It does not stop someone arranging the
  overlap deliberately, and it misses an overlap with an outer repository when lane runs from
  inside a submodule. The authorization boundary was redesigned six times over this feature's
  review, and every break was found by adversarial reproduction rather than by reading the code;
  the seventh conclusion was to withdraw the claim rather than attempt an eighth fix.
- **The recursion guard stops a cooperative verifier from re-entering lane**, not a child that
  strips the sentinel before spawning a grandchild.
- It does not pin the *contents* at an authorized path, does not track grandchildren, and is not
  re-run at `advance --phase 5_done`.
- **`SIGKILL` bounds the direct child, not its descendants.** stdout/stderr are captured through
  pipes, so a grandchild that inherited them keeps the call waiting after the child is gone. The
  deadline still holds (measured three ways), but within it the elapsed time is governed by
  descendants — so a command that exited zero immediately can be reported as `timeout`.
- **Command output is echoed, not inspected.** On failure lane attaches a truncated tail
  (20 lines / 2000 characters, marker counted inside that bound) and **does not redact it**.
- `lane validate` really runs the command (once per call). A dry run that skipped it would report
  "this would pass" without having checked. It never writes a gate snapshot — but it does append
  its usual `effective_risk_log` entry, so "leaves `lane-state.json` untouched" is true of
  `advance` and not of `validate`.

## 0.8.0

A fail-closed fix for a data-destroying write-back, and the first release that records
*how* a wrapped agent was asked to run (PR #25).

### Fixed

- **`lane estimate --adopt` no longer destroys intent.yaml keys it doesn't recognize.**
  `IntentSchema.parse` silently strips unknown keys, and the adopt write-back re-serialized
  the stripped object — a user-approved `intent.critical_invariants` list was wiped this way
  in real use. Both adopt paths now read through a fail-closed `readIntentForWrite` **before
  any side effect** (bare adopt writes estimate.json first, so the strict read happens at
  load time): an unrecognized key aborts with the full dot-path list and guidance, leaving
  both intent.yaml and estimate.json untouched. Detection is own-property based
  (`Object.hasOwn`) so keys that collide with prototype names (`constructor`, `toString`)
  cannot slip past the guard; `writeIntent` keeps the same check as defense-in-depth, and
  read-only paths (`readIntent`) warn on stderr but continue.

### Added

- **`intent.critical_invariants`** is now a first-class optional field (non-empty array of
  non-empty strings) in `IntentSchema`, the generated JSON Schema, and the differential
  fixtures — the operational field the R-pilot enrollment procedure records for
  medium/high-risk lanes no longer lives outside the schema.
- **`attribution/v2` binding records** carry `requested_model`, `requested_reasoning_effort`
  (both nullable — null means "not derivable from the spawn argv", never "confirmed
  uncontrolled") and a `capture_status` (`captured`/`absent`/`unsupported_syntax`/
  `ambiguous`). `lane work run` extracts the values from the argv it actually spawns
  (canonical flag forms only; quoted and unquoted codex `-c model_reasoning_effort=...`
  values; tokens after a literal `--` ignored; a canonical flag mixed with a known alias
  demotes to `ambiguous` rather than guessing), and never rejects the wrapped command.
  Readers accept v1 and v2; writers emit v2; a record carrying *any* of the three capture
  fields must validate as v2 — a malformed new record raises
  `MalformedBindingRecordCaptureError` instead of masquerading as clean legacy v1 data.
  This is the join key that lets per-session cost be grouped by model x effort (cohort-3
  measurement prerequisite).

### Verification

- sol (gpt-5.6-sol, xhigh): design review 1 round + implementation review 3 rounds ->
  approve; every blocker regression-tested.
- Full workspace green: typecheck / lint / 1094 tests passed (3 skipped), 0 failed.

## 0.7.0

Two honesty fixes in how the tool reports what it does **not** know.

### Added

- **`lane estimate` records abstentions instead of erroring** (#21). When the basis-eligible
  population is too small for a k-NN prediction and no reference table is given, the command
  used to throw and record nothing. It now writes a revision whose estimate/v2 decision is
  `abstained` with reason `INSUFFICIENT_POPULATION` (never a fabricated number: `predicted` is
  absent, and the schema rejects an abstained revision that carries one), prints what would
  unblock a prediction, and exits 0 — recording an honest "I don't know" is a success.
  `--adopt` refuses a revision with no `predicted` value: an abstention can never become the
  baseline. The long-standing pattern where a `NOVEL_SURFACE_UNKNOWN` v2-abstain rides on top
  of a reference-table prediction is unchanged.
- `EstimateRevision.predicted` is now optional and `population_condition.method` gains
  `"abstained"`; a refinement enforces "absent exactly when abstained, required otherwise".

### Changed

- **Design-critic qualification reasons are now catalog-composed end to end** (#22, closes the
  R46 conformance gap recorded in 0.6.0's own verification notes). The vendored
  derive-independence module (re-vendored at its structured-reasons revision) now yields
  `{code, params}` records instead of prose, and every reason `lane design status` prints is
  composed from this repo's own message catalog — a raw upstream sentence can no longer appear
  branded as catalog-backed. Visible effect: minor wording normalization in qualification
  reasons. A living-contract test imports the vendored `REASON_CODES` and fails CI if a future
  re-vendor introduces a code with no catalog entry; an unrecognized code at runtime throws
  rather than passing through.

## 0.6.0

Adds an opt-in design-critic track, and changes what promotion to `5_done` checks. Pre-1.0:
a lane that passed its gates under 0.5.2 can be refused promotion under 0.6.0 — see the
`Changed` note below before upgrading a lane mid-flight.

### Added

- **Opt-in design-critic track** (`lane start --design`, plus `lane design submit|status|override|decide`).
  It records design options and their critic reviews, and **derives** how independent each review
  actually was rather than accepting a producer's claim. `independence_status` is never written by a
  producer and never stored: it is recomputed from `artifact_shapers[]` + `critic` +
  `prior_involvement`, evaluated against **every** shaper of the active revision, taking the closest
  (least independent) relationship. Qualifying requires a conjunction — a genuinely separate lineage
  (or an independent human) **and** involvement recorded as not-observed-within-a-stated-scope.
  There is deliberately no absolute "no involvement" value: positive involvement can be evidenced,
  universal non-involvement cannot.
  - A lane that does not pass `--design` is unaffected, including its `lane-state.json` bytes:
    `design_track` is `.optional()` with no default, so the key is genuinely absent rather than
    present-null.
  - New schemas `DesignOptionsSchema` / `DesignCriticAttestationSchema` and `DesignTrackSchema`
    (`@lane/schemas`, additive).
  - Shipped **behind a flag and measured, not as a gate**, on architect review's objection that one
    observed divergence proves model disagreement rather than more real defects caught. On the only
    real data available at merge, the deriver reported `6 review(s) evaluated across 3 file(s),
    0 qualifying` — including for its own PR. Zero, not two, is the state the mechanism exists to
    make visible. If no decision ever changes, no falsifier is ever surfaced and no decision is ever
    retracted, the honest conclusion is that it produced paperwork and should be removed.
- `--weakening-rationale` on the promotion path, for the case below.

### Changed

- **Promotion to `5_done` now re-evaluates the evidence predicates that must hold in the state being
  promoted.** Previously each gate fired only at its own transition edge and nothing re-checked
  earlier links, so a lane could record honest `premise_evidence`, pass `1_intent → 2_spec`, then be
  edited to values that gate would have refused, and still reach `5_done` — `lane validate` replied
  "intent.yaml is valid" throughout. This was demonstrated on the real binary before the fix was
  written.
  - On failure: nonzero exit, **no completion overlay, phase unchanged** — not just a nonzero exit.
  - This is a *predicate over the final state*, not a replay of every historical gate. Widening the
    `spec_consensus` digest to cover `intent.yaml` was considered and rejected on review: the
    weakening happens *before* the later ack, so the ack would merely bind an already-invalid file.
  - **Known limitation, stated rather than papered over:** this cannot prove a lane was *always*
    passing. A digest created later proves nothing about earlier history; that would need append-only
    transition receipts, which are not implemented.

### Fixed

- Four stale vendoring markers under `packages/core/src/vendor/` were re-pinned, and all seven are
  now verified in CI, so a vendored file drifting from its upstream pin fails the build instead of
  passing silently.

### Internal

- The real-agent-cost tests are hermetic (125s → 3s, flake removed): they read a throwaway
  `CLAUDE_HOME`/`CODEX_HOME` instead of the developer's own history, which grew without bound and so
  flaked only on the maintainer's machine — the one person who would see it.
- The R45/R46 message-catalog check identifies design-gate messages by the gate id they are declared
  under, not by their position in `gate.ts`. The previous positional slice failed an unrelated gate
  that happened to be written in its range.
- The release version is now checked for drift. It lives in five `package.json` files *and* two
  hardcoded literals — `main.ts`'s `program.version(...)` (what `lane --version` prints) and
  `advance.ts`'s `toolVersion` fallback (what gets written into a lane's recorded artifacts) — and
  nothing compared them. Both were still on 0.5.2 after every `package.json` had been bumped for this
  release. `docs/releasing.md` step 8 would have caught the first only *after* publishing and tagging,
  and does not cover the second at all.

### Verification

- CI green on the release commit: lint / build / typecheck / JSON Schema regeneration diff /
  dependency-cruiser / 963 tests (schemas 160, core 523, adapters 45, cli 235).

## 0.5.2

Scaffold/skill docs improvement — no schema change and no change to command semantics
(the content `lane start` writes into `intent.yaml` does gain a comment block): real dogfooding
turned up three cases where an agent's `premise_evidence`/`critic.yaml` *content* was
right but its *shape* got rejected by `lane validate` -- `premise_evidence` written as a
list under a `premises:` key instead of the single `PremiseEvidenceSchema` object,
`method` set to `static_trace` (not one of `live`/`data`/`code-only`), and
`critic.yaml`'s `taxonomy` set to a lens name (`security`) instead of the closed
10-value knowledge-taxonomy enum.

- `intent.yaml` writes now append a schema-accurate, commented `premise_evidence` shape
  guide (both the `required: true` and `required: false` branches) whenever the field is
  still unrecorded — on `lane start` scaffolds and preserved across re-writes such as
  `lane estimate --adopt` — so the exact shape is visible at the point of use instead of
  only in `skills/lane/SKILL.md`'s prose. Once `premise_evidence` is recorded the guide
  is dropped.
- `skills/lane/SKILL.md` gained schema-exact YAML examples for `premise_evidence`,
  `critic.yaml`'s required top-level shape (explicitly calling out that `taxonomy` is
  never a lens name), and `verification.yaml`'s `success_criteria_matrix`/
  `cross_check_intent_vs_spec`.
- `SuccessCriteriaRowSchema` and `CrossCheckIntentVsSpecSchema` (`packages/schemas/src/verification.ts`)
  are now exported (previously module-private) so the new
  `packages/cli/test/skill-md-examples.test.ts` can parse every fenced YAML example out
  of `skills/lane/SKILL.md` and validate it against the same zod schemas `lane validate`
  runs -- a schema change that silently breaks a doc example now fails CI instead of
  surfacing as another agent's rejected scaffold.

Clean-state verification (`rm -rf packages/*/dist` + all `*.tsbuildinfo`, rebuild):
`pnpm run -r build` / `-r typecheck` / root `tsc -b` / `lint` / `-r test` all green.
schemas 103, core 435, adapters 45, cli 177 = 760 tests, 0 failures.

## 0.5.1

Dogfood bug fix: `lane attribution audit` (the one command that scans *every* intent
under `specDir`, not just one named on the command line) crashed with a raw zod
`invalid_enum_value` error on real, in-progress lanes.

- **`LaneStateSchemaV1`'s `phase_history.result` enum was missing `"in_progress"`.**
  That schema's own doc comment claimed "there is no real 1.0 population for this
  greenfield TS tool yet" -- a real dogfooded repo's `docs/spec/` (hundreds of lanes
  going back to the *Python reference implementation*, which has always used `"1.0"`/
  `"2.0"` as its own version literals and has always supported `in_progress`) disproved
  that: an open phase's `in_progress` entry in a `schema_version: "1.0"` file is the
  common case, not a hypothetical edge case. Fixed by reusing `PhaseHistoryEntrySchema`
  (the same 5-value enum `v2`/`v3` already use) for `v1` too, instead of a separate,
  incorrectly-narrower inline definition.
- **`lane attribution audit` now skips (rather than crashes on) an intent whose
  `lane-state.json` cannot be parsed for any other reason** -- most commonly real,
  never-migrated legacy `cost_ledger` data (the flat, `phase: "lane_total"`-sentinel
  shape `lane migrate-legacy-ledger` exists specifically to convert). A skipped intent
  is reported via a stderr diagnostic (with a short, one-line issue summary, not a raw
  multi-line zod dump) and rolled into the audit's own `coverage_scope` honesty note --
  never silently dropped, never allowed to take down the whole audit for every other,
  readable intent. Verified against the actual real dataset this bug was reported
  against (250+ real lanes, read-only) in addition to new fixture-based regression
  tests.
- Audited `usage-import`/`evidence-export`/`work` for the same category of mistake
  (a multi-intent scan silently using the wrong schema branch): neither is affected --
  both only ever read the one intent named on the command line, where a parse failure
  surfacing as a clear per-intent error is the correct, expected behavior, not a bug.
- **Fixed a main-CI flake in `usage-import`**: the per-phase measurement window's
  `since` (the phase's earliest `task_run.started_at`) and `until` (the wall-clock
  instant `usage-import` reads its own "now") are two genuinely distinct events, but on
  a fast enough run both can round to the same millisecond under `Date`'s ms
  resolution, producing a `since==until` window that `trace/v1`'s strict
  `window_ordering_invalid` check (correctly) rejects -- intermittently, only when the
  race was hit. Fixed by nudging `until` forward by the minimum representable step
  whenever it would not already be strictly later than `since`, which corrects only the
  clock-resolution artifact; it does not fabricate a window that never happened (more
  than zero wall-clock time genuinely elapsed between the two reads), does not weaken
  the frozen `window_ordering_invalid` contract check, and does not drop the
  `matched:false` case's own event (a session agent-cost can't match must still be
  recorded, never silently zero-filled). Added a deterministic repro test that freezes
  `Date` to force the exact same-millisecond collision, rather than relying on the
  race happening to hit in CI.

## 0.5.0

M0 spec-lane pilot deliverable: a trace ledger, wrapper-based session-to-task binding,
usage import into that ledger, a session-attribution audit, a first-cut evidence export,
and an honesty layer over the estimator (estimate/v2). All four external contracts this
release mirrors (`trace/v1`, `attribution/v1`, `estimate/v2`, plus the pre-existing
`agent-metrics/v1`) come from `ai-agent-skills-playbook` and are verified against their
own vendored fixtures (`packages/core/test/fixtures/{trace,attribution,estimate}/`,
UPSTREAM-pinned) — see the differential tests referenced below for pass counts.

- **Trace ledger** (`packages/core/src/trace.ts`, mirrors `trace/v1`): an append-only
  JSONL ledger at `$LANE_DATA_DIR/trace/events.jsonl`. `event_id` is a deterministic
  `"tr1_" + sha256(JCS(...))` hash over a relation-specific identity subset (ported
  byte-for-byte from the contract's own `verify-fixtures.mjs`), so a retried write is
  harmless — a reader dedups by `event_id`, and this codebase never scans the ledger
  before appending. 27/27 vendored fixtures pass (`trace-fixtures.test.ts`).
- **`lane work start|bind|run`** (design.md/attribution-v1.md's binding-feasibility
  spike): `lane work start --intent <id> --phase <phase>` issues a `task_run_id`/
  `phase_run_id` pair and tracks it per repo fingerprint (never a `cwd` marker file —
  attribution-v1.md's own "Rejected designs" cut that for the race it would introduce
  between concurrent worktrees). `lane work run -- <claude|codex> ...` spawns the given
  command via wrapper binding — Claude gets a pre-assigned `--session-id` UUID nonce with
  no separate join step; Codex's `session_id` is read after the fact from `codex exec
  --json`'s leading `{"type":"thread.started",...}` stdout line (30s timeout kills the
  child rather than continue unbound). `lane work bind` records a manual bind
  (`binding_method=manual_bind`, `actor.kind=human`) for a session started outside the
  wrapper. A session already bound to a different `task_run` gets a `MULTI_TASK_BINDING`
  stderr warning but is still appended — append-only; `lane attribution audit` is what
  judges it. `session_bound` events always carry `lane_id` now (fixed in review — a
  missing `lane_id` used to make a derived `attribution/v1` binding-record fabricate an
  empty string to satisfy the schema's `minLength:1`; the derivation now skips producing
  a record at all for a malformed event rather than fabricate one). The Claude wrapper's
  `--session-id` conflict check now catches the `--session-id=<value>` single-token form
  too, and injects its own `--session-id` before the wrapped command's own literal `--`
  (not after, where it would land as a positional argument instead of a recognized
  flag). The Codex wrapper kills the child on every bind-failure path, not just a
  timeout — an unbound `codex` process left running was an unmeasured cost accruing in
  the background.
- **`lane usage-import --intent <id>`** (the G1 pilot's data-collection entry point):
  measures every session ever bound to an intent's active `task_run`s via `agent-cost`,
  records `usage_imported`/`attributed_to` trace events per (`task_run`, session) pair,
  and upserts a `scope:"phase"` ledger entry (in-repo, or the done overlay's
  `ledger_delta` post-done) from the aggregate measurement, reusing `calibrate`'s own
  per-agent attribution rules (`totalsByAgent`/`fallbackAgent`/`sourceForAgent`, now
  exported from `calibrate-service.ts`). **Aggregates at the phase level, not the
  task_run level** (fixed in review): `computeLedgerEntryId` keys only on `(lane_id,
  phase, source, pricing_version)` — never `task_run_id` — so two concurrent `task_run`s
  in the same phase each writing their own ledger entry would silently overwrite one
  another. `usage-import` instead groups active `task_run`s by phase, runs one
  `agent-cost measure` call per phase covering the union of every one of that phase's
  bound sessions, and upserts one ledger entry per agent for the whole phase
  (`session_ids` = that union) — idempotent under a rerun even as new concurrent
  `task_run`s join the phase. The per-`task_run` breakdown lives in the trace ledger's
  `usage_imported` events, never in the ledger entry itself. A session `agent-cost`
  can't match, or a measure call that fails outright, is never zero-filled — that
  session's `usage_imported` event carries `matched:false` instead. Runs `lane
  attribution audit` automatically at the end (warnings to stderr, never blocking).
- **`lane attribution audit [--since --until] [--require-coverage <ratio>]`** (mirrors
  `attribution/v1`): global, not per-intent — scans every trace event and cross-references
  every lane's own `cost_ledger` `session_ids` for `ORPHAN_USAGE` detection (the one
  honesty-limited check v1 can make without an `agent-cost` session-enumeration API;
  what it can't scan is reported to stderr as `coverage_scope`, never silently treated as
  scanned). The schema-conformant `audit-result` JSON always goes to stdout, including on
  a failed `--require-coverage` gate (exit 3) — a coverage gate is a signal layered on a
  valid result, not an error that replaces it. 22/22 vendored fixtures pass
  (`attribution-fixtures.test.ts`).
- **`lane evidence export --format lane-evidence:v1 --intent <id>`**: a digest bundle of
  every artifact a lane has produced (intent/spec/verification content digests,
  success-criteria-matrix/consensus-ack/premise-evidence summaries, done-overlay summary,
  cost-ledger summary). `LaneEvidenceSchema` is **spec-lane-owned for now**, not a
  playbook contract — promoted to `contracts/` if/when a real downstream consumer starts
  reading it (see its own doc comment).
- **`estimate/v2` abstain** (`packages/core/src/estimator-v2.ts`): a new honesty layer
  over (never replacing) the existing k-NN/LOO/reference-table estimator.
  `EstimateRevisionSchema` gains an optional `decision_v2` field — absent on pre-v2
  revisions (backward-compatible read), always populated on new writes — plus
  `novel_surface_declaration` for a human's `--novel-surface established|novel` override
  (recorded with provenance). `profile.estimate.cohort` (`agent_type`/`model_provider`/
  `model_generation`/`model_id`/`routing_policy_digest`/`prompt_policy_digest`/
  `execution_profile_digest`) is a hard prerequisite for a *predicted* decision — an
  unconfigured cohort throws (`CohortNotConfiguredError`) rather than emit a fabricated
  or v1-only decision. `profile.estimate` (and its `cohort` sub-object) is fully
  **optional** on `Profile` itself, at both the schema and the TypeScript level — a
  pre-0.5.0 `profile.yaml` with no `estimate:` key at all keeps parsing exactly as it
  always did; the hard-prerequisite behavior only applies once `lane estimate` actually
  runs `buildEstimateRevision`, never during config parsing. A
  candidate observation with no recorded cohort (every observation predates this field)
  is excluded as `MODEL_GENERATION_MISMATCH`, never a silent match — so `estimate/v2` is
  *expected* to abstain `INSUFFICIENT_POPULATION` until cohort-tagged calibration data
  accumulates, by design. `NOVEL_SURFACE_UNKNOWN` is BLOCKING unless resolved by
  `--novel-surface`. 24/24 vendored fixtures pass (`estimate-v2-fixtures.test.ts`).
- Full-pipeline e2e (`work-usage-import-audit-e2e.test.ts`): `work start` → (a simulated
  agent session) → `work bind` → `usage-import` → `attribution audit
  --require-coverage 1.0`, against a fake `agent-cost` binary in temp
  `LANE_DATA_DIR`/`LANE_CONFIG_DIR`/repo dirs.

## 0.4.0

The GitHub repository was renamed from `lane` to `spec-lane` to match the
package/product name. The CLI command remains `lane`; `npm install -g spec-lane` and all
`lane ...` commands are unchanged.

Fixes the measurement path disconnect between `lane calibrate` and `lane emit-metrics`:
a real task could run `calibrate` successfully (a real, non-trivial measurement) and
still have `emit-metrics` report `no_data`, because `calibrate` never touched
`cost_ledger` — only the calibration store. Directly reproduced and fixed (sol ruling):

- **Schema migration (minor bump)**: `LedgerEntrySchema` is now a discriminated union on
  `scope` (`"phase"` → `phase` required; `"lane"` → `phase: null`), and both branches
  gained `since`/`until`/`agents` (the exact agent-cost query selector that produced the
  entry, so a later re-query can replay it exactly). `LaneStateSchemaV2` (`"2.0"`) is now
  migration-source-only; the current schema is `LaneStateSchemaV3` (`"3.0"`). A
  pre-existing `"2.0"` `lane-state.json` — including one with real phase-scoped ledger
  entries and/or an existing done overlay, as already exist in real repositories today —
  keeps working with no explicit migrate step, upgrading transparently on read the same
  way a `"1.0"` file already did.
- **`lane calibrate` now records a `scope:"lane"` ledger entry alongside the
  `CalibrationObservation`**, from the same measurement, and both writes are idempotent
  upserts — re-running the same call updates both records in place rather than
  duplicating either one. If only one of the two writes succeeds, the command reports a
  non-zero exit naming which half failed, instead of a clean success message; re-running
  repairs the missing half safely. The entry's `source`/`confidence` (`claude_jsonl_auto`/
  `imported_lane` or `codex_sqlite_auto`/`estimated`) is attributed from agent-cost's own
  per-row `agent` breakdown, never hardcoded — a measurement whose rows are entirely (or
  partly) `codex` is recorded as such, never silently misattributed as `claude`. A
  genuinely mixed measurement is recorded as two separately-attributed entries (one per
  agent, each carrying only that agent's own totals) rather than blending both agents'
  cost under one, necessarily-wrong-for-at-least-one-of-them, source.
- **No phase apportionment**: a lane-scope measurement is never split into fabricated
  per-phase records by a `phase_history` time-ratio guess.
- **`lane emit-metrics`** now groups a `scope:"lane"` entry under its own
  `whole-delivery` activity (`namespace: "spec-lane"`), replays the exact selector
  `calibrate` recorded when re-querying `agent-cost` for it, and reads an *effective*
  ledger composed from in-repo `cost_ledger` plus any done-overlay ledger delta (see
  below) rather than `cost_ledger` alone. When more than one `scope:"lane"` entry
  contributes to the same activity (the common case now that a single calibrate call can
  produce several per-agent entries above), their selectors are unioned — same
  since/until with different `agents` merges cleanly — rather than one silently
  overwriting another; genuinely conflicting since/until windows fail the whole call
  closed (`ambiguous_lane_selector`) instead of replaying whichever one happened to be
  processed last.
- **No double-counting across lane and phase scope**: if a lane-scope entry's sessions
  are fully covered by KPI-eligible phase-scoped entries, the lane-scope entry is excluded
  from the KPI population (the per-phase breakdown already accounts for it). If the
  overlap is only partial — neither fully covered nor fully disjoint — `emit-metrics`
  fails the whole call closed (`ambiguous_session_attribution`, the same mechanism MP-3
  already used for cross-activity overlap) rather than guessing which side is
  authoritative.
- **Post-done `calibrate` never rewrites in-repo `lane-state.json`**: if the lane's done
  overlay already exists (the documented `lane-finish` flow runs `calibrate` after
  `advance --phase 5_done`), the new ledger entry is upserted into the overlay's own
  `ledger_delta` instead — matching the overlay's existing "never rewrite in-repo state
  after merge" principle rather than being a new exception to it. The *effective* ledger
  (in-repo + overlay delta) always recomputes `included_in_kpi` fresh from the composed
  result rather than trusting whichever persisted flag each entry happens to carry — a
  persisted flag is a cache, never the source of truth, since a re-calibrate with a new
  `pricing_version` creates a new entry that should retroactively supersede (and exclude)
  the older one, and nothing else ever re-persists that older entry's own flag.
- **`premise_evidence.method`'s invalid-value error message is now fixed at the schema
  layer** (zod's own `errorMap`, not CLI-side enum redefinition or issue pattern
  matching): `premise_evidence.method must be one of live|data|code-only (got: <value>)`.
- **Unified `token_basis`**: every `CalibrationObservation` and `EstimateRevision` now
  records `token_basis: "agent-cost-raw-total/v1"` (agent-cost's raw total, cache tokens
  included). The estimator's k-NN population excludes any observation whose `token_basis`
  doesn't match this value, including one with none at all — never assumed to match by
  default.
- **No more silent `reference_table` fallback**: `lane estimate` used to default to
  placeholder numbers (50 000/150 000 tokens, $1/$4) whenever the calibration population
  was too small and no `--reference-*` flags were given. It now requires all four
  (`--reference-tokens-p50/p80`, `--reference-cost-p50/p80`) explicitly together, or
  fails clearly naming them.
- **No more raw `Infinity` in prediction-error scoring**: a `predicted.p50 == 0` with a
  nonzero actual used to produce `Number.POSITIVE_INFINITY`, which doesn't round-trip
  through JSON. It's now recorded as `relative_error_p50: null` plus a machine-readable
  `reason`, distinct from "no error was computed." A large but finite error ratio is
  preserved exactly, never clipped.

**Known issue**: an older CLI (pre-0.4.0) that reads a `lane-state.json` this version has
already migrated to `"3.0"` will fail with a raw, unhandled `ZodError` — not a clean,
readable rejection — since the pre-0.4.0 schema has no forward-compatibility handling for
a `schema_version` it doesn't recognize. Upgrading every environment that touches a given
lane's `lane-state.json` (not just the one that last wrote it) to 0.4.0+ together avoids
this; it is not something an older CLI can gracefully detect or work around on its own.

## 0.3.1

Fixes three self-inflicted rough edges found while running MP-3 (the agent-metrics:v1
emitter, 0.3.0) through spec-lane's own `lane` workflow for the first time:

- `skills/lane/SKILL.md`'s knowledge-query step now describes `--paths` as the repeatable,
  single-value flag it actually is (`lane knowledge-query --paths <file-1> --paths
  <file-2> ...`), instead of reading like one flag that takes a space-separated list —
  the old wording led directly to a "too many arguments" CLI error during MP-3.
- `skills/lane/SKILL.md`'s critic.yaml step now states that `taxonomy` is a closed
  10-value enum and lists all 10 values, instead of reading as free text.
- `lane validate` now catches a `ZodError` thrown by `readIntent`/`readCriticIfExists` and
  returns a human-readable, one-line-per-issue message (`<file>: <path>: <message>`)
  instead of letting the raw, unformatted `ZodError` issues array (serialized as JSON —
  that's exactly what `Error#message` returns on a raw `ZodError`) reach the console via
  the CLI's top-level catch handler. Any other error (e.g. invalid YAML syntax) still
  propagates exactly as before — this is a `validate`-only fix.
  **Known limitation, intentionally out of scope for this fix**: `lane advance` calls the
  same `readIntent`/`readCriticIfExists` functions and still surfaces a raw, unformatted
  `ZodError` on the same kind of schema violation — this asymmetry is deliberate (scoped to
  `validate` only per this fix's own instructions), not an oversight, and is left for a
  future pass.

## 0.3.0

Adds `lane emit-metrics <intent-id> [--post] [--pr N]`: an emitter for the external,
normative `agent-metrics:v1`/`token-usage/v1` contract (`ai-agent-skills-playbook`'s
`docs/protocols/agent-metrics-v1.md` + `contracts/agent-metrics/v1/`, vendored at
`contracts/agent-metrics/UPSTREAM`'s pinned commit). No spec-lane-specific vocabulary
reaches the wire format — the marker this command builds/posts is indistinguishable from
one built by an unrelated emitter targeting the same public contract.

- Reads a lane's `cost_ledger`, groups KPI-eligible entries by activity (phase), dedupes
  session ids, and calls the existing (read-only) `TelemetryAdapter.measure()` once per
  activity. Fails closed (prints/posts nothing) if the same session id spans more than one
  activity (`ambiguous_session_attribution`) or if `agent-cost` returns an unrecognized
  `token_kind`.
- Never fabricates a record for an entry it can't honestly attribute a breakdown to
  (manual source, no session ids, or no matching `agent-cost` rows) — each becomes a
  `data.coverage.omissions[]` entry with a machine-readable reason instead.
- `--post` upserts by identity: it searches the target PR's existing comments, decodes and
  independently re-verifies (sha256 + recomputed `upsert_key`, never trusting a declared
  value) any `agent-metrics:v1` marker found, and updates the matching comment in place
  rather than creating a duplicate.
- New port `MetricsPublisher` (`core/ports/metrics-publisher.ts`) and adapter
  `GithubCommentMetricsPublisher` — deliberately not folded into `VcsAdapter` or
  `TrackerAdapter.annotatePr` (the latter already posts PR comments but has no
  upsert-by-identity semantics); see `docs/design.md` §4.5 and this lane's own
  `docs/spec/I-2026-08-07-agent-metrics-emitter/spec.md` for why.
- New, contract-exact 11-key personal-dimension scanner (`core/agent-metrics-goodhart.ts`),
  kept deliberately separate from the existing, smaller, spec-lane-internal
  `core/goodhart.ts` (7 keys) — the public contract's own forbidden-key set is larger and
  versioned externally; the two files carry cross-reference comments to each other so a
  future key-set change doesn't silently drift the two apart.
- `packages/schemas/src/agent-cost.ts`'s `AgentCostRowSchema` (previously an opaque
  `z.record`, unused beyond totals) is now modeled to `agent-cost`'s real row shape —
  confirmed additive-safe: no existing test or fixture referenced its opaque fields.
- This feature was itself implemented as the first real task run through spec-lane's own
  `lane` workflow after switching over to it (premise_evidence, a dependency/path
  cross-check, the full gate sequence, and a human-review-band approval all exercised for
  real, not just tested in isolation).

**Review-round fixes (2026-08-07, post-PR):**

- `--post` no longer leaks the marker to stdout before every precondition is satisfied.
  Previously the marker was printed to stdout before the PR-number check and before the
  publish call ran, so a failed `--post` (no PR number, or the publish itself failing)
  still wrote the marker to stdout; the "created/updated `<url>`" status text was also
  printed to stdout on success, mixing with the marker. Now stdout carries the marker and
  nothing else on every path — a failed `--post` writes nothing to stdout at all, and the
  status text always goes to stderr.
- `decodeAndVerifyAgentMetricsMarker` now validates `payload_b64`'s format (the contract's
  own `BASE64_RE` + `length % 4` check, mirrored from `verify-fixtures.mjs`) before
  decoding it. Node's `Buffer.from(str, "base64")` is a lenient decoder that silently
  skips out-of-alphabet characters, so a malformed `payload_b64` (e.g. one with a stray
  trailing character) could still decode to the same bytes and match the declared
  `sha256` — previously accepted as valid despite being malformed on format grounds,
  which the `GithubCommentMetricsPublisher`'s own upsert-candidate re-verification relied
  on.
- `tokenUsageRecordsFromRows` no longer silently drops an `agent-cost` row with a null
  `agent`/`model`/`token_kind`. A `measure/v1` row is documented as always pre-grouped by
  those three fields, so a null is a protocol violation, not a "nothing to report" shape
  — it now aborts the whole emit (`measure_protocol_violation`) the same as an
  unrecognized `token_kind`, instead of silently producing a `coverage.status="complete"`
  snapshot with a quietly-missing record.
- New `--gh-bin` flag (mirrors the existing `--agent-cost-bin`) to override the `gh`
  binary `GithubCommentMetricsPublisher` shells out to.

## 0.2.0

Gate-port review: ports two more of the private reference implementation's gates
(premise-evidence and success-criteria checks), calibrated against 10 real pilot
lanes before this port, with none of the pilot's thresholds or fail/warning
classifications changed.

### Gate foundation refactor

- `GateResult` (`{pass:true} | {pass:false, reason}`) is replaced by `Diagnostic[]`
  (`{gateId, code, severity: "warning"|"error", message}`), so a single gate can report
  more than one simultaneous finding instead of stopping at the first.
- `GateContext`'s flat `{phase, targetPhase, event}` is replaced by a discriminated
  `GateTrigger` union: `{type:"phase_advance", from, to} | {type:"before_pr_publish", phase}`.
- `evaluateGates` no longer short-circuits on the first failing gate; it collects
  diagnostics from every gate that applies.
- `lane advance` now runs "validity check -> read artifacts -> evaluate gates -> update
  state" on **every** transition, not just the `5_done` one, and leaves lane-state.json
  completely untouched if any gate reports an error.
- `lane validate` drops the "skip all gate evaluation below `4_verify`" early return; it
  now evaluates both the forward transition edge from wherever the lane currently sits and
  the standalone `before_pr_publish` checkpoint, so early-phase gates are reachable without
  first attempting (and having blocked) a real `advance`.

### New gates

- **premise_evidence** (`1_intent` -> `2_spec`): if a change is AI-originated or the
  symptom was never directly observed, and it introduces a new guard/branch/completion
  condition, the premise's real-world existence must be confirmed (live observation,
  existing data, or at minimum a static code trace) and recorded in `intent.yaml`'s new
  `premise_evidence` field before drafting spec.md. Unrecorded is a warning (the CLI cannot
  itself decide whether a change needed the check); `required:true` with
  `reproduced:false` is a hard error.
- **success_criteria** (`3_implement` -> `4_verify`, and a standing `before_pr_publish`
  double-check): every line of `intent.intent.success` must be cross-checked against the
  final diff, in both directions, and recorded in `verification.yaml`'s new
  `success_criteria_matrix`. `covered_by: "none"` is a hard error; a criterion with no
  corresponding `intent.success` line is a warning (spec/verification grew a stronger
  condition than the SSOT states). Matching is exact, normalized-text equality
  (`normalizeCriterion`, absorbing markdown links/emphasis/whitespace only) -- never fuzzy
  similarity.

### Schema additions

- `IntentSchema.premise_evidence` (optional, discriminated union on `required`).
- `VerificationSchema.success_criteria_matrix` / `cross_check_intent_vs_spec` (both
  optional).
- `canonicalVerificationContent()` (the content `spec_consensus`'s digest binds a reviewer
  ack to) now includes both new fields -- editing `success_criteria_matrix` after an ack
  now invalidates it, the same as editing any other verification content already did.

### Skill

- `skills/lane/SKILL.md` weaves premise-evidence confirmation into the lane-start step
  (before spec.md, not after), a dependency/path cross-check into the spec.md step (with
  its own human-review-approval gate and a 3-blind-spot disclaimer), an independent
  re-search obligation into `critic.yaml`'s `test_coverage` lens, and the
  success-criteria cross-check plus a fixed ordering (cross-check -> consensus refresh/ack
  -> validate -> advance -> no further spec/verification/critic edits) into the
  `3_implement` step.

## 0.1.0

Initial public release: a from-scratch TypeScript rewrite of a private Python delivery-lane
orchestrator, driving a change through Intent -> Spec/Critic -> Implement -> Verify -> Done
with human-decision gates, plus four features layered on top of the original tool's own
scope -- cost/effort estimation with calibration against real usage, a resource-aware
"what should I work on next" view, a `spec_consensus` hard gate binding reviewer
acknowledgement to exact content by digest, and a knowledge-DB lens surfacing past review
lessons for files a new change touches.
