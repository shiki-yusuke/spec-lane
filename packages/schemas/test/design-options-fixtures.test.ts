import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import addFormatsModule from "ajv-formats";
// The vendored upstream schema declares itself draft 2020-12 ($schema field) -- ajv's
// default export only ships draft-07's meta-schema, so this file needs the dedicated
// Ajv2020 build (differential.test.ts's own fixtures predate 2020-12 and don't need this).
// Same ESM/CJS + NodeNext typing gap as ajv-formats below: ajv/dist/2020.js's default
// export is not typed as constructable even though it works at runtime, so this imports
// the named `Ajv2020` export instead.
import { Ajv2020 as Ajv2020Ctor } from "ajv/dist/2020.js";
const addFormats = addFormatsModule as unknown as (ajv: InstanceType<typeof Ajv2020Ctor>) => void;
import { describe, expect, it } from "vitest";
import { DesignOptionsDocSchema } from "../src/design-options.js";

// I-2026-08-18-design-critic-injection R4/R5/R37 (Dependency table "Upstream contract
// shape") — replays the vendored upstream design-options/v1 fixture set (see
// packages/schemas/test/fixtures/design-options/UPSTREAM) against BOTH the raw upstream
// .schema.json (via ajv, same tool differential.test.ts already uses) and this lane's
// hand-authored zod mirror (design-options.ts), asserting accept/reject PARITY between the
// two -- the mirror's job is to reject exactly what the pinned upstream schema rejects, no
// more and no less, so that "conforms to the upstream contract exactly" (R5) is actually
// checked rather than merely asserted in a comment.
//
// Fixtures whose expected rejection reason is a SEMANTIC-only check (a named reason code
// like "dangling_decision_request_option_id" or "engine_ref_field_undeclared", not a raw
// JSON-Schema-validator path) are schema-VALID by design -- upstream's own
// verify-fixtures.mjs applies those on top of schema validation, not inside the .schema.json
// itself (see design-options.ts's header comment for why this lane's mirror does the same
// split). Those fixtures are asserted to schema-ACCEPT here (parity with ajv), and their
// semantic rejection is covered separately by design-independence.test.ts
// (engineRefIssues) and this file's own decision_request.option_ids check below.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "fixtures", "design-options", "v1");
const FIXTURES_DIR = join(FIXTURES_ROOT, "fixtures");

const rawSchema = JSON.parse(
  readFileSync(join(FIXTURES_ROOT, "design-options.schema.json"), "utf-8"),
);
const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });
addFormats(ajv);
const ajvValidate = ajv.compile(rawSchema);

interface ManifestEntry {
  id: string;
  files: { record: string };
  expected: "accept" | "reject";
  reason_code: string | null;
  all_forbidden_keys_flagged?: boolean;
}

const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "expected-results.json"), "utf-8")) as {
  fixtures: ManifestEntry[];
};

// Reason codes upstream's OWN verify-fixtures.mjs computes from something other than the
// raw .schema.json's own required/allOf/additionalProperties structure -- these fixtures
// are schema-valid on their own (both ajv and the zod mirror must ACCEPT them).
const SEMANTIC_ONLY_REASON_CODES = new Set([
  "dangling_decision_request_option_id",
  "engine_ref_field_undeclared",
]);

function isSemanticOnly(entry: ManifestEntry): boolean {
  return (
    entry.expected === "reject" &&
    !!entry.reason_code &&
    SEMANTIC_ONLY_REASON_CODES.has(entry.reason_code)
  );
}

describe("design-options/v1 vendored fixture parity (packages/schemas/test/fixtures/design-options/UPSTREAM)", () => {
  it("vendored fixtures directory is non-empty and matches the manifest", () => {
    expect(manifest.fixtures.length).toBeGreaterThan(0);
    const files = readdirSync(FIXTURES_DIR).filter(
      (f) => f.endsWith(".json") && f !== "expected-results.json",
    );
    expect(files.length).toBe(manifest.fixtures.length);
  });

  for (const entry of manifest.fixtures) {
    const expectedAtSchemaLevel = isSemanticOnly(entry) ? "accept" : entry.expected;

    it(`ajv (raw upstream schema): ${entry.id} -> ${expectedAtSchemaLevel}`, () => {
      const record = JSON.parse(readFileSync(join(FIXTURES_DIR, entry.files.record), "utf-8"));
      const valid = ajvValidate(record);
      expect(valid ? "accept" : "reject", JSON.stringify(ajvValidate.errors)).toBe(
        expectedAtSchemaLevel,
      );
    });

    it(`zod mirror (design-options.ts): ${entry.id} -> ${expectedAtSchemaLevel} (parity with ajv)`, () => {
      const record = JSON.parse(readFileSync(join(FIXTURES_DIR, entry.files.record), "utf-8"));
      const parsed = DesignOptionsDocSchema.safeParse(record);
      const category = parsed.success ? "accept" : "reject";
      expect(category, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(
        expectedAtSchemaLevel,
      );
    });
  }

  it("invalid-personal-dimension.json: all 11 forbidden top-level keys are individually flagged by zod's own unrecognized_keys issue", () => {
    const record = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "invalid-personal-dimension.json"), "utf-8"),
    );
    const parsed = DesignOptionsDocSchema.safeParse(record);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const unrecognized = parsed.error.issues.find((i) => i.code === "unrecognized_keys") as
      | { keys: string[] }
      | undefined;
    expect(unrecognized, JSON.stringify(parsed.error.issues)).toBeDefined();
    expect(unrecognized?.keys.length).toBeGreaterThanOrEqual(11);
  });

  it("invalid-decision-request-dangling-option-id.json: decision_request.option_ids must resolve against options[] (lane-level semantic check, not the raw schema)", () => {
    const record = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "invalid-decision-request-dangling-option-id.json"), "utf-8"),
    ) as { options: { option_id: string }[]; decision_request: { option_ids: string[] } };
    const parsed = DesignOptionsDocSchema.parse(record);
    const knownIds = new Set(parsed.options.map((o) => o.option_id));
    const dangling = parsed.decision_request.option_ids.filter((id) => !knownIds.has(id));
    expect(dangling).toEqual(["option_that_does_not_exist"]);
  });
});
