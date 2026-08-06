import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import { runStart } from "../src/commands/start.js";
import { runValidate } from "../src/commands/validate.js";
import { criticPath } from "../src/critic-store.js";
import { intentPath } from "../src/intent-store.js";

// Codex M4 review, must-2: critic.yaml had no CLI-side schema check at all before this --
// a malformed one could sail past every gate undetected. lane validate now checks it
// whenever it exists, but never requires it (matching intent.yaml/verification.yaml's own
// "read-if-exists, never mandatory before it's written" convention).
describe("runValidate (critic.yaml)", () => {
  let specDir: string;
  const intentId = "I-2026-07-31-validate-critic";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-validate-critic-"));
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("passes when critic.yaml doesn't exist yet", () => {
    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(0);
    expect(result.message).not.toContain("critic.yaml");
  });

  it("passes and mentions critic.yaml when a valid one exists", () => {
    writeFileSync(
      criticPath(specDir, intentId),
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "decision: pass",
        "confidence: high",
        "per_lens:",
        "  - lens_id: lifecycle_management",
        "    result: not_applicable",
        "  - lens_id: error_handling",
        "    result: not_applicable",
        "  - lens_id: security",
        "    result: not_applicable",
        "  - lens_id: performance",
        "    result: not_applicable",
        "  - lens_id: a11y",
        "    result: not_applicable",
        "  - lens_id: i18n",
        "    result: not_applicable",
        "  - lens_id: architecture",
        "    result: not_applicable",
        "  - lens_id: test_coverage",
        "    result: unknown",
        "    open_question: No test exists yet.",
        "  - lens_id: documentation",
        "    result: not_applicable",
      ].join("\n"),
    );
    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("critic.yaml is valid");
  });

  // MP-7 dogfood fix (2026-08-07): runValidate used to let a malformed critic.yaml's
  // ZodError propagate uncaught (asserted here via .toThrow()); it now catches ZodError
  // and returns a formatted CommandResult (exitCode 2) instead -- these three tests are
  // rewritten to assert on that returned result, per spec.md TEST-01
  // (docs/spec/I-2026-08-07-lane-dogfood-followups/spec.md).
  it("returns exitCode 2 with a formatted message when critic.yaml has an applicable lens missing finding/taxonomy", () => {
    writeFileSync(
      criticPath(specDir, intentId),
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "decision: pass",
        "confidence: high",
        "per_lens:",
        "  - lens_id: security",
        "    result: applicable", // missing finding + taxonomy, required per the schema refine
      ].join("\n"),
    );
    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("critic.yaml:");
    expect(result.message).not.toMatch(/^\s*\[\s*\{/); // not a raw JSON issues array
  });

  it("returns exitCode 2 with a formatted message when critic.yaml uses an unrecognized lens_id", () => {
    writeFileSync(
      criticPath(specDir, intentId),
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "decision: pass",
        "confidence: high",
        "per_lens:",
        "  - lens_id: not_a_real_lens",
        "    result: not_applicable",
      ].join("\n"),
    );
    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("critic.yaml:");
    expect(result.message).not.toMatch(/^\s*\[\s*\{/);
  });

  it("returns exitCode 2 with a formatted message when critic.yaml puts `decision` on a per-lens entry instead of at the top level (the old, wrong shape)", () => {
    writeFileSync(
      criticPath(specDir, intentId),
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "decision: pass",
        "confidence: high",
        "per_lens:",
        "  - lens_id: security",
        "    decision: pass", // wrong: per-lens has `result`, not `decision`
      ].join("\n"),
    );
    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("critic.yaml:");
    expect(result.message).not.toMatch(/^\s*\[\s*\{/);
  });

  // spec.md Rule 3 / TEST-01: the formatted message is one line per issue, in the
  // "<file>: <path>: <message>" form, naming the actual offending field path -- not just
  // "some error happened."
  it("formats an invalid taxonomy value as one line per issue naming the field path", () => {
    writeFileSync(
      criticPath(specDir, intentId),
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "decision: pass",
        "confidence: high",
        "per_lens:",
        "  - lens_id: security",
        "    result: applicable",
        "    finding: something",
        "    taxonomy: not_a_real_taxonomy_value",
      ].join("\n"),
    );
    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(2);
    const lines = result.message.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line).toMatch(/^critic\.yaml: .+: .+$/);
    }
    expect(result.message).toContain("taxonomy");
  });

  // spec.md Rule 4 / TEST-02: a non-ZodError (a syntactically invalid critic.yaml, not a
  // schema violation) is *not* intercepted by the new formatter -- it still propagates to
  // the caller exactly as before this fix (main.ts's existing top-level handler is what
  // ultimately reports it when run through the real CLI).
  it("still propagates (does not format) a non-schema error, e.g. syntactically invalid YAML", () => {
    writeFileSync(criticPath(specDir, intentId), "decision: pass\n  bad_indent: [oops");
    expect(() => runValidate(intentId, { specDir })).toThrow();
  });
});

// Codex review (2026-08-07, should-2): the new formatted-message tests above only ever
// exercised critic.yaml's ZodError path. intent.yaml's own premise_evidence field is a
// discriminated union (z.discriminatedUnion("required", [...])), the one place in this
// schema whose error shape could plausibly differ from a plain object's (a union member
// mismatch, rather than a simple missing/wrong-type field) -- so it gets its own
// dedicated regression test rather than assuming the critic.yaml coverage above
// generalizes.
describe("runValidate (intent.yaml schema errors)", () => {
  let specDir: string;
  const intentId = "I-2026-08-07-validate-intent-schema";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-validate-intent-"));
    runStart(intentId, { specDir });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("formats a discriminated-union premise_evidence violation as one line per issue naming the field path", () => {
    // runStart() writes a valid intent.yaml with no premise_evidence field at all --
    // inject an invalid one (required:true branch, but method isn't one of the enum's
    // three values) directly into the raw YAML rather than constructing a typed Intent
    // (which the type system wouldn't let be invalid in the first place).
    const path = intentPath(specDir, intentId);
    const original = readFileSync(path, "utf-8");
    const withInvalidPremiseEvidence = original.replace(
      "budget: []\n",
      'budget: []\npremise_evidence:\n  required: true\n  method: not_a_real_method\n  reproduced: true\n  evidence: "x"\n',
    );
    expect(withInvalidPremiseEvidence).not.toBe(original); // sanity: the replace actually matched
    writeFileSync(path, withInvalidPremiseEvidence);

    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(2);
    const lines = result.message.split("\n");
    for (const line of lines) {
      expect(line).toMatch(/^intent\.yaml: .+: .+$/);
    }
    expect(result.message).toContain("premise_evidence.method");
    expect(result.message).not.toMatch(/^\s*\[\s*\{/); // not a raw JSON issues array
  });
});

// Codex review (2026-08-06, should): at 3_implement, `lane validate` evaluates
// successCriteriaGate through *two* triggers (phase_advance{3_implement->4_verify} and
// before_pr_publish{phase:3_implement}) -- both apply, so without dedupe the exact same
// finding would appear twice in the output.
describe("runValidate diagnostic dedupe", () => {
  let specDir: string;
  const intentId = "I-2026-08-06-validate-dedupe";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-validate-dedupe-"));
    runStart(intentId, { specDir });
    expect(runAdvance(intentId, "2_spec", { specDir }).exitCode).toBe(0);
    expect(runAdvance(intentId, "3_implement", { specDir }).exitCode).toBe(0);
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("reports the success_criteria matrix-missing warning exactly once at 3_implement, not twice", () => {
    const result = runValidate(intentId, { specDir });
    expect(result.exitCode).toBe(0);
    const occurrences = result.message.split("success_criteria_matrix is not recorded").length - 1;
    expect(occurrences).toBe(1);
  });
});
