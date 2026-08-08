# Spec — measurement path fix (calibrate → cost_ledger → emit-metrics) + estimator hardening

## Intent summary

`lane calibrate --session-id` measures real token/cost usage via `agent-cost` and writes
a `CalibrationObservation`, but never touches `cost_ledger` — so `lane emit-metrics`,
which reads only `cost_ledger`, reports `no_data` even after a real, successful
calibration. This spec closes that gap (sol ruling points 1-5) and separately hardens
the estimator against three latent defects sol's ruling also mandates fixing in the same
pass (points 6-7): a hardcoded schema-bypassing premise_evidence error message, a silent
reference-table fallback, and an `Infinity`-producing divide-by-zero in prediction-error
scoring. Sol point 8 (an optional backfill/repair CLI) is explicitly deferred — see
"Non-goals" below.

## Premise

Recorded in `intent.yaml`: `premise_evidence.required: true`, `method: live`,
`reproduced: true`. Directly reproduced against the built CLI this session: a fake
`agent-cost` reporting 104.8M tokens / $28.34 (this task's own acceptance-criteria
numbers) fed through `lane calibrate` recorded a real observation, then `cost_ledger`
was confirmed still `[]` immediately after, and `lane emit-metrics` on the same lane
printed `coverage.status=no_data` with zero records — the exact reported failure,
end to end, not inferred from reading code alone (though the root cause was also
independently confirmed via a static trace of `runCalibrate` and a repo-wide grep
confirming no code path anywhere constructs a `scope:"lane"` `LedgerEntry`).

## Non-goals

- Sol point 8 (a usage-import-style repair/backfill command) is **not** implemented here.
  Sol marked it optional ("実装するなら最小で"); given the size of points 1-7, this pass
  ships the atomic-and-idempotent `calibrate` write itself (point 1) as the actual fix —
  a partial write is now self-healing by re-running `calibrate`, which is the repair path
  a dedicated backfill command would otherwise exist to provide. A follow-up task can add
  one later if a real gap remains.
- Phase-scoped `LedgerEntry` producers (`migrate-legacy-ledger`, a future `usage-import`)
  are not changed to populate the new `since`/`until`/`agents` selector fields — those
  fields are added to the schema generically (so any future producer can use them) but
  only `calibrate`'s new lane-scope entry actually populates and replays them in this
  pass, per sol's own scoping (points 1 and 5 are both specifically about the calibrate
  → lane-scope-entry → emit-metrics path).

## EARS rules

### Rule 1 (Event-driven): calibrate records observation + lane-scope ledger entry together
When `lane calibrate <intent-id> --session-id ...` measures usage successfully, the
system shall record both a `CalibrationObservation` and one or more `scope:"lane"`
`LedgerEntry` records (`phase: null`, `confidence` derived per source,
`session_ids` = the measured sessions, `tokens`/`cost_usd`/`cost_credits` from the same
measurement) from the same call, and every write shall be an idempotent upsert keyed so
that re-running the identical call updates the same records in place rather than
duplicating any of them.

### Rule 1b (Unwanted behavior): lane-scope entry source is attributed, never hardcoded
Amendment (2026-08-08, Codex review round, must-1) — Rule 1's original wording hardcoded
`source: "claude_jsonl_auto"` on the single entry it described; this was wrong whenever
the measurement's own rows showed codex usage (agent-cost's `--agent` filter accepts
both, and `calibrate` never restricts it), which both corrupted that entry's identity
(`source` is part of the upsert key) and defeated `deriveIncludedInKpi`'s
`codex_sqlite_auto`-specific dedup rule. The system shall derive each `scope:"lane"`
entry's `source`/`confidence`/`agents` from agent-cost's own per-row `agent` breakdown
(`measurement.total.rows`), not from the `--agent` selector the query was scoped to
allow. A measurement whose rows are entirely one agent still produces exactly one entry
(Rule 1's common case, unchanged). A measurement whose rows genuinely mix `claude` and
`codex` usage shall produce one entry per agent that actually contributed tokens, each
carrying only that agent's own totals — never one entry blending, or misattributing,
both agents' cost under a single source. Tokens/cost agent-cost could not attribute to
either agent (a null-agent row, or a rounding mismatch) fold into a single fallback
entry so nothing is silently dropped from the ledger.

### Rule 2 (Unwanted behavior): partial write never reports clean success
If only one of the observation write or the ledger-entry write(s) succeeds, the command
shall not report exit code 0 / a "clean success" message — it shall report which half
failed, and re-running the same call shall be sufficient to repair the missing half
without duplicating the half that already succeeded (both writes being upserts, per
Rule 1, makes this safe by construction).

### Rule 3 (Ubiquitous): no phase apportionment
The system shall never derive per-phase `LedgerEntry` records from a `phase_history`
time-ratio split of a lane-scope (or otherwise single-session-set) measurement — no
fabricated `1_intent`/`2_spec`/etc. entries. (Amended 2026-08-08 per Rule 1b: this no
longer caps `calibrate` at exactly one `scope:"lane"` entry per call — a mixed-agent
measurement legitimately produces more than one — the invariant this rule actually
protects is "never a fabricated *phase*-scoped entry," which per-agent lane-scope
entries do not violate.)

### Rule 4 (Event-driven): emit-metrics treats a lane-scope entry as one whole-delivery activity
When `lane emit-metrics` groups KPI-eligible ledger entries, every `scope:"lane"` entry
shall form (or join) one shared activity group named `whole-delivery`
(`namespace: "spec-lane"`), distinct from any `scope:"phase"` activity groups, and shall
never be split into per-phase records.

### Rule 4b (Unwanted behavior): conflicting lane-scope selectors fail closed, compatible ones merge
Amendment (2026-08-08, Codex review round, should-fix) — Rule 1b means more than one
`scope:"lane"` entry can legitimately join the same `whole-delivery` group (the common
case: one calibrate call's per-agent split, same `since`/`until`, different `agents`).
When two contributing entries' selectors share the same `since`/`until`, the system
shall union their `agents` (a `null` agents value, meaning "no filter," wins over a
narrower array rather than being narrowed away) into the group's replayed selector,
never let one silently overwrite another. When two contributing entries' `since`/`until`
genuinely conflict, the system shall fail the whole `emit-metrics` call closed
(`ambiguous_lane_selector`) rather than replaying whichever entry was processed last.

### Rule 5 (Unwanted behavior): no double-counting a measurement across lane and phase scope
If a `scope:"lane"` entry's `session_ids` are fully covered by the union of KPI-eligible
`scope:"phase"` entries' `session_ids`, the system shall exclude the lane-scope entry
from the KPI population (the per-phase breakdown already accounts for it) rather than
counting it a second time. If the overlap is partial (neither fully covered nor fully
disjoint), the system shall fail the whole `emit-metrics` call closed
(`ambiguous_session_attribution`, extending the existing cross-activity check to also
span scope) rather than guess which side is authoritative.

### Rule 6 (Event-driven): emit-metrics replays calibrate's own measurement selector
When `lane emit-metrics` re-queries `agent-cost` for a `scope:"lane"` activity group, it
shall pass the same `since`/`until`/`agents` selector that `calibrate` recorded on that
ledger entry, not a bare `session_ids`-only query — so a value drift between calibrate
time and emit time (e.g. new events landing in the underlying log) cannot silently
change the measured window.

### Rule 7 (Unwanted behavior): post-done calibrate never rewrites in-repo state
If a lane's done overlay already exists (`isDoneOverlayGuarded`), `lane calibrate` shall
write its ledger-entry delta into the done overlay (not `lane-state.json`), and `lane
emit-metrics` shall read an *effective* ledger composed from the in-repo `cost_ledger`
plus any overlay-recorded delta (delta entries winning on `ledger_entry_id` collision) —
matching `done-overlay.ts`'s existing "never rewrite in-repo state after merge" principle
rather than being a new exception to it.

### Rule 7b (Unwanted behavior): the effective ledger always recomputes included_in_kpi on read
Amendment (2026-08-08, Codex review round, must-2) — a persisted `included_in_kpi` flag
is a cache, never the source of truth: a re-calibrate with a new `pricing_version`
creates a new `ledger_entry_id` (never upserted in place over the old one), which should
retroactively supersede — and exclude — the older entry, but nothing else ever
re-persists that older entry's own flag once it has been written. The system shall
recompute `included_in_kpi` for every entry over the fully-composed effective ledger on
every read (never trust whichever value each entry happens to carry on disk, in either
the in-repo `cost_ledger` or the overlay's `ledger_delta`), and shall do so without
mutating the caller's own in-memory `LaneState.cost_ledger` entries as a side effect.

### Rule 8 (Ubiquitous): premise_evidence.method's error message is schema-fixed
If `intent.yaml`'s `premise_evidence.method` is not one of `live`/`data`/`code-only`, the
schema itself shall produce exactly the message `premise_evidence.method must be one of
live|data|code-only (got: <value>)` (via zod's own `errorMap`, not a value the CLI
reconstructs by pattern-matching a generic issue or redefining the enum).

### Rule 8b (Ubiquitous): v2 lane-state files upgrade transparently on read
Reading a pre-existing `schema_version: "2.0"` `lane-state.json` (including ones with
real, non-empty `scope:"phase"` ledger entries and/or an existing done overlay, as
already exist in real repositories today) shall transparently upgrade it to v3 in
memory via `parseLaneState`'s existing version-dispatch mechanism — the same
already-established behavior `parseLaneState` has for v1→v2 today, not a new "reject and
require an explicit migrate command" behavior. Every command that reads lane state
(`status`, `calibrate`, `emit-metrics`, `advance`, `validate`, ...) shall keep working
against a v2-shaped file on disk with no user-visible migration step, and shall not
silently invent a `since`/`until`/`agents` selector that a pre-existing entry never
recorded (they upgrade to `null`, honestly representing "unknown," not a guess).

### Rule 9 (Ubiquitous): unified, filterable token basis
Every `CalibrationObservation` and `EstimateRevision` shall record a `token_basis` of
`"agent-cost-raw-total/v1"` (agent-cost's raw total, cache tokens included). The
estimator's k-NN population shall exclude any observation whose `token_basis` does not
equal this value (including one with no `token_basis` at all) before ranking neighbors.

### Rule 10 (Unwanted behavior): no silent reference-table fallback
If the (basis-filtered) calibration population is too small for a k-NN prediction and no
explicit `--reference-tokens-p50/p80`/`--reference-cost-p50/p80` were given, `lane
estimate` shall fail with a clear message requiring them, rather than silently defaulting
to placeholder numbers (50 000/150 000/$1/$4).

### Rule 11 (Unwanted behavior): finite, unclipped prediction error
Prediction-error scoring (`evaluatePrediction` and the estimator's own leave-one-out
validation) shall never produce or store a raw `Infinity` (which does not round-trip
through JSON) — a `predicted.p50 == 0` with a nonzero actual shall be recorded as
`relative_error_p50: null` plus a machine-readable reason, distinct from "no error was
computed." A large but finite error ratio (this task's own acceptance case:
2096.03396x) shall be preserved exactly, never clipped or excluded.

## Gherkin scenarios

```gherkin
Scenario: calibrate creates both records from one real measurement
  Given a fresh lane and a fake agent-cost reporting 104.8M tokens / $28.34 for one session
  When I run `lane calibrate <intent-id> --session-id <id>`
  Then exactly one CalibrationObservation exists with tokens=104800000, cost_usd=28.34
  And exactly one cost_ledger entry exists with scope="lane", phase=null,
    source="claude_jsonl_auto", confidence="imported_lane", included_in_kpi=true

Scenario: re-running calibrate is idempotent
  Given the lane from the previous scenario
  When I run the identical `lane calibrate` call again
  Then the observation count is still exactly 1 and the cost_ledger still has exactly 1
    lane-scope entry (same ledger_entry_id, values upserted in place)

Scenario: emit-metrics reports the calibrated measurement as one whole-delivery record
  Given the lane from the first scenario
  When I run `lane emit-metrics <intent-id>`
  Then coverage.status is "complete"
  And there is exactly one record, with activity.namespace="spec-lane" and
    activity.name="whole-delivery"
  And there are no records with activity.name in ("1_intent","2_spec","3_implement",
    "4_verify","5_done")

Scenario: overlapping lane and phase session_ids fail closed when ambiguous
  Given a lane with a scope="phase" entry covering session "s1" and a scope="lane" entry
    covering sessions "s1" and "s2" (s2 not covered by any phase entry -- partial overlap)
  When I run `lane emit-metrics <intent-id>`
  Then the command aborts with ambiguous_session_attribution and prints nothing

Scenario: a lane-scope entry fully covered by phase entries is not double-counted
  Given a lane with a scope="phase" entry covering sessions "s1","s2" and a scope="lane"
    entry covering only "s1" (fully covered, not partial)
  When I run `lane emit-metrics <intent-id>`
  Then the lane-scope entry is excluded from the KPI population and only the phase
    entry's measurement is emitted -- no ambiguous_session_attribution abort

Scenario: calibrate after done overlay never touches in-repo state
  Given a lane at 4_verify with a done overlay already recorded
  When I run `lane calibrate <intent-id> --session-id <id>`
  Then lane-state.json's cost_ledger on disk is unchanged
  And `lane emit-metrics` on this lane still reports the new measurement (read from the
    overlay-composed effective ledger)

Scenario: a real-shaped v2 lane-state.json upgrades transparently on read
  Given a lane-state.json with schema_version="2.0", a real (non-empty, has_usage)
    scope="phase" ledger entry, and an existing done overlay (mirroring a real
    already-existing repository's shape, not a synthetic empty fixture)
  When I run `lane status`, `lane emit-metrics`, and `lane calibrate --session-id <id>`
    against it
  Then all three commands succeed against the v2-shaped file with no explicit migrate
    step, and the pre-existing phase-scoped entry's since/until/agents come back null
    (not fabricated) after the in-memory v2->v3 upgrade

Scenario: premise_evidence.method's own error message
  Given an intent.yaml with premise_evidence.required=true and method="bogus"
  When I run `lane validate <intent-id>`
  Then the message contains exactly "premise_evidence.method must be one of
    live|data|code-only (got: \"bogus\")"

Scenario: estimate requires explicit reference numbers when it would otherwise guess
  Given an intent with no adopted baseline and an empty calibration population
  When I run `lane estimate <intent-id>` without any --reference-* flag
  Then the command fails with a message naming all four required --reference-* flags

Scenario: a basis-mismatched observation never contributes to a k-NN prediction
  Given a calibration population of 8+ observations where one has no token_basis field
  When I run `lane estimate <intent-id>`
  Then the basis-mismatched observation is excluded from population_size and from ranking

Scenario: a real large error ratio is preserved exactly
  Given a baseline prediction with tokens.p50=1000 and a real observation of 2097033.96
    tokens
  When I run `lane calibrate <intent-id> --session-id <id>` against that baseline
  Then the recorded relative_error_p50 is exactly 2096.03396, not clipped or omitted

Scenario: a predicted.p50=0 divide-by-zero never produces raw Infinity
  Given a reference-table baseline with cost_usd.p50=0 and a real nonzero cost observation
  When prediction error is scored against that baseline
  Then relative_error_p50 is recorded as null with a reason, and the record round-trips
    through JSON without becoming invalid

Scenario: a codex-only measurement is never misattributed as claude (Rule 1b)
  Given a fake agent-cost reporting usage whose rows are entirely agent="codex"
  When I run `lane calibrate <intent-id> --session-id <id>`
  Then the recorded cost_ledger entry has source="codex_sqlite_auto",
    confidence="estimated", and agents=["codex"] -- never "claude_jsonl_auto"

Scenario: a genuinely mixed measurement splits into two attributed entries (Rule 1b)
  Given a fake agent-cost reporting usage whose rows mix agent="claude" and agent="codex"
  When I run `lane calibrate <intent-id> --session-id <id>`
  Then two cost_ledger entries exist, one source="claude_jsonl_auto" and one
    source="codex_sqlite_auto", each carrying only that agent's own tokens/cost, summing
    back to the measurement's real totals

Scenario: two same-window lane entries union their agents (Rule 4b)
  Given a lane with two scope="lane" entries sharing the same since/until but different
    agents (one ["claude"], one ["codex"])
  When I run `lane emit-metrics <intent-id>`
  Then both entries join one whole-delivery group whose replayed selector's agents is the
    union of both, and coverage.status is "complete"

Scenario: two conflicting-window lane entries fail closed (Rule 4b)
  Given a lane with two scope="lane" entries whose since/until windows genuinely differ
  When I run `lane emit-metrics <intent-id>`
  Then the command aborts with ambiguous_lane_selector and prints nothing

Scenario: a re-calibrate with a new pricing_version supersedes the older lane entry (Rule 7b)
  Given a lane already calibrated once (pricing_version="v1", scope="lane" entry
    included_in_kpi=true), then calibrated again with pricing_version="v2" and a later
    pricing_as_of
  When I run `lane emit-metrics <intent-id>`
  Then coverage.eligible_entries and coverage.measured_entries are both 1, not 2 -- the
    v1 entry's stale persisted included_in_kpi=true is never trusted
```

## Dependency and path cross-check (applies)

**Applicability**: this change (a) introduces a new dependency (the `since`/`until`/
`agents` selector and a discriminated-union `scope`/`phase` shape on `LedgerEntry`,
requiring a `LaneState` schema version bump + migration) and (b) touches an area — the
ledger — that multiple existing paths already read/write/assume a shape for. Applicable.

**DEP-01**: `LedgerEntrySchema` becomes a discriminated union on `scope`
(`"phase"` → `phase` required; `"lane"` → `phase: null`), plus new
`since`/`until`/`agents` fields on both branches. `LaneStateSchemaV2` (current) becomes
`LaneStateSchemaV3` (`schema_version: "3.0"`); the old `"2.0"` definition is kept
migration-source-only (`LedgerEntrySchemaV2Legacy` backing it), with a new
`migrateLaneStateV2ToV3`.

**DEP-02**: `runCalibrate` builds and upserts a `scope:"lane"` `LedgerEntry` alongside the
existing observation write (Rule 1/2), routed through the done-overlay guard (Rule 7).

**DEP-03**: `deriveIncludedInKpi` (`ledger.ts`) gains a new, source-agnostic
full-subset-of-phase-sessions exclusion rule for `scope:"lane"` entries (Rule 5's
non-ambiguous case), added *alongside* (not replacing) the existing
`codex_sqlite_auto`-specific rule already there (Python-reference parity, untouched).

**DEP-04**: `groupLedgerForMetrics`/`detectAmbiguousSessionAttribution`
(`metrics-service.ts`) treat a `scope:"lane"` entry as the `whole-delivery` activity and
carry its selector through; `runEmitMetrics` (`emit-metrics.ts`) reads the
overlay-composed effective ledger (new `effectiveLedger()` in `done-overlay.ts`) and
passes a group's recorded selector to `telemetry.measure()` when present.

**DEP-05**: `PremiseEvidenceSchema.method`'s `errorMap` (schema-fixed message, Rule 8).

**DEP-06**: `token_basis` field on `CalibrationObservationSchema.actual` and
`EstimateRevisionSchema` (new shared constant in `@lane/schemas`); `estimator.ts` filters
the population by it before ranking (Rule 9).

**DEP-07**: `estimator.ts`'s `estimate()`/`referenceTableEstimate()` take an *optional*
reference table and throw a new `ReferenceTableRequiredError` when one was actually
needed but not given; `runEstimate` (CLI) no longer defaults `--reference-*` values and
catches that error (Rule 10).

**DEP-08**: `relativeError()` (`calibrate-service.ts`) and `leaveOneOutValidate()`
(`estimator.ts`) both stop producing `Infinity`; `CalibrationPredictionEvaluationSchema`'s
`error.tokens/cost_usd` gains a nullable `relative_error_p50` + `reason` (Rule 11).

**DEP-09** (added 2026-08-08, Codex review round): `buildLaneScopeLedgerEntry` (singular)
becomes `buildLaneScopeLedgerEntries` (`calibrate-service.ts`), attributing
`source`/`confidence`/`agents` per real agent from `measurement.total.rows` and
returning one or more entries (Rule 1b). `calibrate.ts` loops over the returned entries
for both the in-repo and overlay write paths.

**DEP-10** (added 2026-08-08, Codex review round): `effectiveLedger()`
(`done-overlay.ts`) always recomputes `included_in_kpi` (via `recomputeIncludedInKpi`)
over the composed result before returning, cloning each entry first so the caller's own
`state.cost_ledger` objects are never mutated in place (Rule 7b).

**DEP-11** (added 2026-08-08, Codex review round): `groupLedgerForMetrics`
(`metrics-service.ts`) gains `mergeLedgerActivitySelectors` and a new
`ambiguousSelectorActivities` return field; `runEmitMetrics` (`emit-metrics.ts`) fails
closed (`ambiguous_lane_selector`) when that field is non-empty (Rule 4b).

**PATH × DEP cross-check**:

| Path | References | Action |
|---|---|---|
| `packages/core/test/differential/ledger.differential.test.ts`'s `tsEntry()` helper + its two `scope:"lane"` call sites (currently pass a non-null `phase` alongside `scope:"lane"`, e.g. `phase:"4_verify"`) | DEP-01 (discriminated union rejects this shape) | **TEST-01**: update `tsEntry()`'s type/defaults and both call sites to pass `phase: null` when `scope:"lane"` — the assertions being tested (`deriveIncludedInKpi`'s Python-parity codex rule) don't read `.phase` in that branch, so behavior is unaffected, only the literal shape. |
| `packages/schemas/test/lane-state.test.ts` (`LaneStateSchemaV2`-keyed fixtures/dispatch test) | DEP-01, Rule 8b | **TEST-02**: extend to cover v1→v2→v3 and v2→v3 dispatch/idempotency (not just v1→v2), plus **TEST-02b**: a fixture shaped like a real, already-existing v2 file (non-empty `scope:"phase"` ledger entry with real usage numbers, `current_phase` at 4_verify/5_done-via-overlay) — not just the existing empty-`cost_ledger` fixture — asserting the migrated entry's fields survive and `since`/`until`/`agents` come back `null` rather than fabricated. |
| `packages/schemas/test/differential.test.ts` (`SCHEMAS["lane-state"] = LaneStateSchemaV2`) + `packages/schemas/test/schema-fixtures/lane-state.fixtures.json` + `packages/schemas/generated/lane-state.schema.json` | DEP-01 | **TEST-03**: repoint to `LaneStateSchemaV3`; bump the fixture's `schema_version` to `"3.0"`; add a valid fixture exercising both `LedgerEntry` branches and an `invalidStructural` case for the wrong branch combination; regenerate the committed JSON Schema. |
| `packages/core/test/{done-overlay,gate,gate-applies-to-matrix,premise-evidence-gate,success-criteria-gate}.test.ts` and `packages/core/test/differential/done-overlay.differential.test.ts` (all construct `LaneState` fixtures with a literal `schema_version: "2.0"`, all with `cost_ledger: []`) | DEP-01 | **TEST-04**: bump each literal to `"3.0"`. No `LedgerEntry` literals in these files (`cost_ledger` is always empty), so this is the only change needed — confirmed by reading every match. |
| `packages/cli/src/commands/start.ts` (writes `schema_version: "2.0"` for every new lane) | DEP-01 | Update to `"3.0"`. |
| `packages/cli/test/{status,emit-metrics,calibrate}.test.ts` | Rule 8b | **TEST-02c**: at least one CLI-level test per command, writing a real-shaped v2 `lane-state.json` directly to disk (schema_version="2.0", non-empty phase-scoped ledger entry) and asserting the command succeeds transparently — proves the whole command path, not just `parseLaneState` in isolation. |
| `packages/cli/src/state-store.ts` (`writeLaneState` validates against `LaneStateSchemaV2`) | DEP-01 | Update the import/validation call to `LaneStateSchemaV3`. |
| `packages/core/src/migrate-legacy-ledger.ts` | DEP-01/02 | **Does not reference.** Confirmed by reading: it parses `cost_ledger` entries through its own independent `LegacyLedgerEntrySchema` (a defensive reader for a *different*, pre-existing legacy import format) and only ever produces `CalibrationObservation`s, never constructs or type-depends on the exported `LedgerEntry`/`LedgerEntrySchema` binding at all. No change needed. |
| `packages/cli/src/commands/advance.ts` (`isDoneOverlayGuarded`) | DEP-02/07 | Reused as-is (already exactly the guard DEP-02 needs); not modified. |
| `packages/cli/src/commands/next.ts`/`status.ts` (`loadStateWithOverlay`) | DEP-07 | Read the *state* overlay (phase/status), a different concern from the new *ledger* overlay (DEP-04's `effectiveLedger()`) — confirmed by reading both call sites; neither reads `cost_ledger`, so neither needs to become ledger-overlay-aware. Not modified. |
| `skills/lane-finish/SKILL.md` step 3 (calibrate description) | DEP-02 | Update wording to mention the lane-scope ledger entry now recorded alongside the observation (team-lead's instruction). |
| `docs/design.md` §2.5 (LedgerEntry design rationale) | DEP-01/03 | Update per team-lead's instruction. |
| `packages/cli/src/commands/estimate.ts` (silent `?? 50_000` etc. defaults) | DEP-07 | Remove the silent defaults; require all four `--reference-*` flags together or none. |
| `packages/schemas/src/calibration.ts`/`estimate.ts` (existing `.finite()` on `QuantileSchema`; existing `knn_quantile` p50>0 refine) | DEP-06/08 | Confirmed unaffected/complementary: the existing refine only guards `predicted.tokens/cost_usd.p50` for `knn_quantile`, not `CalibrationPredictionEvaluation.error.*.relative_error_p50` (the actual field that could receive `Infinity`) — this spec's DEP-08 fix is the missing piece, not a duplicate of the existing guard. |
| `packages/core/test/calibrate-service.test.ts` (pre-existing `buildLaneScopeLedgerEntry`-named describe block + its 3 tests) | DEP-09 | **TEST-05** (added 2026-08-08): renamed to `buildLaneScopeLedgerEntries`, results read via array indexing; new tests for codex-only, mixed-agent-split, and null-agent-fallback attribution. |
| `packages/cli/src/commands/calibrate.ts` (single-`ledgerEntry` variable, both write branches) | DEP-09 | Rewritten to loop over `ledgerEntries: LedgerEntry[]` in both the overlay and in-repo write branches; output message prints one line per entry. **TEST-06**: CLI-level codex-only/mixed-agent tests (`packages/cli/test/calibrate.test.ts`). |
| `packages/core/test/done-overlay.test.ts` (no prior coverage of `effectiveLedger`'s own recompute behavior) | DEP-10 | **TEST-07**: a superseded-entry regression test (two overlay-delta entries, differing `pricing_version`/`pricing_as_of`, asserting the older one's `included_in_kpi` recomputes to `false` on read despite being persisted `true` on disk) and a mutation-safety test (`state.cost_ledger` unchanged after calling `effectiveLedger`). |
| `packages/cli/test/calibrate.test.ts` (no prior coverage of a re-calibrate across pricing_versions) | DEP-10 | **TEST-08**: a full CLI-level regression (advance to 5_done, calibrate twice with different `catalogVersion`/`generatedAt`, assert `emit-metrics`'s `coverage.eligible_entries`/`measured_entries` are both 1, not 2). |
| `packages/core/test/metrics-service.test.ts` (pre-existing `groupLedgerForMetrics`/selector tests only covered the single-lane-entry case) | DEP-11 | **TEST-09**: same-window-different-agents union, null-agents-wins-over-narrower union, and conflicting-window-flags-ambiguous tests. |
| `packages/cli/test/emit-metrics.test.ts` (no prior coverage of multiple `scope:"lane"` entries at all) | DEP-11 | **TEST-10**: a new `addLaneScopeLedgerEntry` helper + CLI-level ambiguous-selector-fails-closed test and same-window-union-succeeds test. |

Every cell above has either a resolution or a `TEST-ID`; none are left "unknown."

**Blind-spot disclaimer**: this table doesn't re-confirm that the new subset-based
dedup rule (DEP-03) is itself the *only* correct way to reconcile lane vs. phase
double-counting, or that `token_basis="agent-cost-raw-total/v1"` is the right long-term
name for a value that currently has no alternative to compare against — both were sol's
own explicit rulings, taken as given here, not independently re-derived. `critic.yaml`'s
`test_coverage` lens re-searches for paths this table's own axis choices might have
missed, not to re-confirm what it already found.
