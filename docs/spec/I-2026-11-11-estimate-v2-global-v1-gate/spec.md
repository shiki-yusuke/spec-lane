# I-2026-11-11-estimate-v2-global-v1-gate — retain a valid estimate/v2 prediction when global v1 abstains

**Human-review band: applicable.** This changes an error-handling completion path, adds a
target-dependent population guard, and has two estimators over the same observations. The
cross-check in §4 and the additive local revision-schema work need explicit approval before
Phase 3.

## 0. Context and premise

- `buildEstimateRevision` first calls `buildEstimateV2Decision`, then calls the global
  `runEstimator`, and catches `ReferenceTableRequiredError`. Its current catch rethrows if
  v2 is `predicted`, based on the now-false assumption that the v2 population is always too
  small whenever the global v1 population fails.
- `estimator-v2.ts` already runs v1 over the cohort-matched eligible subset. A predicted v2
  decision therefore has a real `EstimatorResult` internally, but only emits its token
  quantiles in the strict estimate/v2 decision. `estimator.ts` independently ranks the whole
  basis-eligible population and rejects when fewer than five of its nearest seven are
  `eligible_for_knn`.
- The reproduced G5-2a premise records eight cohort-matched observations, one of which is
  G5-2a's own completed (`5_done`) observation, and nearer cohort-less, v1-ineligible
  observations. After the required self-exclusion it has only seven non-target cohort
  observations, so v2 honestly abstains at the unchanged `MIN_POPULATION_FOR_KNN = 8`.
  This is a non-goal, not a threshold defect. The intended real case is a not-yet-finished
  intent (for example G5-2b) with at least eight non-self cohort observations; nearer
  cohort-less, v1-ineligible observations then displace usable global neighbors and cause
  global v1 to raise `ReferenceTableRequiredError` although the v2-only run predicts.
- The vendored `estimate/v2` JSON schema and `EstimateV2DecisionSchema` both reject unknown
  properties; the local revision's `NeighborSchema` currently has only `intent_id`,
  `distance`, and `measurement_quality`.

## 1. Design decisions

- **D1 Preserve a v2-produced result.** Add an internal v2 outcome API in
  `estimator-v2.ts` that returns the unchanged contract-shaped `decision` and, only when its
  final status is `predicted`, the exact `EstimatorResult` from its cohort-subset v1 run.
  `buildEstimateV2Decision` remains the contract-returning wrapper. This avoids a second
  selection/ranking implementation and does not add a property to the strict estimate/v2
  output.
- **D2 Global-v1 failure after a v2 prediction.** If the later whole-population v1 run raises
  `ReferenceTableRequiredError` and D1's decision is `predicted`, return a revision from D1's
  cohort-subset result: its full `predicted` (tokens and cost), its selected `neighbors`,
  `population_condition` with `method: "knn_quantile"`, and current accounting basis. Set the
  existing free-form `estimator_version` field to
  `"estimate/v2-cohort@" + input.estimatorVersion` (for example,
  `"estimate/v2-cohort@lane-estimator/0.1.0"`), and retain `decision_v2` with
  `schema_version: "estimate/v2"` and `status: "predicted"`. `knn_quantile` names the
  algorithm, not v1; the version preserves both contract scope and implementation identity.
  Tokens must equal `decision_v2.predicted`; cost is an auxiliary output from the same
  captured cohort-subset `EstimatorResult`, not a value guaranteed by the estimate/v2
  contract. Neighbors and population condition are from that same captured result. Other v1
  errors still propagate. Rationale: these values are never presented as global-v1 output.
- **D3 Preserve all non-exception paths.** If v2 abstains and no reference table exists, keep
  the current abstained revision (no `predicted`, existing v2 reason codes). If a reference
  table exists, keep the current global-v1 `reference_table` revision, including its basis
  handling; do not replace it with v2 values. A successful global-v1 path is also unchanged.
- **D4 Exclude the target once, before both estimators.** Add required
  `targetIntentId: string` to the exported `@lane/core` `BuildEstimateRevisionInput`;
  `runEstimate` supplies its `intentId`. This is a breaking `buildEstimateRevision` API change:
  the `CHANGELOG.md` Unreleased entry must tell external TypeScript callers to pass the intent
  being estimated as `targetIntentId`. At the top of `buildEstimateRevision`, form one local
  population by removing every observation whose `intent_id === targetIntentId`, then pass only
  that population to D1 and the later global `runEstimator`. Do not put duplicate filters in
  either estimator. This guarantee is scoped to the `lane estimate` / `buildEstimateRevision`
  route; low-level exported estimators remain target-agnostic and do not guarantee
  self-exclusion.
- **D5 Persist neighbor record IDs in the local revision schema.** Do not add a field to the
  vendored strict estimate/v2 contract: it has top-level `additionalProperties: false`, no
  neighbors field, and its local mirror is `.strict()`. Instead, add optional
  `EstimateRevision.neighbors[].record_id` in `packages/schemas/src/estimate.ts`, regenerate
  `packages/schemas/generated/estimate.schema.json`, and update
  `packages/schemas/test/estimate.test.ts`. Populate it from the observation record ID in
  `estimator.ts` neighbor construction. The addition is backward-read compatible only: new
  readers must still parse old revision shapes without `record_id`. Forward compatibility is not
  guaranteed: the old generated schema sets `additionalProperties: false` on neighbors, so an old
  JSON-Schema consumer rejects revisions carrying `record_id` (CHANGELOG states this). `intent_id` alone is insufficient because one
  intent can have multiple observation records.

## 2. EARS requirements and acceptance criteria

- **RULE-01** When estimate/v2 is predicted and the later global-v1 call raises only
  `ReferenceTableRequiredError`, the system shall write a `decision_v2`-predicted revision from
  the v2 outcome, label `estimator_version` as
  `estimate/v2-cohort@<existing implementation identifier>`, and return successfully.
- **RULE-02** When the global-v1 call throws an error other than `ReferenceTableRequiredError`,
  the system shall propagate that error unchanged.
- **RULE-03** When v2 abstains, the system shall preserve the existing no-reference abstained
  revision and reference-table behavior.
- **RULE-04** On the `lane estimate` / `buildEstimateRevision` route, before either estimator
  consumes observations, the system shall remove every observation whose `intent_id` equals the
  required `targetIntentId`; low-level estimators remain target-agnostic.
- **RULE-05** The system shall keep estimate/v2 unchanged and shall persist the exact selected
  observation `record_id` as optional `EstimateRevision.neighbors[].record_id`, while accepting
  old revisions that omit it.
- **RULE-06** The system shall document the v2 provenance behavior and the breaking
  `buildEstimateRevision` migration in CHANGELOG, while preserving all package test, typecheck,
  and Biome checks.

Acceptance criteria (verbatim from `intent.yaml`):

- **AC-01.** When estimate/v2 decides predicted from the cohort-matched population, lane estimate exits 0 and writes a revision carrying that v2 decision even when the whole-population v1 run would raise ReferenceTableRequiredError; no --reference-* flags are needed. A regression test with 8 cohort-eligible observations plus nearer cohort-less ineligible ones fails on 048715d and passes after the change. **Test:** TEST-01, TEST-02.
- **AC-02.** When v2 abstains and no reference table is given, behavior is unchanged (abstained revision, same reason codes); when a reference table is given, the v1 reference_table path is unchanged. **Test:** TEST-03.
- **AC-03.** Observations whose intent_id equals the estimated intent are excluded from both the v1 and v2 populations, asserted by a test where the target's own observation would otherwise be the nearest neighbor (distance 0). **Test:** TEST-04.
- **AC-04.** The persisted v2 decision (or the revision) lets an operator trace a v2 prediction to the record_ids of the observations it used, without a breaking change to the vendored estimate/v2 contract; if the contract cannot carry it compatibly, Phase 2 records that and moves this criterion to a follow-up intent instead of changing the contract. **Test:** TEST-05 (exact record IDs, old-shape parse, strict v2 contract guard).
- **AC-05.** All packages/* test suites, typecheck and biome stay green; CHANGELOG has an Unreleased entry. **Test:** TEST-06, TEST-07.

For AC-01 and TEST-01, "8 cohort-eligible observations" means eight **non-target**
cohort-eligible observations. When a target self-observation is also present, the fixture has
nine cohort-eligible observations before self-exclusion. This clarifies the test population
without changing the verbatim intent success criterion.

## 3. Gherkin scenarios

```gherkin
Feature: retain an estimate/v2 cohort prediction independently of global v1 eligibility

  Scenario: global v1 fails but v2 has eight non-target cohort-eligible observations
    Given 8 non-target cohort-matched, knn-eligible observations and nearer cohort-less ineligible observations
    And novel surface is declared established and no reference table is supplied
    When lane estimate builds a revision
    Then it exits 0 with a predicted decision_v2 revision
    And estimator_version is "estimate/v2-cohort@lane-estimator/0.1.0"
    And tokens equal decision_v2.predicted and cost, neighbors, and population_condition are from the same captured cohort-subset k-NN result

  Scenario Outline: legacy fallback behavior remains intact
    Given estimate/v2 abstains with <reference>
    When lane estimate builds a revision
    Then it records <result> with the existing reason codes
    Examples:
      | reference table | result                              |
      | absent          | no predicted value and method abstained |
      | present         | v1 reference_table predicted value |

  Scenario: the target's own zero-distance observation cannot train its estimate
    Given the target observation is cohort-matched, eligible, and distance 0
    And 8 other cohort-matched eligible observations exist
    When lane estimate builds a revision for the target intent
    Then neither the v1 neighbors nor decision_v2 population include the target observation
```

## 4. Dependency and path cross-check (applicable)

- **DEP-01:** an internal v2 outcome retains the existing cohort-subset `EstimatorResult`.
- **DEP-02:** a single target-intent population filter feeds both estimator paths.
- **DEP-03:** the `ReferenceTableRequiredError` branch selects an honest v2 revision instead of
  rethrowing only when v2 predicted.
- **DEP-04:** estimate/v2 remains a strict vendored contract; local revision neighbors carry
  optional record IDs from the captured cohort result.
- **PATH-01:** `runEstimate` obtains observations, passes `targetIntentId`, persists a revision,
  and reports exit 0. Covered by TEST-02.
- **PATH-02:** `buildEstimateRevision` calls v2 first and global v1 second. Covered by
  TEST-01, TEST-03, and TEST-04.
- **PATH-03:** `estimator-v2.ts` creates its decision and captured cohort-subset result without
  leaking internal data into the vendored contract. Covered by TEST-01 and TEST-05.
- **PATH-04:** callers/tests of `BuildEstimateRevisionInput` must supply `targetIntentId`.
  Covered by TEST-04 and the TypeScript build.

Files to change (all are within `intent.yaml` `allowed_paths`):

- `packages/core/src/application/estimate-service.ts`
- `packages/core/src/estimator.ts`
- `packages/core/src/estimator-v2.ts`
- `packages/core/test/estimate-service.test.ts`
- `packages/core/test/estimator-v2.test.ts`
- `packages/core/test/basis-gate-services.test.ts` (required-input call-site updates)
- `packages/cli/src/commands/estimate.ts`
- `packages/cli/test/estimate.test.ts`
- `packages/schemas/src/estimate.ts`
- `packages/schemas/generated/estimate.schema.json`
- `packages/schemas/test/estimate.test.ts`
- `docs/design.md`, `CHANGELOG.md`, and this `spec.md`

Test plan:

- **TEST-01** (`baseline_expected: red`): In
  `packages/core/test/estimate-service.test.ts`, construct 8 **non-target** matching eligible
  observations plus at least 4 nearer cohort-less `eligible_for_knn: false` observations. With no
  reference table and declared novel surface, assert no throw; revision has
  `estimator_version: "estimate/v2-cohort@lane-estimator/0.1.0"`, `decision_v2` is predicted,
  token quantiles equal `decision_v2.predicted`, and top-level cost, neighbors, and population
  condition all come from the same captured cohort-subset result. A self-observation variant has
  9 cohort-eligible observations before filtering and 8 after it. This is red on `048715d`.
- **TEST-02** (`baseline_expected: red`): In `packages/cli/test/estimate.test.ts`, seed the
  TEST-01 population (eight non-target cohort observations) and assert `runEstimate` exits 0 and
  persists the TEST-01 revision without `--reference-*`.
- **TEST-03** (`baseline_expected: green`, characterization): Extend the existing
  small-population/no-reference and reference-table tests to assert unchanged abstained reason
  codes/no `predicted`, respectively unchanged `reference_table` values and method.
- **TEST-04** (`baseline_expected: red`): Give the target a matching, eligible distance-0
  observation with deliberately distinctive actuals plus 8 other matching observations (9 before
  self-exclusion). Assert it is absent from revision neighbors and from
  `decision_v2.population` counts, proving both v1 and v2 used the one filtered population.
- **TEST-05** (`baseline_expected: red`): In `packages/schemas/test/estimate.test.ts` and the
  core estimate-service test, assert the revision neighbors contain the exact selected
  observation `record_id`s, while `decision_v2` still rejects a proposed neighbor `record_id`.
  Also parse an old revision shape with no `neighbors[].record_id` to prove additive backward
  compatibility. The traceability assertion is red before D5; the old-shape parse and strict
  contract guard are green characterization guards.
- **TEST-06** (`baseline_expected: green`, quality gate): Run `pnpm test`, `pnpm typecheck`, and
  `pnpm lint` (Biome).
- **TEST-07** (`baseline_expected: red`, manual diff check): the `CHANGELOG.md` Unreleased entry
  describes v2/global-v1 provenance, the required `buildEstimateRevision({ targetIntentId })`
  migration, and the backward-read-only compatibility of `neighbors[].record_id`.

Explicit user approval of this cross-check and TEST-01..07 is required before Phase 3; D5 is
in scope, not deferred.

## 5. Out of scope, risks, and architect-review disposition

Out of scope: novel-surface wiring, v1 threshold changes, cohort production, calibration, and
backfill remain as specified in `intent.yaml`; the vendored estimate/v2 contract remains
unchanged. The additive local revision-neighbor schema update is in scope.

Risks: a fallback revision can falsely look like global v1 if D2's scoped version label is
omitted; duplicating v2 filtering/ranking would drift from its decision; a top-level cost could
be mistaken for an estimate/v2 contract guarantee; and omitting record IDs would leave an
ambiguous trace when an intent has multiple observations. The D1 captured outcome, D2 provenance
label and auxiliary-cost statement, one D4 route-scoped filter, and D5's additive local schema
carrier mitigate these risks.
