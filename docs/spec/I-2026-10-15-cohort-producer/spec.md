# I-2026-10-15-cohort-producer — calibrate records the estimate/v2 cohort (issue #58, option B)

**Human-review band: applicable.** This change introduces a new guard (cohort identity derivation
with an explicit ineligibility branch) and a new dependency (calibrate reads the profile). The
cross-check table in §4 and its TEST-IDs need the user's explicit approval before Phase 3. The
S2 decision this spec implements was approved on 2026-10-15 (tasks.md: split rule = mixed
ineligible, no backfill, worker-only attribution scope) after the architect review recorded in
~/ai_bus/codex_a_review.md 10/15.

## 0. Context and premise

- `estimate/v2` excludes every observation without `cohort` as `MODEL_GENERATION_MISMATCH`
  (`packages/core/src/estimator-v2.ts` `classifyCandidateExclusion`). Nothing writes `cohort`:
  `buildObservationFromMeasurement` (`packages/core/src/application/calibrate-service.ts`) never
  sets it and `lane calibrate` (`packages/cli/src/commands/calibrate.ts`) never loads a profile.
- Real data 2026-10-15 (`~/.local/share/lane/calibration`): 13 observations pass every check
  except the cohort (12 as of the S2 material; `I-2026-10-13-g4b3b-correct-preflight` landed
  2026-10-14T18:45Z, reported by the 01-dd session); all are single-model (Sonnet 5.5, 100% of
  tokens, headless worker sessions only; unbound Opus headless sessions of correct-preflight are
  outside the measured scope by D-S2c). Start condition (1) of #58 is met; this spec is start
  condition (2).
- The only profile that declares a cohort today is living-twin's
  `profiles-local/living-twin.profile.yaml` (`agent_type: "claude-code"`,
  `model_generation: "sonnet-5"`, `model_id: "claude-sonnet-5"`). Those values are an operator
  convention that predates this spec and do **not** match D2's canonical format; see D11.
- Decisions carried in from S2 (2026-10-15): **D-S2a** mixed observations are explicitly
  ineligible (no rounding to a dominant model, no per-session split); **D-S2b** no backfill of
  existing observations; **D-S2c** the measured attribution scope stays "sessions bound through
  `lane work`" and is declared in design.md; widening it rotates `execution_profile_digest`.

## 1. Design decisions

- **D1 Identity source.** The observation's cohort identity is derived from
  `measurement.total.rows` restricted to rows with `tokens > 0`. Each such row contributes the
  pair `(agent, model)`. Rows with `tokens === 0` are ignored for identity (they carry no cost).
- **D2 Closed normalization table** (new module `packages/core/src/model-cohort.ts`, exported
  from `packages/core/src/index.ts`). `normalizeModelIdentity(agent, model)` looks the pair up in
  an explicit allowlist (no regex, no inference) and returns
  `{ agent_type, model_provider, model_generation, model_id }` or `null`. The allowlist is the
  agent-cost 0.3.x `rates.json` `model_key` set (agent-cost rows carry the canonical
  `model_key`, `facts.normalize_model_key`), vendored as a `const` table:
  - `agent === "claude"`, provider `anthropic`: `claude-fable-5`, `claude-fable-5-1`,
    `claude-mythos-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`,
    `claude-opus-5-5`, `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-sonnet-5-5`,
    `claude-haiku-4-5`, `claude-haiku-5-5` → `model_generation: "claude-<major>"` (`claude-4` /
    `claude-5`), `agent_type: "claude"`, `model_id: <key verbatim>`.
  - `agent === "codex"`, provider `openai`: `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`, `gpt-5.4`,
    `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.5-cyber`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
    `gpt-6-astra` → `model_generation: "gpt-<major>"` (`gpt-5` / `gpt-6`), `agent_type: "codex"`,
    `model_id: <key verbatim>`. (`gpt-image-2*` are deliberately absent: image models never carry
    lane coding cost.)
  - Anything else (null agent, null model, a key under the other agent, any key not listed) →
    `null` (unknown). A new model needs a table entry in a lane release; until then its
    observations are ineligible (fail-closed by intent constraint 2).
- **D3 Single-identity rule (D-S2a).** Let `pairs` be the set of distinct `(agent, model)` over
  the `tokens > 0` rows. `deriveCohortIdentity(rows)` (in `model-cohort.ts`) returns either a
  resolved identity (exactly one pair and `normalizeModelIdentity` non-null) or an
  ineligibility `{ reason: "MIXED_OR_UNATTRIBUTED_USAGE", detail }`. `buildObservationFromMeasurement`
  merges that into the observation's `knn_ineligibility_reasons` (code appended once, never
  duplicated; array stays in `ESTIMATE_V2_REASON_CODES` order) and `knn_ineligibility_detail`
  (after the shared predicate's lines for the same code). **Contract revision of
  I-2026-09-10 RULE-05**: measurement-level reasons stay derived by the one shared function
  (`deriveKnnIneligibility`, used by usage-import entries, calibrate entries and the observation);
  the cohort-identity reason is an *observation-only* second predicate, because ledger entries are
  per-agent and carry no cohort. design.md records the revision (D9). Detail templates (RULE-39
  vocabulary: only allowlisted model keys, the literals `claude` / `codex` / `null`, and integers
  may be interpolated; a raw payload `model` string never appears):
  - mixed, all pairs known: `cohort_identity: mixed rows: <agent>/<model_key>, <agent>/<model_key>`
    (sorted lexicographically)
  - mixed with at least one unknown pair: `cohort_identity: mixed rows: <known pairs sorted>, +<n> unknown`
    (or `cohort_identity: mixed rows: +<n> unknown` when none is known)
  - single unknown pair: `cohort_identity: unknown model (agent <claude|codex|null|other>)` —
    the agent placeholder is `claude` or `codex` when the row's agent is exactly that literal,
    `null` when it is null, and `other` for any other value (the zod enum rejects such rows at the
    adapter, but the template is total so no raw agent string can ever reach a detail)
  - no row with tokens: `cohort_identity: no priced rows`
- **D4 Cohort write.** `cohort` is written on the observation only when the identity is resolved
  **and** `profile.estimate.cohort` is configured: the four identity fields from D2, the three
  digests (`routing_policy_digest`, `prompt_policy_digest`, `execution_profile_digest`) from the
  profile, `measure_contract_version` from core's `MEASURE_CONTRACT_VERSION`, which becomes an exported
  constant of `estimator-v2.ts` so producer and estimator share one definition. The
  profile's own `agent_type` / `model_*` values are **not** copied (option A rejected in #58).
- **D5 Profile not configured.** When `profile.estimate?.cohort` is absent: if the identity is
  resolved, the observation is written field-for-field as the pre-change code would (no `cohort`,
  eligibility unchanged); if the identity is unresolved, D3 applies anyway (reason + detail,
  `eligible_for_knn` false). The identity rule therefore never depends on operator configuration,
  and only the unresolved case changes shape relative to the pre-change code.
- **D6 Profile wiring.** `lane calibrate` resolves the profile the same way `lane estimate` does
  (`resolveProfilePath({ explicit: opts.profile, cwd, packageDefaultPath })` + `loadProfile`) and
  gains `--profile <idOrPath>` in `packages/cli/src/main.ts`. `BuildObservationFromMeasurementInput`
  gains `cohortConfig?: EstimateCohortConfig | undefined` (the profile's `estimate.cohort`);
  core never reads the profile file itself.
- **D7 Full-identity match in estimate/v2.** `classifyCandidateExclusion` compares every cohort
  field: a missing cohort or a differing `agent_type` / `model_provider` / `model_generation` /
  `model_id` → `MODEL_GENERATION_MISMATCH`; a differing `routing_policy_digest` /
  `prompt_policy_digest` / `execution_profile_digest` / `measure_contract_version` →
  `ROUTING_PROFILE_MISMATCH`. Order unchanged (token basis, recorded reasons, model, routing).
  No new reason code; the vendored estimate/v2 contract and its fixtures are untouched.
- **D8 No backfill (D-S2b).** No code path writes `cohort` onto an existing record; the schema
  comment "never backfilled" stays; no field is added, so `calibration.schema.json` is expected
  to be byte-identical after regeneration (the diff must prove it). Because `record_id` is
  deterministic over `(intent, session_ids, since, until)` and `writeCalibrationRecord` is an
  upsert ("safe to retry", calibrate.ts spec Rule 1/2), a re-run after this change would
  otherwise *become* a backfill. Rule: before writing the observation, `lane calibrate` reads any
  existing record with the same `record_id` (new `readCalibrationRecord(recordId)` in
  `packages/cli/src/calibration-store.ts`); when it exists and `cohort` presence differs (existing
  lacks it, new one has it, or vice versa) calibrate exits 1 with
  `observation <record_id> already exists without a cohort; re-measuring cannot add one (issue #58, no backfill)`
  (mirror wording for the reverse case) and writes nothing. When presence is the same, the upsert
  stays retry-safe as today. The prediction_evaluation record write is untouched.
- **D9 Documentation (D-S2c).** design.md §5.1 補足 gets one paragraph: the split rule, the
  RULE-05 contract revision (observation-only identity predicate), the re-run guard, the
  model_generation / model_id format, the no-backfill rule, the attribution scope declaration
  ("an observation covers the sessions bound through `lane work`; the parent interactive session
  is not bound today; widening the scope is a separate intent and rotates
  `execution_profile_digest` so the two populations never share a cohort"), and that the generic
  profile never carries a cohort. CHANGELOG `Unreleased` gets an `Added`/`Changed` entry.
- **D11 Canonical format vs. profile target.** The cohort identity written by calibrate is
  always the *derived* one (D2), never the profile's `agent_type` / `model_*`. At estimate time
  the profile's values are the target, so an operator whose profile still says
  `agent_type: "claude-code"`, `model_generation: "sonnet-5"`, `model_id: "claude-sonnet-5"`
  gets `MODEL_GENERATION_MISMATCH` for every new observation until the profile is updated to the
  canonical values (`claude` / `anthropic` / `claude-5` / `claude-sonnet-5-5`). To make that
  visible before the population is wasted, `lane calibrate` prints one non-fatal stderr warning
  when the derived identity differs from `cohortConfig`'s four identity fields:
  `warning: derived cohort identity (<agent_type>/<model_provider>/<model_generation>/<model_id>)
  differs from profile.estimate.cohort (<...>); estimate/v2 will exclude this observation until
  the profile matches`. The observation is still written with the derived cohort (truth over
  configuration). Updating living-twin's profile is the S5 enablement step, outside this lane.
- **D10 Eligibility flag.** `eligible_for_knn` keeps its existing definition
  (`reasons.length === 0 && anyMatched && fullyPriced`), so a D3 reason makes it false.

## 2. EARS requirements

- **RULE-01** When calibrate builds an observation, the system shall derive the cohort identity
  from the `tokens > 0` rows of `measurement.total.rows` only (D1).
- **RULE-02** When the distinct `(agent, model)` pairs number exactly one and normalize through
  the closed table, the system shall treat the identity as resolved (D2, D3).
- **RULE-03** When the pairs number more than one, or the single pair does not normalize, or no
  row carries tokens, the system shall record `MIXED_OR_UNATTRIBUTED_USAGE` once and one
  fixed-template `cohort_identity:` detail line, and shall not write `cohort` (D3).
- **RULE-04** The system shall never select a dominant model by token share and shall never
  split one measurement into several observations (D3).
- **RULE-05** When the identity is resolved and `cohortConfig` is present, the system shall write
  `cohort` with the four derived identity fields, the three profile digests and
  `MEASURE_CONTRACT_VERSION` (D4).
- **RULE-06** When `cohortConfig` is absent and the identity is resolved, the system shall write
  no `cohort` and shall leave every other observation field as the pre-change code would; when the
  identity is unresolved, RULE-03 applies regardless of `cohortConfig` (D5).
- **RULE-07** `lane calibrate` shall resolve the profile exactly as `lane estimate` does and
  accept `--profile <idOrPath>` (D6).
- **RULE-08** `classifyCandidateExclusion` shall return `MODEL_GENERATION_MISMATCH` when the
  candidate has no cohort or any of `agent_type`, `model_provider`, `model_generation`,
  `model_id` differs from the target (D7).
- **RULE-09** `classifyCandidateExclusion` shall return `ROUTING_PROFILE_MISMATCH` when any of the
  three digests or `measure_contract_version` differs (D7).
- **RULE-10** The system shall not add an estimate/v2 reason code, change the contract version,
  or add a calibration schema field (D7, D8).
- **RULE-11** The normalization table shall map only the two families in D2; `model_generation`
  is `claude-<major>` / `gpt-<major>` and `model_id` is the row's model string verbatim (D2).
- **RULE-12** `profiles/generic.profile.yaml` shall remain without `estimate.cohort` (D9).
- **RULE-14** When an observation record with the same `record_id` already exists and its
  `cohort` presence differs from the new observation's, `lane calibrate` shall exit 1 naming the
  record_id and write nothing; otherwise the write stays an upsert (D8).
- **RULE-15** The normalization table shall be an explicit allowlist in code; no model key
  outside it shall ever yield an identity (D2).
- **RULE-13** When the derived identity differs from `cohortConfig`'s `agent_type`,
  `model_provider`, `model_generation` or `model_id`, `lane calibrate` shall print one non-fatal
  warning naming both and shall still write the derived cohort (D11).

## 3. Gherkin scenarios

```gherkin
Feature: calibrate records the cohort an observation was measured under

  Scenario: single known model with a configured profile cohort
    Given measurement.total.rows has rows (claude, claude-sonnet-5-5) with tokens > 0 only
    And cohortConfig carries routing/prompt/execution digests
    When buildObservationFromMeasurement runs
    Then observation.cohort is { agent_type: claude, model_provider: anthropic,
      model_generation: claude-5, model_id: claude-sonnet-5-5, <the three digests>,
      measure_contract_version: measure/v1 }
    And knn_ineligibility_reasons is unchanged (no cohort_identity detail)

  Scenario Outline: identity cannot be resolved
    Given tokens > 0 rows with pairs <pairs>
    When buildObservationFromMeasurement runs (with or without cohortConfig)
    Then observation has no cohort
    And knn_ineligibility_reasons contains MIXED_OR_UNATTRIBUTED_USAGE exactly once
    And knn_ineligibility_detail contains "<detail>"
    And eligible_for_knn is false
    Examples:
      | pairs                                                   | detail |
      | (claude, claude-opus-5-5), (claude, claude-sonnet-5-5)  | cohort_identity: mixed rows: claude/claude-opus-5-5, claude/claude-sonnet-5-5 |
      | (claude, null)                                          | cohort_identity: unknown model (agent claude) |
      | (codex, claude-sonnet-5-5)                              | cohort_identity: unknown model (agent codex) |
      | (claude, llama-3-70b)                                   | cohort_identity: unknown model (agent claude) |
      | (claude, claude-sonnet-5-5), (claude, llama-3-70b)      | cohort_identity: mixed rows: claude/claude-sonnet-5-5, +1 unknown |
      | none (all rows tokens = 0)                              | cohort_identity: no priced rows |

  Scenario: zero-token rows do not count toward identity
    Given rows (claude, claude-sonnet-5-5) tokens 100 and (codex, gpt-5.6) tokens 0
    When buildObservationFromMeasurement runs with cohortConfig
    Then observation.cohort.model_id is claude-sonnet-5-5 and no cohort_identity detail is recorded

  Scenario: profile without cohort keeps the pre-change observation
    Given rows (claude, claude-sonnet-5-5) tokens > 0 and cohortConfig undefined
    When buildObservationFromMeasurement runs
    Then observation has no cohort and equals the pre-change observation field for field

  Scenario Outline: estimate/v2 matches on the full identity
    Given a target cohort T and a candidate whose cohort equals T except <field>
    When classifyCandidateExclusion runs
    Then it returns <reason>
    Examples:
      | field                                   | reason                    |
      | (cohort missing)                        | MODEL_GENERATION_MISMATCH |
      | agent_type                              | MODEL_GENERATION_MISMATCH |
      | model_provider                          | MODEL_GENERATION_MISMATCH |
      | model_generation                        | MODEL_GENERATION_MISMATCH |
      | model_id                                | MODEL_GENERATION_MISMATCH |
      | routing_policy_digest                   | ROUTING_PROFILE_MISMATCH  |
      | prompt_policy_digest                    | ROUTING_PROFILE_MISMATCH  |
      | execution_profile_digest                | ROUTING_PROFILE_MISMATCH  |
      | measure_contract_version                | ROUTING_PROFILE_MISMATCH  |
      | model_id AND prompt_policy_digest       | MODEL_GENERATION_MISMATCH (model before routing) |
      | token_basis AND model_id                | TOKEN_BASIS_MISMATCH (basis first, unchanged)   |
      | (none)                                  | null (eligible)           |

  Scenario: re-run cannot backfill a cohort
    Given a calibration record cal-X recorded by the pre-change code (no cohort) for sessions S
    When lane calibrate runs again for the same intent, sessions S and window with a cohort profile
    Then it exits 1 naming cal-X and the file is byte-identical
    And running it again with the same profile after a successful post-change write upserts (exit 0)

  Scenario: lane calibrate CLI with --profile
    Given a lane with a bound session whose measurement rows are a single known model
    And a profile file declaring estimate.cohort
    When lane calibrate <id> --session-id <s> --profile <file> runs
    Then the written calibration record carries cohort with the profile's digests
    And the same command without a cohort-bearing profile writes no cohort
```

## 4. Dependency and path cross-check (applicable)

| DEP | description |
|---|---|
| DEP-01 | cohort identity derivation + explicit ineligibility (D1–D3, new guard) |
| DEP-02 | calibrate reads the profile (`cohortConfig`), new `--profile` option (D6) |
| DEP-03 | full-identity match in `classifyCandidateExclusion` (D7) |
| DEP-04 | closed normalization table `model-cohort.ts` (D2) |

| PATH | references DEP-01 | DEP-02 | DEP-03 | DEP-04 | test |
|---|---|---|---|---|---|
| PATH-01 `lane calibrate` → `buildObservationFromMeasurement` | yes | yes | — | yes | TEST-01..06, TEST-08, TEST-13 |
| PATH-02 `usage-import` → `buildLaneScopeLedgerEntries` / ledger entries (per-agent) | does not, by design (ledger has no cohort; per-agent split stays) | no | — | no | TEST-10 (ledger unchanged) |
| PATH-03 `estimate-service` → `estimator-v2` `tallyExclusions` | — | — | yes | — | TEST-07 |
| PATH-04 existing observations on disk (no cohort) | yes: re-run guard (D8) | — | yes | — | TEST-07 (missing cohort), TEST-15 |
| PATH-08 `deriveKnnIneligibility` shared predicate (usage-import entries, calibrate entries, observation) | does not change; observation adds the identity predicate on top (RULE-05 revision) | no | — | no | TEST-10, existing knn-ineligibility tests untouched |
| PATH-05 `migrate-legacy-ledger` (`imported_legacy_ledger` observations) | does not (no rows available) | no | yes (missing cohort → excluded) | no | TEST-07 |
| PATH-06 `estimate-v2` fixtures (`packages/core/test/fixtures/estimate/v2`) | — | — | unknown → fixtures must still pass | — | TEST-12 |
| PATH-07 lane-finish skill / docs invoking calibrate without `--profile` | — | cwd / package default resolution, same as estimate | — | — | TEST-08 (default path) |

- **TEST-01** resolved identity + cohortConfig → cohort written (RULE-02, RULE-05).
- **TEST-02** mixed models → ineligible, sorted detail, no cohort, fails on pre-change code (RULE-03, RULE-04).
- **TEST-03** null model / family mismatch / unknown id → ineligible with `unknown model` detail (RULE-03).
- **TEST-04** zero-token foreign row ignored (RULE-01).
- **TEST-05** no priced rows → `no priced rows` detail (RULE-03).
- **TEST-06** cohortConfig undefined → no cohort, observation otherwise identical to the pre-change shape (RULE-06).
- **TEST-07** classifyCandidateExclusion matrix over all 8 cohort fields plus missing cohort, plus
  the two priority rows (model before routing; token basis before model) (RULE-08, RULE-09).
- **TEST-08** CLI: `--profile` with cohort → record has cohort; without → none; default resolution works (RULE-07).
- **TEST-09** `normalizeModelIdentity`: every key enumerated in D2 maps to the stated
  provider/generation/agent_type; rejects for null, cross-agent key, unlisted key (`gpt-999-x`,
  `claude-opus-5-6`, `gpt-image-2`), an out-of-enum agent (`"gemini"` cast at the type level →
  `unknown model (agent other)`); and `deriveCohortIdentity` detail templates incl. the RULE-39
  guarantee that neither a raw model nor a raw agent string ever appears in a detail (RULE-11, RULE-15).
- **TEST-10** ledger entries from the same mixed measurement are unchanged in count and fields (PATH-02).
- **TEST-11** `profiles/generic.profile.yaml` loads without `estimate.cohort` (RULE-12).
- **TEST-13** CLI: profile cohort with `agent_type: claude-code` / `model_generation: sonnet-5`
  and a `claude-sonnet-5-5` measurement → record carries the derived cohort (`claude` / `claude-5`
  / `claude-sonnet-5-5`) and stderr contains the D11 warning; a matching profile → no warning (RULE-13).
- **TEST-12** existing estimate/v2 fixture suite and `estimate-service` tests stay green under D7, and
  a regression assertion keeps a fully matching candidate eligible (`null`) (PATH-06).
- **TEST-14** existing `calibrate-service` / `basis-gate-services` fixtures that build
  `total.rows = []` with `totals.tokens > 0` are updated to carry one known row
  (`claude` / `claude-sonnet-5-5`) so their `reasons = []` / eligible assertions keep their
  meaning; the updated fixture is the only change to those tests, and one new case asserts that
  the empty-rows shape now yields `cohort_identity: no priced rows` (RULE-03).
- **TEST-15** CLI: pre-seeded cohort-less record + cohort profile → exit 1, message names the
  record_id, file byte-identical; same-presence re-run → exit 0 upsert (RULE-14).

## 5. Out of scope

Backfill, supersession of observations, parent-session binding, new reason codes, ledger
changes, profile defaults — see intent.yaml `non_goal`.
