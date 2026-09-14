# I-2026-09-10-agent-cost-v2-basis-gate — spec

**Revision 3 (2026-09-11)** — revised against the architect's second review
[`reviews/sol-spec-review-2.md`](reviews/sol-spec-review-2.md) ("修正後可"), which confirmed all nine
round-1 findings resolved and raised five new must-level ones (reference-table basis, the
mismatch record's shape, schema evolution, the missing template catalogue, the legacy-migration
writer) plus the scope-list inconsistency. Each is decided below as D25..D28 and RULE-35/37/39..42;
the "Scope findings" table is now the single normalized scope list. Revision 2 had already
withdrawn **D3**, moving the token basis to v2 inside this lane rather than a follow-up.

**2026-09-14** — the user approved, in one four-item decision, the scope extension, the narrowing
of intent success line 4, the cross-check table and design judgments (the human-review band), and
the merge of PR #12. `intent.yaml` carries the scope list and the narrowed S4; no open question
remains and no RULE or TEST changed on that account.

**Dependency and path cross-check: applicable.** This change (a) introduces new state (five
additive fields on the cost_ledger entry), a new guard (basis-conflict supersession refusal) and a
new completion condition (`eligible_for_knn` gains three more ways to be false), and (b) touches an
area where several existing paths already read the same `measure/v1` payload and the same
`cost_ledger` entries for different purposes (adapter validation, usage-import, calibrate, the
trace ledger, estimate/v1+v2, `lane estimate --adopt`, `lane next`, emit-metrics, evidence export,
attribution audit). Both limbs of the applicability test are met, so the full cross-check table
below is mandatory.

**Human-review band: applies, and is satisfied.** It requires the operator's explicit approval of
(1) the cross-check table and its TEST-ID mappings, (2) the axis/test-strategy choice, and (3) the
`allowed_paths` extensions listed in the "Scope findings" table. **All three were approved by the
user on 2026-09-14**, as items ③ (the cross-check table and the design decisions) and ① (the scope
list) of the four-item approval the team-lead put to them, alongside the narrowing of intent
success line 4 and the merge of PR #12.

`declared_risk: high` — approval before implementation is required on that ground as well.

## Premise (recorded at Phase 1)

`intent.yaml` `premise_evidence`: `required: true`, `method: data`, `reproduced: true`. Re-confirmed
by reading the code while writing this spec:

- `calibrate-service.ts:112-134` sets `eligible_for_knn = anyMatched && fullyPriced` and nothing
  else, so a 0.2.0 payload with `identity_missing` rows or an unattributed session is eligible today.
- `computeLedgerEntryId` (`core/ledger.ts:30-40`) keys on `(lane, phase, source, pricing_version)`,
  so a re-measurement under a new basis at the same rates upserts over the old entry
  (`upsertLedgerEntry`, `ledger.ts:197-206`) with no diagnostic.
- No occurrence of `producer_version`, `accounting_basis`, `conflicting_duplicate_groups`,
  `missing_dedup_identity_rows` or `identity_missing` exists anywhere under `packages/*/src`.
- `MIXED_OR_UNATTRIBUTED_USAGE` is declared in `estimate-v2.ts:28` and is never produced by any code
  path in this repo.

The payload side is confirmed against a captured artefact — see "Falsification conditions".

## Scope findings (files needed vs. `allowed_paths`) — read before approving

**This table is the single normalized scope list.** Nothing else in this document, in
`critic.yaml`, or in the open questions restates a count or a range — they refer either to this
table as a whole or to a specific row of it. **Status: approved by the user on 2026-09-14, with no exception left.** Every
row below is inside `intent.yaml`'s `allowed_paths` (`intent.yaml:113-128`), including
`publish/spec-lane/package.json`, added the same day.

Test directories are *not* listed: `packages/{schemas,core,adapters,cli}/test/**` and
`docs/spec/<intent-id>/**` and `CHANGELOG.md` are already inside `allowed_paths`, so the new tests,
their fixtures and the changelog entry need no scope extension.

| # | File | Why it is unavoidable | Related RULEs |
|---|---|---|---|
| SCOPE-1 | `packages/schemas/src/lane-state.ts` | The cost_ledger entry shape is `LedgerEntrySchema`/`LedgerEntryCommonFields` here, **not** in `calibration.ts` (which holds `CalibrationObservationSchema`). DEP-03 has nowhere else to live. | 03, 04, 12, 17, 32 |
| SCOPE-2 | `packages/core/src/application/usage-import-service.ts` | `buildPhaseScopedLedgerEntries` constructs the phase-scoped entry object; the new fields cannot reach a usage-import entry without editing it. | 03, 04, 12 |
| SCOPE-3 | `packages/cli/src/main.ts` | `--supersede-basis` on `usage-import`/`calibrate` (main.ts:361, :598) and `--reference-token-basis` on `estimate` (RULE-40). | 16, 17, 40 |
| SCOPE-4 | `packages/core/src/estimator-v2.ts` | `population.excluded_by_reason` / `decision.reason_codes` come only from `tallyExclusions`/`classifyCandidateExclusion`; the target cohort's `token_basis` is hardcoded at :72. | 20, 30 |
| SCOPE-5 | `packages/schemas/src/token-basis.ts` | D3 (revised): the basis literal itself moves to v2. | 30 |
| SCOPE-6 | `packages/core/src/estimator.ts` | The v1 population filter compares against that literal (`estimator.ts:144-146`). | 30, 31 |
| SCOPE-7 | `packages/core/src/application/estimate-service.ts` | Two revision write sites stamp the literal (`:220`, `:241`); RULE-40 makes the reference-table branch stamp `"unknown"` instead. | 30, 40 |
| SCOPE-8 | the five `package.json` files carrying `0.9.1` (`packages/{schemas,core,adapters,cli}/package.json`, `publish/spec-lane/package.json`) | The **0.10.0** bump: the basis move changes estimation output for every existing lane, which is not patch-level. All five are approved: `package.json`, `packages/*/package.json` and `publish/spec-lane/package.json` (the last added 2026-09-14 after this row flagged that the earlier globs missed it, which would have left the published package at 0.9.1). | 41 |
| SCOPE-9 | `packages/cli/src/commands/estimate.ts` | The reference-table branch (`:154-182`) builds the four hand-entered values that RULE-40 must mark `"unknown"`, and parses the new flag. | 40 |
| SCOPE-10 | `packages/schemas/generated/**` | The committed JSON Schemas are regenerated from zod and are what `packages/schemas/test/differential.test.ts` compiles with ajv; a calibration/lane-state change without regeneration fails that suite (`generate-json-schema.ts:25-40`, design.md §6). | 41 |
| SCOPE-11 | `packages/core/src/migrate-legacy-ledger.ts` | It writes observations (`:160-187`) with `eligible_for_knn: true` and no basis, which contradicts RULE-12's "every written observation". | 12, 42 |
| SCOPE-12 | `packages/schemas/src/lane-evidence.ts` | `LedgerSummarySchema` is `.strict()`; the basis status field cannot be emitted without editing it (`:62-70`). | 35 |
| SCOPE-13 | `packages/core/src/application/evidence-export-service.ts` | `summarizeLedger` (`:75-91`) is what would compute the basis set. | 35 |

The rows for `token-basis.ts`, `estimator.ts`, `estimate-service.ts`, `cli/commands/estimate.ts`
and `packages/schemas/generated/**` exist only because of the operator's decisions to withdraw D3
(sol round-1 must-1) and to fix the reference-table basis (round-2); all of them are now approved,
so those decisions are implementable as written.

**intent.yaml's success line 4 has been narrowed** to the wording D19 describes and now reads:
reason code plus a fixed-template detail string on the entry and the observation, the reason code
alone in the estimate/v2 abstain output, no version bump to that contract, and nothing living only
in stderr (`intent.yaml:42-46`, updated 2026-09-14). S4 in the mapping table below is that
narrowed criterion, not the original wider one.

## Decisions

- **D1. The new measure/v1 fields are declared, not carried by passthrough.**
  `AgentCostMeasureResultSchema` is a plain `z.object()` (zod's default is *strip*), and so is its
  `data_quality` sub-object; only `AgentCostRowSchema` is `.passthrough()`. An undeclared
  `producer_version`/`accounting_basis` therefore does not survive `safeParse` at
  `adapters/src/telemetry/agent-cost.ts:82` — it is silently dropped, not rejected. Declaring the
  new fields `optional()` is what makes the data reach the ledger at all.
  `data_quality.source_quality` is already `z.record(z.string(), z.number())`, so
  `identity_missing` survives today; RULE-07 still reads it defensively. The three new counters are
  declared as plain optional numbers rather than non-negative integers on purpose: a schema that
  rejects `-1` or `0.5` throws the whole measurement away at the adapter and destroys RULE-07's
  chance to classify it as `MIXED_OR_UNATTRIBUTED_USAGE` with a detail string. The stricter the
  schema here, the less the gate can say.
- **D2. One literal, two names.** `TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V2 = "agent-cost-raw-total/v2"`
  is defined once in `packages/schemas/src/token-basis.ts`;
  `CURRENT_ACCOUNTING_BASIS` in `agent-cost.ts` is an alias of that same constant, so the value the
  producer declares and the value the estimator compares against can never drift apart.
  `TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1` stays exported for reading records already on disk.
- **D3 (withdrawn and replaced, 2026-09-11 — sol must-1). The token basis moves to v2 atomically in
  this lane.** The previous decision (keep stamping the v1 literal, exclude stale data through
  `eligible_for_knn`) left every *pre-existing* 0.1.x observation in the k-NN population: those
  records carry `eligible_for_knn: true` and the v1 literal, `estimator.ts:144-158` reads only
  those two things, and D15 forbids recomputing them. The gate would have been enforced only on new
  writes. The replacement: `token-basis.ts`, `estimator.ts`, `estimator-v2.ts:72` and
  `estimate-service.ts:220,241` all move to the v2 literal in one diff (SCOPE-4..7), and
  **an observation's `actual.token_basis` is exactly its measurement's normalized
  `accounting_basis`** (RULE-03's normalization, so `"unknown"` for a 0.1.x payload). Every record
  written before this lane is then excluded by the one comparison that already exists, with no
  second exclusion path to keep in sync (RULE-31).
- **D4. Additive, optional entry fields; `schema_version` stays `"3.0"`.** `accounting_basis:
  string`, `producer_version: string | null`, `knn_ineligibility_reasons: EstimateV2ReasonCode[]`,
  `knn_ineligibility_detail: string[]`, `basis_history: BasisHistoryEntry[]`. All `.optional()`
  with **no zod default**, following `DesignTrackSchema`'s precedent (`lane-state.ts:194`): a
  `.default([])` would materialize the key into every pre-existing entry the next time any command
  round-trips lane-state.json, rewriting files this lane never measured. Writers always set the
  first four explicitly; `basis_history` appears only once a supersession has happened.
- **D5 (extended, sol implementation review 2026-09-14). Absent is not clean, and for an
  observation that has a consequence.** A reader that finds `knn_ineligibility_reasons` absent must
  treat the record as "never evaluated", never as "no reasons" — the same fail-closed convention
  `calibration.ts:30` already uses for a missing `token_basis`. On the estimate/v2 side the
  candidate is therefore excluded from the population rather than admitted: an absent array means
  either a writer that predates this lane or a defect in one that does not, and neither is a reason
  to treat the observation as clean. It is counted under the existing
  `MIXED_OR_UNATTRIBUTED_USAGE`; minting a code for "we do not know" would put an unmeasured state
  into a contract whose codes all name measured ones.
- **D6. One predicate, exported from `calibrate-service.ts`.**
  `deriveKnnIneligibility(input): {reasons, detail}` is pure (no filesystem, no subprocess) and
  takes the measurement, the entry's `session_ids`, and an already-built attribution projection. It
  is exported from the module that already exports `totalsByAgent`/`fallbackAgent`/`sourceForAgent`
  for exactly this "one rule, reused, not reimplemented" reason (design.md §5.6).
  `usage-import-service.ts`, the observation builder and both CLI commands call it.
- **D7. Attribution is reused, never re-derived.** Session classification comes from
  `core/attribution.ts` — the same module `buildAttributionAuditResult` uses, built on the
  projection of `session_bound` trace events, whose multi-binding rule is the existing
  `deriveBindingRecordsFromTrace`/`checkBindingCollectionViolations`. "Exactly attributed" means:
  present in `sessions.exactly_attributed`. Presence in `unbound`, `mixed`, `orphan_usage`,
  `measurement_incomplete`, **or in no bucket at all** (a bound session never usage-imported —
  `attribution.ts:319-325` excludes those from the audit's universe) all count as not exactly
  attributed.
- **D8 (revised — sol must-3). Preflight before any side effect.** The old order appended trace
  events per phase and only then discovered a basis conflict, so a *refused* command had already
  changed the authoritative trace ledger, which feeds the next run's attribution. New order, one
  pass per command: (1) measure every phase and **stage** the results in memory, writing nothing;
  (2) preflight — compute every entry id and compare each against the existing entry's normalized
  basis, for **all** phases; (3) if any conflict is unresolved, refuse, with no file touched at all;
  (4) otherwise append this run's `usage_imported`/`attributed_to` events; (5) derive the
  attribution projection **once**; (6) build entries with their reasons; (7) write lane-state.json
  or the overlay's `ledger_delta` once. The end-of-run stderr audit summary is served from the same
  derivation, not a second scan.
- **D9. `calibrate` runs the same derivation before writing.** It writes no trace events of its own,
  so a session that was bound but never usage-imported is not exactly attributed and its
  observation is ineligible. See "Known affected behavior" item 1.
- **D10. The supersession guard is a pure planner plus a CLI refusal.**
  `planBasisSupersession(existing, incoming)` lives in `core/ledger.ts` and returns either a refusal
  (both normalized bases, both producer_versions) or the entry to write with its `basis_history`
  appended; `upsertLedgerEntry` stays a pure array operation. Both CLI commands use the same
  planner. `computeLedgerEntryId` is untouched — Python-parity identity is frozen (intent
  non-goal 2).
- **D11 (revised — sol must-3). A refusal has no side effect at all.** Because the conflict is
  detected before step (4) of D8, refusal leaves the trace ledger, lane-state.json and the overlay
  file byte-identical. This is now an unconditional claim, not one scoped to the ledger files.
  `calibrate` additionally refuses before `writeCalibrationRecord`, so no observation is written for
  a refused ledger write.
- **D12. Nothing is discarded.** An unattributed or wrong-basis measurement keeps its tokens, cost
  and `usage_imported` event exactly as measured; only eligibility changes. `included_in_kpi` and
  `deriveIncludedInKpi` are untouched — this lane gates the k-NN population, not the KPI ledger.
- **D13. "Exactly attributed to one task" is a per-session predicate.** A phase-scoped entry unions
  the sessions of every concurrent task_run in that phase (design.md §5.6,
  `usage-import.ts:136-150`), by design. An entry spanning more than one task_run of the same lane
  is not itself a reason; the intent's phrase is read as attribution/v1's own `exactly_attributed`
  predicate applied to each `session_id` independently.
- **D14 (revised — sol must-4). The "latest usage_imported" projection, defined.** For eligibility,
  each `(task_run_id, session_id)` pair resolves to exactly one event:
  1. **De-duplicate by `event_id` first.** `usage_imported`'s identity is
     `(task_run_id, session_id, window)` (`trace.ts:41-49`), so the same window replayed produces
     the same `event_id`; it is one fact recorded twice, counted once.
  2. **Highest `occurred_at` wins** among the remaining events for that pair.
  3. **Ties break on ledger order** — the later line in `events.jsonl` wins, matching the file's
     append-only semantics; no other tie-break is invented.
  4. **A correction outranks both**: an event whose `supersedes_event_id` names another event
     retires that event regardless of timestamp, and the retired event is never the latest.
  A pair's latest event's `matched` decides that pair. Recovery is therefore real: a later
  `matched:true` supersedes an earlier failure.
- **D15 (revised — sol must-4). The projection is eligibility-only.** `buildAttributionAuditResult`'s
  token arithmetic is unchanged: `tokens.exact_attributed` and `tokens.total_measured` keep summing
  every in-window `usage_imported` event, as today (`attribution.ts:299-304`). Only the
  matched/unmatched *classification* consumes the latest projection. This is what makes TEST-44's
  byte-identity claim achievable, and it keeps attribution/v1's published token contract intact.
- **D16. Binding count is evaluated before the per-pair fold.** If a session is bound to two or more
  task_runs it is `mixed`, without looking at any `usage_imported` state; the D14 fold runs only for
  a session with exactly one binding. Consistent with `checkBindingCollectionViolations`
  (`attribution.ts:44-65`) and the existing branch order at `attribution.ts:252-277`, and it removes
  the otherwise-undefined case where one pair says `matched:true` and another says `matched:false`.
- **D17 (revised — sol must-5). Recovery takes two commands, and the spec says which.** D14 is the
  classification rule applied at evaluation time; the stored reasons are a write-time snapshot (D18)
  that nothing rewrites behind the operator's back. `lane usage-import` refreshes the **ledger
  entry** only — the k-NN population is the calibration store, which usage-import never writes
  (`usage-import.ts:220-244`, `calibration-store.ts:39-42`, `estimator.ts:131-160`). Restoring a
  recovered session to the population therefore requires **both**: re-run `lane usage-import`, then
  re-run `lane calibrate` with the same `--session-id`/`--since`/`--until` so `record_id` is
  identical and the observation is upserted, not duplicated. Any claim that usage-import alone
  updates an observation is wrong and has been removed.
- **D18. The reasons are a write-time snapshot; nothing recomputes them.** Unlike `included_in_kpi`
  (recomputed over the whole ledger on every mutation, `ledger.ts:209-214`), the reasons depend on
  the measurement payload, which only exists at measure time. No background recomputation is added.
- **D19 (sol must-6, operator ruling). S4 is narrowed to code visibility, plus a local detail
  string.** The entry and the observation carry `knn_ineligibility_reasons: EstimateV2ReasonCode[]`
  **and** `knn_ineligibility_detail: string[]` — one human-readable sentence per failing condition,
  so two different conditions that collapse into the same `MIXED_OR_UNATTRIBUTED_USAGE` stay
  distinguishable where they are recorded. The **estimate/v2 output is unchanged in shape**: it
  reports codes only, one exclusive primary reason per candidate, exactly as
  `estimator-v2.ts:76-114` already does. No contract version bump, no new field on the estimate/v2
  decision. intent success line 4 is being narrowed to match (team-lead owns that edit).
- **D20 (sol must-7). Read-time normalization.** An entry with no `accounting_basis` key at all
  (every entry written before this lane) normalizes to `"unknown"` on read, and a missing
  `producer_version` to `null` — in conflict detection, in `basis_history` and in diagnostics
  alike. There is one normalization function and the tests exercise the genuine pre-change shape,
  not a hand-written `"unknown"`.
- **D21 (sol must-9, PATH additions). The estimate/adopt/next chain is deliberately unchanged.**
  After the basis move the eligible population is empty until new observations accumulate, so
  `estimator.ts` falls back to `referenceTableEstimate`, which is already marked
  `method: "reference_table"`, `experimental: true` (`estimator.ts:120-128`), and
  `AbstainedRevisionCannotBeBaselineError` already permits adopting such a revision
  (`estimate-service.ts:41-64`). That number is a generic reference table, **not** a stale-basis
  measurement, and it already carries its own honesty label; adding a new adoption gate would be a
  new guard on two existing commands that no success line asks for. Recorded as a non-goal, pinned
  by TEST-59 so the labelling cannot quietly degrade.
- **D22 (critic must-1, operator ruling 2026-09-11). A prediction is never scored across bases.**
  `evaluatePrediction` (`calibrate-service.ts:40-86`) compares an adopted baseline's `predicted`
  with the new observation's `actual` and never looks at either side's basis; every revision
  already on disk carries the v1 literal (`estimate-service.ts:220,241`), so after DEP-09 the first
  `lane calibrate` on any existing lane would report a relative error between two incomparable
  bases — the very error this lane exists to prevent, in the one path the cross-check table never
  had a column for. The fix reuses the shape already in the schema: when the baseline revision's
  `token_basis` differs from the observation's, `relative_error_p50` is `null` and `reason` is the
  new value `token_basis_mismatch`, added to `calibration.ts:80`'s existing enum (additive and
  optional, no contract version bump). `covered_by_p80` is likewise not asserted across bases.
  Same rule `predicted_p50_zero` already established: null plus a machine-readable reason, never a
  fabricated number.
- **D23 (critic must-2, operator ruling 2026-09-11). A refused run writes nothing, including the
  trace ledger.** D11 holds unqualified. The preflight judges conflicts using only the phases whose
  measurement succeeded; a phase whose `agent-cost measure` threw contributes no payload and
  therefore no conflict. If the run is then refused, the honest `matched:false` events that
  `usage-import.ts:180-203` would have written for the failed phase are **not** written either.
  That is a real, accepted consequence, and the diagnostic is what makes it recoverable: the
  refusal names both the conflict (both normalized bases, both producer_versions) **and** every
  phase whose measurement failed in the same run. When the operator resolves the conflict and
  re-runs, a failure that is still real is recorded exactly as before. Until then the affected
  sessions stay "never usage-imported" in the audit — absent, not zero — so design.md §5.6's
  never-zero-fill rule is preserved even though the failure record is deferred.
- **D25 (sol round-2 must, operator ruling 2026-09-11). A reference-table revision has no basis.**
  The four `--reference-*` values are typed in by a human (`estimate.ts:154-182`) and carry no
  provenance at all, yet both revision write sites stamp the basis literal unconditionally
  (`estimate-service.ts:220,241`). After DEP-09 that would stamp v2 on a hand-entered number and
  D22 would then treat it as comparable with a real v2 measurement — the same fabrication this lane
  exists to prevent, one layer up. A reference-table revision therefore records
  `token_basis: "unknown"` by default; the operator can declare a real basis with a new
  `--reference-token-basis <basis>` flag, and only then is v2 stamped. D22 treats `"unknown"` as
  incomparable, so an undeclared reference baseline is never scored. Adoption itself stays a
  non-goal (D21).
- **D26 (sol round-2 must, operator ruling 2026-09-11). Schema evolution is forward-incompatible,
  and that is stated rather than discovered.** Adding `token_basis_mismatch` to
  `calibration.ts:80`'s enum and making `covered_by_p80` nullable are backward-compatible for
  reading (every record written before this lane still parses) and forward-*in*compatible for
  writing (a pre-change binary, or the committed JSON Schema at
  `generated/calibration.schema.json:337-376`, rejects a record carrying the new reason —
  `calibration-store.ts:31-42` parses every file in the store with one schema, so a single new
  record stops an old binary). The policy: **the new binary reads every old record** (asserted),
  **an old binary is not supported against a new store** (declared). spec-lane is a single-user
  CLI with no downgrade path and no second consumer; inventing a record-level version negotiation
  for that would be more contract than the situation has. The committed JSON Schemas are
  regenerated in the same diff (SCOPE-10) and `packages/schemas/test/differential.test.ts` gains a
  valid fixture in the new shape while keeping every existing one.
- **D27 (sol round-2 must, operator ruling 2026-09-11). The detail templates are enumerated in this
  spec.** A tester cannot derive an expected string from a principle, so the full template set is
  listed below under "Detail string templates", together with the placeholder vocabulary and the
  array order. The apparent contradiction sol found — D24 permits embedding a bounded
  `accounting_basis` while TEST-64 banned every payload substring — is resolved by the templates
  themselves: `accounting_basis` is the one payload-derived value allowed inside a detail string,
  because RULE-28 already bounds its length and charset at the boundary. Nothing else from the
  payload appears, and `producer_version` in particular never does.
- **D28 (sol round-2 must, operator ruling 2026-09-11). The legacy-migration writer obeys RULE-12
  too.** `migrate-legacy-ledger.ts:160-187` builds observations with `eligible_for_knn: true` and
  no `token_basis`, which is how "every written observation carries reasons" would have been false
  the moment anyone ran the migration again. It now writes `token_basis: "unknown"`,
  `knn_ineligibility_reasons: [TOKEN_BASIS_MISMATCH]`, the matching detail string, and
  `eligible_for_knn: false`. The salvaged numbers are unchanged; only their honest labelling is
  added. This also removes the accident the first critic pass relied on — those records were
  excluded only because `token_basis` happened to be absent.
- **D24 (critic medium, operator ruling 2026-09-11). Detail strings are composed, not
  interpolated.** Each `knn_ineligibility_detail` string is built from a fixed, lane-owned template
  plus lane-known identifiers — a session id, a counter name from this spec's own closed list, or
  a basis value already bounded by RULE-28. No payload-derived free text is embedded, so the field
  cannot become a second unbounded channel for subprocess output one layer above the boundary
  RULE-28 defends.

## Requirements (EARS)

- RULE-01 (ubiquitous, revised — sol implementation review): `AgentCostMeasureResultSchema` shall
  declare `producer_version` and `accounting_basis` as optional top-level strings and
  `data_quality.{duplicate_rows_skipped, conflicting_duplicate_groups, missing_dedup_identity_rows}`
  as **optional numbers**, so a 0.2.0 payload's values survive parsing. Integrality, sign and
  finiteness shall **not** be enforced by the schema; RULE-07 inspects them and records the failure
  as a reason. A value that is not a number at all remains an adapter-level rejection — that is a
  malformed payload, not a dedup-quality signal.
- RULE-02 (unwanted): No field added by RULE-01 shall be required — a payload carrying none of them
  (agent-cost 0.1.x) shall still validate at the telemetry adapter boundary.
- RULE-03 (event-driven): When usage-import or calibrate writes a cost_ledger entry, that entry
  shall carry `accounting_basis` equal to the payload's value, or the literal string `"unknown"`
  written explicitly when the payload carries none.
- RULE-04 (event-driven): The same entry shall carry `producer_version` equal to the payload's
  value, or `null` when the payload carries none.
- RULE-05 (ubiquitous): Exactly one function shall derive the reasons and their detail strings;
  usage-import's entries, calibrate's entries and calibrate's observation shall all obtain them
  from it.
- RULE-06 (unwanted): If the measurement's normalized `accounting_basis` is not
  `CURRENT_ACCOUNTING_BASIS`, the derived reasons shall contain `TOKEN_BASIS_MISMATCH`.
- RULE-07 (unwanted, revised — sol must-2): Each of `data_quality.conflicting_duplicate_groups`,
  `data_quality.missing_dedup_identity_rows` and `data_quality.source_quality.identity_missing`
  shall count as clean **only** when it is present as a finite integer equal to `0`; absent,
  negative, non-integer or non-finite shall each produce `MIXED_OR_UNATTRIBUTED_USAGE`.
- RULE-08 (unwanted): `data_quality.duplicate_rows_skipped` shall produce no reason at any value —
  skipping duplicate rows is the 0.2.0 fix working, not a defect. Its absence shall likewise
  produce no reason.
- RULE-09 (unwanted): If any `session_id` of the entry is absent from the exactly-attributed set,
  the derived reasons shall contain `MIXED_OR_UNATTRIBUTED_USAGE`.
- RULE-10 (ubiquitous): The reasons shall list every failing condition, de-duplicated and ordered
  by the declaration order of `ESTIMATE_V2_REASON_CODES` (`estimate-v2.ts:18-31`), so
  `TOKEN_BASIS_MISMATCH` precedes `MIXED_OR_UNATTRIBUTED_USAGE` — never only the first condition
  found, and never in discovery order.
- RULE-11 (ubiquitous): `eligible_for_knn` shall be `reasons.length === 0 && anyMatched &&
  fullyPriced`; the pre-existing matched-and-fully-priced condition keeps its independent power to
  make an observation ineligible with an empty reasons array.
- RULE-12 (ubiquitous, revised): Every written entry and observation shall carry both
  `knn_ineligibility_reasons` (possibly `[]`) and `knn_ineligibility_detail`, with one detail
  string per failing condition — so two conditions collapsing into one code remain distinguishable
  — and the observation shall additionally carry `accounting_basis`.
- RULE-13 (unwanted, extended — sol implementation review): A reader that finds
  `knn_ineligibility_reasons` absent shall treat the record as not-yet-evaluated, never as
  eligible. For a calibration observation this is operative, not advisory: such a candidate shall
  be excluded from the estimate/v2 population and counted under
  `population.excluded_by_reason["MIXED_OR_UNATTRIBUTED_USAGE"]`. No new reason code is minted for
  it.
- RULE-14 (ubiquitous): Session classification shall come from `core/attribution.ts`; no code added
  by this change shall re-derive binding state from `cost_ledger.session_ids`.
- RULE-15 (event-driven, revised): usage-import and calibrate shall stage every measurement in
  memory and complete the entry-id and basis preflight for all phases **before** appending any
  trace event; the attribution projection shall then be derived once, after this run's events are
  appended and before any ledger write.
- RULE-16 (unwanted, revised): If an incoming entry's `ledger_entry_id` matches an existing entry
  whose normalized `accounting_basis` differs and `--supersede-basis` was not given, the command
  shall exit non-zero with a diagnostic naming both normalized `accounting_basis` values and both
  `producer_version` values, and shall leave the trace ledger, lane-state.json and the overlay file
  all byte-identical.
- RULE-17 (event-driven): With `--supersede-basis`, the new entry shall be written under the
  unchanged `ledger_entry_id` and shall append to `basis_history` one element preserving the
  replaced entry's normalized `{accounting_basis, producer_version, tokens, cost_usd, cost_credits,
  recorded_at}`, keeping any pre-existing elements.
- RULE-18 (ubiquitous): `computeLedgerEntryId` shall keep its `(lane, phase, source,
  pricing_version)` inputs and produce an unchanged id for every input it accepts today.
- RULE-19 (ubiquitous): A re-import under the same normalized `accounting_basis` shall remain a
  plain idempotent upsert and shall not grow `basis_history`.
- RULE-20 (event-driven, revised — sol must-6): `classifyCandidateExclusion` shall evaluate the
  basis comparison first (unchanged), then the observation's recorded reasons in
  `ESTIMATE_V2_REASON_CODES` order, then the existing cohort checks, returning exactly one primary
  code; the decision shall count it under `population.excluded_by_reason` and name it in
  `decision.reason_codes` when abstaining. The estimate/v2 payload shape, its field set and its
  contract version shall not change.
- RULE-21 (ubiquitous): An ineligible measurement's tokens, cost and `usage_imported` event shall be
  recorded exactly as measured; only eligibility changes.
- RULE-22 (ubiquitous): `included_in_kpi`, `deriveIncludedInKpi`, `isSuperseded`, and emit-metrics'
  `ambiguous_session_attribution`/`unknown_token_kind` fail-closed rules shall be unchanged.
- RULE-23 (ubiquitous): Session match state shall be derived per `(session_id, task_run_id)` pair
  from the latest event for that pair as defined in D14 (event_id de-duplication, highest
  `occurred_at`, ledger order as tie-break, `supersedes_event_id` outranking both).
- RULE-24 (ubiquitous): The eligibility derivation shall apply no time window, so a given trace
  ledger and entry shall yield the same reasons regardless of when the command runs.
- RULE-25 (unwanted): If `calibrate` refuses a write because of a basis conflict, it shall refuse
  before `writeCalibrationRecord`.
- RULE-26 (unwanted): A phase-scoped entry whose sessions belong to more than one task_run of the
  same lane shall not be ineligible on that ground alone; only RULE-09 applies.
- RULE-27 (ubiquitous): `knn_ineligibility_reasons` shall be written only by the command writing
  the entry; no command shall retroactively recompute the reasons of an entry it is not otherwise
  rewriting.
- RULE-28 (unwanted, revised — sol must-8): If `producer_version` **or** `accounting_basis` is
  present and exceeds 256 characters or contains a control character, the telemetry adapter shall
  reject the payload rather than persist the value; both fields stay optional, so this constrains a
  present value without making it required.
- RULE-29 (ubiquitous): A session bound to two or more task_runs shall be classified `mixed`
  without evaluating any `usage_imported` state.
- RULE-30 (ubiquitous, sol must-1): The k-NN token basis literal shall be
  `"agent-cost-raw-total/v2"`, identical in value to `CURRENT_ACCOUNTING_BASIS`, at every site that
  stamps or compares it — `token-basis.ts`, `estimator.ts`'s population filter,
  `estimator-v2.ts`'s target cohort and `estimate-service.ts`'s two revision write sites, subject
  to RULE-40's exception for a reference-table revision. The v1 literal shall remain exported for
  reading records already on disk and shall be written by nothing.
- RULE-31 (ubiquitous, sol must-1): An observation's `actual.token_basis` shall be its measurement's
  normalized `accounting_basis`, and a basis-mismatched observation shall be excluded by that one
  comparison; the reasons array shall not create a second exclusion path, so such a candidate is
  counted exactly once in `population.excluded_by_reason`.
- RULE-32 (ubiquitous, sol must-7): On read, an entry with no `accounting_basis` key shall normalize
  to `"unknown"` and one with no `producer_version` key to `null`, through a single normalization
  function used by conflict detection, `basis_history` and diagnostics alike.
- RULE-33 (unwanted, sol must-3): If any phase of a multi-phase run has an unresolved basis
  conflict, the whole command shall refuse — no other phase's entry shall be written.
- RULE-34 (ubiquitous, sol must-4): `buildAttributionAuditResult`'s `tokens.exact_attributed` and
  `tokens.total_measured` shall keep summing every in-window `usage_imported` event; the latest
  projection shall change classification only.
- RULE-35 (ubiquitous, revised — sol rounds 2 and 3): `evidence-export`'s ledger summary shall keep
  its current arithmetic and shall emit, in the exported JSON itself, two keys:
  `accounting_bases: string[]` — the normalized bases of the summed entries, de-duplicated and in
  ascending lexicographic order — and `accounting_basis_status`, which shall be `"single"` when
  `accounting_bases` has exactly one element and `"unqualified"` otherwise, the empty case
  included. A consumer then sees that a total may span more than one basis without reading this
  repo's schema comments.
- RULE-36 (ubiquitous, sol must-9 / D21): `lane estimate --adopt` and `lane next` shall keep their
  current behaviour, including that a reference-table revision stays adoptable while estimate/v2
  abstains, and shall keep reporting `method: "reference_table"` with `experimental: true`.
- RULE-37 (unwanted, revised — critic must-1 / D22 / sol round-2): If the baseline revision's
  `token_basis` differs from the observation's — including when either is `"unknown"` or absent —
  `evaluatePrediction` shall emit, for both `tokens` and `cost_usd`, exactly
  `{relative_error_p50: null, covered_by_p80: null, reason: "token_basis_mismatch"}`, and
  `covered_by_p80` shall become `boolean | null` in `calibration.ts`'s schema so that shape is
  representable. When the two bases are equal it shall score exactly as it does today.
- RULE-38 (unwanted, critic must-2 / D23): A refused run shall write nothing at all — trace
  ledger, lane-state.json and overlay file each byte-identical — even when a phase's measurement
  failed in the same run, and its diagnostic shall name both the conflict (both normalized bases,
  both producer_versions) and every phase whose measurement failed.
- RULE-39 (ubiquitous, revised — critic medium / D24 / D27): Each `knn_ineligibility_detail` string
  shall be one of the templates enumerated under "Detail string templates", with placeholders
  filled only from that section's vocabulary; the array shall be ordered by reason code
  (`ESTIMATE_V2_REASON_CODES` order) and, within one code, by the order the conditions are listed
  there.
- RULE-40 (event-driven, sol round-2 / D25): When a revision's prediction comes from the
  reference table rather than the eligible population, the revision shall record
  `token_basis: "unknown"` unless the operator declared one with `--reference-token-basis`, in
  which case that value shall be recorded; a k-NN-derived revision shall record
  `CURRENT_ACCOUNTING_BASIS`.
- RULE-41 (ubiquitous, sol round-2 / D26): The new binary shall parse every calibration and
  lane-state record written before this change, the committed JSON Schemas under
  `packages/schemas/generated/**` shall be regenerated in the same diff, and the differential suite
  shall carry both a new-shape valid fixture and every pre-change one.
- RULE-42 (ubiquitous, sol round-2 / D28): An observation written by the legacy-ledger migration
  shall carry `token_basis: "unknown"`, `knn_ineligibility_reasons: [TOKEN_BASIS_MISMATCH]`, the
  matching detail string and `eligible_for_knn: false`, with its salvaged token and cost numbers
  unchanged.

## Detail string templates (RULE-39, D27)

This is the complete set. A `knn_ineligibility_detail` string is one of these, filled from the
placeholder vocabulary below and nothing else. A tester derives the expected strings from this
table alone.

| # | Reason code | Condition | Template |
|---|---|---|---|
| T-1 | `TOKEN_BASIS_MISMATCH` | the payload declared no basis | `accounting basis is "unknown" (the measurement declared none); the current basis is "{current_basis}"` |
| T-2 | `TOKEN_BASIS_MISMATCH` | the payload declared a different basis | `accounting basis "{accounting_basis}" is not the current basis "{current_basis}"` |
| T-3 | `MIXED_OR_UNATTRIBUTED_USAGE` | a dedup counter is non-zero | `data_quality.{counter_name} is {counter_value}, expected 0` |
| T-4 | `MIXED_OR_UNATTRIBUTED_USAGE` | a dedup counter is absent | `data_quality.{counter_name} is absent; an explicit 0 is required` |
| T-5 | `MIXED_OR_UNATTRIBUTED_USAGE` | a dedup counter is present but not a finite non-negative integer | `data_quality.{counter_name} is not a finite non-negative integer` |
| T-6 | `MIXED_OR_UNATTRIBUTED_USAGE` | attribution state is exactly `unbound` | `session {session_id} is unbound (usage recorded, no session_bound event)` |
| T-7 | `MIXED_OR_UNATTRIBUTED_USAGE` | attribution state is exactly `mixed` (bound to more than one task_run) | `session {session_id} is bound to {binding_count} task_runs` |
| T-8 | `MIXED_OR_UNATTRIBUTED_USAGE` | attribution state is exactly `orphan_usage` | `session {session_id} is orphan usage (in the ledger, never bound)` |
| T-9 | `MIXED_OR_UNATTRIBUTED_USAGE` | latest event for the pair is `matched:false` | `session {session_id} is measurement-incomplete for task_run {task_run_id}` |
| T-10 | `MIXED_OR_UNATTRIBUTED_USAGE` | bound but never usage-imported | `session {session_id} has never been usage-imported` |
| T-11 | `TOKEN_BASIS_MISMATCH` | written by the legacy migration (RULE-42) | `observation reconstructed from a legacy ledger; accounting basis is "unknown"` |

**Placeholder vocabulary** — the only values that may be substituted:

- `{session_id}`, `{task_run_id}`, `{phase}` — lane-owned identifiers from the trace ledger.
- `{binding_count}`, `{counter_value}` — integers this lane computed.
- `{counter_name}` — one of the closed set `conflicting_duplicate_groups`,
  `missing_dedup_identity_rows`, `source_quality.identity_missing`.
- `{accounting_basis}`, `{current_basis}` — basis values, already length- and charset-bounded by
  RULE-28. **This is the one payload-derived value a detail string may contain.**
  `producer_version` and every other payload string are excluded.

**Ordering** — the array is sorted by reason code in `ESTIMATE_V2_REASON_CODES` declaration order.
Within one code:

1. The counter templates T-3, T-4 and T-5 come first, as one group, ordered by the counter's
   position in the closed set declared above — `conflicting_duplicate_groups`, then
   `missing_dedup_identity_rows`, then `source_quality.identity_missing`. Counter position
   dominates the template's row number here, because one counter matches exactly one of T-3/T-4/T-5
   (non-zero, absent, or not a finite non-negative integer are mutually exclusive), so each counter
   contributes at most one string and the sequence is fully determined.
2. Then the session templates T-6 through T-10, ordered by `session_id` ascending. Each session
   matches exactly one of them: T-6, T-7, T-8 and T-9 key off mutually exclusive attribution
   states (`unbound`, `mixed`, `orphan_usage`, `measurement_incomplete`), and T-10 covers the
   remaining case of a session in no bucket at all.
3. T-1, T-2 and T-11 fire at most once each per record.

Two runs over the same inputs produce byte-identical arrays.

## Scenarios

```gherkin
Scenario Outline: the reason predicate, one failing condition at a time
  Given a measure/v1 payload that is matched and fully priced
  And   the payload's <field> is <value>
  And   every session of the entry is exactly_attributed
  When  the reasons are derived
  Then  the reasons are exactly <reasons>

  Examples:
    | field                                        | value                     | reasons                        |
    | accounting_basis                             | "agent-cost-raw-total/v2" | []                             |
    | accounting_basis                             | absent                    | [TOKEN_BASIS_MISMATCH]         |
    | accounting_basis                             | "agent-cost-raw-total/v1" | [TOKEN_BASIS_MISMATCH]         |
    | data_quality.conflicting_duplicate_groups    | 1                         | [MIXED_OR_UNATTRIBUTED_USAGE]  |
    | data_quality.conflicting_duplicate_groups    | absent                    | [MIXED_OR_UNATTRIBUTED_USAGE]  |
    | data_quality.missing_dedup_identity_rows     | 1                         | [MIXED_OR_UNATTRIBUTED_USAGE]  |
    | data_quality.missing_dedup_identity_rows     | -1                        | [MIXED_OR_UNATTRIBUTED_USAGE]  |
    | data_quality.source_quality.identity_missing | 1                         | [MIXED_OR_UNATTRIBUTED_USAGE]  |
    | data_quality.source_quality.identity_missing | absent                    | [MIXED_OR_UNATTRIBUTED_USAGE]  |
    | data_quality.source_quality.identity_missing | 0.5                       | [MIXED_OR_UNATTRIBUTED_USAGE]  |
    | data_quality.duplicate_rows_skipped          | 42                        | []                             |
    | data_quality.duplicate_rows_skipped          | absent                    | []                             |

Scenario Outline: attribution state, one session state at a time
  Given a measure/v1 payload on the current accounting basis with clean dedup counters
  And   the entry has one session whose attribution state is <state>
  When  the reasons are derived
  Then  the reasons are <reasons>

  Examples:
    | state                                      | reasons                       |
    | exactly_attributed                         | []                            |
    | unbound (usage but no session_bound)       | [MIXED_OR_UNATTRIBUTED_USAGE] |
    | mixed (bound to two task_runs, RULE-29)    | [MIXED_OR_UNATTRIBUTED_USAGE] |
    | orphan_usage (in ledger, never bound)      | [MIXED_OR_UNATTRIBUTED_USAGE] |
    | measurement_incomplete (latest matched:false) | [MIXED_OR_UNATTRIBUTED_USAGE] |
    | bound but never usage-imported (no bucket) | [MIXED_OR_UNATTRIBUTED_USAGE] |

Scenario: one non-exact session among several spoils the entry
  Given an entry with two sessions
  And   the first is exactly_attributed
  And   the second is orphan_usage
  When  the reasons are derived
  Then  the reasons are [MIXED_OR_UNATTRIBUTED_USAGE]
  And   the detail names the second session, not the first

Scenario: both kinds of failure are recorded, not just the first
  Given a 0.1.x payload (no accounting_basis) with missing_dedup_identity_rows = 3
  And   one of its sessions is unbound
  When  the entry is written
  Then  knn_ineligibility_reasons is exactly
        [TOKEN_BASIS_MISMATCH, MIXED_OR_UNATTRIBUTED_USAGE], in that order
  And   knn_ineligibility_detail has one entry per failing condition, so the dedup failure and
        the attribution failure are separately readable
  And   the order is the same when the two conditions are detected in the opposite sequence

Scenario: the pre-existing conditions still stand on their own
  Given a payload on the current basis whose sessions are all exactly_attributed
  And   <condition>
  When  the observation is built
  Then  knn_ineligibility_reasons is empty
  And   eligible_for_knn is false

  Examples:
    | condition                            |
    | the measurement has unpriced_tokens > 0 |
    | no session matched (anyMatched false)   |

Scenario: a 0.1.x measurement records an explicit unknown basis
  Given agent-cost 0.1.x (a payload with neither producer_version nor accounting_basis)
  When  lane usage-import writes the phase-scoped entry
  Then  the entry's accounting_basis is the string "unknown", present as a key
  And   the entry's producer_version is null
  And   the entry's tokens and cost_usd are exactly what was measured
  And   knn_ineligibility_reasons is [TOKEN_BASIS_MISMATCH]

Scenario: the basis move excludes old observations exactly once
  Given a calibration store holding one observation with token_basis "agent-cost-raw-total/v1"
  And   one observation with token_basis "agent-cost-raw-total/v2" and no reasons
  When  the estimate/v2 decision is built
  Then  population.excluded_by_reason["TOKEN_BASIS_MISMATCH"] is 1
  And   the excluded_by_reason values sum to candidate_count minus eligible_count
  And   the v1 observation is not counted a second time under any other code

Scenario: two bindings outrank the per-pair fold
  Given a session bound to task_run A and task_run B
  And   the latest usage_imported event for (session, A) carries matched:true
  And   the latest usage_imported event for (session, B) carries matched:false
  When  the session's attribution state is derived
  Then  the state is mixed
  And   the per-pair matched values were not consulted to reach that state

Scenario: a re-measurement restores exact attribution
  Given a (session, task_run) pair whose earlier usage_imported event carried matched:false
  And   a later usage_imported event for the same pair carries matched:true
  When  the reasons are derived
  Then  the reasons are []
  And   this test fails against a derivation that folds "any unmatched event in the window"

Scenario Outline: the latest projection is fully determined
  Given the events <events> for one (task_run, session) pair
  When  the latest event for that pair is resolved
  Then  it is <winner>

  Examples:
    | events                                                        | winner                   |
    | the same event_id appended twice                              | that one event, counted once |
    | two events, occurred_at T and T+1s                            | the T+1s event           |
    | two events with the identical occurred_at                     | the later ledger line    |
    | an event plus one whose supersedes_event_id names it          | the superseding event    |

Scenario: the audit's token arithmetic is untouched by the projection
  Given a trace ledger with several usage_imported events for one pair
  When  lane attribution audit runs
  Then  tokens.total_measured is the sum over every in-window event, as before this change
  And   only the measurement_incomplete classification reflects the latest projection

Scenario: eligibility does not depend on when the command runs
  Given a fixed trace ledger containing a usage_imported event written at instant T
  When  the reasons are derived with the wall clock at T, at T+1ms, and at T+1 day
  Then  the reasons are identical in all three cases

Scenario: a session first measured in this very run is classified on this run's evidence
  Given a task_run whose session has a session_bound event but no usage_imported event yet
  When  lane usage-import runs once
  Then  the projection used for eligibility sees this run's usage_imported event
  And   the written entry's knn_ineligibility_reasons is []

Scenario: a refused re-measurement touches nothing at all
  Given a cost_ledger entry written before this change, with no accounting_basis key
  And   agent-cost now returns "agent-cost-raw-total/v2" at the same pricing_version
  When  lane usage-import runs without --supersede-basis
  Then  the exit code is non-zero
  And   stderr names "unknown" and "agent-cost-raw-total/v2", and both producer_versions
  And   the trace ledger, lane-state.json and the overlay file are each byte-identical
  And   this test fails against the pre-change code

Scenario: one conflicting phase refuses the whole run
  Given two phases to import, of which only the second conflicts on basis
  When  lane usage-import runs without --supersede-basis
  Then  no entry is written for either phase
  And   no usage_imported event is appended for either phase

Scenario: --supersede-basis keeps the old basis visible
  Given the same conflict against a pre-change entry with no accounting_basis key
  When  lane usage-import runs with --supersede-basis
  Then  the entry keeps its original ledger_entry_id
  And   basis_history's last element records accounting_basis "unknown" and producer_version null,
        with the replaced entry's tokens, cost_usd, cost_credits and recorded_at
  And   any basis_history element written by an earlier supersession is still present

Scenario: same-basis re-import stays a plain idempotent upsert
  Given a cost_ledger entry written under accounting_basis "agent-cost-raw-total/v2"
  When  lane usage-import runs again with the same basis
  Then  the entry is upserted in place
  And   basis_history is unchanged (absent if it was absent)

Scenario: recovery reaches the population only after calibrate
  Given an entry and an observation both recorded while a session was unbound
  When  the session is bound and lane usage-import is re-run
  Then  the ledger entry's reasons are []
  And   the observation is unchanged, so the k-NN population is unchanged
  When  lane calibrate is re-run with the same session ids and window
  Then  the same record_id is upserted, not duplicated
  And   the observation's reasons are [] and it re-enters the population

Scenario: an absent reasons key is not read as eligible
  Given a cost_ledger entry written before this change, with no knn_ineligibility_reasons key
  When  eligibility is inspected
  Then  the entry is reported as not-yet-evaluated
  And   it is not counted as having zero reasons

Scenario Outline: a hostile boundary value is rejected
  Given a measure/v1 payload whose <field> is 300 characters long, or contains "\n"
  When  the telemetry adapter validates it
  Then  the call fails with TelemetryImportFailed
  And   nothing is written to lane-state.json

  Examples:
    | field            |
    | producer_version |
    | accounting_basis |

Scenario: an ineligible observation is visible in the estimate/v2 decision  # SCOPE-4
  Given a calibration population containing one observation on the current basis with
        knn_ineligibility_reasons = [MIXED_OR_UNATTRIBUTED_USAGE]
  When  lane estimate builds the estimate/v2 decision
  Then  population.excluded_by_reason["MIXED_OR_UNATTRIBUTED_USAGE"] counts it
  And   if the decision abstains, decision.reason_codes names that code
  And   the decision document's field set is unchanged from the current contract

Scenario Outline: a prediction is scored only within one basis
  Given an adopted baseline revision whose token_basis is <baseline>
  And   a new observation whose token_basis is <observed>
  When  lane calibrate records the prediction_evaluation
  Then  error.tokens.relative_error_p50 is <result>

  Examples:
    | baseline                  | observed                  | result                                  |
    | "agent-cost-raw-total/v1" | "agent-cost-raw-total/v2" | null with reason "token_basis_mismatch" |
    | "unknown"                 | "agent-cost-raw-total/v2" | null with reason "token_basis_mismatch" |
    | "agent-cost-raw-total/v2" | "agent-cost-raw-total/v2" | the same number as before this change   |

Scenario: a refused run keeps its measurement failure unrecorded, and says so
  Given two phases to import
  And   agent-cost measure fails for the first phase
  And   the second phase conflicts on accounting_basis without --supersede-basis
  When  lane usage-import runs
  Then  the exit code is non-zero
  And   the trace ledger, lane-state.json and the overlay file are each byte-identical
  And   no matched:false event exists for the first phase's sessions
  And   stderr names the conflict's two bases and two producer_versions
  And   stderr also lists the first phase as one whose measurement failed in this run
  And   the audit still reports those sessions as never usage-imported, not as zero tokens

Scenario: a basis supersession leaves the KPI ledger coherent
  Given a phase-scoped entry included_in_kpi true under one accounting basis
  When  the entry is superseded with --supersede-basis under the current basis
  Then  included_in_kpi is re-derived over the whole ledger as it is for any other upsert
  And   exactly one entry for that ledger_entry_id contributes to the KPI totals

Scenario: detail strings are exactly the specified templates
  Given a payload whose producer_version is "0.2.0-weird/../text"
  And   a session that is orphan_usage
  When  the detail strings are built
  Then  each string equals one template from "Detail string templates" with its placeholders filled
  And   producer_version does not appear in any of them
  And   the array order is reason-code order, then template order, then session_id

Scenario Outline: a reference-table revision declares no basis it cannot know
  Given the four --reference-* values are given <flag>
  When  lane estimate writes the revision
  Then  the revision's token_basis is <basis>

  Examples:
    | flag                                                  | basis                     |
    | without --reference-token-basis                       | "unknown"                 |
    | with --reference-token-basis agent-cost-raw-total/v2  | "agent-cost-raw-total/v2" |

Scenario: an undeclared reference baseline is never scored
  Given an adopted reference-table baseline whose token_basis is "unknown"
  When  lane calibrate records an observation on the current basis
  Then  error.tokens is {relative_error_p50: null, covered_by_p80: null,
        reason: "token_basis_mismatch"}
  And   error.cost_usd has the same shape

Scenario: the new binary reads every record written before this lane
  Given a calibration store and a lane-state.json produced by spec-lane 0.9.1
  When  the new binary reads them
  Then  every record parses
  And   the regenerated JSON Schemas accept them under ajv as well as zod

Scenario: a legacy-migrated observation is labelled, not silently excluded
  When  the legacy-ledger migration writes an observation
  Then  its token_basis is "unknown"
  And   knn_ineligibility_reasons is [TOKEN_BASIS_MISMATCH] with template T-11's detail
  And   eligible_for_knn is false
  And   its salvaged tokens and cost_usd are unchanged

Scenario Outline: the evidence export says whether its total spans one basis
  Given a ledger whose summed entries carry the bases <bases>
  When  lane evidence export runs
  Then  ledger_summary.accounting_bases is <set>, de-duplicated and lexicographically ascending
  And   ledger_summary.accounting_basis_status is <status>

  Examples:
    | bases                                   | set                                        | status        |
    | only "agent-cost-raw-total/v2"          | ["agent-cost-raw-total/v2"]                | "single"      |
    | "unknown" and "agent-cost-raw-total/v2" | ["agent-cost-raw-total/v2", "unknown"]     | "unqualified" |
    | no summed entries at all                | []                                         | "unqualified" |

Scenario: adoption and lane next are unchanged by the basis move
  Given every observation on disk predates the basis move, so the eligible population is empty
  When  lane estimate runs and lane estimate --adopt adopts the revision
  Then  the revision's population_condition.method is "reference_table" with experimental true
  And   the adoption succeeds, as it does today
  And   lane next reads that predicted value with no new gate
```

## Dependency and path cross-check

### DEP — what this change introduces

| ID | What |
|---|---|
| DEP-01 | Optional `producer_version` / `accounting_basis` / three `data_quality` counters on `AgentCostMeasureResultSchema`, with RULE-28's bounds (`schemas/src/agent-cost.ts`). |
| DEP-02 | `CURRENT_ACCOUNTING_BASIS`, an alias of the single v2 literal (same file). |
| DEP-03 | Five optional cost_ledger entry fields — `accounting_basis`, `producer_version`, `knn_ineligibility_reasons`, `knn_ineligibility_detail`, `basis_history` — plus the read-time normalizer (`schemas/src/lane-state.ts`, **SCOPE-1**). |
| DEP-04 | `deriveKnnIneligibility()` — the single predicate, returning codes and detail strings (`core/application/calibrate-service.ts`). |
| DEP-05 | The `(task_run, session)`-latest projection (D14), window-optional, exported from `core/attribution.ts` and consumed by both the audit's classification and the eligibility path. |
| DEP-06 | `planBasisSupersession()` in `core/ledger.ts`, the preflight ordering of D8, and the `--supersede-basis` flag (**SCOPE-3** for wiring). |
| DEP-07 | Reasons, detail and `accounting_basis` on `CalibrationObservationSchema` (`schemas/src/calibration.ts`). |
| DEP-08 | estimate/v2 surfacing of the recorded codes in `excluded_by_reason` / `reason_codes`, shape unchanged (`core/estimator-v2.ts`, **SCOPE-4**). |
| DEP-09 | The atomic token-basis move to v2 (`schemas/src/token-basis.ts` **SCOPE-5**, `core/estimator.ts` **SCOPE-6**, `core/application/estimate-service.ts` **SCOPE-7**, plus `estimator-v2.ts:72`). |
| DEP-10 | Basis-aware prediction scoring: the `token_basis_mismatch` reason value on `calibration.ts:80`'s enum, `covered_by_p80` becoming nullable, and the guard in `evaluatePrediction` (D22/D25). |
| DEP-11 | The reference-table revision's `"unknown"` basis and the `--reference-token-basis` flag (`cli/commands/estimate.ts` **SCOPE-9**, `estimate-service.ts` **SCOPE-7**, `main.ts` **SCOPE-3**). |
| DEP-12 | Regenerated JSON Schemas under `packages/schemas/generated/**` (**SCOPE-10**) and the differential fixtures that cover the new shapes (D26). |
| DEP-13 | Basis labelling on the legacy-migration writer (**SCOPE-11**) and on the evidence export summary (`lane-evidence.ts` **SCOPE-12**, `evidence-export-service.ts` **SCOPE-13**). |

### PATH — existing code that handles the same payload, events or entries

`ref` = must reference the DEP; `no` = deliberately does not; `unk` = not decidable by reading the
code alone. Every `no` and `unk` cell is promoted to a TEST.

| ID | Path | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | TESTs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PATH-01 | `adapters/src/telemetry/agent-cost.ts` `measure()` | ref | no | no | no | no | no | no | no | no | TEST-04, 05, 41, 57 |
| PATH-02 | `cli/src/commands/usage-import.ts` | ref | ref | ref | ref | ref | ref | no | no | no | TEST-16..19, 21, 48, 49 |
| PATH-03 | `core/application/usage-import-service.ts` (**SCOPE-2**) | ref | ref | ref | ref | ref | no | no | no | no | TEST-16, 17 |
| PATH-04 | `cli/src/commands/calibrate.ts` | ref | ref | ref | ref | ref | ref | ref | no | ref | TEST-19b, 28, 52 |
| PATH-05 | `core/application/calibrate-service.ts` | ref | ref | ref | ref | ref | no | ref | no | ref | TEST-06..15, 28, 45, 53, 55, 56 |
| PATH-06 | `core/ledger.ts` (`computeLedgerEntryId`, `upsertLedgerEntry`, `isSuperseded`, `deriveIncludedInKpi`) | no | no | unk | no | no | ref | no | no | no | TEST-19, 20, 22, 23, 54 |
| PATH-07 | `core/done-overlay.ts` (`upsertOverlayLedgerEntry`, `effectiveLedger`) | no | no | unk | no | no | no | no | no | no | TEST-20b |
| PATH-08 | `core/estimator.ts` population filter (**SCOPE-6**) | no | no | no | no | no | no | ref | no | ref | TEST-25, 26, 45, 59 |
| PATH-09 | `core/estimator-v2.ts` `classifyCandidateExclusion` / `tallyExclusions` / cohort (**SCOPE-4**) | no | no | no | no | no | no | ref | ref | ref | TEST-24, 27, 45 |
| PATH-10 | `core/application/metrics-service.ts` (emit-metrics) | no | no | no | no | no | no | no | no | no | TEST-29 |
| PATH-11 | `core/application/evidence-export-service.ts` `summarizeLedger` | no | no | no | no | no | no | no | no | no | TEST-30, 58 |
| PATH-12 | `cli/src/commands/next.ts` + `core/ports/budget.ts` | no | no | no | no | no | no | no | no | no | TEST-31, 59 |
| PATH-13 | `core/attribution.ts` (`buildAttributionAuditResult`, `deriveBindingRecordsFromTrace`, `sumUsageBySession`) | no | no | no | ref | ref | no | no | no | no | TEST-13, 18, 32, 35, 36, 38, 43, 44, 51 |
| PATH-14 | `schemas/src/lane-state.ts` v1→v2→v3 migration | no | no | unk | no | no | no | no | no | no | TEST-23, 54 |
| PATH-15 | `core/migrate-legacy-ledger.ts` | no | no | no | no | no | no | unk | no | no | TEST-25 |
| PATH-16 | `adapters/src/budget/codex-budget.ts` | no | no | no | no | no | no | no | no | no | TEST-33 |
| PATH-17 | `cli/src/main.ts` command wiring (**SCOPE-3**) | no | no | no | no | no | ref | no | no | no | TEST-34 |
| PATH-18 | `core/trace.ts` (`computeTraceEventBaseIdentity`, `computeTraceEventId`, `readTraceEvents`) | no | no | no | no | ref | no | no | no | no | TEST-50, 51 |
| PATH-19 | `core/application/estimate-service.ts` adopt chain (**SCOPE-7**) + `AbstainedRevisionCannotBeBaselineError` | no | no | no | no | no | no | no | no | ref | TEST-59 |

**DEP-10's own cross-check** (kept as a sub-table rather than a tenth column, because only two
paths can reach a `prediction_evaluation` record at all):

| ID | Path | DEP-10 | TESTs |
|---|---|---|---|
| PATH-05 | `core/application/calibrate-service.ts` `evaluatePrediction` | ref | TEST-60, 61 |
| PATH-20 | `cli/src/commands/calibrate.ts:228-231`, the sole caller, plus `calibration-store.ts`'s record write | ref | TEST-60, 61 |

Every other PATH is `no` for DEP-10: `evaluatePrediction` has exactly one caller and no other code
in `packages/*/src` reads or writes a `prediction_evaluation` record. TEST-61 is the regression
that pins same-basis scoring as byte-equal to today's.

**DEP-11..13's own cross-check** (same reason — each reaches a small, disjoint set of paths):

| ID | Path | DEP | TESTs |
|---|---|---|---|
| PATH-21 | `cli/src/commands/estimate.ts:154-182` (the reference-table branch) + `main.ts` flag wiring | DEP-11 ref | TEST-65 |
| PATH-19 | `core/application/estimate-service.ts:202-241` (both revision write sites) | DEP-11 ref, DEP-09 ref | TEST-59, 65 |
| PATH-22 | `packages/schemas/generated/**` + `packages/schemas/test/differential.test.ts:55-84` (ajv/zod agreement and the "generate:json-schema is up to date" check) | DEP-12 ref | TEST-66, 67 |
| PATH-15 | `core/migrate-legacy-ledger.ts:160-187` | DEP-13 ref (was `unk` for DEP-07 in revision 2 — now a writer this lane owns) | TEST-25, 68 |
| PATH-11 | `core/application/evidence-export-service.ts:75-91` + `schemas/src/lane-evidence.ts:62-70` | DEP-13 ref (was `no` in revision 2) | TEST-30, 69 |
| PATH-23 | `cli/src/calibration-store.ts:31-42` (parses every record in the store with one schema) | DEP-10 ref, DEP-12 ref | TEST-66 |

No other path reads `packages/schemas/generated/**` at runtime — it is a build artefact consumed by
the differential suite and by publish, per design.md §6 — and no other code writes a
`CalibrationObservation` besides `calibrate-service.ts` and the legacy migration
(grep: `CalibrationObservationSchema.parse` has exactly those two call sites).

Notes on the three `unk` cells:

- **PATH-06 × DEP-03**: `upsertLedgerEntry` replaces the whole entry object, so a superseding write
  drops the previous `basis_history` unless the caller merges it forward (TEST-20); TEST-23 pins
  that an entry without the new fields round-trips unchanged.
- **PATH-07 × DEP-03**: `effectiveLedger` composes in-repo entries with the overlay's `ledger_delta`
  and re-derives `included_in_kpi`; the architect confirmed by reading `done-overlay.ts:222-234`
  that spread plus schema parse preserves new optional fields, but no fixture exercises it —
  TEST-20b does.
- **PATH-15 × DEP-07**: a legacy-migrated observation carries `eligible_for_knn: true` and no
  `token_basis`; after DEP-09 it is still excluded by the basis comparison. TEST-25 pins it.

**Blind-spot disclaimer.** This table does not see (i) how the predicate and the latest projection
hold their own state — the reasons array's ordering and the D14 fold have no column here, (ii) the
real shape of an agent-cost 0.2.0 payload, which is no longer a blind spot as of 2026-09-11
(`fixtures/measure-0.2.0-real-8b283624.json` is a captured payload and every field-location claim
is checked against it), (iii) whether the premise and success criteria were genuinely confirmed,
handled by `premise_evidence` and Phase 3's `success_criteria_matrix`.

## Tests

**Inventory.** Every TEST-ID has exactly one row below — there is no compressed range row and no
ID defined only in prose. The set is `TEST-01` … `TEST-71` with no gaps, plus `TEST-19b` and
`TEST-20b`, which hang off their parents deliberately (the same scenario on the `calibrate` path
and on the post-done overlay path). Counting rows in this table is therefore the authoritative
count; no other section of this document or of `critic.yaml` states a total.

| ID | Level | What it pins |
|---|---|---|
| TEST-01 | unit (schemas) | A 0.2.0 payload parses and the five new values are present on the parsed result (not stripped). |
| TEST-02 | unit (schemas) | A 0.1.x payload with none of the new fields still validates; the values read back as `undefined`. |
| TEST-03 | unit (schemas) | `source_quality.identity_missing` survives parsing; the predicate's defensive read is exercised by TEST-46/47. |
| TEST-04 | integration (adapters) | A fake `agent-cost` emitting the captured 0.2.0 shape returns the new fields through `measure`. |
| TEST-05 | regression (adapters) | The personal-dimension scan still runs against the raw pre-Zod JSON and still rejects a forbidden key. |
| TEST-06 | unit (core) | Current basis, clean counters, exactly-attributed sessions: the reasons are `[]`. |
| TEST-07 | unit (core) | `accounting_basis` absent: `[TOKEN_BASIS_MISMATCH]`. |
| TEST-08 | unit (core) | `accounting_basis` present but not the current one: `[TOKEN_BASIS_MISMATCH]`. |
| TEST-09 | unit (core) | `conflicting_duplicate_groups` > 0: `[MIXED_OR_UNATTRIBUTED_USAGE]`. |
| TEST-10 | unit (core) | `missing_dedup_identity_rows` > 0: `[MIXED_OR_UNATTRIBUTED_USAGE]`. |
| TEST-11 | unit (core) | `source_quality.identity_missing` > 0: `[MIXED_OR_UNATTRIBUTED_USAGE]`. |
| TEST-12 | unit (core) | `duplicate_rows_skipped` at any value, and absent, produces no reason. |
| TEST-13 | unit (core) | The attribution Examples table, all six session states. |
| TEST-14 | unit (core) | Two independent failures produce both codes, de-duplicated, in `ESTIMATE_V2_REASON_CODES` order. |
| TEST-15 | unit (core) | Empty reasons + `unpriced_tokens > 0` still yields `eligible_for_knn: false`. |
| TEST-16 | integration (cli) | usage-import with a 0.1.x fixture: `accounting_basis: "unknown"` present as a key, `producer_version: null`, tokens unchanged, reasons `[TOKEN_BASIS_MISMATCH]`. |
| TEST-17 | integration (cli) | usage-import with the captured 0.2.0 fixture and an exactly-attributed session: reasons `[]`, both new values persisted. |
| TEST-18 | integration (cli) | A session bound and measured in the same run is exactly attributed (fails if the projection is derived before the trace append). |
| TEST-19 | integration (cli) | Basis conflict without the flag: non-zero exit, both normalized bases and both producer_versions in stderr, all three files byte-identical. **Must fail against pre-change code.** |
| TEST-19b | integration (cli) | The same refusal in `calibrate` happens before `writeCalibrationRecord`. |
| TEST-20 | integration (cli) | `--supersede-basis`: same `ledger_entry_id`, `basis_history` appended, earlier elements preserved. |
| TEST-20b | integration (cli) | The same two paths post-done (overlay `ledger_delta`), including that `effectiveLedger` preserves the new fields. |
| TEST-21 | integration (cli) | Same-basis re-import: plain upsert, `basis_history` unchanged/absent. |
| TEST-22 | regression (core) | `computeLedgerEntryId` parity vector unchanged; the existing differential test stays green. |
| TEST-23 | unit (schemas) | A `schema_version: "2.0"` lane-state migrates to 3.0 without inventing the new fields, and a 3.0 entry lacking them round-trips byte-identically. |
| TEST-24 | unit (core) | estimate/v2 counts a recorded reason under `excluded_by_reason` and names it in `reason_codes` when abstaining, with the decision's field set unchanged. *(SCOPE-4)* |
| TEST-25 | regression (core) | A legacy-migrated observation (no `token_basis`) is still excluded after the basis move. |
| TEST-26 | regression (core) | `estimator.ts`'s `usable` filter still drops observations whose `eligible_for_knn` is false. |
| TEST-27 | regression (core) | `population` accounting still satisfies `EstimateV2DecisionSchema`'s sum invariant after DEP-08/09. |
| TEST-28 | integration (cli) | calibrate persists reasons, detail and `accounting_basis` on both the observation and the lane-scoped entry, from the one predicate. |
| TEST-29 | regression (core) | emit-metrics is unchanged, **including that it still sums KPI-eligible entries across mixed bases. This test fixes a known gap in place; it does not demonstrate that the behaviour is safe.** |
| TEST-30 | regression (core) | `summarizeLedger` totals are unchanged for a mixed-basis ledger (the same known gap). |
| TEST-31 | regression (cli) | `lane next` and `ResourceSnapshot.quality` are untouched. |
| TEST-32 | unit (core) | `lane attribution audit`'s window stays half-open — regression — and the eligibility path, being window-free, is unaffected by an event on the boundary. |
| TEST-33 | regression (adapters) | `AgentCostReportResultSchema` (codex-budget) is untouched and its tests stay green. |
| TEST-34 | e2e (cli) | `--supersede-basis` appears in both commands' help and reaches the command. |
| TEST-35 | unit (core) | Recovery: an earlier `matched:false` then a later `matched:true` for the same pair yields `[]`. **Must fail against an any-unmatched-in-window derivation.** |
| TEST-36 | unit (core) | Window independence: identical reasons at three different wall-clock instants. |
| TEST-37 | integration (cli) | A phase entry unioning two task_runs' sessions, each exactly attributed, yields `[]`. |
| TEST-38 | regression (core) | The audit's `measurement_incomplete` bucket no longer holds a session whose latest event for a pair is `matched:true`. |
| TEST-39 | integration (cli) | Snapshot semantics: binding a session after the entry was written does not change the stored reasons; a re-run does. |
| TEST-40 | unit (core) | RULE-13's negation: an entry with no reasons key reports not-yet-evaluated, never "zero reasons". |
| TEST-41 | unit (adapters) | `producer_version` over 256 chars or containing a control character is rejected; a normal and an absent value pass. |
| TEST-42 | integration (cli) | One invocation derives the projection once, asserted by counting trace-ledger reads. |
| TEST-43 | unit (core) | Two bindings with disagreeing per-pair states classify as `mixed`. **Must fail against a fold-first implementation.** |
| TEST-44 | regression (core) | Whole-output regression: on a ledger with no recovery in it, the audit-result JSON is byte-identical before and after D14. |
| TEST-45 | unit (core) | The basis move: a v1 observation is excluded once under `TOKEN_BASIS_MISMATCH`, a v2 observation with empty reasons is eligible, and no candidate is counted twice. |
| TEST-46 | unit (core) | RULE-07 negation: a current-basis payload with a counter **absent** yields `MIXED_OR_UNATTRIBUTED_USAGE`. |
| TEST-47 | unit (core) | RULE-07 negation: negative, fractional and non-finite counter values each yield `MIXED_OR_UNATTRIBUTED_USAGE`. |
| TEST-48 | integration (cli) | A refused run appends no `usage_imported` event: the trace ledger file is byte-identical. **Must fail against a trace-append-before-preflight implementation.** |
| TEST-49 | integration (cli) | Two phases, one conflicting: nothing is written for either phase (RULE-33). |
| TEST-50 | unit (core) | The latest projection's four rules: duplicate `event_id`, `occurred_at` ordering, identical-timestamp tie-break by ledger order, and `supersedes_event_id` outranking both. |
| TEST-51 | regression (core) | `tokens.total_measured` still sums every in-window event under the new projection (RULE-34). |
| TEST-52 | integration (cli) | Recovery end-to-end: usage-import alone refreshes only the entry; calibrate with the same record identity is what returns the observation to the population. |
| TEST-53 | unit (core) | Two distinct MIXED conditions produce one code but two `knn_ineligibility_detail` entries, each naming its own condition. |
| TEST-54 | integration (cli) | A genuine pre-change entry (no `accounting_basis` key at all) is refused with `"unknown"` named, and under `--supersede-basis` its `basis_history` element records `"unknown"`/`null`. |
| TEST-55 | unit (core) | S2's "any session": one exactly-attributed plus one non-exact session yields `MIXED_OR_UNATTRIBUTED_USAGE`. |
| TEST-56 | unit (core) | `anyMatched === false` with empty reasons yields `eligible_for_knn: false`. |
| TEST-57 | unit (adapters) | RULE-28 applied to `accounting_basis`: over-long or control-character values are rejected. |
| TEST-58 | unit (schemas) | The evidence-export ledger summary is labelled a basis-unqualified summary in the schema's own description (RULE-35). |
| TEST-59 | integration (cli) | With an empty eligible population, the reference-table revision keeps `experimental: true`, stays adoptable, and `lane next` reads it with no new gate (RULE-36). |
| TEST-60 | unit (core) | Cross-basis scoring: a v1 (and an `"unknown"`) baseline against a v2 observation yields `relative_error_p50: null` with `reason: "token_basis_mismatch"` for both metrics. **Must fail against pre-change code, which returns a number.** |
| TEST-61 | unit (core) | Same-basis scoring is unchanged: the identical inputs produce the identical evaluation record as before this lane. |
| TEST-62 | integration (cli) | One phase's measure fails while another conflicts on basis: exit non-zero, all three files byte-identical, no `matched:false` event written, and stderr lists both the conflict's two bases/producer_versions and the failed phase (RULE-38). |
| TEST-63 | integration (cli) | The KPI side of a basis supersession: `included_in_kpi` is re-derived over the whole ledger and exactly one entry per `ledger_entry_id` contributes to the totals. |
| TEST-64 | unit (core) | Every detail string **equals** a template from "Detail string templates" with its placeholders filled; `producer_version` never appears; the array order is reason-code order, then template order, then `session_id` (RULE-39). |
| TEST-65 | integration (cli) | A reference-table revision records `token_basis: "unknown"` without the new flag and the declared basis with it; an `"unknown"` baseline is then never scored (RULE-40). **Must fail against pre-change code, which stamps the basis unconditionally.** |
| TEST-66 | differential (schemas) | The regenerated `calibration.schema.json` and `lane-state.schema.json` accept a new-shape record under both zod and ajv, **and** every pre-change valid fixture still passes both — the backward-read half of RULE-41. |
| TEST-67 | regression (schemas) | The existing "generate:json-schema is up to date" check stays green, i.e. the committed schemas were actually regenerated (SCOPE-10). |
| TEST-68 | unit (core) | A legacy-migrated observation carries `"unknown"`, `[TOKEN_BASIS_MISMATCH]`, template T-11's detail and `eligible_for_knn: false`, with salvaged numbers unchanged (RULE-42). |
| TEST-69 | integration (cli) | `lane evidence export` emits `accounting_bases` (de-duplicated, lexicographically ascending) and `accounting_basis_status`: `"single"` for a one-basis ledger, `"unqualified"` for a mixed one, and `[]` with `"unqualified"` when there are no summed entries at all (RULE-35). |
| TEST-70 | unit (core) | A fixed hash vector for `computeLedgerEntryId` over the four identity arguments, asserted **without** the private Python reference, so identity parity is pinned even where `ledger.differential.test.ts` skips (`python-harness.ts:35-72`). |
| TEST-71 | unit (core) | An observation with **no** `knn_ineligibility_reasons` key is excluded from the estimate/v2 population and counted under `excluded_by_reason["MIXED_OR_UNATTRIBUTED_USAGE"]`, not admitted (RULE-13). **Must fail against an implementation that reads absent as `[]`.** |

## intent success ↔ RULE / TEST

| # | intent success line (abbreviated) | RULEs | TESTs |
|---|---|---|---|
| S1 | 0.2.0 payload accepted, both values persisted; 0.1.x persists `"unknown"` explicitly | RULE-01..04, 12, 28, 32 | TEST-01, 02, 04, 16, 17, 28, 41, 57 |
| S2 | `eligible_for_knn` false + reason code for basis mismatch, dedup flags, non-exact attribution; matched-and-priced still applies | RULE-05..14, 23, 24, 26, 27, 29..31, 34 | TEST-06..15, 16, 17, 28, 35..40, 43, 45..47, 50, 51, 53, 55, 56, 71 |
| S3 | Re-measurement under a different basis never silently overwrites; identity unchanged; superseding entry or refusal; test fails against pre-change code | RULE-15..19, 25, 33, 38 | TEST-19, 19b, 20, 20b, 21, 22, 48, 49, 54, 62, 63 |
| S4 (narrowed) | Every reason visible in the entry/observation as code plus detail, and in the estimate/v2 abstain output as a code | RULE-12, 20, 39, 42 | TEST-16, 17, 24, 27, 53, 64, 68 |
| S5 | Existing suites green, old fixtures still validate, no new required field | RULE-02, 22, 35, 36, 37, 40, 41 | TEST-02, 05, 22, 25, 26, 29..33, 38, 44, 51, 58, 59, 61, 65..70 |

S4 is the narrowed criterion (`intent.yaml:42-46`, updated 2026-09-14) and `estimator-v2.ts` is
approved, so RULE-20 and TEST-24 stand as written; the earlier fallback of dropping them no longer
applies.

## Falsification conditions

**F1 and F2 were checked and cleared on 2026-09-11** against a real captured payload:
`fixtures/measure-0.2.0-real-8b283624.json` (agent-cost 0.2.0 at origin/main `2972f27`, session
8b283624), captured by the team-lead. Confirmed there: `producer_version: "0.2.0"` and
`accounting_basis: "agent-cost-raw-total/v2"` at the **top level**, next to `protocol_version`;
`data_quality` carrying `duplicate_rows_skipped`, `conflicting_duplicate_groups` and
`missing_dedup_identity_rows`; `data_quality.source_quality` =
`{ok: 296, first_event_delta: 0, identity_missing: 0}`; `rates` =
`{catalog_version: "2026-09-09", sha256: "30b0f4a9…"}`; each `sessions[sid]` =
`{matched, rows, totals}`. This fixture is the reference shape for TEST-01/04/17.

- F1. **Cleared.** agent-cost 0.2.0 does not emit `accounting_basis` at the top level (nests it, or
  omits it for `measure`). Then RULE-03's source is wrong and every entry records `"unknown"`.
- F2. **Cleared.** `identity_missing` is not a key of `data_quality.source_quality`. Then RULE-07's
  third clause never fires. The captured payload has it there, beside `ok` and `first_event_delta`,
  so the existing `z.record(z.string(), z.number())` already carries it.
- F3. **Open until Phase 3.** Every session in the real trace ledger is already exactly attributed
  and no ledger entry has a dedup flag set, making RULE-07/09 unreachable in practice. The
  2026-09-10 audit (orphan_usage 10, measurement_incomplete 1, violations 11) says otherwise; re-run
  it at implementation time.
- F4. **Open until Phase 3.** The RULE-16 refusal fires on an ordinary same-basis re-import, making
  `lane usage-import` unusable. TEST-21 is the guard.
- F5. **Open until Phase 3.** After DEP-09 the eligible population is empty and stays empty because
  no new observation can ever satisfy the v2 comparison (e.g. a write site was missed). TEST-45
  covers the intended path; a live `lane calibrate` at Phase 3 confirms it end to end.

## Non-goals (restated from intent.yaml, plus two added here)

- Changing agent-cost itself, or re-measuring historical cost_ledger entries. 0.1.x entries stay as
  recorded and are corrected, if at all, by the ledger owner's correction rows.
- Changing `computeLedgerEntryId`'s Python-parity identity, or emit-metrics' existing fail-closed
  rules (`ambiguous_session_attribution` / `unknown_token_kind`).
- Adding a new binding limit. "Exactly one task" is enforced through the existing attribution/v1
  `exactly_attributed` predicate, not a new guard.
- **Versioning the estimate/v2 contract** (added 2026-09-11, D19). The failing-condition text lives
  on the entry and the observation; estimate/v2 keeps reporting codes only, with no field added and
  no version bump.
- **Gating `lane estimate --adopt` / `lane next`** (added 2026-09-11, D21). A reference-table
  prediction stays adoptable while estimate/v2 abstains; that number is a generic table already
  labelled `experimental`, not a stale-basis measurement, and no success line asks for a new gate.

## Known affected behavior (this lane's own additions)

intent.yaml records two consequences (0.1.x entries become KNN-ineligible; orphan-session entries
lose eligibility). Four more follow from the decisions above and must be folded back into
intent.yaml at Phase 3 via `cross_check_intent_vs_spec` direction ②:

1. **A lane measured only with `lane calibrate` is almost always ineligible.** calibrate writes no
   `usage_imported` trace event, so its sessions are bound-but-never-imported and therefore not
   exactly attributed (D7/D9). Accepted as honest: the fix is to run `lane usage-import`, not to
   weaken the predicate.
2. **`lane attribution audit`'s `measurement_incomplete` bucket shrinks** (D14), while its token
   totals are unchanged (D15). A deliberate change to a shipped command's output, pinned by
   TEST-38 and bounded by TEST-44/51.
3. **Every observation recorded before this lane leaves the k-NN population at once** (D3 revised).
   The v1 literal no longer matches the target basis, so estimate/v1 falls back to the reference
   table and estimate/v2 abstains `INSUFFICIENT_POPULATION` until new v2-basis observations
   accumulate. This is the intended honest consequence and the reason D3 was withdrawn: the
   alternative left those records silently in the population.
4. **`lane estimate --adopt` keeps succeeding on a reference-table revision** during that window
   (D21), so `lane next` keeps producing fits/not_fit from an `experimental` number. Unchanged
   behaviour, called out because the basis move makes it the common case rather than a cold-start
   edge case.

5. **`lane calibrate` stops printing a relative error when the bases differ** (D22). The first
   calibrate on any lane whose baseline predates the move reports
   `relative_error_p50: null, reason: "token_basis_mismatch"` instead of a number. The number it
   used to print was a comparison between incomparable bases, so this is a correction, but it is a
   visible output change for every existing lane.
6. **A refused run does not record its own measurement failures** (D23). If one phase's
   `agent-cost measure` fails and another phase refuses on a basis conflict, nothing is written,
   including that phase's `matched:false` events. The sessions stay "never usage-imported" in the
   audit rather than appearing as zero-token measurements, and the refusal's diagnostic names both
   the conflict and the failed phase so the operator can re-run.

7. **A pre-change binary can no longer read a new calibration store** (D26). Records carrying
   `reason: "token_basis_mismatch"` or `covered_by_p80: null` are rejected by the pre-change zod
   schema and by the previously committed JSON Schema, and `calibration-store.ts:31-42` parses
   every file with one schema, so a single new record stops an old binary. Reading in the other
   direction is asserted (TEST-66). spec-lane is a single-user CLI with no downgrade path, so this
   is declared rather than engineered around.
8. **A reference-table revision now records `"unknown"` instead of a basis** (D25), so an adopted
   reference baseline is never scored against a real measurement. Before this lane it recorded a
   basis it had no way to know.
9. **`lane evidence export`'s ledger summary gains two fields** (RULE-35). `lane-evidence:v1`'s
   summary object is `.strict()`, so a consumer pinned to the old shape sees new keys; the schema
   is spec-lane-owned with no external consumer yet (design.md §5.6), which is why this is additive
   rather than a new version.

None of the nine is a regression; each is the stated cost of the gate.

## Implementation tasks (Phase 3, beyond the code itself)

- Rewrite `token-basis.ts:8-12`'s comment: after RULE-30 there are two literals with different
  roles — v2 written and compared, v1 read-only for records already on disk — which is the
  opposite of what that comment currently tells a reader. Likewise `calibrate-service.ts:97-107`
  (eligibility now has four more conditions plus D22's guard) and `attribution.ts:173-185` (the
  D14/D15 split).
- Update `docs/design.md` §5.6 on two points: the audit's classification under D14/D15, and the
  never-zero-fill rule's new **deferred case** — a refused run records no `matched:false` events at
  all (D23), so §5.6's "0埋めしない" paragraph must say that the honest record is deferred to the
  operator's re-run rather than written during a refusal. Also update the §5.1 supplement for the
  abstain layer's new population reality.
- Regenerate `packages/schemas/generated/**` (SCOPE-10) in the same commit as the zod change; the
  differential suite fails otherwise (TEST-67).
- Add the `CHANGELOG.md` entry and bump the version to **0.10.0** across the five `package.json`
  files carrying `0.9.1` (SCOPE-8). Minor, not patch: the basis move changes estimation output for
  every existing lane.
- Suggested landing order inside the diff, to keep the blast radius legible: the pure attribution
  projection and the predicate first, then the entry/observation fields and the preflight, then
  the basis literal last, with TEST-45 and TEST-59 as the boundary between the gate half and the
  migration half.

## Limits and open questions

Seven questions raised while drafting or by the architect review were decided by the operator on
2026-09-11 and are now decisions: the token-basis move (D3 revised, sol must-1), zero-only-clean
counters (RULE-07, must-2), preflight-before-trace (D8/D11, must-3), the latest projection's
definition and its isolation from token arithmetic (D14/D15, must-4), the two-command recovery
(D17, must-5), S4's narrowing (D19, must-6), and read-time normalization (D20, must-7). The second
critic pass raised three more, all decided the same day: cross-basis scoring (D22), the refused
run's measurement failures (D23) and the detail strings' composition (D24). The architect's second
round added four, likewise decided: the reference-table revision's basis (D25), the schema-evolution
policy (D26), the enumerated detail templates (D27) and the legacy-migration writer (D28). The
reasons array's order (RULE-10) and the adopt/next ruling (D21) were decided by the spec author and
approved. What remains:

**No open questions remain.** The last three closed on 2026-09-14: OQ-4 (the scope extension and
the S4 narrowing were approved and `intent.yaml` carries both), OQ-6
(`publish/spec-lane/package.json` was added to `allowed_paths`, so all five version-bump targets
are covered) and OQ-7 (the human-review band's cross-check table, TEST-ID mappings and axis choice
were item ③ of the same four-item approval). What is left is the limits, which are properties of
the design rather than questions:
- **L1.** Refusal is side-effect-free across all three files (D11/D23), at two costs: every phase
  is measured before anything is written, so a conflict found in the last phase has still spent
  every `agent-cost measure` call of the run; and a measurement failure in the same run goes
  unrecorded until the operator re-runs (D23, Known affected behavior 6).
- **L2.** The attribution derivation inside the write path costs a full read of the trace ledger
  per command; it is shared with the end-of-run audit (TEST-42) and grows linearly with an
  append-only file. `calibrate` gains a trace read it does not have today.
- **L3.** Reasons are a write-time snapshot (D18) while the classification rule is recovery-capable
  (D14). Recovery is real but not retroactive, and it takes two commands (D17). Nothing signals
  that a stored reason has gone stale.
- **L4.** `knn_ineligibility_detail` is free text. It is written for a human reading the ledger, is
  never parsed, and must not become a de-facto machine contract; the codes are the machine surface.
