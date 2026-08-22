import { describe, expect, it } from "vitest";
import { mapReasonRecordToDesignMessage } from "../src/design-independence.js";
import {
  REASON_CODES,
  type ReasonCode,
  type ReasonRecord,
} from "../src/vendor/derive-independence/v1/derive-independence.mjs";

// R46 (2026-08-22 re-vendor, I-2026-08-22-r46-vendored-reason-catalog) — living-contract
// test: imports the VENDORED module's own closed REASON_CODES set (never a hand-copied
// list) and asserts every one of them maps onto a real catalog entry via
// mapReasonRecordToDesignMessage. TypeScript's exhaustive `switch` in that function
// already fails to COMPILE if a re-vendor adds a code with no matching `case`
// (design-independence.ts's own comment on the function explains why); this test is the
// runtime half of the same guarantee, and the one that would actually fail CI if the
// vendored .mjs and this hand-written test both silently forgot the same code (the type
// check alone can't catch a REASON_CODES entry that isn't reflected in the ReasonCode
// union type at all, since that union is itself hand-written against the vendored file).

const context = { reviewIndex: 0 };

/** One syntactically-plausible sample record per code, built from each code's own real
 * params shape (see derive-independence.d.mts) -- not exhaustive of every real value each
 * field can take, just enough to exercise formatDesignMessage's placeholder-fill path for
 * that code without throwing on a missing param. */
function sampleRecord(code: ReasonCode): ReasonRecord {
  switch (code) {
    case "critic_ref_missing":
    case "human_third_party":
    case "human_is_decision_maker":
    case "human_missing_decision_maker_flag":
    case "no_artifact_shapers":
    case "unknown_shaper_comparison":
    case "provider_unknown":
    case "same_session_ref":
    case "different_session_ref":
    case "session_ref_one_side":
    case "session_ref_neither_side":
      return { code, params: {} };
    case "shaper_relation":
      return {
        code,
        params: {
          shaper_desc: "claude-sonnet-5",
          how: "authored",
          relation: "different_lineage",
          inner: { code: "provider_unknown", params: {} },
        },
      };
    case "closest_relation":
      return { code, params: { relation: "same_session" } };
    case "no_shared_lineage_possible":
      return { code, params: { shaper_kind: "human", critic_kind: "model" } };
    case "different_provider":
      return { code, params: { shaper_provider: "openai", critic_provider: "anthropic" } };
    case "same_provider_different_family":
      return {
        code,
        params: { provider: "anthropic", shaper_family: "claude-4", critic_family: "claude-5" },
      };
    case "same_family_different_model":
      return {
        code,
        params: {
          provider: "anthropic",
          family_confirmed: true,
          shaper_model_id: "claude-sonnet-4",
          critic_model_id: "claude-sonnet-5",
        },
      };
    case "lineage_dimension":
      return { code, params: { derived_status: "different_lineage", clears: true } };
    case "involvement_dimension":
      return {
        code,
        params: { prior_involvement: "none_observed_in_recorded_scope", clears: true },
      };
    case "conjunction":
      return { code, params: { qualifying: true } };
  }
}

describe("mapReasonRecordToDesignMessage (R46 living contract)", () => {
  it("REASON_CODES is the closed 20-code set this test (and the mapping function) were written against", () => {
    // Pins the count so a re-vendor that adds/removes a code is impossible to miss here --
    // the loop below would otherwise still pass with fewer codes checked than exist.
    expect(REASON_CODES.length).toBe(20);
  });

  it.each(REASON_CODES)("code %s maps onto a non-empty catalogued message", (code) => {
    const message = mapReasonRecordToDesignMessage(sampleRecord(code), context);
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });

  it("every code the vendored module actually exports is covered by sampleRecord (no silent skip in the test itself)", () => {
    const covered = REASON_CODES.map((code) => {
      expect(() => sampleRecord(code)).not.toThrow();
      return code;
    });
    expect(covered).toEqual([...REASON_CODES]);
  });

  it("shaper_relation recurses through its nested inner record via the catalog too (relation_comparison's {reason} placeholder)", () => {
    const message = mapReasonRecordToDesignMessage(
      {
        code: "shaper_relation",
        params: {
          shaper_desc: "gpt-5.6",
          how: "authored",
          relation: "same_provider_different_family",
          inner: {
            code: "same_provider_different_family",
            params: { provider: "openai", shaper_family: "gpt-5", critic_family: "gpt-6" },
          },
        },
      },
      context,
    );
    expect(message).toContain("gpt-5.6");
    expect(message).toContain("same provider (openai)");
  });

  // Injection test (team-lead's explicit ask): a fabricated record with a code outside the
  // vendored module's closed set must fail closed, never render a placeholder guess.
  // Bypasses the type system on purpose (this is exactly the "corrupted/fabricated input"
  // case the function's own doc comment says is the only way to reach its runtime default
  // -- TypeScript itself refuses to construct this value for any real caller).
  it("throws (fails closed) for a fabricated record whose code is outside the vendored REASON_CODES set", () => {
    const injected = { code: "nonexistent_code", params: {} } as unknown as ReasonRecord;
    expect(() => mapReasonRecordToDesignMessage(injected, context)).toThrow(
      /unrecognized reason code "nonexistent_code"/,
    );
  });
});
