import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileSchema } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { computeDigest } from "../src/digest.js";
import { loadProfile } from "../src/profile.js";

/**
 * I-2026-08-29-external-verify-gate, TEST-32 / TEST-33.
 *
 * `effective_risk_log[].profile_digest` is `computeDigest(JSON.stringify(profile))` over the
 * *parsed* profile (src/risk.ts). That makes any `.default()` on a new profile field a silent
 * compatibility break: zod materializes defaults at parse time, so the key would appear on
 * every profile ever parsed and change the digest recorded by every existing lane -- violating
 * this feature's own core invariant that configuring nothing changes nothing (architect review
 * 9-4). `external_verify` is therefore `.optional()` with no default, and the shipped profile
 * must not carry the key either.
 *
 * The expected digest below is not a value this test computed for itself. It is the digest
 * recorded in a real lane-state.json written by lane 0.7.0, *before* external_verify existed at
 * all. Anchoring to a pre-change artifact is what makes this a compatibility test rather than a
 * tautology: recomputing today's value and asserting it equals itself would pass no matter what
 * we added.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const shippedProfilePath = join(__dirname, "..", "..", "..", "profiles", "generic.profile.yaml");

const DIGEST_RECORDED_BY_LANE_0_7_0 =
  "d72951e0e685b0a1e0ea7d370fbce3e7f45f8e549d28657a123735486c2c88ca";

describe("profile compatibility: adding external_verify must not disturb profile_digest", () => {
  it("the shipped profile does not mention external_verify at all (TEST-33)", () => {
    // Writing even an empty `external_verify: {}` into the shipped file would change its parsed
    // shape and therefore its digest, which is exactly what this feature must not do.
    expect(readFileSync(shippedProfilePath, "utf-8")).not.toContain("external_verify");
  });

  it("parsing the shipped profile does not materialize external_verify (no .default())", () => {
    const parsed = loadProfile(shippedProfilePath);
    expect(Object.hasOwn(parsed, "external_verify")).toBe(false);
    expect(parsed.external_verify).toBeUndefined();
  });

  it("still produces the digest a pre-change lane recorded (TEST-32)", () => {
    expect(computeDigest(JSON.stringify(loadProfile(shippedProfilePath)))).toBe(
      DIGEST_RECORDED_BY_LANE_0_7_0,
    );
  });

  it("a profile that DOES configure external_verify gets a different digest (the assertion above is not vacuous)", () => {
    const configured = ProfileSchema.parse({
      ...loadProfile(shippedProfilePath),
      external_verify: { allowed_command_digests: [`sha256:${"a".repeat(64)}`] },
    });
    expect(computeDigest(JSON.stringify(configured))).not.toBe(DIGEST_RECORDED_BY_LANE_0_7_0);
  });
});
