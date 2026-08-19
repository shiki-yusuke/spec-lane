import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DesignCriticAttestation,
  DesignCriticAttestationSchema,
  emptyDesignCriticAttestation,
} from "@lane/schemas";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// I-2026-08-18-design-critic-injection R6/R30/R35 -- same read/write shape as
// verification-store.ts. YAML on disk (matches critic.yaml/verification.yaml, the other
// hand-editable-but-schema-checked artifacts in this repo); the design-options revisions
// themselves stay JSON (design-options-store.ts) since their digest is computed over the
// canonical JSON form and a YAML round-trip would be one more place that could silently
// perturb bytes.

export function designAttestationPath(specDir: string, intentId: string): string {
  return join(specDir, intentId, "design", "attestation.yaml");
}

export function readDesignAttestation(specDir: string, intentId: string): DesignCriticAttestation {
  const path = designAttestationPath(specDir, intentId);
  if (!existsSync(path)) return emptyDesignCriticAttestation(intentId);
  const raw = parseYaml(readFileSync(path, "utf-8"));
  return DesignCriticAttestationSchema.parse(raw);
}

export function writeDesignAttestation(
  specDir: string,
  intentId: string,
  attestation: DesignCriticAttestation,
): void {
  const validated = DesignCriticAttestationSchema.parse(attestation);
  const path = designAttestationPath(specDir, intentId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, stringifyYaml(validated));
}
