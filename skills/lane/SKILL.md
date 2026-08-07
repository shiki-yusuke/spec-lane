---
name: lane
description: Delivery lane orchestrator's default entry point. Drives Phase 1 (Intent) through Phase 4 (Verify/PR) using `lane status <intent-id>` to determine the current phase, then advances a single phase or forward to the next gate (never advances past PR creation on its own). Use for starting/resuming a lane, checking status, moving to the next phase, or opening a PR, or for a plain request like "move this lane forward" / "write the spec" / "implement this" / "verify and open a PR" that doesn't name a specific phase. For Phase 5 (post-merge closeout) use lane-finish instead.
---

# Lane Orchestrator (drives Phase 1 -> 4)

This skill is the command center that moves a lane from wherever it currently is toward
the next gate. It does not replace judgment about spec content, code quality, or risk —
it only governs *which* phase runs next and *where it must stop*.

> **Router invariant**: this is the default entry point for Phase 1-4. Even when the user
> names a single phase ("write the spec", "implement", "verify"), always start by running
> `lane status <intent-id>` to confirm the current phase, then run whatever this skill says
> for *that* phase. Never invent phase logic outside what's described here. Phase 5 (done),
> anything post-merge, and multi-lane batch closeout belong to `lane-finish` — never run
> `advance --phase 5_done` from this skill.

## When to use this

- "move this lane forward", "take this to PR", "advance to the next phase", "resume this lane"
- "Phase 3, go" (a single named phase is fine too — still confirm via `status` first)
- Starting a brand-new lane ("start a lane for X")

> **Phase 5 is out of scope here.** This skill's forward-drive always stops once a PR is
> open (Phase 4). Post-merge closeout is [lane-finish](../lane-finish/SKILL.md).

## Basic flow (always in this order)

1. **Confirm the current phase.** Run `lane status <intent-id>`. Trust `current_phase` over
   any assumption about where the lane "should" be.
   - If the lane doesn't exist yet (`lane status` fails), this is a **new lane**: go to
     "Phase (none) -> 1_intent" below.
2. **Decide how far to go.** A single named phase runs and stops. "Move it forward" /
   "take it to PR" / no scope given means run phase-by-phase until a gate stops you or
   Phase 4 is reached.
3. **Run the phase** (see the table below).
4. **Stop at any gate** (see "Stopping rules") and report to the user what's blocking and
   what decision they need to make.

## Phase-by-phase

| current_phase | do this | then |
|---|---|---|
| (none) | `lane start <intent-id> --business-goal "..." --user-visible-intent "..." --primary-user "..." --risk low\|medium\|high --affected-layer <layer> [--affected-layer ...] --allowed-path <glob> [--allowed-path ...]`. Fill in real content — the flags exist so intent.yaml doesn't ship with placeholder text. **Before writing spec.md** (not after), work through "Premise evidence" below and record `premise_evidence` in intent.yaml. Then `lane validate <intent-id>`. | now at 1_intent |
| 1_intent | Write `docs/spec/<intent-id>/spec.md` (EARS requirements + Gherkin scenarios), including the "Dependency and path cross-check" section below when it applies. Write `docs/spec/<intent-id>/critic.yaml` (the 9-lens self-review: lifecycle_management / error_handling / security / performance / a11y / i18n / architecture / test_coverage / documentation). Each lens has its own `result: applicable\|not_applicable\|unknown` (`applicable` requires `finding`+`taxonomy`; `unknown` requires `open_question`); `taxonomy` is a **closed 10-value enum** (`missing_state`\|`wrong_assumption`\|`too_implementation_specific`\|`test_missing`\|`architecture_violation`\|`compatibility_missed`\|`context_variant_missed`\|`lifecycle_missed`\|`scope_ambiguity`\|`observability_gap`), not free text — `lane validate` rejects any other value; the overall `decision: pass\|needs_revision\|blocked` is a single top-level field, not per-lens. `test_coverage`'s own independent re-search obligation (below) applies here too. Before writing critic.yaml, run `lane knowledge-query` to fold matches into each lens's `knowledge_candidates` (design.md §5.4) — this is the knowledge-DB injection feature, not optional decoration. `--paths` is a **repeatable, single-value** flag, not one flag taking a space-separated list — pass it once per file: `lane knowledge-query --paths <file-1> --paths <file-2> ...` (repeat for every file this change will touch; `--paths a b` fails with "too many arguments"). Also run `lane estimate <intent-id> [--impact-scan-file <report.md>] --adopt` if a cost/effort estimate is useful before committing to the work; without `--impact-scan-file` the estimate falls back to a generic reference table (still recorded, just marked `experimental`/low-confidence). Then `lane validate <intent-id>` (schema-checks intent.yaml always, and critic.yaml if it exists yet; also runs the premise_evidence/success_criteria gates as a diagnostic — see "What `validate`/`advance` actually enforce" below), then `lane advance <intent-id> --phase 2_spec`. | now at 2_spec |
| 2_spec | Create a branch, write the real code + tests. Run this project's own lint/typecheck/test before moving on — this skill doesn't define those commands; use whatever the target repo's own tooling is. | run `lane advance <intent-id> --phase 3_implement` when it's green |
| 3_implement | **Success-criteria cross-check** (below) first: if spec.md has a "Dependency and path cross-check" section, re-check it against the final diff before writing verification.yaml. Then write `docs/spec/<intent-id>/verification.yaml` (test_matrix mapping EARS rules to tests, test_gaps, manual_verification, goal_stopping_condition, `success_criteria_matrix`, `cross_check_intent_vs_spec`). Then initialize spec_consensus: `lane consensus <intent-id> --refresh --spec-ssot-ref <path to the spec this change traces to>`. If the implementation deviates from the spec at all (including "no deviation, confirmed"), record it: `lane consensus <intent-id> --add-deviation --spec-ref <ref> --actual "<what actually happened>" --action accept\|fix\|update_spec`, then `--resolve-deviation <spec-ref> --rationale "..."`. Once every deviation is resolved, ack it: `lane consensus <intent-id> --ack --reviewer-kind self\|independent_agent\|human --reviewer-id <id>` (a `self` ack at effective risk=high needs `--override-reason`). Run `lane validate <intent-id>` and confirm no gate errors. Then `lane advance <intent-id> --phase 4_verify`. From this point on, **do not edit spec.md or verification.yaml again** — any edit invalidates the ack's digest binding (the digest covers spec.md's content and verification.yaml's own fields; it does not cover critic.yaml at all) and you would have to re-refresh/re-ack. Leave critic.yaml alone too as a matter of procedural discipline from here on — editing it after this point isn't part of what this flow accounts for, even though it doesn't invalidate anything. Commit, push, and open a PR (`git`/`gh` directly — no CLI wrapper for this in v1). Optionally run `lane consensus <intent-id> --emit-pr-section` and paste its output into the PR description. | PR open, **stop** |
| 4_verify | **Stop here.** The PR is open; merging is the user's call. Before stopping, run `lane validate <intent-id>` — this dry-runs the same spec_consensus gate `advance --phase 5_done` will enforce later (a missing/invalidated ack surfaces now instead of after merge), and re-runs success_criteria's own before_pr_publish double-check one more time (that gate is not re-applied at the literal 4_verify->5_done transition itself, only here and at 3_implement->4_verify). | — |

### What `validate`/`advance` actually enforce

`lane advance` is the last mechanical backstop for a lane that skipped `lane validate` entirely — it re-runs the same gates at the moment of transition and refuses to change lane-state.json if any gate reports an error. It is **not** the primary way these gates are meant to be caught; `lane validate` (run early, as part of the flow above, not as an afterthought) is. Two things the gates can only check the *shape* of, never the *truth* of:

- **Premise evidence** (design.md §3.9): if this change is AI-originated, or the symptom was never directly observed, and it introduces a new guard/branch/completion condition — or it's unclear whether either of those is true — confirm the premise actually exists (against a real system, existing data, or at minimum a static trace of the code) before writing spec.md, and record it in intent.yaml's `premise_evidence`. Unrecorded is only ever a warning (the CLI cannot itself decide whether this change needed the check); `required:true` with `reproduced:false` is a hard error.
- **Success criteria** (design.md §3.9): before opening a PR, cross-check every line of `intent.intent.success` against the final diff **one at a time**, in both directions — ① does the diff actually cover this condition, ② does spec.md/verification.yaml's own decisions imply a *stronger* condition than intent.yaml (the SSOT) currently states, in which case update intent.yaml to match rather than leaving it weaker than what was actually built. Record the result as `success_criteria_matrix` (with a `negation_test` for each row — something that shows the negative case actually fails, not just that the positive case passes) and `cross_check_intent_vs_spec` (record that direction ② was performed even if it found nothing). `covered_by: none` on any row blocks the PR until a human confirms whether it's a real gap, a criterion that needs rewriting, or genuinely out of scope.

Both checks share the same limit: they only prove "a record exists and its shape is valid," never that the record's content is honest. Fail-closed enforcement for either one is a skill/human responsibility, not something the CLI can substitute for.

### Premise evidence (before writing spec.md)

Work through this before drafting spec.md, not after:

1. Decide whether this change needs the check: is it AI-originated, or does the symptom come from something that was never directly observed — **and** does it introduce a new guard, rejection branch, state, or completion condition? If either is unclear, treat it as applicable (fail-closed).
2. If applicable, confirm the premise's real-world existence: run it live against a real system, or find it in existing data/records (either counts as strong evidence), or at minimum trace the code path statically (the weakest option — upgrade to live/data if at all possible).
3. Record the result in intent.yaml's `premise_evidence`: `required: true` with `method`/`reproduced`/`evidence` (the actual action taken and what was observed, not "should be fine"), or `required: false` with a `reason` for why it doesn't apply.
4. If `reproduced` came back false, do not proceed to spec.md — pause, cancel, or re-scope to a confirmed problem, and get the user's input.

### Dependency and path cross-check (spec.md, when it applies)

A cross-cutting check embedded inside spec.md, not a separate document:

1. **Applicability (fail-closed)**: does this change (a) introduce a new dependency, state, guard, or completion condition, or (b) touch an area where multiple existing paths handle the same resource/input/data shape — or is either unclear? If yes or unclear, do this section. If clearly neither, write one line: "Not applicable (reason)."
2. List the dependencies/changes being introduced as `DEP-01..`, then the existing paths/call sites that need to respect them (including ones outside the diff) as `PATH-01..`, then build a cross-check table (PATH × DEP: references it / does not / unknown).
3. Every "does not" or "unknown" cell gets promoted to a Gherkin scenario or a named regression-test requirement (`TEST-01..`), which Phase 3 must actually implement. This cross-cutting section is allowed to exceed the usual EARS-rule-count / Gherkin-scenario-count guidance (compress with Scenario Outline / equivalence grouping instead).
4. If a path outside `allowed_paths` turns out to be necessary, don't proceed silently — go back to the user for a scope re-approval.
5. **Human-review band**: if step 1 found this applicable or unclear, say so explicitly near the top of spec.md, and do not advance to Phase 3 until the cross-check table, its TEST-ID mappings, and the axis/test-strategy choice all have the user's **explicit** approval (writing the section is not itself approval — `lane validate` does not check this section's content at all, so this gate is enforced by skill discipline, not the CLI).
6. This table goes stale as implementation proceeds — Phase 3's own cross-check (below) re-verifies it against the final diff.
7. **Do not treat this table as a complete substitute for review.** In practice it has structural blind spots in at least three areas it does not look at by construction: (i) how the implementation actually holds its internal state (constants/enums/heuristics can hide a scope gap the table never named), (ii) assumptions about the shape of external data, (iii) whether the premise and the success criteria were actually confirmed (covered separately above and in "Success criteria" — not by this table). `critic.yaml`'s `test_coverage` lens (below) exists specifically to look for what this table's own axis choices might have missed, not to re-confirm what it already found.

### critic.yaml's test_coverage lens: independent re-search obligation

Don't assume the dependency/path cross-check table above is complete. Independently re-search sibling paths, callers, and data-shape variants on your own (the goal is to catch a wrong axis choice in the table itself, not just re-verify its existing rows). Check every `DEP` column and every required cell for evidence + a `TEST-ID` mapping. Any gap in a path, an axis, or a test mapping — or an unknown semantic — is a **must**-level finding even if it's a single instance, and sets `decision: needs_revision`.

### Success criteria (Phase 3, before PR)

See "What `validate`/`advance` actually enforce" above for what the gate checks; this is the procedure:

1. Re-check the dependency/path cross-check table (if spec.md has one) against the actual final diff — implementation always drifts from the plan somewhat. Record any staleness in verification.yaml; if a genuinely new path has no test yet, add the test before proceeding, don't just note the gap.
2. Build `success_criteria_matrix`: one row per `intent.intent.success` line, `criterion` transcribed **verbatim** (not summarized — the gate's matching is exact-text-after-normalization, never fuzzy), `covered_by`/`evidence`/`negation_test`.
3. Record `cross_check_intent_vs_spec` (direction ②, even if it found nothing).
4. Only after the matrix is clean and consensus is ack'd: `lane validate` -> `lane advance --phase 4_verify` -> commit/push/PR, in that order, with no further edits to spec.md or verification.yaml afterward (an edit after ack invalidates the digest binding — critic.yaml isn't part of that digest, but leave it alone too from this point on).

## Stopping rules (gates — never proceed past these without the user)

- **1_intent -> 2_spec**: `declared_risk` medium or higher -> stop for intent approval before
  writing spec.md.
- **Cross-cutting human-review band (1_intent -> 2_spec)**: if the "Dependency and path
  cross-check" section's own applicability check (above) came back applicable *or*
  unclear, do not advance to 2_spec until the user has given **explicit** approval of the
  cross-check table, its `TEST-ID` mappings, and the chosen axes/test strategy. Writing the
  section is not approval by itself, and `lane validate` never checks this section's
  content — this stop is enforced by following this procedure, not by the CLI.
- `premise_evidence.required:true` with `reproduced:false` -> hard stop before 1_intent ->
  2_spec; do not draft spec.md against an unconfirmed premise (see "Premise evidence" above).
- **2_spec -> 3_implement**: critic.yaml `decision: needs_revision` (2+ must-level findings)
  or `blocked` (a forbidden_paths violation or a serious security finding) -> stop.
  Reviewing the spec content itself with the user before implementing is also recommended
  for anything non-trivial.
- **3_implement**: `declared_risk: high` needs approval before implementation starts.
  Hard-halt immediately on: an existing e2e/regression test going from green to red, a
  change outside `allowed_paths`, anything touching migrations/IaC/lockfiles, or anything
  touching auth/billing/personal data.
- **4_verify -> merge**: always stop once the PR is open and reviewed. Merging is the
  user's decision, never automatic. If review comes back with 2+ must-level findings,
  `lane advance <intent-id> --phase 2_spec` to re-enter spec (confirm this with the user
  first, don't loop back automatically).
- **Runaway retries**: stop after 3 consecutive lint/typecheck-fix failures, or if the same
  error recurs after a fix attempt. Don't keep retrying blindly — report what's failing.

## Forward-drive invariants

- The ceiling is **PR creation (Phase 4)**. Never advance to Phase 5 from this skill —
  that's `lane-finish`, and it only runs after the user confirms the PR merged.
- Re-run `lane status` after each phase transition rather than assuming `advance` succeeded
  silently.
- Always tell the user how far you got and what decision (if any) they need to make next.

## Evolved features woven into the flow above

- **Estimate/calibrate** (design.md §5.1): `lane estimate` at Phase 1 gives a cost/effort
  prediction with an honest confidence signal (`population_condition.method` /
  `experimental`); `--adopt` records it as the baseline this lane will later be measured
  against. Measurement happens post-merge (`lane-finish`), not here.
- **lane next** (design.md §5.2): run standalone, any time, to see which lanes (with an
  adopted baseline) fit the current Claude/Codex resource budget — not part of this
  skill's own flow, but useful before deciding to start new work.
- **spec_consensus** (design.md §5.3): woven into Phase 3->4 above (`lane consensus`).
- **knowledge** (design.md §5.4): woven into Phase 1->2 above (`lane knowledge-query` at
  spec/critic time); `lane knowledge-append` records a new lesson any time review turns
  one up, regardless of phase.

## Trigger keywords

- "move this lane forward" / "take it to PR" / "next phase"
- "write the spec" / "implement this" / "verify and open a PR" (phase confirmed via status)
- "start a lane for ..."
