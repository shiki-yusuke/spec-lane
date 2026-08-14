import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CrossCheckIntentVsSpecSchema,
  PremiseEvidenceSchema,
  ProfileSchema,
  SuccessCriteriaRowSchema,
  buildCriticSchema,
} from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// Scaffold/skill-doc review (#52): three real mistakes shipped in this repo's own
// docs/spec/ history despite content being right: `premise_evidence` written as a list
// under `premises:`, `method` set to a value (`static_trace`) outside the schema's
// live|data|code-only enum, and critic.yaml's `taxonomy` set to a lens name (`security`)
// instead of the closed knowledge-taxonomy enum. skills/lane/SKILL.md now embeds
// schema-exact YAML examples to prevent a repeat -- this test is the guardrail that keeps
// those examples honest: every fenced ```yaml block in the skill doc is parsed and
// validated against the same zod schemas `lane validate` actually runs, so a schema
// change that silently breaks a doc example fails CI instead of surfacing months later as
// another agent's rejected scaffold.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const laneSkillMd = readFileSync(join(repoRoot, "skills", "lane", "SKILL.md"), "utf-8");

function extractYamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```yaml\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(re)) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

const yamlBlocks = extractYamlBlocks(laneSkillMd);

const genericProfile = ProfileSchema.parse({
  schema_version: "1.0",
  profile_id: "generic",
  extra_lenses: [],
});
const criticSchema = buildCriticSchema(genericProfile);

describe("skills/lane/SKILL.md YAML examples stay schema-valid", () => {
  it("found the expected number of fenced yaml examples (update this test if SKILL.md's examples change)", () => {
    expect(yamlBlocks.length).toBe(4);
  });

  it("both premise_evidence examples (required:true and required:false) parse under PremiseEvidenceSchema", () => {
    const premiseBlocks = yamlBlocks
      .map((block) => parseYaml(block))
      .filter(
        (parsed): parsed is { premise_evidence: unknown } =>
          !!parsed && typeof parsed === "object" && "premise_evidence" in parsed,
      );
    expect(premiseBlocks.length).toBe(2);

    for (const { premise_evidence } of premiseBlocks) {
      expect(PremiseEvidenceSchema.safeParse(premise_evidence).success).toBe(true);
    }

    const requiredValues = premiseBlocks.map(
      (b) => (b.premise_evidence as { required: boolean }).required,
    );
    expect(requiredValues.sort()).toEqual([false, true]);
  });

  it("the critic.yaml example parses under buildCriticSchema (core lenses, real taxonomy value)", () => {
    const criticBlock = yamlBlocks
      .map((block) => parseYaml(block))
      .find(
        (parsed): parsed is Record<string, unknown> =>
          !!parsed && typeof parsed === "object" && "decision" in parsed && "per_lens" in parsed,
      );
    expect(criticBlock).toBeDefined();
    const result = criticSchema.safeParse(criticBlock);
    expect(result.success).toBe(true);
  });

  it("rejects the same critic example if taxonomy is swapped for a lens name (documents why the doc calls this out)", () => {
    const criticBlock = yamlBlocks
      .map((block) => parseYaml(block))
      .find(
        (parsed): parsed is Record<string, unknown> =>
          !!parsed && typeof parsed === "object" && "decision" in parsed && "per_lens" in parsed,
      );
    // biome-ignore lint/suspicious/noExplicitAny: deliberately corrupting a valid fixture to prove the rejection
    const corrupted = structuredClone(criticBlock) as any;
    corrupted.per_lens[0].taxonomy = "security"; // a lens_id, not a taxonomy value
    expect(criticSchema.safeParse(corrupted).success).toBe(false);
  });

  it("the success_criteria_matrix / cross_check_intent_vs_spec example parses under their schemas", () => {
    const successBlock = yamlBlocks
      .map((block) => parseYaml(block))
      .find(
        (parsed): parsed is Record<string, unknown> =>
          !!parsed && typeof parsed === "object" && "success_criteria_matrix" in parsed,
      );
    expect(successBlock).toBeDefined();
    const rows = successBlock?.success_criteria_matrix as unknown[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(SuccessCriteriaRowSchema.safeParse(row).success).toBe(true);
    }
    expect(
      CrossCheckIntentVsSpecSchema.safeParse(successBlock?.cross_check_intent_vs_spec).success,
    ).toBe(true);
  });
});
