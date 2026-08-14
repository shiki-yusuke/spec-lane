import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Intent, IntentSchema } from "@lane/schemas";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export function intentPath(specDir: string, intentId: string): string {
  return join(specDir, intentId, "intent.yaml");
}

/**
 * Every intent id with an intent.yaml directly under specDir (`lane next`, M3 — needs to
 * enumerate all lanes to build a candidate list, not just one). Returns [] if specDir
 * doesn't exist yet rather than throwing (a brand-new repo with no lanes started is not an
 * error).
 */
export function listIntentIds(specDir: string): string[] {
  if (!existsSync(specDir)) return [];
  return readdirSync(specDir)
    .filter((name) => {
      const dirPath = join(specDir, name);
      return statSync(dirPath).isDirectory() && intentExists(specDir, name);
    })
    .sort();
}

export function intentExists(specDir: string, intentId: string): boolean {
  return existsSync(intentPath(specDir, intentId));
}

export function readIntent(specDir: string, intentId: string): Intent {
  const raw = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
  return IntentSchema.parse(raw);
}

// Real-world scaffold mistakes this guards against (all three shipped `premise_evidence`
// or `critic.yaml` in a shape `lane validate` rejects, even though the *content* was
// right): `premise_evidence` written as a list under a `premises:` key instead of the
// single object PremiseEvidenceSchema actually is, and `method` set to a value
// (`static_trace`) that isn't one of the schema's three (`live`/`data`/`code-only`). A
// scaffolded intent.yaml carrying the exact shape inline -- not just prose in
// skills/lane/SKILL.md -- means an agent editing this file sees the real constraint at
// the point of use, instead of having to have already read (and correctly recalled) the
// skill doc. Appended as a raw comment after the IntentSchema-validated write, not folded
// into the `Intent` object itself: YAML comments have no equivalent in a parsed JS value.
// Lives here (not in `lane start`) so every writer that re-stringifies intent.yaml --
// e.g. `lane estimate --adopt` -- re-appends it as long as premise_evidence is still
// unrecorded; once the field exists the guide has served its purpose and is dropped.
const PREMISE_EVIDENCE_GUIDE_COMMENT = `
# premise_evidence:            # <- record this at Phase 1 (gate 1), before writing spec.md.
#                               #    Exactly one of these two shapes -- a single object, never a list:
#   required: true             # this change's premise needs its real-world existence confirmed
#   method: code-only          # live | data | code-only ONLY -- no other value (live/data are stronger evidence)
#   reproduced: true           # boolean -- was it actually confirmed?
#   evidence: "..."            # a single string (not a list) -- what was checked and how
# --- or ---
# premise_evidence:
#   required: false
#   reason: "..."              # string -- why this doesn't apply
`;

export function writeIntent(specDir: string, intentId: string, intent: Intent): void {
  const validated = IntentSchema.parse(intent);
  const path = intentPath(specDir, intentId);
  mkdirSync(join(path, ".."), { recursive: true });
  const guide = validated.premise_evidence === undefined ? PREMISE_EVIDENCE_GUIDE_COMMENT : "";
  writeFileSync(path, stringifyYaml(validated) + guide);
}
