import {
  type Intent,
  type LaneState,
  LaneStateSchemaV3,
  type Profile,
  ProfileSchema,
  type Verification,
  VerificationSchema,
} from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { type GateContext, successCriteriaGate } from "../src/gate.js";

const profile: Profile = ProfileSchema.parse({ schema_version: "1.0", profile_id: "generic" });

// Deliberately NOT IntentSchema.parse(): the empty-success test below exercises
// successCriteriaGate's own defense-in-depth for intent.intent.success=[] , a state
// IntentSchema's own `.min(1)` already prevents a schema-validated Intent from ever
// carrying -- the gate still checks independently, matching the reference
// implementation's own guard, and this cast is what lets a test construct the
// otherwise-unreachable input to prove that guard still works.
function buildIntent(success: string[]): Intent {
  return {
    schema_version: "1.0",
    intent_id: "I-2026-08-06-example",
    execution_mode: "manual",
    budget: [],
    intent: {
      business_goal: "Reduce onboarding time by clarifying setup docs.",
      user_visible_intent: "New users see setup steps in order.",
      success,
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

function buildVerification(overrides: Partial<Verification> = {}): Verification {
  return VerificationSchema.parse({
    schema_version: "1.0",
    intent_id: "I-2026-08-06-example",
    test_matrix: [{ ears_rule: "Rule 1", test_type: "unit", status: "added" }],
    ...overrides,
  });
}

function buildState(): LaneState {
  return LaneStateSchemaV3.parse({
    schema_version: "3.0",
    intent_id: "I-2026-08-06-example",
    tracker_url: null,
    pr_url: null,
    owner: null,
    current_phase: "3_implement",
    status: "running",
    created_at: "2026-08-06T09:00:00+09:00",
  });
}

function buildContext(success: string[], verification?: Verification): GateContext {
  return {
    trigger: { type: "phase_advance", from: "3_implement", to: "4_verify" },
    state: buildState(),
    profile,
    artifacts: { intent: buildIntent(success), verification },
  };
}

describe("successCriteriaGate.appliesTo", () => {
  it("applies to the 3_implement -> 4_verify edge and to before_pr_publish at any phase", () => {
    const ctx = buildContext(["ok"]);
    expect(successCriteriaGate.appliesTo(ctx)).toBe(true);
    expect(
      successCriteriaGate.appliesTo({
        ...ctx,
        trigger: { type: "before_pr_publish", phase: "1_intent" },
      }),
    ).toBe(true);
    expect(
      successCriteriaGate.appliesTo({
        ...ctx,
        trigger: { type: "before_pr_publish", phase: "4_verify" },
      }),
    ).toBe(true);
    expect(
      successCriteriaGate.appliesTo({
        ...ctx,
        trigger: { type: "phase_advance", from: "4_verify", to: "5_done" },
      }),
    ).toBe(false);
    expect(
      successCriteriaGate.appliesTo({
        ...ctx,
        trigger: { type: "phase_advance", from: "2_spec", to: "3_implement" },
      }),
    ).toBe(false);
  });
});

describe("successCriteriaGate.evaluate", () => {
  it("warns (never errors) when success_criteria_matrix is entirely absent", () => {
    const diagnostics = successCriteriaGate.evaluate(buildContext(["ok"], buildVerification()));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "warning", code: "matrix_missing" });
  });

  it("warns when verification.yaml itself has not been written yet (no verification at all)", () => {
    const diagnostics = successCriteriaGate.evaluate(buildContext(["ok"], undefined));
    expect(diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });

  it("errors on covered_by:'none' even though the schema itself accepts it", () => {
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        ["ok"],
        buildVerification({
          success_criteria_matrix: [{ criterion: "ok", covered_by: "none", evidence: "n/a" }],
        }),
      ),
    );
    expect(diagnostics.some((d) => d.severity === "error" && d.code === "covered_by_none")).toBe(
      true,
    );
  });

  it("errors when an intent.success line has no corresponding criterion", () => {
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        ["ok", "another condition"],
        buildVerification({
          success_criteria_matrix: [
            {
              criterion: "ok",
              covered_by: "test",
              evidence: "test.ts::ok",
              negation_test: "test.ts::not-ok",
            },
          ],
        }),
      ),
    );
    expect(diagnostics.some((d) => d.severity === "error" && d.code === "success_uncovered")).toBe(
      true,
    );
  });

  it("warns (not errors) when a criterion has no corresponding intent.success line (direction 2)", () => {
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        ["ok"],
        buildVerification({
          success_criteria_matrix: [
            {
              criterion: "ok",
              covered_by: "test",
              evidence: "test.ts::ok",
              negation_test: "test.ts::not-ok",
            },
            {
              criterion: "an extra stronger condition",
              covered_by: "test",
              evidence: "test.ts::extra",
            },
          ],
        }),
      ),
    );
    expect(diagnostics.some((d) => d.severity === "error")).toBe(false);
    expect(diagnostics.some((d) => d.severity === "warning" && d.code === "criterion_extra")).toBe(
      true,
    );
  });

  it("warns when negation_test is empty on an otherwise-covered row", () => {
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        ["ok"],
        buildVerification({
          success_criteria_matrix: [
            { criterion: "ok", covered_by: "test", evidence: "test.ts::ok" },
          ],
        }),
      ),
    );
    expect(
      diagnostics.some((d) => d.severity === "warning" && d.code === "negation_test_missing"),
    ).toBe(true);
  });

  it("matches criterion<->success via normalizeCriterion (markdown link + emphasis + full-width space all absorbed)", () => {
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        ["New user completes setup within 5 minutes."],
        buildVerification({
          success_criteria_matrix: [
            {
              criterion: "**New　user** completes [setup](https://x.com) within 5 minutes.",
              covered_by: "test",
              evidence: "test.ts::completes-setup",
              negation_test: "test.ts::fails-without-setup",
            },
          ],
        }),
      ),
    );
    // Zero *error* diagnostics is the point of this test (the bidirectional match
    // succeeded); the one remaining diagnostic is the unrelated cross_check_missing
    // warning (this fixture never sets cross_check_intent_vs_spec).
    expect(diagnostics.some((d) => d.severity === "error")).toBe(false);
    expect(diagnostics).toEqual([expect.objectContaining({ code: "cross_check_missing" })]);
  });

  it("does NOT absorb a summarized criterion — normalized full-text equality only, never fuzzy similarity", () => {
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        ["New user completes setup within 5 minutes."],
        buildVerification({
          success_criteria_matrix: [
            {
              criterion: "Setup is fast.", // a summary, not a transcription -> must not match
              covered_by: "test",
              evidence: "test.ts::x",
              negation_test: "test.ts::y",
            },
          ],
        }),
      ),
    );
    expect(diagnostics.some((d) => d.code === "success_uncovered")).toBe(true);
    expect(diagnostics.some((d) => d.code === "criterion_extra")).toBe(true);
  });

  it("duplicate (post-normalization) intent.success lines matched by a single matrix row both count as covered — intentional set-membership parity with the reference implementation, not a bug", () => {
    // The reference implementation's own gate_check_success_criteria builds `criteria` as
    // a *set* of normalized matrix criteria and checks `normalize_criterion(s) not in
    // criteria` for each intent.success line -- membership, not a per-line count. Two
    // intent.success lines that normalize to the same text are therefore both considered
    // covered by one matching matrix row, exactly like this. This test exists so that
    // property is understood as a deliberate parity choice (Codex review, 2026-08-06) and
    // isn't "fixed" into requiring a 1:1 row count without that being a deliberate,
    // separately-discussed change to the ported semantics.
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        [
          "New user completes setup within 5 minutes.",
          "New user completes setup within 5 minutes.",
        ],
        buildVerification({
          success_criteria_matrix: [
            {
              criterion: "New user completes setup within 5 minutes.",
              covered_by: "test",
              evidence: "test.ts::completes-setup",
              negation_test: "test.ts::fails-without-setup",
            },
          ],
          cross_check_intent_vs_spec: {
            performed_at: "2026-08-06 (Phase 4)",
            finding: "No differences.",
          },
        }),
      ),
    );
    expect(diagnostics).toHaveLength(0);
  });

  it("skips the bidirectional cross-check (warning only) when intent.intent.success is empty", () => {
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        [],
        buildVerification({
          success_criteria_matrix: [{ criterion: "x", covered_by: "test", evidence: "test.ts::x" }],
        }),
      ),
    );
    expect(diagnostics.every((d) => d.severity !== "error")).toBe(true);
    expect(diagnostics.some((d) => d.code === "intent_success_empty")).toBe(true);
  });

  it("warns about cross_check_intent_vs_spec being unrecorded only once everything else is clean", () => {
    const cleanVerification = buildVerification({
      success_criteria_matrix: [
        {
          criterion: "ok",
          covered_by: "test",
          evidence: "test.ts::ok",
          negation_test: "test.ts::not-ok",
        },
      ],
    });
    const diagnostics = successCriteriaGate.evaluate(buildContext(["ok"], cleanVerification));
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "cross_check_missing", severity: "warning" }),
    ]);
  });

  it("does not pile on a redundant cross_check_missing warning when there is already an error", () => {
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        ["ok"],
        buildVerification({
          success_criteria_matrix: [{ criterion: "ok", covered_by: "none", evidence: "n/a" }],
        }),
      ),
    );
    expect(diagnostics.some((d) => d.code === "cross_check_missing")).toBe(false);
  });

  it("passes cleanly (no diagnostics at all) with a fully satisfied matrix and cross_check recorded", () => {
    const diagnostics = successCriteriaGate.evaluate(
      buildContext(
        ["ok"],
        buildVerification({
          success_criteria_matrix: [
            {
              criterion: "ok",
              covered_by: "test",
              evidence: "test.ts::ok",
              negation_test: "test.ts::not-ok",
            },
          ],
          cross_check_intent_vs_spec: {
            performed_at: "2026-08-06 (Phase 4)",
            finding: "No differences found.",
          },
        }),
      ),
    );
    expect(diagnostics).toHaveLength(0);
  });
});
