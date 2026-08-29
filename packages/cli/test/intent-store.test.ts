import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Intent } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
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
