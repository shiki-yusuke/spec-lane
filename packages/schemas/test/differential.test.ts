import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
// ajv-formats ships a CJS build with an ESM-shaped .d.ts and no package.json "exports"
// field; under moduleResolution:NodeNext, TS cannot see its default export as callable
// even though it works correctly at runtime (a well-known upstream ajv-formats/NodeNext
// typing gap, unrelated to lane's own module boundaries).
import addFormatsModule from "ajv-formats";
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => void;
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { CalibrationRecordSchema } from "../src/calibration.js";
import { EstimateSchema } from "../src/estimate.js";
import { FactSchema } from "../src/fact.js";
import { IntentSchema } from "../src/intent.js";
import { KnowledgeRecordSchema } from "../src/knowledge.js";
import { LaneStateSchemaV3 } from "../src/lane-state.js";
import { ProfileSchema } from "../src/profile.js";
import { VerificationSchema } from "../src/verification.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "schema-fixtures");
const generatedDir = join(__dirname, "..", "generated");

// design.md §2/§10 (sol 裁定 c): the committed generated/*.schema.json must reject/accept
// the same fixtures as the zod schema it was generated from. This only holds for the
// *structural* constraints JSON Schema can express (types, enums, patterns, required,
// min/max, unions) — zod .refine() cross-field invariants (e.g. estimate's p50<=p80,
// verification's digest-binding) have no JSON Schema equivalent and are dropped by
// zod-to-json-schema. Fixtures here are deliberately chosen to only exercise structural
// constraints; refine-only invariants are covered separately by each schema's own unit
// test (e.g. estimate.test.ts, verification.test.ts).
const SCHEMAS: Record<string, z.ZodTypeAny> = {
  intent: IntentSchema,
  verification: VerificationSchema,
  "lane-state": LaneStateSchemaV3,
  estimate: EstimateSchema,
  calibration: CalibrationRecordSchema,
  knowledge: KnowledgeRecordSchema,
  profile: ProfileSchema,
  fact: FactSchema,
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

interface FixtureFile {
  valid: unknown[];
  invalidStructural: Array<{ description: string; input: unknown }>;
}

for (const [name, zodSchema] of Object.entries(SCHEMAS)) {
  describe(`differential: ${name}`, () => {
    const fixturePath = join(fixturesDir, `${name}.fixtures.json`);
    const fixtures: FixtureFile = JSON.parse(readFileSync(fixturePath, "utf-8"));
    const jsonSchema = JSON.parse(readFileSync(join(generatedDir, `${name}.schema.json`), "utf-8"));
    const ajvValidate = ajv.compile(jsonSchema);

    it("generated/*.schema.json exists and compiles with ajv", () => {
      expect(typeof ajvValidate).toBe("function");
    });

    for (const [i, fixture] of fixtures.valid.entries()) {
      it(`valid fixture #${i}: zod and ajv both accept`, () => {
        const zodResult = zodSchema.safeParse(fixture);
        const ajvResult = ajvValidate(fixture);
        expect({ zod: zodResult.success, ajv: ajvResult }).toEqual({ zod: true, ajv: true });
      });
    }

    for (const { description, input } of fixtures.invalidStructural) {
      it(`invalid fixture (${description}): zod and ajv both reject`, () => {
        const zodResult = zodSchema.safeParse(input);
        const ajvResult = ajvValidate(input);
        expect({ zod: zodResult.success, ajv: ajvResult }).toEqual({ zod: false, ajv: false });
      });
    }
  });
}

describe("generate:json-schema is up to date", () => {
  it("generated/ contains exactly one .schema.json per schema in SCHEMAS", () => {
    const files = readdirSync(generatedDir).filter((f) => f.endsWith(".schema.json"));
    expect(new Set(files)).toEqual(new Set(Object.keys(SCHEMAS).map((n) => `${n}.schema.json`)));
  });
});
