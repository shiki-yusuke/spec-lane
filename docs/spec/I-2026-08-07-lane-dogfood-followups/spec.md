# Spec — MP-3 dogfood follow-ups: skill doc fixes + `lane validate` error formatting

## Intent summary

MP-3 was the first real task run through spec-lane's own `lane` workflow. Running it
surfaced three self-inflicted rough edges in spec-lane itself:

1. `skills/lane/SKILL.md`'s knowledge-query step reads as if `--paths` accepts multiple
   space-separated paths after a single flag; the actual CLI (`--help`) shows it is a
   repeatable single-value option.
2. `skills/lane/SKILL.md`'s critic.yaml step never states that `taxonomy` is a closed
   10-value enum, or lists the values — the wording reads as free text.
3. `lane validate` prints a raw `ZodError` issues array (serialized as JSON, since that
   is exactly what an unformatted `ZodError`'s own `Error#message` getter returns) when
   `intent.yaml` or `critic.yaml` fails schema validation, instead of a message in the
   same human-readable style gate diagnostics already use (`[gateId] message`).

This lane fixes all three. Items 1-2 are documentation-only; item 3 changes
`runValidate`'s error-handling behavior, which is why the dependency/path cross-check
below applies.

## Premise

Recorded in `intent.yaml`: `premise_evidence.required: true`, `method: live`,
`reproduced: true`. All three findings were directly observed during MP-3's own dogfood
run (this session's transcript) — not inferred from reading the code.

## EARS rules

### Rule 1 (Ubiquitous): `--paths` documented as repeatable
`skills/lane/SKILL.md`'s knowledge-query step shall describe `--paths` as a repeatable,
single-value flag and its own example command shall show the repeated-flag form
(`--paths a --paths b`), not a single flag taking multiple space-separated values.

### Rule 2 (Ubiquitous): `taxonomy` enum documented
`skills/lane/SKILL.md`'s critic.yaml step shall state that `taxonomy` is a closed
10-value enum and list all 10 values (`missing_state`, `wrong_assumption`,
`too_implementation_specific`, `test_missing`, `architecture_violation`,
`compatibility_missed`, `context_variant_missed`, `lifecycle_missed`,
`scope_ambiguity`, `observability_gap`).

### Rule 3 (Unwanted behavior): schema validation failure produces a formatted message
If `intent.yaml` or `critic.yaml` fails schema validation, `lane validate` shall catch the
resulting `ZodError` and return a `CommandResult` (exit code 2) whose message contains one
line per issue, each in the form `<file>: <path>: <message>` (`<path>` = the issue's
dotted field path, or `(root)` if empty) — never the raw, unformatted `ZodError` array.

### Rule 4 (Unwanted behavior): non-schema errors are unaffected
If `readIntent`/`readCriticIfExists` throw anything other than a `ZodError` (e.g. a YAML
syntax error), `lane validate` shall not intercept it — it propagates to the CLI's
existing top-level handler exactly as before this change.

## Gherkin scenarios

```gherkin
Scenario: critic.yaml with an invalid taxonomy value
  Given a lane whose critic.yaml has an "applicable" lens with taxonomy: "not_a_real_value"
  When I run `lane validate <intent-id>`
  Then the command exits with code 2
  And the message contains a line matching "critic.yaml: .*taxonomy.*: "
  And the message does not contain a raw JSON array (no literal "[\n  {" issues-array shape)

Scenario: intent.yaml with a missing required field
  Given a lane whose intent.yaml is missing intent.primary_user
  When I run `lane validate <intent-id>`
  Then the command exits with code 2
  And the message contains a line starting with "intent.yaml: "

Scenario: a syntactically invalid critic.yaml (not a schema error)
  Given a lane whose critic.yaml is not valid YAML at all
  When I run `lane validate <intent-id>`
  Then the command exits with a non-zero code via the CLI's existing top-level error
    handler (unchanged), not the new formatted-schema-error path

Scenario: a valid critic.yaml still passes
  Given a lane whose critic.yaml is schema-valid
  When I run `lane validate <intent-id>`
  Then the command exits with code 0 and the message still says "critic.yaml is valid"
```

## Dependency and path cross-check (applies)

**Applicability**: Rule 3/4 change `runValidate`'s existing error-handling behavior (an
uncaught throw becomes a caught-and-reformatted `CommandResult`) — an existing path that
several tests already exercise. Applicable.

**DEP-01**: `runValidate` (`packages/cli/src/commands/validate.ts`) catches `ZodError`
thrown by `readIntent`/`readCriticIfExists` and returns a formatted `CommandResult`
instead of letting it propagate.

**PATH × DEP-01 cross-check**:

| Path | References DEP-01? | Action |
|---|---|---|
| `packages/cli/test/validate.test.ts`'s 3 `expect(() => runValidate(...)).toThrow()` tests (invalid taxonomy is not exercised there today, but the missing-finding/unrecognized-lens_id/decision-on-per-lens-entry cases all currently rely on `runValidate` throwing) | Yes — these assert the *old* throw-based contract directly | **TEST-01**: rewrite all 3 to assert on the returned `CommandResult` (`exitCode: 2`, formatted message) instead of `toThrow()`. |
| `packages/cli/test/commands.test.ts`'s `runValidate` calls | No — every call there uses a schema-valid intent.yaml/critic.yaml, never exercises the throw/catch path | No change needed (confirmed by reading each call site). |
| `packages/cli/src/main.ts`'s top-level `program.parseAsync(...).catch(...)` handler | No longer reached for a `ZodError` from `validate`'s own `readIntent`/`readCriticIfExists` calls, but unchanged for every other command and every non-`ZodError` throw | **TEST-02**: add a test proving a non-`ZodError` throw (a syntactically invalid critic.yaml) is *not* caught by the new formatter and still propagates (Rule 4). |
| `packages/cli/src/commands/advance.ts` (also calls `readIntent`/`readCriticIfExists` via `buildGateContext`) | Not touched by this change — `advance`'s own error handling is explicitly out of scope (team-lead's instruction scopes this to `validate` only) | No change. Confirmed by reading `advance.ts`: it still lets a `ZodError` propagate uncaught, same as before this lane. Not a regression — pre-existing behavior, unchanged. |

Every "does not reference" cell above already has a resolution (no change needed, with the
reason recorded) or a `TEST-ID`; no cell is left as "unknown."

**Blind-spot disclaimer**: this table doesn't re-confirm that the 10-value taxonomy list
now documented in Rule 2 is itself complete and correctly spelled — that was cross-checked
directly against `packages/schemas/src/critic.ts`'s own `taxonomy` enum at spec-writing
time (not deferred to critic.yaml's `test_coverage` lens, which still independently
re-searches below).

## Implementation scope hint

- `skills/lane/SKILL.md`: two wording fixes (knowledge-query step, critic.yaml step). No
  code.
- `packages/cli/src/commands/validate.ts`: catch `ZodError` from `readIntent`/
  `readCriticIfExists`, format via a small helper, return as `CommandResult`.
- `packages/cli/test/validate.test.ts`: rewrite the 3 `.toThrow()` tests, add the new
  formatted-message test and the non-ZodError-propagates test.
- `docs/design.md` / `CHANGELOG.md`: record the fix. Version bump 0.3.0 -> 0.3.1 (patch —
  no new feature, no schema change).

## Verification strategy

| Rule | Verified by |
|---|---|
| 1 | Manual read of the updated `skills/lane/SKILL.md` text (documentation-only; no executable test possible) |
| 2 | Manual read of the updated `skills/lane/SKILL.md` text, cross-checked against `packages/schemas/src/critic.ts`'s taxonomy enum |
| 3 | New test: invalid-taxonomy critic.yaml -> formatted message assertion (TEST-01) |
| 4 | New test: non-ZodError (invalid YAML syntax) still propagates (TEST-02) |
