# Changelog

All notable changes to `lane`/`spec-lane` are documented here. This project is pre-1.0
(alpha); breaking changes between minor releases are expected and are not accompanied by a
deprecation period.

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
  `CalibrationObservation`**, from the same measurement (`source: "claude_jsonl_auto"`,
  `confidence: "imported_lane"`), and both writes are idempotent upserts — re-running the
  same call updates both records in place rather than duplicating either one. If only one
  of the two writes succeeds, the command reports a non-zero exit naming which half
  failed, instead of a clean success message; re-running repairs the missing half safely.
- **No phase apportionment**: a lane-scope measurement is never split into fabricated
  per-phase records by a `phase_history` time-ratio guess.
- **`lane emit-metrics`** now groups a `scope:"lane"` entry under its own
  `whole-delivery` activity (`namespace: "spec-lane"`), replays the exact selector
  `calibrate` recorded when re-querying `agent-cost` for it, and reads an *effective*
  ledger composed from in-repo `cost_ledger` plus any done-overlay ledger delta (see
  below) rather than `cost_ledger` alone.
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
  after merge" principle rather than being a new exception to it.
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
