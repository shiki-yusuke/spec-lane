# Spec — promotion invariants

## Premise

Recorded in `intent.yaml` (`method: live`). A lane reached `5_done` with `premise_evidence` holding
values that would have blocked the `1_intent → 2_spec` transition it had already passed. Evidence
preserved at `~/dev/ai-agent-lab/oss-growth/probes/chain-probe-2026-08-20/`.

## Non-goals

- **Not proving the lane was always passing.** Promotion is a predicate over the state being
  promoted. A digest created later proves nothing about earlier history; that would need append-only
  transition receipts, which this lane does not attempt.
- **Not re-running every historical gate.** Only the predicates that must hold in the final state.
- **Not a security boundary.** Local YAML and `lane-state.json` are editable by whoever runs the
  tool. The failure mode addressed here is accidental edits, merges, and misunderstood
  "strengthening" — not a hostile operator.
- **Not widening the spec_consensus digest to cover `intent.yaml`.** Rejected in architect review:
  the weakening happens *before* the later ack, so the ack would bind already-invalid content.

## EARS rules

- **R1** The system SHALL evaluate, at the transition into the final phase, every predicate that must
  hold in the state being promoted.
- **R2** The system SHALL NOT re-run gates whose subject is not part of that state.
- **R3** When any such predicate fails, the system SHALL refuse the transition, SHALL NOT record the
  completion overlay, and SHALL leave the phase unchanged.
- **R4** The system SHALL record, at lane start, the version of the gate contract in force.
- **R5** Where a recorded contract version does not match the installed one, the system SHALL refuse
  the transition until an explicit migration is acknowledged, and SHALL NOT reinterpret the lane
  under the newer contract silently.
- **R6** Where no contract version was recorded, the system SHALL state, in the diagnostic itself,
  that the lane is being evaluated under the installed contract and that this cannot be confirmed to
  match — an unverifiable assumption made visible rather than a silent pass.
- **R7** The system SHALL retain, at each gate crossing, a semantically readable record of what that
  gate saw — not only a digest of it.
- **R8** Where the state at promotion is strictly weaker than that record, the system SHALL report
  which dimension weakened and in which direction, and SHALL require a written rationale.
- **R9** Where the state is not weaker, the system SHALL require no rationale, so that a benign edit
  does not train the operator to acknowledge reflexively.

## Gherkin scenarios

```gherkin
Feature: a currently gate-failing lane cannot be labelled done

  Scenario: evidence weakened after its own gate passed
    Given a lane that passed its premise gate with confirmed evidence
    When the evidence is weakened to values that gate would have refused
    And promotion to the final phase is attempted
    Then the transition is refused
    And no completion overlay is written
    And the phase is unchanged
    And the diagnostic names both the failing predicate and how it weakened

  Scenario: the same lane once the evidence is restored
    Given the weakened lane above
    When the original evidence is restored
    And the identical promotion command is run
    Then the transition succeeds

Feature: promotion is a predicate over the final state, not a replay of history

  Scenario: gates whose subject is not part of the promoted state do not run
    When the applies-to matrix is evaluated for the promotion trigger
    Then the design-track gates are absent from it

Feature: an unverifiable assumption is stated, not hidden

  Scenario: a lane with no recorded contract version
    Given a lane that predates contract versioning
    When promotion is attempted
    Then the diagnostic says the lane is evaluated under the installed contract
    And says that this cannot be confirmed to match
    And the transition is not blocked on that ground alone

Feature: friction only where it is earned

  Scenario: an edit that weakens nothing
    Given a lane whose evidence prose is rewritten without weakening any predicate
    When promotion is attempted
    Then no rationale is required
    And the transition succeeds
```

## Dependency and path cross-check (applies)

| Concern | Where | Cross-check |
|---|---|---|
| Existing gate behaviour | `packages/core/src/gate.ts` | The new trigger is added alongside `phase_advance`, not in place of it; existing gates' `evaluate()` bodies are reused unchanged rather than reimplemented |
| Applies-to registration | `packages/core/test/gate-applies-to-matrix.test.ts` | Extended to the new trigger for every gate in its own list, so a later gate cannot skip registration silently |
| Catalog static check | `packages/cli/test/design-message-catalog.test.ts` | Slices `gate.ts` **positionally**; new gates must sit outside that range or be swept up as design-gate messages. Worked around by placement; the positional slicing is recorded as a defect in `verification.yaml` test_gaps |
| Consensus command | `packages/cli/src/commands/consensus.ts` | Deliberately not given a lane-state write side effect; `spec_consensus` keeps its existing digest binding rather than gaining a second, softer mechanism |
