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

/**
 * Thrown by readIntentForWrite/writeIntent (never by readIntent) when the candidate object
 * carries a key IntentSchema doesn't recognize -- writing it back (IntentSchema.parse's
 * default non-strict behavior silently strips unrecognized keys) would permanently delete
 * that data from intent.yaml. Fail-closed: no file is touched when this is thrown.
 */
export class IntentWriteWouldDropKeysError extends Error {
  constructor(
    readonly intentId: string,
    readonly droppedPaths: readonly string[],
  ) {
    super(
      `refusing to write intent.yaml for ${intentId}: it carries key(s) IntentSchema doesn't recognize, and writing it back would silently delete them: ${droppedPaths.join(", ")}. Add the missing field(s) to IntentSchema (packages/schemas/src/intent.ts), or move them out of intent.yaml by hand before adopting.`,
    );
    this.name = "IntentWriteWouldDropKeysError";
  }
}

/**
 * Recursively finds keys present in `raw` but absent from `parsed` at the same path --
 * i.e. keys IntentSchema.parse silently stripped because it isn't `.strict()`. Paths use
 * dot notation (`intent.critical_invariants`); array elements are walked pairwise by index
 * but never appear in the reported path themselves (a dropped key inside one element of
 * `budget[]` is reported as e.g. `budget.made_up_field`, not `budget[0].made_up_field` --
 * per-element indices aren't useful here, only the key name is).
 */
function diffDroppedPaths(raw: unknown, parsed: unknown, pathPrefix: string, dropped: Set<string>) {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) return;
    const len = Math.min(raw.length, parsed.length);
    for (let i = 0; i < len; i++) {
      diffDroppedPaths(raw[i], parsed[i], pathPrefix, dropped);
    }
    return;
  }
  if (raw !== null && typeof raw === "object") {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const rawObj = raw as Record<string, unknown>;
    const parsedObj = parsed as Record<string, unknown>;
    for (const key of Object.keys(rawObj)) {
      const here = pathPrefix ? `${pathPrefix}.${key}` : key;
      // sol review (2nd round, 2026-08-29): `key in parsedObj` also matches inherited
      // properties (Object.prototype's own `constructor`/`toString`/`hasOwnProperty`/etc.)
      // -- a YAML key named e.g. `intent.constructor` would then read as "present on
      // parsed" even though IntentSchema actually stripped it, silently defeating the
      // whole fail-closed guard readIntentForWrite/writeIntent exist to provide.
      // Object.hasOwn checks own properties only; `Object.keys(rawObj)` above already only
      // ever yields own keys, so this is the correct check on both sides.
      if (!Object.hasOwn(parsedObj, key)) {
        dropped.add(here);
        continue;
      }
      diffDroppedPaths(rawObj[key], parsedObj[key], here, dropped);
    }
  }
}

export interface IntentInspection {
  parsed: Intent;
  /** Sorted, deduped dot-paths of every key `raw` carried that IntentSchema doesn't
   * recognize (and therefore isn't present on `parsed`). Empty when raw round-trips clean. */
  droppedPaths: string[];
}

/** Parses `raw` against IntentSchema (same acceptance behavior as `IntentSchema.parse`
 * always had) while also reporting which keys, if any, that parse silently dropped. Shared
 * by readIntent (warn-only), readIntentForWrite (fail-closed), and writeIntent (fail-closed
 * defense-in-depth on the object about to be re-serialized) so the detection logic exists
 * exactly once. */
export function inspectIntent(raw: unknown): IntentInspection {
  const parsed = IntentSchema.parse(raw);
  const dropped = new Set<string>();
  diffDroppedPaths(raw, parsed, "", dropped);
  return { parsed, droppedPaths: [...dropped].sort() };
}

export function readIntent(specDir: string, intentId: string): Intent {
  const raw = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
  const { parsed, droppedPaths } = inspectIntent(raw);
  if (droppedPaths.length > 0) {
    process.stderr.write(
      `warning: intent.yaml for ${intentId} carries key(s) IntentSchema doesn't recognize, dropped from the in-memory Intent (this read is read-only, so intent.yaml itself is unchanged): ${droppedPaths.join(", ")} -- add them to IntentSchema (packages/schemas/src/intent.ts) before anything re-writes this file, or they will be permanently lost\n`,
    );
  }
  return parsed;
}

/**
 * Like readIntent, but fail-closed: throws IntentWriteWouldDropKeysError instead of
 * warning when intent.yaml carries a key IntentSchema doesn't recognize. Every call site
 * that is about to re-serialize intent.yaml (`lane estimate --adopt`'s two adopt paths)
 * must read through this, not readIntent, so an unrecognized key blocks the write instead
 * of being silently deleted by it.
 */
export function readIntentForWrite(specDir: string, intentId: string): Intent {
  const raw = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
  const { parsed, droppedPaths } = inspectIntent(raw);
  if (droppedPaths.length > 0) {
    throw new IntentWriteWouldDropKeysError(intentId, droppedPaths);
  }
  return parsed;
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
  // Defense-in-depth (not the primary guard -- readIntentForWrite is): `intent`'s static
  // type is already `Intent`, but nothing at runtime stops a caller from handing this an
  // object that's merely *assignable* to that type while actually carrying an extra key
  // (e.g. widened through `as Intent`, or built by spreading an object read some other
  // way). Reusing inspectIntent here means that key is caught and refused, not silently
  // stripped by IntentSchema.parse below.
  const { parsed: validated, droppedPaths } = inspectIntent(intent);
  if (droppedPaths.length > 0) {
    throw new IntentWriteWouldDropKeysError(intentId, droppedPaths);
  }
  const path = intentPath(specDir, intentId);
  mkdirSync(join(path, ".."), { recursive: true });
  const guide = validated.premise_evidence === undefined ? PREMISE_EVIDENCE_GUIDE_COMMENT : "";
  writeFileSync(path, stringifyYaml(validated) + guide);
}
