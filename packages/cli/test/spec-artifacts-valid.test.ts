import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL_VERIFY_FAILURES, EXTERNAL_VERIFY_REFUSALS } from "@lane/core";
import { IntentSchema, VerificationSchema } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

/**
 * This repo's own `docs/spec/*` artifacts, validated against the schemas the CLI enforces.
 *
 * They were not checked by anything. `lane validate` parses these files when it runs *on a lane*,
 * but nothing parsed the ones committed here, so a hand-edit could leave an artifact that the tool
 * would reject on its own repo -- and the suite would stay green.
 *
 * Found by making both mistakes while editing one file (2026-08-20): `status: partial`, which is
 * not in the enum, and a `RESOLVED (date):` line inside a plain scalar, where the colon-space made
 * YAML read it as a mapping key and the file stopped parsing at all. Full lint, typecheck and 944
 * tests passed over both. A schema whose own repo's artifacts are unchecked is a convention, not a
 * schema -- and this project uses these files as evidence that requirements were verified, so an
 * unparseable or off-enum one silently weakens the evidence rather than anything visible.
 *
 * Kept to the two schemas whose files exist per lane and are hand-edited most. `lane-state.json`
 * and `critic.yaml` are written by the tool rather than by hand; adding them here would test the
 * tool's own output against the tool's own schema, which is a weaker thing to assert.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const specRoot = join(__dirname, "..", "..", "..", "docs", "spec");

function laneDirectories(): string[] {
  return readdirSync(specRoot).filter((entry) => entry.startsWith("I-"));
}

describe("this repo's own spec artifacts satisfy the schemas the CLI enforces", () => {
  const lanes = laneDirectories();

  it("finds the lanes, rather than validating an empty list", () => {
    // Without this the cases below pass trivially if the directory layout ever changes.
    expect(lanes.length).toBeGreaterThan(3);
  });

  it.each(lanes)("%s: verification.yaml parses and validates", (lane) => {
    const file = join(specRoot, lane, "verification.yaml");
    if (!existsSync(file)) return;
    const raw = readFileSync(file, "utf-8");
    // Parsed separately from validation so a YAML syntax error reports as one, rather than
    // surfacing as a confusing schema failure about a field that is not really there.
    const parsed = YAML.parse(raw);
    const result = VerificationSchema.safeParse(parsed);
    expect(
      result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    ).toEqual([]);
  });

  it.each(lanes)("%s: intent.yaml parses and validates", (lane) => {
    const file = join(specRoot, lane, "intent.yaml");
    if (!existsSync(file)) return;
    const parsed = YAML.parse(readFileSync(file, "utf-8"));
    const result = IntentSchema.safeParse(parsed);
    expect(
      result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    ).toEqual([]);
  });
});

describe("D7's failure table lists every code the implementation can emit", () => {
  // spec.md D7 is normative: it says which refusal and failure codes exist and, for the
  // execution-status ones, in what order they are decided. It went stale SEVEN times on this
  // lane, and every remedy I wrote down was a promise to search more carefully next time --
  // "grep spec.md", then "grep all four artifacts", then "grep source strings too". Each was
  // exactly one category too narrow, and the seventh miss was a code I had added myself in the
  // commit immediately before.
  //
  // So this stops being maintained by memory. The unions are exported as values, and the table
  // has to mention each of them by name. Adding a code without documenting it now fails here
  // rather than being noticed by a reviewer three rounds later.
  const specMd = readFileSync(
    join(specRoot, "I-2026-08-29-external-verify-gate", "spec.md"),
    "utf-8",
  );
  const d7 = specMd.slice(specMd.indexOf("### D7."), specMd.indexOf("### D8."));

  it("mentions every ExternalVerifyRefusal", () => {
    expect(d7).not.toBe("");
    const undocumented = EXTERNAL_VERIFY_REFUSALS.filter((code) => !d7.includes(code));
    expect(undocumented).toEqual([]);
  });

  it("mentions every ExternalVerifyFailure", () => {
    const undocumented = EXTERNAL_VERIFY_FAILURES.filter((code) => !d7.includes(code));
    expect(undocumented).toEqual([]);
  });
});
