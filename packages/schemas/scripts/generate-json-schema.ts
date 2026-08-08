// design.md §2 / §10 (sol 裁定 c): zod is the SSOT, but the generated JSON Schema is
// committed so that (a) a Python-side consumer can validate against it without touching
// TypeScript, and (b) test/differential.test.ts can assert zod-parse and
// JSON-Schema-validate agree on the same fixtures.
//
// Only schemas with no data-dependent factory (buildCriticSchema takes a Profile
// argument, so it has no single JSON Schema) are generated here.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CalibrationRecordSchema } from "../src/calibration.js";
import { EstimateSchema } from "../src/estimate.js";
import { FactSchema } from "../src/fact.js";
import { IntentSchema } from "../src/intent.js";
import { KnowledgeRecordSchema } from "../src/knowledge.js";
import { LaneStateSchemaV3 } from "../src/lane-state.js";
import { ProfileSchema } from "../src/profile.js";
import { VerificationSchema } from "../src/verification.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "generated");

const targets: Array<{ name: string; schema: Parameters<typeof zodToJsonSchema>[0] }> = [
  { name: "intent", schema: IntentSchema },
  { name: "verification", schema: VerificationSchema },
  { name: "lane-state", schema: LaneStateSchemaV3 },
  { name: "estimate", schema: EstimateSchema },
  { name: "calibration", schema: CalibrationRecordSchema },
  { name: "knowledge", schema: KnowledgeRecordSchema },
  { name: "profile", schema: ProfileSchema },
  { name: "fact", schema: FactSchema },
];

for (const { name, schema } of targets) {
  const jsonSchema = zodToJsonSchema(schema, { name, $refStrategy: "none" });
  const outPath = join(outDir, `${name}.schema.json`);
  writeFileSync(outPath, `${JSON.stringify(jsonSchema, null, 2)}\n`, "utf-8");
  console.log(`wrote ${outPath}`);
}
