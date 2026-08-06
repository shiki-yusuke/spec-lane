# Changelog

All notable changes to `lane`/`spec-lane` are documented here. This project is pre-1.0
(alpha); breaking changes between minor releases are expected and are not accompanied by a
deprecation period.

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
