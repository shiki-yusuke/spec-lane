import {
  type Intent,
  type LaneState,
  LaneStateSchemaV3,
  type Profile,
  ProfileSchema,
} from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { type GateContext, premiseEvidenceGate } from "../src/gate.js";

const profile: Profile = ProfileSchema.parse({ schema_version: "1.0", profile_id: "generic" });

// Deliberately NOT IntentSchema.parse(): a couple of tests below exercise
// premiseEvidenceGate's own defense-in-depth checks (invalid method enum) that a
// schema-validated Intent could never actually carry (IntentSchema's discriminated union
// already rejects an unrecognized `method`) -- the gate still checks independently,
// matching the reference implementation's own redundant check, and this cast is what lets
// a test construct the otherwise-unreachable input to prove that check still works.
function buildIntent(premiseEvidence?: unknown): Intent {
  return {
    schema_version: "1.0",
    intent_id: "I-2026-08-06-example",
    execution_mode: "manual",
    budget: [],
    premise_evidence: premiseEvidence,
    intent: {
      business_goal: "Reduce onboarding time by clarifying setup docs.",
      user_visible_intent: "New users see setup steps in order.",
      success: ["ok"],
      non_goal: [],
      constraints: [],
      primary_user: "new_developer",
      state_segments: [],
      known_affected_behavior: [],
      declared_risk: "low",
    },
    ai_inferred_scope: {
      affected_layers: ["docs"],
      related_files: [],
      required_docs: [],
      confidence: "medium",
      open_questions: [],
      allowed_paths: ["docs/**"],
      forbidden_paths: [],
    },
  } as unknown as Intent;
}

function buildState(): LaneState {
  return LaneStateSchemaV3.parse({
    schema_version: "3.0",
    intent_id: "I-2026-08-06-example",
    tracker_url: null,
    pr_url: null,
    owner: null,
    current_phase: "1_intent",
    status: "running",
    created_at: "2026-08-06T09:00:00+09:00",
  });
}

function buildContext(premiseEvidence?: unknown): GateContext {
  return {
    trigger: { type: "phase_advance", from: "1_intent", to: "2_spec" },
    state: buildState(),
    profile,
    artifacts: { intent: buildIntent(premiseEvidence) },
  };
}

describe("premiseEvidenceGate.appliesTo", () => {
  it("applies only to the 1_intent -> 2_spec phase_advance edge", () => {
    const ctx = buildContext();
    expect(premiseEvidenceGate.appliesTo(ctx)).toBe(true);
    expect(
      premiseEvidenceGate.appliesTo({
        ...ctx,
        trigger: { type: "phase_advance", from: "2_spec", to: "3_implement" },
      }),
    ).toBe(false);
    expect(
      premiseEvidenceGate.appliesTo({
        ...ctx,
        trigger: { type: "before_pr_publish", phase: "1_intent" },
      }),
    ).toBe(false);
  });
});

describe("premiseEvidenceGate.evaluate", () => {
  it("warns (never errors) when premise_evidence is entirely absent — the CLI cannot decide applicability", () => {
    const diagnostics = premiseEvidenceGate.evaluate(buildContext(undefined));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "warning", code: "missing" });
  });

  it("passes silently for required:false with a reason", () => {
    const diagnostics = premiseEvidenceGate.evaluate(
      buildContext({
        required: false,
        reason: "User-reported issue with an already-observed symptom.",
      }),
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("errors when required:true and reproduced:false (fail-closed)", () => {
    const diagnostics = premiseEvidenceGate.evaluate(
      buildContext({
        required: true,
        method: "live",
        reproduced: false,
        evidence: "Attempted to reproduce locally but could not observe the reported behavior.",
      }),
    );
    expect(diagnostics.some((d) => d.severity === "error" && d.code === "not_reproduced")).toBe(
      true,
    );
  });

  it("errors when method is not one of live|data|code-only", () => {
    const diagnostics = premiseEvidenceGate.evaluate(
      buildContext({
        required: true,
        method: "hearsay",
        reproduced: true,
        evidence: "Ran the failing scenario locally and confirmed the reported timeout.",
      }),
    );
    expect(diagnostics.some((d) => d.severity === "error" && d.code === "invalid_method")).toBe(
      true,
    );
  });

  it("errors when evidence is shorter than 20 codepoints after trimming", () => {
    const diagnostics = premiseEvidenceGate.evaluate(
      buildContext({ required: true, method: "live", reproduced: true, evidence: "  too short  " }),
    );
    expect(diagnostics.some((d) => d.severity === "error" && d.code === "evidence_too_short")).toBe(
      true,
    );
  });

  it("codepoint-vs-UTF-16 regression: an evidence string with fewer than 20 real codepoints but a UTF-16 .length >= 20 (due to surrogate-pair emoji) still errors", () => {
    // 10 emoji (each 1 codepoint / 2 UTF-16 units) + 9 ASCII letters = 19 codepoints,
    // but "evidence".length (UTF-16 units) is 10*2 + 9 = 29 -- a naive `.length` check
    // would wrongly accept this as >= 20. Array.from(...).length (codepoints) is 19 < 20,
    // matching Python's len() on the same string, so this must still error.
    const evidence = "🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉abcdefghi";
    expect(evidence.length).toBeGreaterThanOrEqual(20); // sanity: naive .length would pass
    expect(Array.from(evidence).length).toBe(19); // real codepoint count is under the threshold
    const diagnostics = premiseEvidenceGate.evaluate(
      buildContext({ required: true, method: "live", reproduced: true, evidence }),
    );
    expect(diagnostics.some((d) => d.severity === "error" && d.code === "evidence_too_short")).toBe(
      true,
    );
  });

  it("codepoint-vs-UTF-16 regression: 20 real codepoints (mixed emoji + ASCII) passes the length check", () => {
    const evidence = "🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉abcdefghij"; // 10 emoji + 10 ASCII = 20 codepoints
    expect(Array.from(evidence).length).toBe(20);
    const diagnostics = premiseEvidenceGate.evaluate(
      buildContext({ required: true, method: "live", reproduced: true, evidence }),
    );
    expect(diagnostics.some((d) => d.code === "evidence_too_short")).toBe(false);
  });

  it("warns (does not error) when method=code-only and everything else is valid — weak evidence, not fail-closed", () => {
    const diagnostics = premiseEvidenceGate.evaluate(
      buildContext({
        required: true,
        method: "code-only",
        reproduced: true,
        evidence:
          "Traced the code path statically and confirmed the branch is reachable as described.",
      }),
    );
    expect(diagnostics.some((d) => d.severity === "error")).toBe(false);
    expect(diagnostics.some((d) => d.severity === "warning" && d.code === "weak_evidence")).toBe(
      true,
    );
  });

  it("does not warn about weak evidence for method=live even if it happens to be otherwise the same shape", () => {
    const diagnostics = premiseEvidenceGate.evaluate(
      buildContext({
        required: true,
        method: "live",
        reproduced: true,
        evidence:
          "Ran the failing scenario locally and confirmed the reported timeout with a trace.",
      }),
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("accumulates multiple simultaneous errors rather than stopping at the first (Diagnostic[] design)", () => {
    const diagnostics = premiseEvidenceGate.evaluate(
      buildContext({ required: true, method: "hearsay", reproduced: false, evidence: "short" }),
    );
    const codes = diagnostics.map((d) => d.code).sort();
    expect(codes).toEqual(["evidence_too_short", "invalid_method", "not_reproduced"]);
  });
});
