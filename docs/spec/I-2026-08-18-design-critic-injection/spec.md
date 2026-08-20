# Spec — design-critic injection (opt-in pilot)

## Intent summary

`lane` records design options and their critic reviews, derives how independent each review actually
was, and refuses to claim independence it cannot support. Enabled only with `--design`; a lane that
does not pass it behaves exactly as before.

## Premise

Recorded in `intent.yaml` (`method: data`). The premise is **not** "lane lacks a `design_critic`
feature" (that is the weak, code-only side). The premise is that **independence labels are actually
mis-recorded in practice**, and two instances exist:

1. A published contract's own fixtures labelled `gpt-5.6-terra` as `different_lineage` and
   `gpt-5.6-sol` as `same_lineage_different_order`, though both are the same provider and generation.
   The labels used two different reference points; the contract never defined which reference point
   applies.
2. The same fixture set labelled a *different session's* blind re-analysis as `same_session`, while
   its own note said "same engine lineage as the generating session" — label and note contradicted.

Both passed machine validation and were caught only by a human reading the values. An architect
review (`gpt-5.6-sol`) independently reached the same root cause: "`critic_engine` records no
builder engine, actual invocation, fallback, model snapshot, or lineage basis. A routing
configuration expresses intent, not what ran."

**R39's premise is live, in this repo, right now** (`method: data`). This repo already vendors five
upstream contracts, each with an `UPSTREAM` marker recording a pinned commit and a reproducible tree
hash. One of those pins does not resolve:

- `packages/adapters/test/fixtures/measure/UPSTREAM` pins a commit that was on a feature branch. The
  marker file itself says to re-pin to the merged main commit once that PR landed. The PR landed; the
  re-pin never happened.
- An unrelated history rewrite in the upstream repo then changed every commit id, so that commit is
  no longer reachable from upstream `main` or from any branch. On the remote it survives only through
  backup tags that were pushed for an entirely different reason. Delete those tags and the pin
  becomes permanently unresolvable.
- The vendored bytes are nonetheless current — byte-identical to upstream `main`.

So the state is: **content correct, provenance reference dead, and nothing noticed** — there is no
check that a pin still resolves. This is the same class of defect as a digest recorded without the
path it is a digest of, and it is why R39 fails closed rather than warning.

## Non-goals

- **lane does not invoke models.** No spawning of critics, no routing implementation. lane records
  and gates; the operator (or a wrapper) runs the critic.
- **Not a mandatory gate.** The architect review's strongest counter-argument was accepted: one
  observed divergence between engines proves disagreement, not that the second engine caught more
  real defects, and agents can cheaply manufacture plausible options and reviews. So this ships
  opt-in and is measured before any promotion.
- **Not proving blindness.** No mechanism here establishes that a critic had no other context.
- **Not fixing `premise_evidence`.** Its `evidence` field is `z.string()` free text with no uri,
  digest, or reproduction reference; calling it "verified evidence" is a category error. That is a
  real defect but **out of scope for this lane** — tracked separately. This spec calls it
  *recorded* premise evidence throughout and never launders it into "evidence".
- **Not wiring `novel_surface` into the gate.** `gate.ts` has zero occurrences of `novel_surface`
  or `estimate`; `GateContext` is `{trigger, state, artifacts, profile}`. Activation is `--design`
  only.

## EARS rules

### Activation and non-interference

- **R1** When `lane start` is invoked without `--design`, the system SHALL behave exactly as it does
  today: no new artifact is required, no new gate is evaluated, and no new field appears in
  `lane-state.json`.
- **R2** When `lane start` is invoked with `--design`, the system SHALL persist the activation in
  lane state together with its provenance (who recorded it, when), so activation is not inferable
  only from an absent file.
- **R3** While the design track is active, the system SHALL evaluate the design gates described in
  R20–R48 and no others.

### Artifacts

- **R4** The system SHALL store design options at a content-addressed revision path with a separate
  active pointer, so that a revision is immutable once written and superseding it never destroys the
  reviews bound to it.
- **R5** The design options document SHALL conform to the upstream `design-options` contract exactly,
  and the system SHALL pin the upstream schema by commit and digest rather than copying it silently.
- **R6** The system SHALL store lane-owned fields that the upstream contract does not define in a
  separate companion artifact versioned independently
  (`design-critic-attestation/v0`), and SHALL NOT add fields to the upstream-conforming document.
- **R7** Where the companion artifact references the upstream document, it SHALL bind each reference
  to both the exact location within that document and the document's own digest, because the
  upstream contract provides no per-review identifier.

### The critic packet — DEFERRED, not dropped

**R8–R11 are deferred out of the pilot** (recorded 2026-08-19, after implementation review). They are
retained here rather than deleted, so the reason is on the record and re-adding them is a decision
rather than a rediscovery.

Why deferred:

1. The packet's *identity and freshness* function duplicates R7, which already binds every review to
   the exact location within the options document **and** that document's digest. Editing the options
   after review already invalidates the binding.
2. The packet's *unique* function was to hand the critic a view with the generator's rationale and
   ranking stripped out. Architect review judged that function unsound in v2: free-text `summary` and
   `predicted_outcomes` fields can embed rankings, so **field selection cannot establish blindness**.
   The unique value was refuted before it was built.
3. lane does not run the critic (Non-goals). R11 already concedes that a recorded packet digest does
   not establish that the packet was delivered to the stated engine. Generating an artifact whose own
   required disclaimer says it proves nothing about delivery is ceremony of exactly the kind the v1
   architect review warned about ("agents can cheaply manufacture plausible options, assumptions and
   reviews, increasing maintenance cost without changing implementation quality").

What would bring them back: a wrapper that records the actual invocation (route taken, model
snapshot, response id) rather than an operator-authored claim about it. At that point the packet
digest becomes one half of a checkable pair instead of a standalone assertion.

- **R8** *(deferred)* When the operator requests a critic packet, the system SHALL generate it from a
  deterministic, versioned representation of the options' typed fields only.
- **R9** *(deferred)* The system SHALL record the packet as `{uri, digest, digest_algorithm}`, never as a bare
  digest.
- **R10** The packet SHALL NOT include recorded premise evidence unless `intent.yaml` is declared and
  digest-bound as a second, separately identified packet source.
- **R11** *(deferred)* The system SHALL state, in the packet and in its documentation, that the digest identifies
  the packet the review claims to address, and does not establish that this was the critic's only
  input, that it was delivered to the stated engine, that the engine had no prior context, or that
  the derived independence classification is correct.

### Recording who shaped and who reviewed

- **R12** The system SHALL require the set of parties that shaped the active options revision, with
  at least one entry, each recording how it shaped them.
- **R13** The system SHALL record each critic as a structured engine reference, not free text.
- **R14** Where any field needed to classify an engine is unavailable, the system SHALL require that
  field to be named explicitly as unknown rather than omitted silently.
- **R15** The system SHALL require every critic review to reference its own output artifact; a review
  entry that carries no reachable output SHALL be rejected.

### Derivation, not assertion

- **R16** The system SHALL derive the independence classification from the recorded shapers and
  critic, and SHALL NOT accept a producer-supplied classification.
- **R17** The system SHALL NOT persist the derived classification, and SHALL recompute it at
  validation and display time.
- **R18** When deriving, the system SHALL evaluate the critic against every shaper of the active
  revision and take the closest — that is, the least independent — relationship.
- **R19** Where recorded fields leave more than one relationship possible, the system SHALL classify
  as undetermined **only if** at least one possible relationship would qualify; otherwise it SHALL
  derive the closest possible relationship. An undetermined classification SHALL NOT qualify.

### Prior involvement

- **R20** The system SHALL NOT offer an absolute "no prior involvement" value, because positive
  involvement can be evidenced while universal non-involvement cannot.
- **R21** Where a review claims that no involvement was observed within a recorded scope, the system
  SHALL require a reference to the artifact that establishes that scope.
- **R22** Where prior involvement is undetermined, the review SHALL NOT qualify.

### Qualifying, coverage, and counting

- **R23** The system SHALL treat a review as qualifying only when the derived classification is a
  genuinely separate lineage or an independent human, **and** involvement is recorded as
  not-observed-within-scope. Both conditions SHALL be required.
- **R24** The system SHALL require that every option offered for decision is covered by at least one
  qualifying review before establishment is claimed.
- **R25** The system SHALL NOT emit a single independence count. Where any count is shown, it SHALL
  show total reviews and qualifying reviews separately, and SHALL present per-option coverage and
  derived status before either count.
- **R26** The system SHALL report the reasons a review did or did not qualify, never a bare verdict.

### Three-state outcome and override

- **R27** When every option is covered by a qualifying review, the system SHALL report establishment
  as established.
- **R28** When no qualifying review exists, **or coverage is partial**, and the operator records an
  override, the system SHALL report establishment as not-established and mark it operator-asserted.
- **R29** When establishment fails and no override is recorded, the system SHALL block **the
  transition into the spec phase**. This is the first of two gates; the second is R35–R36 at the
  transition into the implement phase. The two are deliberately separate: the first asks whether the
  options were reviewed at all, the second asks whether the option actually selected was among those
  reviewed. A single combined gate cannot express the state where review happened but the decision
  then selected something else.
- **R30** The override SHALL be a distinct operation that records reason, actor, timestamp, and policy
  basis, and SHALL NOT be satisfiable by editing a field in an artifact the same agent authors.
- **R31** The override SHALL be scoped to the active options revision, the specific uncovered options,
  and — at the implementation gate — the selected option; a generic reusable override SHALL be
  rejected.
- **R32** The system SHALL call the override outcome operator-asserted rather than human-verified,
  because the operator's identity is not authenticated.
- **R33** Where the profile forbids the override, the system SHALL block instead of accepting it.

### Decision binding

- **R34** Before the spec phase, the system SHALL require that options exist, that reviews reference
  their outputs, and that establishment has been derived and reported.
- **R35** Before the implement phase, the system SHALL require a decision record whose selected
  option names an option that exists in the active revision and was covered by a qualifying review,
  unless an override scoped to that selected option is recorded.
- **R36** Before the implement phase, the system SHALL require that `spec.md` references the selected
  option identifier.

### Vendoring the derivation (resolves the architecture halt trigger)

- **R37** The system SHALL consume the upstream derivation as a vendored file, not as a cross-repo
  import and not as a spawned external command, because lane is distributed to users who have no
  copy of the contracts repository.
- **R38** The vendored copy SHALL carry an `UPSTREAM` marker recording the upstream commit, the
  vendored paths, the date, and a reproducible tree hash, matching the convention this repo already
  uses for its five other vendored contracts.
- **R39** The system SHALL verify, in CI, that the recorded tree hash matches the vendored bytes, and
  SHALL fail closed when it does not. A verification that only warns is not sufficient, because the
  failure mode being closed is a reference that has silently stopped resolving.
- **R40** The system SHALL distinguish, in its diagnostics, an unresolvable upstream pin from a
  content mismatch, because they call for different remedies: re-pinning versus re-vendoring.

### Lifecycle of a design revision

- **R41** When the active options pointer moves to a new revision, the system SHALL NOT carry reviews
  or establishment status forward from the previous revision. Establishment SHALL be re-derived
  against the new revision, starting from no qualifying coverage.
- **R42** The system SHALL retain the superseded revision and the reviews bound to it, and SHALL NOT
  delete or rewrite them when the pointer moves.

### Values that must not carry identity

- **R43** The system SHALL reject engine-reference values matching an enumerated set of prohibited
  **formats** -- an address-shaped string, and the forbidden key names this project already enforces
  at its metrics boundaries. It SHALL NOT attempt to decide whether an arbitrary opaque string
  denotes a natural person.
- **R44** The system SHALL reject a session reference matching an enumerated set of
  credential-shaped formats.
- **R44a** The documentation SHALL state that R43 and R44 are format checks, not identity detection:
  an opaque identifier that happens to be a person's internal account id will pass, and the operator
  remains responsible for not putting one there.

  *Narrowed after architect review of v3.* The original wording required rejecting "a value that
  identifies a natural person", which is not reliably machine-decidable without an identity model and
  pulls unrelated policy scope into this lane. A format allow/deny list is decidable and matches the
  pattern this project already uses for its personal-dimension enforcement (a closed list of
  forbidden keys checked at three boundaries), rather than inventing semantic person detection here.
  Semantic detection is deferred, and deferred visibly rather than quietly dropped.

### Message catalog

- **R45** Every message the new commands emit SHALL be addressed by a stable identifier in a message
  catalog, and SHALL NOT be keyed by its own source text.
- **R46** Reason text explaining why a review did or did not qualify SHALL be composed from whole
  catalogued messages with named placeholders, and SHALL NOT be assembled by concatenating sentence
  fragments.

**Scope of "every message the new commands emit" (R45), decided 2026-08-20 — provisional.**
R45 covers the messages a design command **returns**. It does **not** cover text printed when a
design command throws, which `main.ts`'s global handler writes with `console.error(err.message)`.

The wording admits both readings, so this is a decision rather than a deduction. Two facts about
the uncovered path, so a later reader can weigh it without re-deriving them:

- What a user actually sees today is the raw exception text. Exceptions arise wherever a design
  artifact fails schema validation or a file read fails -- four `Schema.parse()` sites across
  `design-attestation-store.ts` and `design-options-store.ts`, plus the filesystem. The case with a
  test (an operator hand-editing `establishment: established` into the attestation, bypassing
  `lane design override`) prints a zod issue dump: `Unrecognized key(s) in object: 'establishment'`
  wrapped in JSON. It carries no stable identifier, and it is also the most informative thing that
  could be printed about a corrupted artifact.
- Design commands return exit codes 0/1/2/3, and the global handler also exits 2. So an unexpected
  failure and an in-spec refusal are **indistinguishable by exit code**.

Chosen because normalising exceptions into catalogued messages trades away exactly the detail that
makes a corrupted artifact diagnosable, and nothing observed so far needs the trade. It is recorded
here rather than left implicit so that "every message is catalogued" is not read as covering more
than it does — what holds is *every message a design command returns*.

**What would revisit it:** something needing to react to a design command's failure by identity
rather than by matching its text (tooling, a wrapper, a test asserting a specific failure), or a
real case where the exit code collision misleads. The shape it would take is a catalogued message
carrying the underlying detail as a placeholder, plus a distinct exit code for unexpected failure --
not a catalogued message that replaces the detail.

### Distinguishing the two critics

- **R47** User-facing documentation SHALL state the difference between the pre-existing nine-lens
  spec critic and the design critic introduced here, and when each is written.
- **R48** The residual-risk statement required by R11 SHALL appear both in the generated artifact and
  in the user-facing documentation, not in one of the two.

## Gherkin scenarios

```gherkin
Feature: the design track does not disturb existing lanes

  Scenario: a lane started without --design is unaffected
    Given a lane started without --design
    When the operator runs validate and advances through every phase
    Then no design artifact is required
    And no design gate diagnostic appears
    And the resulting lane state is byte-identical to the pre-change behaviour

Feature: independence is derived, not claimed

  Scenario: a producer-supplied classification is rejected
    Given a companion artifact that carries an independence classification field
    When the operator runs validate
    Then validation fails naming that field as producer-supplied

  Scenario: the closest relationship wins across multiple shapers
    Given the active revision was shaped by one party from a different provider
    And also by a party from the same provider and family as the critic
    When the classification is derived
    Then the result is the relationship with the shaper of the same provider and family
    And the reasons list both comparisons

  Scenario: missing model identity does not become undetermined when nothing could qualify
    Given the critic and a shaper share provider and family
    And neither records a model identifier
    When the classification is derived
    Then the result is the closest non-qualifying relationship
    And the result is not undetermined

  Scenario: missing provider does become undetermined
    Given the critic does not record a provider
    When the classification is derived
    Then the result is undetermined
    And the review does not qualify

Feature: a review must contain a review

  Scenario: a review without a reachable output is rejected
    Given a review entry with no reference to its own output
    When the operator runs validate
    Then validation fails naming the missing output reference

Feature: involvement cannot be claimed absolutely

  Scenario: an absolute no-involvement value is rejected
    Given a review recording that there was no prior involvement at all
    When the operator runs validate
    Then validation fails because only not-observed-within-a-recorded-scope is expressible

  Scenario: not-observed requires the scope artifact
    Given a review recording that no involvement was observed
    And no reference to the artifact establishing that scope
    When the operator runs validate
    Then validation fails naming the missing scope reference

Feature: qualifying requires both dimensions

  Scenario: a separate lineage that shaped the options does not qualify
    Given a critic from a different provider than every shaper
    And that critic is recorded as having shaped the options
    When qualification is evaluated
    Then the review does not qualify
    And the reasons name the involvement dimension

  Scenario: partial coverage is not establishment
    Given two options offered for decision
    And a qualifying review covering only the first
    When establishment is evaluated without an override
    Then the transition is blocked
    And the report shows per-option coverage before any count

Feature: the override is explicit and scoped

  Scenario: an override recorded as an artifact field is not accepted
    Given an override expressed only as a field in the companion artifact
    When establishment is evaluated
    Then the transition is blocked

  Scenario: a scoped override yields an honest status
    Given no qualifying review exists
    And the operator records an override scoped to the active revision and the uncovered options
    When establishment is evaluated
    Then establishment is reported as not-established
    And it is marked operator-asserted
    And the transition proceeds

  Scenario: a profile may forbid the override
    Given a profile that forbids the design override
    And an override recorded by the operator
    When establishment is evaluated
    Then the transition is blocked

Feature: the decision must name a reviewed option

  Scenario: selecting an option no qualifying review covered
    Given a decision record selecting an option covered by no qualifying review
    And no override scoped to that selected option
    When the implement gate is evaluated
    Then the transition is blocked
```

Feature: the vendored derivation must still resolve

  Scenario: a pin that no longer resolves upstream blocks
    Given a vendored derivation whose recorded upstream commit is unreachable upstream
    When the operator runs validate
    Then the transition is blocked
    And the diagnostic names an unresolvable pin, not a content mismatch

  Scenario: vendored bytes that no longer match the recorded tree hash block
    Given a vendored derivation whose bytes differ from the recorded tree hash
    When the operator runs validate
    Then the transition is blocked
    And the diagnostic names a content mismatch, not an unresolvable pin

Feature: activation leaves a trace

  Scenario: the design track records who activated it and when
    Given a lane started with --design
    When the operator inspects lane state
    Then the activation records the actor and the timestamp

Feature: the derived classification is never stored

  Scenario: no artifact and no lane state holds a classification
    Given a validated design track
    When the operator inspects lane state and the companion artifact
    Then neither contains an independence classification
    And the classification appears only in validation and display output

Feature: superseding a revision resets establishment

  Scenario: moving the active pointer does not carry establishment forward
    Given an established design revision
    When a new options revision is written and the active pointer moves to it
    Then establishment for the new revision starts from no qualifying coverage
    And the superseded revision and its reviews are still present

Feature: engine references carry no personal identity

  Scenario: an address-shaped human reference is rejected
    Given a critic recorded with a human reference containing an address-shaped string
    When the operator runs validate
    Then validation fails naming the prohibited format it matched

  Scenario: an opaque reference passes even if it could denote a person
    Given a critic recorded with an opaque human reference matching no prohibited format
    When the operator runs validate
    Then validation passes
    And the documented limitation is that this is a format check, not identity detection

Feature: reason text is catalogued, not concatenated

  Scenario: every emitted message resolves to a catalog identifier
    Given the design commands emit their full set of diagnostics
    When the messages are checked against the catalog
    Then every message resolves to a stable identifier
    And no message was assembled from sentence fragments

## Dependency and path cross-check (applies)

| Concern | Where it lives | Cross-check |
|---|---|---|
| Upstream contract shape | external contracts repo, `design-options` | Conformance test asserts accept/reject parity against the pinned upstream schema; the pin records commit + digest |
| Independence derivation | vendored copy under `packages/core/src/vendor/`, pinned by upstream commit + tree hash in an `UPSTREAM` marker | **Resolved (R37-R40).** The naive reading -- "import the published helper" -- violates the placement rule that implementation repos never import each other directly (linkage is file / CLI / protocol only). Three options were considered; vendoring is the only one that survives. Spawning it as a CLI requires the contracts repo to be present at runtime, and lane is published on npm to users who have no checkout of it. Reimplementing it violates the companion rule that the contract repo distributes validators rather than each repo writing its own. Vendoring a distributed file IS file linkage, and this repo already does it for five other contracts. |
| Existing spec critic | `packages/schemas/src/critic.ts` (9 lenses) | Distinct artifact, distinct purpose (reviews the chosen spec, may be self-authored). Must not be conflated in naming, docs, or state fields |
| Gate wiring | `packages/core/src/gate.ts` | `GateContext` is `{trigger, state, artifacts, profile}`; new artifacts must be added to `GateArtifacts`, not read ad hoc from disk inside a gate |
| `novel_surface` | `packages/schemas/src/estimate.ts` | Deliberately NOT used for activation; the gate does not read estimates today and this lane does not add that wiring |
| Digest circularity | options revision ↔ any in-repo reference to it | Editing an options revision invalidates digests that reference it; the active-pointer design plus content-addressed revisions is what keeps this from silently rotting |

## What this lane will be measured on before any promotion

Recorded here so the pilot is falsifiable rather than self-justifying:

- did a design decision **change** after a qualifying review, in at least one real lane
- did any review surface a **falsifier** that the options did not already list
- did any decision get **retracted** or superseded after review
- did downstream rework go down, or did the artifact only add maintenance cost

If, after the pilot lanes, none of the first three ever happened, the honest conclusion is that the
mechanism produced paperwork and it should be removed rather than promoted.
