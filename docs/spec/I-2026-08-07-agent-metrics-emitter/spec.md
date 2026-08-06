# Spec — `lane emit-metrics`: agent-metrics:v1 token-usage emitter

## Intent summary

Give spec-lane a `lane emit-metrics <intent-id>` command that builds a `token-usage/v1`
snapshot (under the public `agent-metrics:v1` envelope) of a lane's real, measured
token/cost usage and either prints it (as a marker, ready to paste anywhere) or posts it
directly to the lane's PR as an upserted comment. The contract is normative and external —
[`agent-metrics-v1.md`](../../protocols/agent-metrics-v1.md) in
`ai-agent-skills-playbook`, commit `d99e480` — this feature is an emitter *for* that
contract, not a new contract of its own. No spec-lane-specific vocabulary reaches the
wire format; a harvester written by someone who has never heard of spec-lane must be able
to ingest what this command posts.

## Premise

Recorded in `intent.yaml`: `premise_evidence.required: false`. This is a user-requested
capability (a working generic emitter), not a defect fix — there is no existing broken
behavior to reproduce, and the "premise" is simply the user's own stated need.

## EARS rules

### Rule 1 (Ubiquitous): schema-conformant output
The system shall serialize `lane emit-metrics <intent-id>`'s output as a payload that
validates against `envelope.schema.json` and `token-usage.schema.json` (vendored fixtures,
see "Contract integration" below) with no extra fields (`additionalProperties: false`
throughout) and no fields renamed or reinterpreted from their contract meaning.

### Rule 2 (Ubiquitous): correct upsert identity
The system shall compute `upsert_key` as `"am1_" + hex(sha256(JCS({schema, repository,
subject})))` using RFC 8785 JCS canonicalization, byte-identical to
`contracts/agent-metrics/v1/verify-fixtures.mjs`'s own `recomputeUpsertKey`, for every
payload it emits.

### Rule 3 (Event-driven): activity-grouped, session-deduped measurement
When building a snapshot, the system shall group KPI-eligible `cost_ledger` entries by
`activity` (namespace `"spec-lane"`, name = the entry's `phase`), deduplicate `session_ids`
within an activity, and call the telemetry adapter's `measure()` at most once per activity.

### Rule 4 (Unwanted behavior): ambiguous session attribution fails closed
If the same session id appears in more than one activity's `session_ids` after
deduplication, the system shall abort the entire emit with reason
`ambiguous_session_attribution`, print nothing to stdout, and post nothing — never a
partial snapshot.

### Rule 5 (Unwanted behavior): unattributable entries are never fabricated
For a ledger entry the system cannot honestly attribute a token/cost breakdown to (manual
source, empty `session_ids`, or the telemetry adapter returning no matching rows for the
recorded ids), the system shall omit it from `data.records` and instead add one
`data.coverage.omissions[]` entry with a machine-readable `reason` — never a fabricated
record.

### Rule 6 (Unwanted behavior): hard-fail conditions abort the whole emit
If, while building a snapshot, the system encounters an unrecognized `token_kind` from the
telemetry adapter, an `AgentCostMeasureResult.protocol_version` other than `"measure/v1"`,
a payload that fails schema validation, or a personal-dimension violation (the protocol's
own 11-key forbidden set — see "Dependency and path cross-check" DEP-08), the system shall
abort before printing or posting anything.

### Rule 7 (Event-driven): `--post` upserts by identity, never duplicates
When `--post` is given, the system shall search the target PR's existing comments for one
that decodes to an `agent-metrics:v1` marker whose recomputed `upsert_key` matches the new
payload's own, and update that comment in place if found, or create a new comment only if
none is found.

### Rule 8 (Ubiquitous): honest coverage on the empty case
When a lane has no KPI-eligible, attributable ledger entries at all, the system shall still
emit a valid snapshot with `data.records: []` and `data.coverage.status: "no_data"` — never
suppressing the emit entirely, so "nothing posted" and "measured, and there was nothing to
measure" stay distinguishable to a consumer.

## Gherkin scenarios

### Scenario 1: minimal happy path, single activity
```gherkin
Given a lane with one KPI-eligible cost_ledger entry at phase "3_implement"
  And that entry's session_ids resolve to real, priced agent-cost measure rows
When I run `lane emit-metrics <intent-id>`
Then stdout contains exactly one well-formed "<!-- agent-metrics:v1 ... -->" marker
  And the decoded payload's data.coverage.status is "complete"
  And the decoded payload's upsert_key matches recomputing the JCS recipe over {schema, repository, subject}
```

### Scenario 2: ambiguous session attribution fails closed
```gherkin
Given a lane with two cost_ledger entries at different phases
  And both entries list the same session id in their session_ids
When I run `lane emit-metrics <intent-id>`
Then the command exits non-zero
  And stderr reports reason "ambiguous_session_attribution"
  And nothing is printed to stdout
```

### Scenario 3: unattributable entries become honest omissions, not fabricated records
```gherkin
Given a lane with one manual-source cost_ledger entry (no session_ids)
  And no other KPI-eligible entries
When I run `lane emit-metrics <intent-id>`
Then the emitted payload's data.records is empty
  And data.coverage.status is "no_data"
  And data.coverage.omissions contains one entry with reason "manual_source_no_breakdown"
```

### Scenario 4: `--post` upserts an existing comment rather than duplicating
```gherkin
Given a PR already has a comment containing an agent-metrics:v1 marker for this lane's exact subject
When I run `lane emit-metrics <intent-id> --post` again (e.g. after a re-measurement)
Then the existing comment is updated in place
  And no new comment is created
  And the PR's comment count is unchanged
```

### Scenario 5: cache-write granularity is preserved, never collapsed
```gherkin
Given agent-cost measure returns rows with token_kind cache_write_5m and cache_write_1h for the same activity/agent/model
When the snapshot is built
Then data.records contains two separate rows, one per token_kind
  And neither is merged into a generic "cache_write" bucket
```

## Dependency and path cross-check (applies)

**Applicability**: applicable. This change introduces (a) a new port (`MetricsPublisher`)
and a new adapter, (b) a new CLI command with a new external wire contract, and (c)
touches an area — reading `cost_ledger` and calling the telemetry adapter — where existing
code already reads the same resource for a different purpose (calibration). Per-item
detail below.

### DEP (new dependencies/changes this introduces)

| ID | What |
|---|---|
| DEP-01 | New `MetricsPublisher` port (`core/ports/metrics-publisher.ts`): `upsert(marker, {repository, prNumber}): Promise<{action: "created"\|"updated", url}>`. |
| DEP-02 | New `GithubCommentMetricsPublisher` adapter (`adapters/src/metrics/github-comment.ts`), implementing DEP-01 via `gh api` (list PR comments, decode+verify any `agent-metrics:v1` marker found, compare recomputed `upsert_key`, `PATCH` on a match or `POST` a new comment otherwise). |
| DEP-03 | Tightened `AgentCostRowSchema` (`schemas/src/agent-cost.ts`): from an opaque `z.record` to the real shape agent-cost's `measure`/`report` both actually emit (`agent`, `model`, `token_kind`, `tokens`, `priced_tokens`, `unpriced_tokens`, `estimated_cost_usd`, `credits`, `pricing_status`). |
| DEP-04 | New `packages/schemas/src/agent-metrics.ts`: `AgentMetricsEnvelopeSchema` / `TokenUsageDataSchema` / `TokenUsageRecordSchema` / `CoverageSchema`, structurally mirroring the vendored `envelope.schema.json`/`token-usage.schema.json` exactly (same required fields, same `additionalProperties: false`). |
| DEP-05 | New `core/application/metrics-service.ts`: builds the snapshot (activity grouping, session dedupe, ambiguous-attribution detection, omission recording, `upsert_key` computation via RFC 8785 JCS, marker serialization). |
| DEP-06 | New `cli/src/commands/emit-metrics.ts` + `main.ts` wiring for `lane emit-metrics <intent-id> [--post] [--pr N]`. |
| DEP-07 | Vendored contract fixtures (11 files from `contracts/agent-metrics/v1/fixtures/`) as spec-lane test fixtures, plus `contracts/agent-metrics/UPSTREAM` recording the playbook commit SHA and a fixture-tree hash. |
| DEP-08 | New protocol-exact personal-dimension scanner matching the contract's own 11-key forbidden set (`author, reviewer, assignee, owner, user_id, username, email, display_name, handle, chat_id, real_name`) — **not** a reuse of `core/goodhart.ts`'s existing 7-key `PERSONAL_DIMENSION_KEYS` (see PATH-06). |

### PATH (existing code that touches the same resources/concerns)

| ID | Existing path | References DEP? | Note / TEST-ID |
|---|---|---|---|
| PATH-01 | `adapters/src/telemetry/agent-cost.ts` (`AgentCostTelemetryAdapter.measure`) | References DEP-03 transitively (returns `AgentCostMeasureResultSchema`-validated data as-is; never destructures `.rows` fields itself) | Verified safe by reading the adapter; no behavior change. `TEST-01`: existing adapter test suite must stay green after DEP-03 lands. |
| PATH-02 | `adapters/src/budget/codex-budget.ts` (reads `AgentCostReportResultSchema.rows`) | Does not reference DEP-03 — a separate schema (`AgentCostReportRowSchema`), confirmed by reading the file | `TEST-02`: existing codex-budget tests must stay green untouched (regression guard, not new behavior). |
| PATH-03 | `core/application/calibrate-service.ts` (`buildObservationFromMeasurement`) | Does not reference DEP-03 — reads only `measurement.total.totals`, never `.rows` | `TEST-03`: existing calibrate-service tests must stay green untouched. |
| PATH-04 | `core/ports/vcs.ts` / `adapters/src/vcs/github.ts` (`VcsAdapter`) | Does not reference DEP-01/02 — sol's own instruction is explicit that `VcsAdapter` must not grow a comment-posting method for this | No test needed; this is an intentional non-extension, documented here so a future reader doesn't "fix" the gap by bolting comment-posting onto `VcsAdapter`. |
| PATH-05 | `adapters/src/tracker/github.ts` (`GithubTrackerAdapter.annotatePr`) | **Does not** reference DEP-01/02 — it already posts PR comments via `gh pr comment`, but always creates a new one (no upsert-by-identity). This is the same underlying resource (PR comments) as DEP-02, handled by unrelated, non-upserting code. | `TEST-05` (must implement): DEP-02's own upsert logic must be independently correct — do not assume `annotatePr`'s existence means "PR commenting is already solved here." Do not modify `annotatePr`; it is out of scope. |
| PATH-06 | `core/goodhart.ts` (`PERSONAL_DIMENSION_KEYS`, 7 keys) | **Does not** cover the protocol's forbidden set — missing `username`/`display_name`/`handle`/`chat_id`/`real_name` | `TEST-06` (must implement): DEP-08's scanner is exercised with the exact protocol key set, independently of `goodhart.ts`. Do not extend or alias `goodhart.ts`'s own list — it backs an unrelated, spec-lane-internal feature (ledger/export) with its own versioning. |
| PATH-07 | `core/ledger.ts` (`LedgerEntry.session_ids`/`.included_in_kpi`/`.phase`/`.scope`/`.source`) | References DEP-05 directly — the snapshot builder's only source of which sessions belong to which activity | `TEST-07`: covered by Rule 3/4/5/8's scenarios directly. |
| PATH-08 | `cli/src/main.ts` (commander wiring) | References DEP-06 directly (new subcommand registration) | `TEST-08`: e2e coverage that `lane emit-metrics --help` and the command itself are actually reachable through the packed CLI. |
| PATH-09 | `cli/src/state-store.ts` / `intent-store.ts` | References DEP-05/06 directly (`subject.id` and `cost_ledger` both come from these) | Covered by Rule 1/3's scenarios. |
| PATH-10 | `LedgerEntrySchema.source` enum values | References DEP-05 directly (`"manual"` is exactly the omission case in Rule 5/Scenario 3) | Covered by Scenario 3. |

**Blind-spot disclaimer** (per this project's own skill discipline): this table does not
see (i) how the snapshot builder's own internal grouping logic holds session-id state
across activities (the ambiguous-attribution check itself, Rule 4 — a wrong internal data
structure there could silently under- or over-detect it), (ii) the actual shape of
`agent-cost measure`'s real JSON output on this machine vs. what's assumed here, (iii)
whether the premise/success-criteria for this feature were genuinely confirmed (handled
separately, not by this table). `critic.yaml`'s `test_coverage` lens re-searches
independently of this table's own axis choices.

**Human-review band approval (recorded, cross-cutting stopping rule)**: this change's
applicability check above resolved to "applicable," so per the skill's own
cross-cutting-band rule, advancing to Phase 3 required the reviewer's explicit approval
of this table, its `TEST-ID` mappings, and the axis/test-strategy choice. **Approved by
team-lead, 2026-08-07**, with one bundled condition: PATH-06's decision (a new,
contract-exact personal-dimension scanner kept separate from `core/goodhart.ts`'s own
list) is approved for this v1, on the condition that both files carry a one-line
cross-reference comment to each other (not a merge) so the existence of two separate
personal-dimension key sets in one codebase doesn't silently drift apart over time. A
full consolidation refactor is explicitly out of scope for this change.

## Implementation scope (Phase 3 hint)

`packages/schemas/src/agent-metrics.ts`, tightened `packages/schemas/src/agent-cost.ts`,
`packages/core/src/ports/metrics-publisher.ts`, `packages/core/src/goodhart-agent-metrics.ts`
(protocol-exact scanner, kept separate from `goodhart.ts` per PATH-06), `packages/core/src/application/metrics-service.ts`,
`packages/adapters/src/metrics/github-comment.ts`, `packages/cli/src/commands/emit-metrics.ts`,
vendored fixtures + `contracts/agent-metrics/UPSTREAM`, `skills/lane-finish/SKILL.md` one-line
mention, `docs/design.md` new subsections, `CHANGELOG.md`, version bump to 0.3.0.

## Verification strategy (Phase 4 hint)

| Check | Tool | Expected |
|---|---|---|
| Vendored-fixture parity | unit test replaying `verify-fixtures.mjs`'s own logic in TS against the vendored fixtures | All 11 fixtures resolve to their `expected-results.json` outcome |
| Golden marker reproduction | fixture lane-state + fake `measure/v1` response → built snapshot | Matches a vendored valid fixture's `data` shape field-for-field |
| Invalid-input rejection | one test per rejected-design/hard-fail rule above | Each aborts with the documented reason, nothing printed/posted |
| `upsert_key` recipe parity | recompute over each vendored valid fixture's own `{schema, repository, subject}` | Matches the fixture's own declared `upsert_key` |
| e2e | packed CLI, `lane emit-metrics --help` reachable, a real snapshot printed for a fixture lane | Exit 0, valid marker on stdout |
