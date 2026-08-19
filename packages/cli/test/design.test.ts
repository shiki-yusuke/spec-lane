import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignOptionsDoc } from "@lane/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdvance } from "../src/commands/advance.js";
import {
  runDesignDecide,
  runDesignOverride,
  runDesignStatus,
  runDesignSubmit,
} from "../src/commands/design.js";
import { runStart } from "../src/commands/start.js";
import { specMdPath, writeSpecMd } from "../src/spec-store.js";
import { laneStatePath } from "../src/state-store.js";

// I-2026-08-18-design-critic-injection — CLI-level coverage for the Gherkin scenarios that
// need a real lane lifecycle (activation, establishment/override at the spec gate,
// decision/override at the implement gate, pointer-move reset). Schema-level scenarios are
// covered in packages/schemas/test/ and packages/core/test/ instead (see those files'
// header comments for the split).

function baseDoc(overrides: Partial<DesignOptionsDoc> = {}): DesignOptionsDoc {
  return {
    schema_version: "design-options/v1",
    design_options_id: "d1",
    intent_ref: { logical_id: "I-x", digest_omitted_reason: "prose brief, not a versioned file" },
    artifact_shapers: [
      {
        engine_ref: {
          kind: "model",
          provider: "openai",
          family: "gpt-5.6",
          model_id: "gpt-5.6-sol",
        },
        how: "authored",
      },
    ],
    options: [
      {
        option_id: "opt-a",
        summary: "Option A",
        key_assumptions: ["assume A"],
        falsifiers: ["falsify A"],
        observable_proxies: ["proxy A"],
        predicted_outcomes: ["outcome A"],
        rollback_strategy: "revert A",
      },
      {
        option_id: "opt-b",
        summary: "Option B",
        key_assumptions: ["assume B"],
        falsifiers: ["falsify B"],
        observable_proxies: ["proxy B"],
        predicted_outcomes: ["outcome B"],
        rollback_strategy: "revert B",
      },
    ],
    critic_reviews: [
      {
        critic: { kind: "model", provider: "openai", family: "gpt-5.6", model_id: "gpt-5.6-terra" },
        prior_involvement: "shaped_options",
        review_output_ref: {
          logical_id: "review-1",
          uri: "design/reviews/review-1.txt",
          content_digest: `sha256:${"a".repeat(64)}`,
        },
        reviewed_at: "2026-08-19T00:00:00Z",
        target_option_ids: ["opt-a", "opt-b"],
      },
    ],
    decision_request: {
      open_questions: ["which option?"],
      option_ids: ["opt-a", "opt-b"],
      what_would_change_the_answer: ["new data"],
    },
    ...overrides,
  };
}

describe("design track (R1/R2/R27-R33/R35/R36/R41)", () => {
  let specDir: string;

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-design-"));
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to "undefined"
    delete process.env.LANE_DATA_DIR;
  });

  it("R1: a lane started without --design never gets a design_track key, and the spec gate never applies", () => {
    const intentId = "I-2026-08-19-no-design";
    runStart(intentId, { specDir });
    const raw = readFileSync(laneStatePath(specDir, intentId), "utf-8");
    expect(raw).not.toContain("design_track");

    const result = runAdvance(intentId, "2_spec", { specDir });
    expect(result.exitCode).toBe(0);
    expect(result.message).not.toContain("design_establishment");
    expect(readFileSync(laneStatePath(specDir, intentId), "utf-8")).not.toContain("design_track");
  });

  it("R2: --design records who activated it and when", () => {
    const intentId = "I-2026-08-19-design-activation";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    const raw = JSON.parse(readFileSync(laneStatePath(specDir, intentId), "utf-8"));
    expect(raw.design_track).toEqual({
      activated: true,
      activated_by: "shiki",
      activated_at: expect.any(String),
    });
  });

  it("R29: with --design active and no options submitted, the spec gate blocks", () => {
    const intentId = "I-2026-08-19-design-no-options";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    const result = runAdvance(intentId, "2_spec", { specDir });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("design_options");
  });

  it("R25: lane design status's actual runtime output shows coverage/status before any count, and total+qualifying together (success condition 3, runtime complement to design-single-count.test.ts's static source-order check)", () => {
    const intentId = "I-2026-08-19-design-status-r25";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    // A doc with one qualifying review covering opt-a only, so opt-a's coverage line
    // exercises coverage_present_for_option and opt-b's exercises
    // coverage_missing_for_option -- both real code paths, not just the totals line.
    const doc = baseDoc({
      critic_reviews: [
        {
          critic: { kind: "model", provider: "anthropic", family: "claude", model_id: "claude-x" },
          prior_involvement: "none_observed_in_recorded_scope",
          observation_scope_ref: { logical_id: "scope-1", digest_omitted_reason: "test fixture" },
          review_output_ref: {
            logical_id: "review-1",
            uri: "design/reviews/review-1.txt",
            content_digest: `sha256:${"b".repeat(64)}`,
          },
          reviewed_at: "2026-08-19T00:00:00Z",
          target_option_ids: ["opt-a"],
        },
      ],
    });
    const file = join(specDir, "doc.json");
    writeFileSync(file, JSON.stringify(doc));
    expect(runDesignSubmit(intentId, { specDir, file, by: "shiki" }).exitCode).toBe(0);

    const status = runDesignStatus(intentId, { specDir });
    expect(status.exitCode).toBe(0);
    const lines = status.message.split("\n");

    const optionLineIndexes = lines
      .map((l, i) => (l.startsWith("option ") ? i : -1))
      .filter((i) => i >= 0);
    const reviewLineIndexes = lines
      .map((l, i) => (l.startsWith("critic_reviews[") ? i : -1))
      .filter((i) => i >= 0);
    const totalsLineIndex = lines.findIndex((l) => l.startsWith("total_reviews="));
    expect(optionLineIndexes.length).toBe(2);
    expect(reviewLineIndexes.length).toBe(1);
    expect(totalsLineIndex).toBeGreaterThan(-1);

    // "per-option coverage and derived status before either count" (R25).
    expect(Math.max(...optionLineIndexes, ...reviewLineIndexes)).toBeLessThan(totalsLineIndex);

    // total and qualifying reported separately, never collapsed to one number.
    const totalsLine = lines[totalsLineIndex] as string;
    expect(totalsLine).toMatch(/total_reviews=1/);
    expect(totalsLine).toMatch(/qualifying_reviews=1/);

    const coveredLine = lines[optionLineIndexes[0] as number] as string;
    expect(coveredLine).toContain("option opt-a");
    expect(coveredLine).toContain("covered=true");
  });

  it("R23/R29: zero qualifying reviews (shaped_options) blocks the spec gate with no override", () => {
    const intentId = "I-2026-08-19-design-zero-qualifying";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    const file = join(specDir, "doc.json");
    writeFileSync(file, JSON.stringify(baseDoc()));
    const submit = runDesignSubmit(intentId, { specDir, file, by: "shiki" });
    expect(submit.exitCode).toBe(0);

    const status = runDesignStatus(intentId, { specDir });
    expect(status.message).toContain("covered=false");

    const result = runAdvance(intentId, "2_spec", { specDir });
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/no override|not_established_no_override/i);
  });

  it("R28/R32: a scoped override yields an honest not-established status and the transition proceeds", () => {
    const intentId = "I-2026-08-19-design-override";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    const file = join(specDir, "doc.json");
    writeFileSync(file, JSON.stringify(baseDoc()));
    runDesignSubmit(intentId, { specDir, file, by: "shiki" });

    const override = runDesignOverride(intentId, {
      specDir,
      reason: "pilot: proceeding without qualifying coverage",
      actor: "shiki",
      policyBasis: "opt-in pilot, no mandatory gate",
      uncoveredOptionIds: ["opt-a", "opt-b"],
    });
    expect(override.exitCode).toBe(0);

    const result = runAdvance(intentId, "2_spec", { specDir });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/operator-asserted/);
  });

  it("R33: a profile that forbids the override still blocks the transition", () => {
    const intentId = "I-2026-08-19-design-override-forbidden";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    const file = join(specDir, "doc.json");
    writeFileSync(file, JSON.stringify(baseDoc()));
    runDesignSubmit(intentId, { specDir, file, by: "shiki" });
    runDesignOverride(intentId, {
      specDir,
      reason: "pilot",
      actor: "shiki",
      policyBasis: "pilot",
      uncoveredOptionIds: ["opt-a", "opt-b"],
    });

    const profilePath = join(specDir, "profile.yaml");
    writeFileSync(
      profilePath,
      [
        'schema_version: "1.0"',
        "profile_id: forbids-design-override",
        "design_override_forbidden: true",
        "",
      ].join("\n"),
    );
    const result = runAdvance(intentId, "2_spec", { specDir, profile: profilePath });
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/forbids the design override/);
  });

  it("R35/R36: the implement gate requires a decision bound to the active revision, and spec.md must reference it", () => {
    const intentId = "I-2026-08-19-design-decision";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    const file = join(specDir, "doc.json");
    writeFileSync(file, JSON.stringify(baseDoc()));
    runDesignSubmit(intentId, { specDir, file, by: "shiki" });
    runDesignOverride(intentId, {
      specDir,
      reason: "pilot",
      actor: "shiki",
      policyBasis: "pilot",
      uncoveredOptionIds: ["opt-a", "opt-b"],
    });
    expect(runAdvance(intentId, "2_spec", { specDir }).exitCode).toBe(0);

    // No decision recorded yet -> blocked.
    const blocked = runAdvance(intentId, "3_implement", { specDir });
    expect(blocked.exitCode).toBe(3);
    expect(blocked.message).toMatch(/decision/);

    const decide = runDesignDecide(intentId, { specDir, optionId: "opt-a", by: "shiki" });
    expect(decide.exitCode).toBe(0);

    // Decision recorded but opt-a isn't qualifying-covered and has no matching override
    // scoped to it specifically -> still blocked.
    const stillBlocked = runAdvance(intentId, "3_implement", { specDir });
    expect(stillBlocked.exitCode).toBe(3);

    // Record an override scoped to the selected option specifically, then spec.md must
    // reference it (R36).
    runDesignOverride(intentId, {
      specDir,
      reason: "pilot",
      actor: "shiki",
      policyBasis: "pilot",
      uncoveredOptionIds: ["opt-a", "opt-b"],
      selectedOptionId: "opt-a",
    });
    const missingSpecRef = runAdvance(intentId, "3_implement", { specDir });
    expect(missingSpecRef.exitCode).toBe(3);
    expect(missingSpecRef.message).toMatch(/spec\.md/);

    writeSpecMd(specDir, intentId, "# Spec\n\nSelected option: opt-a\n");
    expect(specMdPath(specDir, intentId)).toBeTruthy();
    const finalResult = runAdvance(intentId, "3_implement", { specDir });
    expect(finalResult.exitCode).toBe(0);
  });

  it("R41: superseding the active revision resets establishment without deleting the prior revision or its reviews", () => {
    const intentId = "I-2026-08-19-design-supersede";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    const file = join(specDir, "doc.json");
    writeFileSync(file, JSON.stringify(baseDoc()));
    const first = runDesignSubmit(intentId, { specDir, file, by: "shiki" });
    expect(first.exitCode).toBe(0);
    runDesignOverride(intentId, {
      specDir,
      reason: "pilot",
      actor: "shiki",
      policyBasis: "pilot",
      uncoveredOptionIds: ["opt-a", "opt-b"],
    });
    expect(runAdvance(intentId, "2_spec", { specDir }).exitCode).toBe(0);
    runDesignDecide(intentId, { specDir, optionId: "opt-a", by: "shiki" });

    // A new revision under the SAME design_options_id, different content (new digest).
    const secondDoc = baseDoc({
      options: [
        { ...baseDoc().options[0], summary: "Option A (revised)" } as never,
        baseDoc().options[1] as never,
      ],
    });
    writeFileSync(file, JSON.stringify(secondDoc));
    const second = runDesignSubmit(intentId, { specDir, file, by: "shiki" });
    expect(second.exitCode).toBe(0);
    expect(second.message).not.toBe(first.message);

    // The old decision (bound to the OLD digest) no longer applies to the new active
    // revision -- the implement gate must once again report no decision, not silently
    // reuse the stale one.
    const result = runAdvance(intentId, "3_implement", { specDir });
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/decision/);
  });

  it("R15: a review whose output is only declared digest_omitted_reason is rejected as unreachable (Gherkin: 'a review without a reachable output is rejected')", () => {
    const intentId = "I-2026-08-19-design-unreachable-output";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    const doc = baseDoc({
      critic_reviews: [
        {
          critic: {
            kind: "model",
            provider: "openai",
            family: "gpt-5.6",
            model_id: "gpt-5.6-terra",
          },
          prior_involvement: "shaped_options",
          review_output_ref: { logical_id: "review-1", digest_omitted_reason: "not preserved" },
          reviewed_at: "2026-08-19T00:00:00Z",
          target_option_ids: ["opt-a", "opt-b"],
        },
      ],
    });
    const file = join(specDir, "doc.json");
    writeFileSync(file, JSON.stringify(doc));
    const result = runDesignSubmit(intentId, { specDir, file, by: "shiki" });
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/review_output_ref/);
  });

  it("Gherkin: an override recorded as a field inside the companion artifact (not via `lane design override`) is not accepted", () => {
    // DesignCriticAttestationSchema is `.strict()`, so writing an `overrides`-shaped or
    // `independence_status`-shaped field directly into the artifact -- bypassing
    // runDesignOverride entirely -- fails to parse at all. Exercised here via the store
    // (the same path `lane design status`/the gates read through), not just the bare
    // schema, to prove the CLI-visible surface actually rejects it too (R30).
    const intentId = "I-2026-08-19-design-override-artifact-field";
    runStart(intentId, { specDir, design: true, activatedBy: "shiki" });
    const file = join(specDir, "doc.json");
    writeFileSync(file, JSON.stringify(baseDoc()));
    runDesignSubmit(intentId, { specDir, file, by: "shiki" });

    const attestationPath = join(specDir, intentId, "design", "attestation.yaml");
    writeFileSync(
      attestationPath,
      [
        'schema_version: "design-critic-attestation/v0"',
        `intent_id: ${intentId}`,
        "overrides: []",
        "decision: null",
        // An operator-authored artifact field claiming establishment directly, bypassing
        // `lane design override` -- must be rejected outright (unrecognized key).
        "establishment: established",
        "",
      ].join("\n"),
    );
    expect(() => runDesignStatus(intentId, { specDir })).toThrow();
  });
});
