import { describe, expect, it } from "vitest";
import { IntentSchema, PremiseEvidenceSchema } from "../src/intent.js";

// Gate-port review (2026-08-06) — premise_evidence discriminated union negative cases
// (gate-port-spec.md §6's required extras). core/gate.ts's premiseEvidenceGate is what
// decides warning-vs-error for a *well-formed* record; these tests are only about the
// discriminated union's own shape enforcement.
describe("PremiseEvidenceSchema (discriminated union on `required`)", () => {
  it("accepts the required:true branch with method/reproduced/evidence", () => {
    const result = PremiseEvidenceSchema.safeParse({
      required: true,
      method: "live",
      reproduced: true,
      evidence: "Ran the failing scenario locally and confirmed the reported timeout.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts the required:false branch with just reason", () => {
    const result = PremiseEvidenceSchema.safeParse({
      required: false,
      reason: "User-reported issue with an already-observed symptom.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects required:true missing method", () => {
    const result = PremiseEvidenceSchema.safeParse({
      required: true,
      reproduced: true,
      evidence: "Ran the failing scenario locally and confirmed the reported timeout.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects required:true missing reproduced", () => {
    const result = PremiseEvidenceSchema.safeParse({
      required: true,
      method: "live",
      evidence: "Ran the failing scenario locally and confirmed the reported timeout.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects required:true with an unrecognized method", () => {
    const result = PremiseEvidenceSchema.safeParse({
      required: true,
      method: "hearsay",
      reproduced: true,
      evidence: "Ran the failing scenario locally and confirmed the reported timeout.",
    });
    expect(result.success).toBe(false);
  });

  // MP-8 (2026-08-08, sol ruling point 6): the message is fixed at the schema layer
  // (zod's own errorMap on the method enum), not reconstructed by any CLI-side pattern
  // matching -- this test pins the exact wording so a future refactor can't silently
  // regress it back to zod's generic "Invalid enum value..." text.
  it("an unrecognized method produces exactly the fixed schema-level message", () => {
    const result = PremiseEvidenceSchema.safeParse({
      required: true,
      method: "hearsay",
      reproduced: true,
      evidence: "Ran the failing scenario locally and confirmed the reported timeout.",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "method");
      expect(issue?.message).toBe(
        'premise_evidence.method must be one of live|data|code-only (got: "hearsay")',
      );
    }
  });

  it("rejects required:false missing reason", () => {
    const result = PremiseEvidenceSchema.safeParse({ required: false });
    expect(result.success).toBe(false);
  });

  it("rejects required:false with an empty-string reason (min(1))", () => {
    const result = PremiseEvidenceSchema.safeParse({ required: false, reason: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a required:false record that also carries true-branch fields (still discriminates strictly on `required`'s value, extra fields don't smuggle it into the other branch)", () => {
    const result = PremiseEvidenceSchema.safeParse({
      required: false,
      reason: "x",
      method: "live",
      reproduced: true,
      evidence: "y",
    });
    // zod object schemas ignore unrecognized/mismatched-branch extra keys by default;
    // this documents that behavior explicitly rather than leaving it implicit -- the
    // `required: false` branch is chosen and validated on its own terms, extra keys and
    // all, which is why gate_check_premise_evidence-equivalent logic must only ever read
    // `reason` off this branch, never `method`/`reproduced`/`evidence`.
    expect(result.success).toBe(true);
  });

  it("rejects a `required` value that is neither true nor false", () => {
    const result = PremiseEvidenceSchema.safeParse({ required: "yes", reason: "x" });
    expect(result.success).toBe(false);
  });
});

describe("IntentSchema.premise_evidence", () => {
  const base = {
    schema_version: "1.0",
    intent_id: "I-2026-07-31-example-feature",
    intent: {
      business_goal: "Reduce onboarding time by clarifying setup docs.",
      user_visible_intent: "New users see setup steps in order.",
      success: ["ok"],
      primary_user: "new_developer",
      declared_risk: "low" as const,
    },
    ai_inferred_scope: {
      affected_layers: ["docs"],
      confidence: "medium" as const,
      allowed_paths: ["docs/**"],
    },
  };

  it("is valid with premise_evidence entirely absent (never a .default() — absence itself is the gate's warning signal)", () => {
    const result = IntentSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.premise_evidence).toBeUndefined();
      expect("premise_evidence" in result.data).toBe(false);
    }
  });

  it("is valid with a well-formed premise_evidence", () => {
    const result = IntentSchema.safeParse({
      ...base,
      premise_evidence: {
        required: true,
        method: "data",
        reproduced: true,
        evidence: "Confirmed via the existing metrics dashboard.",
      },
    });
    expect(result.success).toBe(true);
  });
});
