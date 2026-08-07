# spec-lane

Package: `spec-lane` · Command: `lane` · Repository: [`shiki-yusuke/spec-lane`](https://github.com/shiki-yusuke/spec-lane)

A local-first delivery workflow for AI-assisted changes.

It stops a change before it moves forward when critical assumptions, acceptance
criteria, or required verification evidence are missing, while keeping consequential
decisions explicit for a human reviewer.

```text
Intent -> Spec/Critic -> Implement -> Verify -> Done
```

This is a from-scratch TypeScript rewrite of a private Python tool the author built and
used personally; the source project has no public existence, so this repo stands on its
own.

## What it stops

| Check | Failure it targets | Where it happens |
|---|---|---|
| Premise evidence | Implementing against a problem that was never confirmed to actually exist | Before `spec.md` is written |
| Dependency × Path cross-check | A cross-cutting change missing a path, state, or dependency it should have accounted for | Spec / before implementation |
| Success criteria matrix | An acceptance criterion with no corresponding evidence in the final diff | Verify / before opening a PR |
| Spec consensus | A spec/implementation deviation left unresolved, or a spec/verification edit nobody has acknowledged | Before completion |

Dependency × Path cross-check is **not** a fully automated CLI gate — it's a
skill-driven procedure that requires explicit human approval when it applies. The CLI
can check that a record exists and is shaped correctly; it can't check that its content
is honest, or that its own choice of axes was complete. See "How the gates work" below.

## Install

Requires Node.js >= 22.

```bash
npm install -g spec-lane
lane --version
```

### From source (for contributing to `lane` itself)

Requires [pnpm](https://pnpm.io/) too (`corepack enable` gets you `pnpm` on a recent Node
without a separate install). This checkout is a pnpm workspace of four `@lane/*` packages
(`schemas`/`core`/`adapters`/`cli`) that `pnpm -r run build` compiles independently — the
published `spec-lane` package above is instead a single self-contained bundle produced by
`node scripts/build-publish.mjs` from that same source (see that script's header comment for
why); you don't need to know about the bundle step to work on `lane` day to day.

```bash
git clone https://github.com/shiki-yusuke/spec-lane.git
cd spec-lane
pnpm install
pnpm -r run build
```

Make the `lane` command available globally from this checkout:

```bash
cd packages/cli
npm link
cd ../..
lane --version
```

(`npm link` creates a symlink from your global npm bin dir to this checkout's built CLI —
uninstall any time with `npm unlink -g @lane/cli`. If you'd rather not touch your global
npm state, invoke it directly instead: `node packages/cli/dist/main.js <command>`.)

### Optional: agent-cost, for cost calibration, `lane next`, and `lane emit-metrics`

`lane calibrate`, the Codex side of `lane next`, and `lane emit-metrics` all call out to
[agent-cost](https://github.com/shiki-yusuke/agent-cost), a separate CLI that reads local
Claude Code / Codex CLI logs to measure real token usage and cost. `lane estimate` itself
never calls it — it only ever reads the local calibration population that `lane calibrate`
has already written. Install agent-cost (see that repo's own README) and make sure
`agent-cost` resolves on PATH, or pass `--agent-cost-bin <path>` to the commands that need
it. Without it, everything else in `lane` still works — you just won't have real usage
numbers to calibrate or emit against.

## Quick start

Run these from the root of whatever repo you want to manage lanes for (`lane` looks for
`docs/spec/` relative to your current directory by default — see "Configuration" below).
This is the mechanical skeleton; the full procedure (including exactly what "premise
check" and "dependency/path cross-check" require) lives in
[`skills/lane/SKILL.md`](skills/lane/SKILL.md) and
[`skills/lane-finish/SKILL.md`](skills/lane-finish/SKILL.md) — point an AI coding agent at
those two files and it can drive the whole flow below directly.

```bash
# 1. Start a new lane
lane start I-2026-01-15-my-first-change \
  --business-goal "Reduce onboarding friction in the setup flow." \
  --user-visible-intent "New users see setup steps in the right order." \
  --primary-user "new_user" \
  --risk low

# 2. Before writing spec.md: record premise evidence in intent.yaml (does this change
#    rest on a problem you actually confirmed exists? live observation, existing data, or
#    at minimum a static code trace). lane validate checks the record's shape, not its
#    honesty.
lane validate I-2026-01-15-my-first-change

# 3. Write docs/spec/I-2026-01-15-my-first-change/spec.md (EARS rules + Gherkin
#    scenarios), including a Dependency x Path cross-check section if this change is
#    cross-cutting or touches a shared path -- that section needs explicit human approval
#    before step 6 below, not just existing on disk.

# 4. Write docs/spec/I-2026-01-15-my-first-change/critic.yaml (the 9-lens self-review),
#    then check both artifacts:
lane validate I-2026-01-15-my-first-change
lane advance I-2026-01-15-my-first-change --phase 2_spec

# 5. Implement the change (branch, real code + tests), then:
lane advance I-2026-01-15-my-first-change --phase 3_implement

# 6. Write verification.yaml, including a success_criteria_matrix that cross-checks every
#    line of intent.yaml's own intent.success against the final diff, then resolve
#    spec_consensus:
lane consensus I-2026-01-15-my-first-change --refresh \
  --spec-ssot-ref docs/spec/I-2026-01-15-my-first-change/spec.md
lane consensus I-2026-01-15-my-first-change --ack --reviewer-kind self --reviewer-id you
lane validate I-2026-01-15-my-first-change
lane advance I-2026-01-15-my-first-change --phase 4_verify

# 7. Open a PR. Optionally attach a standardized token-usage snapshot to it:
lane emit-metrics I-2026-01-15-my-first-change --post

# 8. Once the PR is merged:
lane advance I-2026-01-15-my-first-change --phase 5_done \
  --merged-at 2026-01-16T09:00:00Z --pr-url https://github.com/you/your-repo/pull/1
```

Run `lane <command> --help` for every flag a command accepts.

### Two layers of enforcement

`lane validate` is the early-feedback path — run it any time, at any phase, to see
what's currently missing. It never changes phase and never blocks anything by itself.

`lane advance` is the final mechanical backstop. Immediately before changing phase state
it re-evaluates every gate applicable to that transition; an `error`-level diagnostic
blocks the transition and leaves `lane-state.json` completely unchanged — there's no
partial or "failed attempt" state left behind to clean up.

Both commands read the *same* gates against the *current* on-disk artifacts — `validate`
just lets you see a gate's verdict before you actually try to cross it.

## How the gates work

**Warnings vs. errors.** A `warning` is a visible diagnostic that does not by itself
block a transition (the CLI often can't know whether it truly applies to your change). An
`error` blocks the transition. Every diagnostic is tagged with the gate that raised it
(`[gateId] message`), so it's traceable back to source.

**Premise evidence** — the CLI can check that a `required`/`reproduced`/`method`/
`evidence` record exists and is shaped correctly, and it hard-blocks a change that
explicitly records `required: true` with `reproduced: false`. It cannot check whether the
recorded evidence is actually true, or whether this specific change genuinely needed the
check in the first place. In short: **lane requires the premise check to be recorded, and
blocks a required premise that was explicitly not reproduced** — it does not itself prove
the premise is real.

**Success criteria matrix** — every line of `intent.yaml`'s `intent.success` gets
cross-checked against the final diff and recorded with a `covered_by`/`evidence`/
`negation_test`. Matching against `intent.success` is **normalized, exact-text
equality** (whitespace/markdown-link/emphasis differences only) — not LLM fuzzy semantic
matching. A criterion that's been summarized or paraphrased rather than transcribed
verbatim will not be recognized as covering the original line.

**Dependency × Path cross-check** — for a cross-cutting change, `spec.md` enumerates the
new dependencies/states/guards being introduced and the existing paths that need to
respect them, then cross-checks every cell. Any "does not reference" or "unknown" cell
must be promoted to a named test. When this section applies (or it's unclear whether it
does), it requires **explicit human approval** before implementation starts — `lane
validate` does not check this section's content at all, only that the artifacts it lives
in are schema-valid. The table also has known blind spots by construction: it doesn't
look at how the implementation holds its own internal state, at assumptions about
external data shape, or at whether the premise/success-criteria checks above were
actually done honestly. A completed table is not a claim of completeness.

**Spec consensus** — `lane consensus` binds a reviewer's acknowledgement to the *exact*
content of `spec.md` and `verification.yaml` by content digest. Editing either file after
an ack invalidates it automatically, and any unresolved spec/implementation deviation
blocks completion until it's recorded and resolved. `critic.yaml` is **not** part of that
digest — don't generalize this into "editing any artifact invalidates the ack."

## Agent-metrics emission

```bash
lane emit-metrics <intent-id>          # print a token-usage snapshot marker
lane emit-metrics <intent-id> --post   # upsert it as a PR comment instead
```

`spec-lane` is one reference emitter for the external `agent-metrics:v1` contract — not
a metrics platform. What it owns:

- the delivery ledger (which sessions did the work, attributed to which lane phase)
- activity attribution and session deduplication
- invoking `agent-cost` to measure real token usage
- building a conformant `agent-metrics:v1` payload
- optionally publishing/upserting that payload as a PR comment

What it explicitly does **not** own: the protocol itself, repository-wide harvesting,
long-term storage, or team/monthly reporting — those live in separate projects (below).

## The public measurement pipeline

```text
Claude Code / Codex
        │
        ▼
    agent-cost
 local measurement
        │
        ▼
    spec-lane
 lane ledger / attribution
        │
        ▼
 lane emit-metrics
        │
        ▼
 agent-metrics:v1
 hidden PR comment
        │
        ▼
 agent-metrics-harvester
 verify / collect / store
        │
        ▼
 JSONL / SQLite
        │
        ▼
 agent-metrics-report
 cost per merged PR
```

### Protocol

The normative contract lives outside this repo, in
[`ai-agent-skills-playbook`](https://github.com/shiki-yusuke/ai-agent-skills-playbook)
(`docs/protocols/agent-metrics-v1.md`), frozen at tag
[`agent-metrics-v1.0.0`](https://github.com/shiki-yusuke/ai-agent-skills-playbook/tree/agent-metrics-v1.0.0).
`spec-lane` implements the reference emitter for that external contract; it doesn't
define it. A few of the protocol's own design choices, briefly:

- a **snapshot**, never a delta — a re-emit fully replaces the prior one, no merge logic
- a **checksum**, not a signature — integrity, not authenticity (transport-level auth is
  the harvester's job, e.g. a GitHub-authenticated fetch)
- explicit `coverage`/`omissions` fields — a harvester can tell a genuine zero from
  missing data
- **no personal-identity dimension** — the protocol measures work/process telemetry, not
  individual performance; personal-identity fields (author, reviewer, email, etc.) are
  forbidden by the protocol itself, not merely hidden at some later dashboard step

Full details live in the protocol doc itself, not duplicated here.

### End-to-end validation

The public reference pipeline has been exercised end to end on GitHub: a `spec-lane`
marker was posted to a real PR comment, collected by the reference harvester
([`agent-metrics-harvester`](https://github.com/shiki-yusuke/agent-metrics-harvester)),
persisted to its store, and re-fetched through the unchanged/idempotent (HTTP 304) path.

As of this writing, `spec-lane`'s own CI is green, the protocol is frozen at
`agent-metrics-v1.0.0`, this live canary has been exercised successfully, and
`agent-metrics-harvester`'s CI (including its Node 22 compatibility suite and the
cost-per-PR reporter's own tests) is green — this is a **public, end-to-end measurement
pipeline** in the sense that every stage above has been exercised and its CI passes, not
a claim that it has seen production-scale traffic or every possible input shape.

### Cost per merged PR

[`agent-metrics-report`](https://github.com/shiki-yusuke/agent-metrics-harvester)'s
`cost-per-pr` command reports **estimated AI-assisted coding cost per merged PR** — not a
cost precisely billed to any one PR. The denominator is PRs merged within a period; the
numerator is cost snapshots generated within that same period — two independently-counted
populations, not a 1:1 join. It deliberately does not round missing or ambiguous data
down to a clean `$0`: unpriced, unknown, partial, and insufficient-sample cases stay
visible as such rather than becoming an artificially confident number. See that repo's
own docs for the full metric definition and sample-size policy.

## Dogfooding

`spec-lane` has now been used to drive two of its own public changes through the full
lane workflow, end to end:

- **MP-3** (the `agent-metrics:v1` emitter above) revealed three rough edges in the
  workflow itself: misleading `--paths` wording in `skills/lane/SKILL.md`, an
  undocumented closed enum for `critic.yaml`'s `taxonomy` field, and `lane validate`
  printing a raw, unformatted schema-error object instead of a readable message.
- **MP-7** turned those three observations into a documentation fix, a CLI diagnostics
  fix, and dedicated regression tests — closing the loop: dogfood → finding → fix →
  regression test.

Two runs is two runs — this is evidence of the workflow surviving contact with its own
author's real changes, not a claim of being battle-tested or production-hardened.

## Using spec-lane with coding agents

If you're driving `lane` through an AI coding agent rather than by hand, point it at:

- [`skills/lane/SKILL.md`](skills/lane/SKILL.md) — Phase 1 (Intent) through Phase 4
  (Verify/PR): starting a lane, premise evidence, spec/critic, the dependency/path
  cross-check, implementation, the success-criteria cross-check, spec consensus, and PR
  creation.
- [`skills/lane-finish/SKILL.md`](skills/lane-finish/SKILL.md) — the post-merge-only
  Phase 5 closeout: recording the done overlay and closing the estimate/calibrate loop.

Both files describe the same flow as the Quick start above, written for an agent to
follow directly rather than for a human to read once.

## The four evolved features

On top of the gates above, `lane` layers four features that go beyond the original
private tool it's based on:

1. **Estimate / calibrate** — `lane estimate <id> [--impact-scan-file <report.md>] [--adopt]`
   predicts token/cost usage (p50/p80) from a k-NN model over past measured work, always
   labeled with how much to trust it (`experimental` below a 30-observation population,
   `reference_table` fallback below 8). `lane calibrate <id> --session-id <id>` measures
   what a lane's work actually cost (via agent-cost) and, if a baseline was adopted, scores
   the prediction against reality — feeding the next estimate's population.
2. **`lane next`** — a decision table of every lane with an adopted baseline estimate
   against your current Claude/Codex resource snapshots (`~/.claude/rate-limits.json` via
   your Claude Code statusline, and a manually-configured weekly Codex credit budget). It
   only ever shows `fits`/`not_fit` when the predicted cost and a budget constraint share
   the exact same unit — no invented USD-to-credits conversion — and suppresses every
   verdict (showing only raw numbers) when the underlying data is stale or incompletely
   priced.
3. **Knowledge** — `lane knowledge-append`/`lane knowledge-query --paths <path> [--paths
   <path> ...]` (repeatable, one value per flag) is a small, deterministic
   lessons-learned database: append a finding or decision once, and future lanes touching
   the same paths get it surfaced (score >= 0.70, top 3 overall, max 2 per review lens) as
   `knowledge_candidates` your spec/critic review can cite.
4. **Agent-metrics emission** — described above.

See `docs/design.md` for the full design rationale behind each of these, and for
`spec_consensus`'s own design notes (the fourth original evolved feature, folded into
"How the gates work" above since it's part of the core enforcement story now).

## Configuration

| What | Default | Override |
|---|---|---|
| Where lane specs live | `docs/spec/` under your current directory | `--spec-dir <path>` or `$LANE_SPEC_DIR` |
| Runtime data (knowledge records, calibration observations, done overlays) | `$XDG_DATA_HOME/lane` (usually `~/.local/share/lane`) | `$LANE_DATA_DIR` |
| Config (Codex budget file) | `$XDG_CONFIG_HOME/lane` (usually `~/.config/lane`) | `$LANE_CONFIG_DIR` |
| Profile (risk rules, required commands, distance caps, etc.) | the bundled `profiles/generic.profile.yaml` | `--profile <id-or-path>` > `$LANE_PROFILE_PATH` > a `profiles-local/<id>.yaml` in your repo |

### Codex budget file (for `lane next`)

If you want `lane next` to show a Codex credit budget, create
`$LANE_CONFIG_DIR/budgets/codex.yaml`:

```yaml
weekly_limit_credits: 15000
period_start: "2026-01-12"
period_end: "2026-01-19" # exclusive boundary, must be exactly 7 days after period_start for reset_rule=weekly
reset_rule: "weekly"
timezone: "Asia/Tokyo" # v1 supports Asia/Tokyo and UTC only
```

Without this file, `lane next` simply has no Codex row to show — it never fabricates one.

## Data directory and privacy

Runtime data (`$LANE_DATA_DIR`: knowledge records, calibration observations, done overlays)
and config (`$LANE_CONFIG_DIR`) both live **outside this repository** by design (XDG Base
Directory convention) — cloning or publishing this repo never carries your own knowledge
base or calibration history along with it. The one-time importer commands
(`migrate-legacy-ledger`, `migrate-legacy-knowledge`) that backfill a calibration/knowledge
population from old data explicitly warn on every run that imported records may retain
internal references (PR URLs, ticket-shaped text, etc.) from whatever you imported them
from — imported records are tagged `provenance: "imported_legacy_ledger"` /
`"imported_legacy_memories"`, which is the one mechanical key to filter them out if you
ever need to share your data directory with someone else.

## Development

```bash
pnpm -r run typecheck   # all packages
pnpm -r run build       # tsc project references
pnpm run lint           # biome check .
pnpm -r run test        # vitest, all packages
pnpm exec dependency-cruiser --config .dependency-cruiser.cjs packages/schemas/src packages/core/src packages/adapters/src packages/cli/src
```

Monorepo layout: `packages/schemas` (zod schemas + generated JSON Schema, no internal
deps) -> `packages/core` (pure application logic + port interfaces) -> `packages/adapters`
(port implementations: GitHub via `gh`, agent-cost via subprocess) -> `packages/cli`
(commander.js wiring). Dependency direction is enforced by `.dependency-cruiser.cjs` and
checked in CI.

Maintainers publishing a new version: see [`docs/releasing.md`](docs/releasing.md).

### A note on `packages/core/test/differential`

A handful of core functions (ledger derivation, phase transitions, the done overlay, and
the Goodhart personal-dimension guard) were ported byte-for-byte from a private Python
reference implementation this project is based on, and are checked against it via a
differential test suite that calls that Python package as a subprocess. That package isn't
published anywhere you can install it from — these tests skip automatically
(`isPythonReferenceAvailable()` in `python-harness.ts`) when it isn't importable, which is
the normal case for anyone outside the original author. Nothing else in this repo depends
on it.

## License

[MIT](LICENSE)
