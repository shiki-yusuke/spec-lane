# I-2026-10-01-dev-deps-security-alerts — spec

**Revision 2 (2026-10-01)** — after the Codex builder review (gpt-5.6-terra, 可, 0 must): PATH-02..05 corrected (a
`packages/schemas/vitest.config.ts` with `test.include` exists), vite 8 Node floor recorded.

**Revision 1 (2026-10-01)** — drafted from the Dependabot alert list observed the same day
(tasks.md "01-dd 2026-10-01 トリガー到達" entry).

**Dependency and path cross-check: applicable.** This change introduces new dependency
versions (a vitest major, with vite / esbuild / @vitest/mocker following, and a fast-uri patch).
Limb (a) of the applicability test is met, so the cross-check table below is mandatory. Limb (b)
is not met: no code path changes, and every consumer of the runner is the same `vitest run`
script.

**Human-review band: applies, approved in advance.** `declared_risk: medium` and the
cross-check band both require user approval before 2_spec. On 2026-10-01 the user, after
reading the alert breakdown (23 alerts, vitest 3.2.6 minimum vs 4.1.11 full clear), approved
"the recommended or any reasonable policy", delegating the gate to self-review plus a Codex
review when judgment is needed. The recommended policy recorded there is D1 below. The
Phase 3 lockfile hard-halt is covered by the same approval, because the lockfile *is* the
deliverable.

## Premise (recorded at Phase 1)

`intent.yaml` `premise_evidence`: `required: true`, `method: data`, `reproduced: true`.

| package | resolved now | alert ranges (first patched) | severity |
|---|---|---|---|
| vitest | 2.1.9 | <3.2.6 (3.2.6), <4.1.11 (4.1.11) | critical, medium |
| @vitest/mocker | 2.1.9 | <4.1.11 (4.1.11) | medium |
| vite | 5.4.21 (via vitest) | <=6.4.1 (6.4.2), <=6.4.2 (6.4.3) | high, medium |
| esbuild | 0.21.5 (via vite); root pin 0.28.1 | <=0.24.2 (0.25.0) | medium |
| fast-uri | 3.1.4 (dependency-cruiser 16.10.4 → ajv 8.20.0) | <3.1.5/3.1.6/3.1.7 (3.1.7) | high |

Baseline `pnpm test` on 2.1.9: 99 test files passed, 1396 tests passed, 5 files / 72 tests
skipped. vitest 4.1.11 engines `^20 || ^22 || >=24`; vite 8.3.1 engines `^20.19 || >=22.12`
(Codex review should-item): CI `node-version: 22` resolves to current 22.x and satisfies it, the
local toolchain is 22.23.2; `engines.node: ">=22"` in package.json is the *consumer* contract
for the published CLI (vite is dev-only) and is left unchanged, with the contributor requirement
noted in the CHANGELOG.

## Decisions

- **D1** vitest range `^4.1.11` in root and all four packages. 3.2.6 clears only the critical
  alert; 4.1.11 is the first version that satisfies every vitest / @vitest/mocker alert and
  pulls vite ≥6.4.3 (vitest 4 depends on vite `^6 || ^7 || ^8`). vitest 5 (latest 5.0.3) is
  not needed and stays in the deferred-major set.
- **D2** fast-uri is not a direct dependency; it is moved by `pnpm update fast-uri` (ajv 8.20.0
  accepts `^3.0.1`), so dependency-cruiser and ajv keep their resolved versions.
- **D3** The root `esbuild: 0.28.1` pin (publish bundle, `scripts/build-publish.mjs`) is
  untouched; the vulnerable 0.21.5 copy is vite 5's and disappears with vite 5.
- **D4** No test file, vitest config (`packages/schemas/vitest.config.ts`, `test.include` only) or source file changes. If vitest 4 turns a test red,
  Phase 3 stops and reports (intent constraint 1).
- **D5** CHANGELOG.md gets one Unreleased bullet.

## Requirements (EARS)

- **RULE-01** The root `package.json` and `packages/{adapters,cli,core,schemas}/package.json`
  shall declare `"vitest": "^4.1.11"` in `devDependencies`.
- **RULE-02** `pnpm-lock.yaml` shall resolve `vitest` and `@vitest/mocker` to ≥4.1.11 and
  shall contain no `vitest@2.` and no `vite@5.` package entry.
- **RULE-03** `pnpm-lock.yaml` shall resolve `fast-uri` to ≥3.1.7 while `dependency-cruiser`
  stays 16.10.4 and `ajv` stays 8.20.0.
- **RULE-04** When the diff is compared against `main`, no `dependencies` block of any
  `package.json` and no importer `dependencies:` block of the lockfile shall differ.
- **RULE-05** When `pnpm typecheck`, `pnpm lint` and `pnpm test` run on the upgraded
  toolchain, each shall exit 0 and the test run shall report ≥99 passed test files and
  ≥1396 passed tests with no test file modified.
- **RULE-06** For every open Dependabot alert, the version the lockfile resolves for that
  package shall satisfy the alert's `first_patched_version`.
- **RULE-07** `CHANGELOG.md` shall gain an Unreleased entry naming the vitest major move and
  the fast-uri resolution.

## Dependency and path cross-check

| id | dependency / change |
|---|---|
| DEP-01 | vitest 2.1.9 → 4.1.11 (runner behavior: mock restore defaults, workspace → projects) |
| DEP-02 | vite 5.4.21 → ≥6.4.3 (transitive, vitest's bundler) |
| DEP-03 | @vitest/mocker 2.1.9 → 4.1.11 (transitive) |
| DEP-04 | fast-uri 3.1.4 → 3.1.7 (transitive under ajv) |
| DEP-05 | esbuild 0.21.5 copy removed (vite 6 brings ≥0.25) |

| path | what it does | DEP-01 | DEP-02 | DEP-03 | DEP-04 | DEP-05 |
|---|---|---|---|---|---|---|
| PATH-01 root `pnpm test` → `pnpm -r run test` | fans out to the 4 package scripts | references | indirect | indirect | — | — |
| PATH-02..05 `packages/*/package.json` `"test": "vitest run"` (only `packages/schemas/vitest.config.ts` exists: `test.include` alone, no workspace/pool/coverage options) | runs the suites with defaults | references | indirect | indirect | — | — |
| PATH-06 tests using `vi.spyOn` (6), `mockRestore` (5), `vi.restoreAllMocks` (1), fake timers (3) | the only vitest APIs the suites touch | references | — | references | — | — |
| PATH-07 `.github/workflows/ci.yml` `pnpm exec dependency-cruiser ...` and `pnpm depcheck` | loads ajv → fast-uri at runtime | — | — | — | references | — |
| PATH-08 `scripts/build-publish.mjs` → `node_modules/.bin/esbuild` | root pin 0.28.1, unaffected | — | — | — | — | does not (uses root pin) |
| PATH-09 CI `pnpm install --frozen-lockfile` on Node 22 | lockfile must be self-consistent | references | references | references | references | references |

Promoted tests (Phase 3 must run all of them):

- **TEST-01** (RULE-05, PATH-01..06) full `pnpm typecheck && pnpm lint && pnpm test`; negative
  side: the test counts are compared against the recorded baseline, so a silently skipped
  or dropped suite fails the comparison.
- **TEST-02** (RULE-06) a script joins the `gh api` alert list with the lockfile's resolved
  versions and prints one line per alert with satisfied/unsatisfied; any unsatisfied line fails.
  Negative side: run the same script against the pre-change lockfile and observe 23
  unsatisfied lines.
- **TEST-03** (RULE-04) `git diff main -- package.json packages/*/package.json` shows only
  `devDependencies` hunks, and the lockfile diff's importer sections touch only
  `devDependencies:` keys (checked with a grep over the diff hunks).
- **TEST-04** (RULE-03, PATH-07) `pnpm depcheck` exits 0 after the update (dependency-cruiser
  still loads with the new fast-uri).
- **TEST-05** (RULE-02, DEP-05, PATH-08) `grep -c "vitest@2\.\|vite@5\." pnpm-lock.yaml`
  is 0 and `node_modules/.bin/esbuild --version` still prints 0.28.1.

All "does not" cells are explained in-row (PATH-08 deliberately does not take the transitive
esbuild). No path outside `allowed_paths` is needed.

## Gherkin

```gherkin
Feature: dev toolchain clears Dependabot alerts without touching production dependencies

  Scenario: full test run on vitest 4
    Given vitest ^4.1.11 is declared in the root and four workspace packages
    And pnpm install has regenerated pnpm-lock.yaml
    When pnpm typecheck, pnpm lint and pnpm test run
    Then each exits 0
    And at least 99 test files and 1396 tests pass with no test file modified

  Scenario Outline: every open alert is satisfied by the lockfile
    Given the open Dependabot alert for <package> with first_patched_version <patched>
    When the resolved version of <package> is read from pnpm-lock.yaml
    Then it is greater than or equal to <patched>
    Examples:
      | package        | patched |
      | vitest         | 4.1.11  |
      | @vitest/mocker | 4.1.11  |
      | vite           | 6.4.3   |
      | esbuild        | 0.25.0  |
      | fast-uri       | 3.1.7   |

  Scenario: production dependencies are untouched
    Given the diff against main
    When package.json dependencies blocks and lockfile importer dependencies blocks are compared
    Then no hunk touches them

  Scenario: a test regression stops the lane (negative)
    Given vitest 4 turns an existing test red
    When Phase 3 evaluates TEST-01
    Then the lane halts and reports instead of editing the test
```
