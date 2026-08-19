import { describe, expect, it } from "vitest";
import {
  DesignCriticAttestationSchema,
  emptyDesignCriticAttestation,
} from "../src/design-critic-attestation.js";

// I-2026-08-18-design-critic-injection R6/R7/R17. Gherkin: "a producer-supplied
// classification is rejected" / "no artifact and no lane state holds a classification".

describe("DesignCriticAttestationSchema (R6/R7/R17)", () => {
  it("parses a minimal empty attestation", () => {
    const parsed = DesignCriticAttestationSchema.parse(emptyDesignCriticAttestation("I-x"));
    expect(parsed.overrides).toEqual([]);
    expect(parsed.decision).toBeNull();
  });

  it("rejects a producer-supplied independence classification field (R16/R17, .strict())", () => {
    const withClassification = {
      ...emptyDesignCriticAttestation("I-x"),
      independence_status: "different_lineage",
    };
    const parsed = DesignCriticAttestationSchema.safeParse(withClassification);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("rejects an override recorded without an actor/reason/policy_basis (R30)", () => {
    const bad = {
      ...emptyDesignCriticAttestation("I-x"),
      overrides: [
        {
          reason: "",
          actor: "shiki",
          overridden_at: "2026-08-19T00:00:00Z",
          policy_basis: "pilot",
          scope: {
            design_options_ref: { design_options_id: "d1", content_digest: `sha256:${"a".repeat(64)}` },
            uncovered_option_ids: ["opt-a"],
          },
        },
      ],
    };
    expect(DesignCriticAttestationSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a well-formed override scoped to a revision and uncovered options (R30/R31)", () => {
    const good = {
      ...emptyDesignCriticAttestation("I-x"),
      overrides: [
        {
          reason: "pilot: proceeding without qualifying coverage",
          actor: "shiki",
          overridden_at: "2026-08-19T00:00:00Z",
          policy_basis: "opt-in pilot, no mandatory gate",
          scope: {
            design_options_ref: { design_options_id: "d1", content_digest: `sha256:${"a".repeat(64)}` },
            uncovered_option_ids: ["opt-a", "opt-b"],
          },
        },
      ],
    };
    expect(DesignCriticAttestationSchema.safeParse(good).success).toBe(true);
  });

  it("accepts a decision record bound to a specific revision digest (R35/R36/R41)", () => {
    const good = {
      ...emptyDesignCriticAttestation("I-x"),
      decision: {
        design_options_ref: { design_options_id: "d1", content_digest: `sha256:${"a".repeat(64)}` },
        selected_option_id: "opt-a",
        recorded_at: "2026-08-19T00:00:00Z",
        recorded_by: "shiki",
      },
    };
    expect(DesignCriticAttestationSchema.safeParse(good).success).toBe(true);
  });
});
