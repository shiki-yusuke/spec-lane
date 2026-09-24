import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Intent } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  IntentSuccessInlineCommentError,
  IntentWriteWouldDropKeysError,
  inspectIntent,
  intentPath,
  readIntent,
  readIntentForWrite,
  writeIntent,
} from "../src/intent-store.js";

// Data-loss fix (2026-08-29): `lane estimate --adopt` used to re-serialize intent.yaml
// through plain IntentSchema.parse (a non-strict object -- unrecognized keys are silently
// stripped by design elsewhere in this schema layer), which permanently deleted any
// schema-external key (e.g. intent.critical_invariants, before it was first-classed) the
// moment intent.yaml was ever rewritten. These tests cover the shared detection
// (inspectIntent) and its two call sites (readIntent: warn-only, readIntentForWrite/
// writeIntent: fail-closed) directly, independent of the `lane estimate` CLI surface
// (see estimate.test.ts for the end-to-end regression coverage of the actual bug).

const BASE_INTENT: Intent = {
  schema_version: "1.0",
  intent_id: "I-2026-08-29-intent-store-unit",
  execution_mode: "manual",
  budget: [],
  intent: {
    business_goal: "Describe the business goal for this lane.",
    user_visible_intent: "Describe what the user will see change.",
    success: ["Describe at least one success criterion."],
    non_goal: [],
    constraints: [],
    primary_user: "unspecified",
    state_segments: [],
    known_affected_behavior: [],
    declared_risk: "low",
  },
  ai_inferred_scope: {
    affected_layers: ["unspecified"],
    related_files: [],
    required_docs: [],
    confidence: "low",
    open_questions: [],
    allowed_paths: ["**"],
    forbidden_paths: [],
  },
};

describe("inspectIntent", () => {
  it("reports no dropped paths for a clean, schema-conformant object", () => {
    const { droppedPaths } = inspectIntent(BASE_INTENT);
    expect(droppedPaths).toEqual([]);
  });

  it("reports a top-level unrecognized key by its own name", () => {
    const { droppedPaths } = inspectIntent({ ...BASE_INTENT, made_up_top_level: "x" });
    expect(droppedPaths).toEqual(["made_up_top_level"]);
  });

  it("reports a nested unrecognized key with a full dot-path (e.g. intent.made_up_field)", () => {
    const raw = { ...BASE_INTENT, intent: { ...BASE_INTENT.intent, made_up_field: "x" } };
    const { droppedPaths } = inspectIntent(raw);
    expect(droppedPaths).toEqual(["intent.made_up_field"]);
  });

  it("reports critical_invariants as first-classed (not dropped) now that IntentSchema recognizes it", () => {
    const raw = {
      ...BASE_INTENT,
      intent: { ...BASE_INTENT.intent, critical_invariants: ["must never delete user data"] },
    };
    const { parsed, droppedPaths } = inspectIntent(raw);
    expect(droppedPaths).toEqual([]);
    expect(parsed.intent.critical_invariants).toEqual(["must never delete user data"]);
  });

  it("reports a dropped key inside an array element by key name only, without the element's index", () => {
    const raw = {
      ...BASE_INTENT,
      budget: [{ provider: "claude", unit: "usd", limit: 10, made_up_budget_field: true }],
    };
    const { droppedPaths } = inspectIntent(raw);
    expect(droppedPaths).toEqual(["budget.made_up_budget_field"]);
  });

  it("still throws (via IntentSchema.parse) when the object is structurally invalid, independent of key-dropping", () => {
    expect(() => inspectIntent({ ...BASE_INTENT, intent: undefined })).toThrow();
  });

  // sol review (2nd round, 2026-08-29): `key in parsedObj` also matches inherited
  // Object.prototype properties (constructor/toString/hasOwnProperty/...), so a YAML key
  // that happens to share a name with one of those would read as "present on parsed" even
  // though IntentSchema actually stripped it -- silently defeating the fail-closed guard.
  // Object.hasOwn (own-properties-only) is what diffDroppedPaths must use instead.
  it("reports a dropped key that collides with an Object.prototype property name (intent.constructor)", () => {
    const raw = {
      ...BASE_INTENT,
      intent: { ...BASE_INTENT.intent, constructor: "not-a-real-ctor" },
    };
    const { droppedPaths } = inspectIntent(raw);
    expect(droppedPaths).toEqual(["intent.constructor"]);
  });

  it("reports a dropped key that collides with an Object.prototype property name (intent.toString)", () => {
    const raw = {
      ...BASE_INTENT,
      intent: { ...BASE_INTENT.intent, toString: "not-a-real-method" },
    };
    const { droppedPaths } = inspectIntent(raw);
    expect(droppedPaths).toEqual(["intent.toString"]);
  });

  it("reports a dropped key that collides with Object.prototype at the top level (hasOwnProperty)", () => {
    const raw = { ...BASE_INTENT, hasOwnProperty: "not-a-real-method" };
    const { droppedPaths } = inspectIntent(raw);
    expect(droppedPaths).toEqual(["hasOwnProperty"]);
  });
});

describe("readIntent / readIntentForWrite / writeIntent", () => {
  let specDir: string;
  const intentId = "I-2026-08-29-intent-store-unit";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-intent-store-spec-"));
    writeIntent(specDir, intentId, BASE_INTENT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("readIntent returns the parsed intent unchanged when there is nothing to drop", () => {
    const intent = readIntent(specDir, intentId);
    expect(intent.intent.business_goal).toBe(BASE_INTENT.intent.business_goal);
  });

  it("readIntent warns to stderr but still returns the (stripped) parsed intent when a key is unrecognized", () => {
    const raw = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
    raw.intent.made_up_field = "oops";
    writeFileSync(intentPath(specDir, intentId), stringifyYaml(raw));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const intent = readIntent(specDir, intentId);
    expect(stderrSpy).toHaveBeenCalled();
    const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("intent.made_up_field");
    // Read-only: readIntent never rewrites the file, so the unrecognized key is still on
    // disk even though it's absent from the in-memory value this call returns.
    expect((intent.intent as Record<string, unknown>).made_up_field).toBeUndefined();
    const onDisk = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
    expect(onDisk.intent.made_up_field).toBe("oops");
  });

  it("readIntentForWrite throws IntentWriteWouldDropKeysError (not a silent strip) when a key is unrecognized", () => {
    const raw = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
    raw.intent.made_up_field = "oops";
    writeFileSync(intentPath(specDir, intentId), stringifyYaml(raw));

    expect(() => readIntentForWrite(specDir, intentId)).toThrow(IntentWriteWouldDropKeysError);
    let caught: unknown;
    try {
      readIntentForWrite(specDir, intentId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntentWriteWouldDropKeysError);
    expect((caught as IntentWriteWouldDropKeysError).droppedPaths).toEqual([
      "intent.made_up_field",
    ]);
  });

  it("readIntentForWrite returns the parsed intent normally when there is nothing to drop", () => {
    const intent = readIntentForWrite(specDir, intentId);
    expect(intent.intent.business_goal).toBe(BASE_INTENT.intent.business_goal);
  });

  // sol review (2nd round, 2026-08-29): regression for the `key in parsedObj` prototype-
  // chain bug -- these unrecognized keys share a name with an Object.prototype property, so
  // the buggy `in` check would have found them "present" on the parsed object and silently
  // let the write proceed, exactly the fail-closed break this test guards against.
  it.each(["constructor", "toString"] as const)(
    "readIntentForWrite throws for a schema-unrecognized key that collides with Object.prototype (intent.%s)",
    (key) => {
      const raw = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
      raw.intent[key] = "oops";
      writeFileSync(intentPath(specDir, intentId), stringifyYaml(raw));

      expect(() => readIntentForWrite(specDir, intentId)).toThrow(IntentWriteWouldDropKeysError);
      let caught: unknown;
      try {
        readIntentForWrite(specDir, intentId);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(IntentWriteWouldDropKeysError);
      expect((caught as IntentWriteWouldDropKeysError).droppedPaths).toEqual([`intent.${key}`]);
    },
  );

  it("writeIntent itself refuses (defense-in-depth) a candidate object carrying an unrecognized key", () => {
    const candidate = {
      ...BASE_INTENT,
      intent: { ...BASE_INTENT.intent, made_up_field: "oops" },
    } as unknown as Intent;
    expect(() => writeIntent(specDir, intentId, candidate)).toThrow(IntentWriteWouldDropKeysError);
    // Refused before touching disk: the file on disk is still the clean BASE_INTENT.
    const onDisk = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
    expect(onDisk.intent.made_up_field).toBeUndefined();
  });

  it("writeIntent round-trips critical_invariants cleanly now that it's part of the schema", () => {
    const candidate: Intent = {
      ...BASE_INTENT,
      intent: { ...BASE_INTENT.intent, critical_invariants: ["must never delete user data"] },
    };
    writeIntent(specDir, intentId, candidate);
    const intent = readIntentForWrite(specDir, intentId);
    expect(intent.intent.critical_invariants).toEqual(["must never delete user data"]);
  });
});

// Issue #45: a plain (unquoted) intent.success[] entry containing ` #` is silently
// truncated by the YAML parser -- the gate then compares only the truncated text against
// verification.yaml's success_criteria_matrix, so a matrix row that copies the same
// truncated text passes a gate that never checked the lost half of the criterion. Option 1
// (recommended in the issue) rejects the plain-scalar+inline-comment shape at the read
// layer, in both readIntent and readIntentForWrite, before the gate ever sees a truncated
// value. Quoting the entry keeps `#` in the value and is accepted; a comment on its own
// line after the entry is unaffected (nothing was truncated, so nothing to reject).
describe("readIntent / readIntentForWrite reject a plain success[] entry with an inline comment", () => {
  let specDir: string;
  const intentId = "I-2026-09-24-intent-store-inline-comment";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-intent-store-inline-comment-"));
    writeIntent(specDir, intentId, BASE_INTENT);
  });

  function writeSuccessLines(lines: string[]): void {
    const raw = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
    const withoutSuccess = stringifyYaml(raw).replace(
      /success:\n( {4}-.*\n)+/,
      `success:\n${lines.map((l) => `    ${l}`).join("\n")}\n`,
    );
    writeFileSync(intentPath(specDir, intentId), withoutSuccess);
  }

  it("readIntent throws IntentSuccessInlineCommentError for an unquoted plain scalar with an inline comment", () => {
    writeSuccessLines(["- ledger has a PhaseGate row # negative side too"]);
    expect(() => readIntent(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
    let caught: unknown;
    try {
      readIntent(specDir, intentId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntentSuccessInlineCommentError);
    const typed = caught as IntentSuccessInlineCommentError;
    expect(typed.index).toBe(0);
    expect(typed.message).toContain("intent.success[0]");
    expect(typed.message).toMatch(/quote/i);
  });

  it("readIntentForWrite throws IntentSuccessInlineCommentError for the same shape", () => {
    writeSuccessLines(["- ledger has a PhaseGate row # negative side too"]);
    expect(() => readIntentForWrite(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
  });

  it("readIntent reports the correct index for the offending entry among several", () => {
    writeSuccessLines([
      "- first entry, no comment",
      "- second entry has one # negative side too",
      "- third entry, no comment",
    ]);
    let caught: unknown;
    try {
      readIntent(specDir, intentId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntentSuccessInlineCommentError);
    expect((caught as IntentSuccessInlineCommentError).index).toBe(1);
  });

  it("accepts a double-quoted entry containing '#'", () => {
    writeSuccessLines(['- "ledger has a PhaseGate row # negative side too"']);
    const intent = readIntent(specDir, intentId);
    expect(intent.intent.success).toEqual(["ledger has a PhaseGate row # negative side too"]);
  });

  it("accepts a single-quoted entry containing '#'", () => {
    writeSuccessLines(["- 'ledger has a PhaseGate row # negative side too'"]);
    const intent = readIntent(specDir, intentId);
    expect(intent.intent.success).toEqual(["ledger has a PhaseGate row # negative side too"]);
  });

  it("does NOT reject a plain scalar followed by a block comment on its own line", () => {
    writeSuccessLines(["- ledger has a PhaseGate row", "  # this is a block comment, not inline"]);
    const intent = readIntent(specDir, intentId);
    expect(intent.intent.success).toEqual(["ledger has a PhaseGate row"]);
  });

  it("accepts a plain scalar with '#' immediately adjacent (no preceding space, so not a comment at all)", () => {
    writeSuccessLines(["- ledger-has-a-phasegate-row#no-space-before-hash"]);
    const intent = readIntent(specDir, intentId);
    expect(intent.intent.success).toEqual(["ledger-has-a-phasegate-row#no-space-before-hash"]);
  });

  // False negative found in review: a success[] entry can be a YAML *alias* (`*c`)
  // rather than the plain scalar itself. The alias node carries no source range of its
  // own -- the comment lives on the *anchored* node it resolves to -- so the check must
  // resolve the alias (yaml's isAlias/alias.resolve(doc)) before applying the same
  // PLAIN-scalar range check, in both flow and block style.
  function writeRawIntent(source: string): void {
    writeFileSync(intentPath(specDir, intentId), source);
  }

  it("rejects a flow-style alias to a plain scalar with an inline comment on the anchor", () => {
    writeRawIntent(
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "execution_mode: manual",
        "budget: []",
        "intent: { business_goal: &c ledger has a PhaseGate row # negative side too",
        "         , user_visible_intent: describe what the user will see change, success: [*c], non_goal: [], constraints: [], primary_user: unspecified, state_segments: [], known_affected_behavior: [], declared_risk: low }",
        'ai_inferred_scope: { affected_layers: [unspecified], related_files: [], required_docs: [], confidence: low, open_questions: [], allowed_paths: ["**"], forbidden_paths: [] }',
        "",
      ].join("\n"),
    );
    expect(() => readIntent(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
  });

  it("rejects a block-style alias to a plain scalar with an inline comment on the anchor", () => {
    writeRawIntent(
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "execution_mode: manual",
        "budget: []",
        "intent:",
        "  business_goal: &c ledger has a PhaseGate row # negative side too",
        "  user_visible_intent: describe what the user will see change",
        "  success:",
        "    - *c",
        "  non_goal: []",
        "  constraints: []",
        "  primary_user: unspecified",
        "  state_segments: []",
        "  known_affected_behavior: []",
        "  declared_risk: low",
        "ai_inferred_scope:",
        "  affected_layers: [unspecified]",
        "  related_files: []",
        "  required_docs: []",
        "  confidence: low",
        "  open_questions: []",
        '  allowed_paths: ["**"]',
        "  forbidden_paths: []",
        "",
      ].join("\n"),
    );
    expect(() => readIntent(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
  });

  // Second follow-up to issue #45: path-based walking (getIn + isSeq + alias resolution)
  // still missed routes by which a truncated value reaches intent.success. These three are
  // routes the path walker didn't cover; the fix (visit the whole document, then match
  // collected commented values against the fully parsed intent.success array) doesn't
  // special-case any of them.
  it("rejects success itself being an alias to a sequence containing a commented plain scalar", () => {
    writeRawIntent(
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "execution_mode: manual",
        "budget: []",
        "intent:",
        "  business_goal: describe the business goal",
        "  user_visible_intent: describe what the user will see change",
        "  non_goal: &s",
        "    - criterion # lost",
        "  success: *s",
        "  constraints: []",
        "  primary_user: unspecified",
        "  state_segments: []",
        "  known_affected_behavior: []",
        "  declared_risk: low",
        "ai_inferred_scope:",
        "  affected_layers: [unspecified]",
        "  related_files: []",
        "  required_docs: []",
        "  confidence: low",
        "  open_questions: []",
        '  allowed_paths: ["**"]',
        "  forbidden_paths: []",
        "",
      ].join("\n"),
    );
    expect(() => readIntent(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
  });

  it("rejects intent itself being an alias to a map whose success carries a commented plain scalar", () => {
    writeRawIntent(
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "execution_mode: manual",
        "budget: []",
        "base: &i",
        "  business_goal: describe the business goal",
        "  user_visible_intent: describe what the user will see change",
        "  success:",
        "    - criterion # lost",
        "  non_goal: []",
        "  constraints: []",
        "  primary_user: unspecified",
        "  state_segments: []",
        "  known_affected_behavior: []",
        "  declared_risk: low",
        "intent: *i",
        "ai_inferred_scope:",
        "  affected_layers: [unspecified]",
        "  related_files: []",
        "  required_docs: []",
        "  confidence: low",
        "  open_questions: []",
        '  allowed_paths: ["**"]',
        "  forbidden_paths: []",
        "",
      ].join("\n"),
    );
    expect(() => readIntent(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
  });

  it("rejects a merge key (<<) splicing in a success carrying a commented plain scalar", () => {
    writeRawIntent(
      [
        "%YAML 1.1",
        "---",
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "execution_mode: manual",
        "budget: []",
        "intent:",
        "  <<: &i",
        "    success:",
        "      - criterion # lost",
        "  business_goal: describe the business goal",
        "  user_visible_intent: describe what the user will see change",
        "  non_goal: []",
        "  constraints: []",
        "  primary_user: unspecified",
        "  state_segments: []",
        "  known_affected_behavior: []",
        "  declared_risk: low",
        "ai_inferred_scope:",
        "  affected_layers: [unspecified]",
        "  related_files: []",
        "  required_docs: []",
        "  confidence: low",
        "  open_questions: []",
        '  allowed_paths: ["**"]',
        "  forbidden_paths: []",
        "",
      ].join("\n"),
    );
    expect(() => readIntent(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
  });

  // Documents the known over-approximation from the visit-the-whole-document rewrite: the
  // check no longer tracks *which path* reached intent.success, so a plain scalar anywhere
  // else in the document carrying an inline comment whose text happens to equal a success[]
  // entry also triggers rejection, even though the two are otherwise unrelated. Quoting the
  // coincidentally-matching field (not the success entry) resolves it.
  it("over-approximation: rejects when an unrelated field's inline comment text happens to equal a success[] entry", () => {
    writeRawIntent(
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "execution_mode: manual",
        "budget: []",
        "intent:",
        "  business_goal: shared text # unrelated comment",
        "  user_visible_intent: describe what the user will see change",
        "  success:",
        '    - "shared text"',
        "  non_goal: []",
        "  constraints: []",
        "  primary_user: unspecified",
        "  state_segments: []",
        "  known_affected_behavior: []",
        "  declared_risk: low",
        "ai_inferred_scope:",
        "  affected_layers: [unspecified]",
        "  related_files: []",
        "  required_docs: []",
        "  confidence: low",
        "  open_questions: []",
        '  allowed_paths: ["**"]',
        "  forbidden_paths: []",
        "",
      ].join("\n"),
    );
    // The success[] entry itself is quoted (nothing truncated there); the rejection fires
    // solely because business_goal's own inline comment leaves "shared text" as a commented
    // plain scalar value that happens to match success[0].
    expect(() => readIntent(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
  });

  // Third follow-up to issue #45: yaml@2.9.0 attaches a same-line trailing comment to the
  // node that *follows* it (as that node's `commentBefore`) when the commented node is
  // immediately followed by another node's source on the same line -- here, an explicit-key
  // scalar (`? &c shipped # and verified`) is followed by its value (`: holder`) on the next
  // line, and the parser puts the comment on the *value* node, not on the anchored key
  // scalar itself. A `.comment`-based check therefore finds nothing on the key scalar and
  // misses the truncation entirely, even though `success: [*c]` resolves to the truncated
  // "shipped" via the alias. The source-based check (space/tab run + `#` immediately after
  // the scalar's own value end) catches this regardless of which node yaml's parser decided
  // to attribute the comment text to.
  it("rejects an explicit-key anchored plain scalar with an inline comment whose comment yaml attaches to the next node", () => {
    writeRawIntent(
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "execution_mode: manual",
        "budget: []",
        "scratch:",
        "  ? &c shipped # and verified",
        "  : holder",
        "intent:",
        "  business_goal: describe the business goal",
        "  user_visible_intent: describe what the user will see change",
        "  success:",
        "    - *c",
        "  non_goal: []",
        "  constraints: []",
        "  primary_user: unspecified",
        "  state_segments: []",
        "  known_affected_behavior: []",
        "  declared_risk: low",
        "ai_inferred_scope:",
        "  affected_layers: [unspecified]",
        "  related_files: []",
        "  required_docs: []",
        "  confidence: low",
        "  open_questions: []",
        '  allowed_paths: ["**"]',
        "  forbidden_paths: []",
        "",
      ].join("\n"),
    );
    expect(() => readIntent(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
  });

  // Counterpart accepted case for the same explicit-key shape: the anchored key scalar is
  // NOT referenced by intent.success (it's aliased into an unrelated field instead), so even
  // though it does carry a real inline comment, nothing in success[] was truncated by it --
  // over-reach would be flagging this too.
  it("accepts the same explicit-key anchored plain scalar with an inline comment when it is NOT aliased into success", () => {
    writeRawIntent(
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "execution_mode: manual",
        "budget: []",
        "scratch:",
        "  ? &c shipped and verified enough text # and verified",
        "  : holder",
        "intent:",
        "  business_goal: describe the business goal",
        "  user_visible_intent: *c",
        "  success:",
        "    - unrelated criterion",
        "  non_goal: []",
        "  constraints: []",
        "  primary_user: unspecified",
        "  state_segments: []",
        "  known_affected_behavior: []",
        "  declared_risk: low",
        "ai_inferred_scope:",
        "  affected_layers: [unspecified]",
        "  related_files: []",
        "  required_docs: []",
        "  confidence: low",
        "  open_questions: []",
        '  allowed_paths: ["**"]',
        "  forbidden_paths: []",
        "",
      ].join("\n"),
    );
    const intent = readIntent(specDir, intentId);
    expect(intent.intent.success).toEqual(["unrelated criterion"]);
  });

  it("rejects a plain scalar with a tab before the inline comment", () => {
    writeSuccessLines(["- ledger has a PhaseGate row\t# negative side too"]);
    expect(() => readIntent(specDir, intentId)).toThrow(IntentSuccessInlineCommentError);
  });

  it("accepts an alias to a quoted scalar containing '#' (nothing was truncated)", () => {
    writeRawIntent(
      [
        'schema_version: "1.0"',
        `intent_id: ${intentId}`,
        "execution_mode: manual",
        "budget: []",
        "intent:",
        '  business_goal: &c "ledger has a PhaseGate row # negative side too"',
        "  user_visible_intent: describe what the user will see change",
        "  success:",
        "    - *c",
        "  non_goal: []",
        "  constraints: []",
        "  primary_user: unspecified",
        "  state_segments: []",
        "  known_affected_behavior: []",
        "  declared_risk: low",
        "ai_inferred_scope:",
        "  affected_layers: [unspecified]",
        "  related_files: []",
        "  required_docs: []",
        "  confidence: low",
        "  open_questions: []",
        '  allowed_paths: ["**"]',
        "  forbidden_paths: []",
        "",
      ].join("\n"),
    );
    const intent = readIntent(specDir, intentId);
    expect(intent.intent.success).toEqual(["ledger has a PhaseGate row # negative side too"]);
  });
});
