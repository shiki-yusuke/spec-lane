import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesignOptionsDocSchema, type DesignOptionsDoc } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  checkEngineRefCompleteness,
  checkReviewOutputReachable,
  computeCoverage,
  evaluateReview,
  summarizeIndependence,
} from "../src/design-independence.js";

// I-2026-08-18-design-critic-injection R12-R26 — exercises the lane-owned wrapper
// (design-independence.ts) against the same vendored design-options/v1 fixtures used by
// packages/schemas/test/design-options-fixtures.test.ts, so the derivation is checked
// against real (not hand-rolled) documents. Maps to several Gherkin scenarios directly:
//   - "the closest relationship wins across multiple shapers" (R18)
//   - "missing model identity does not become undetermined ..." / "missing provider does
//     become undetermined" (R19)
//   - "a separate lineage that shaped the options does not qualify" (R23, involvement)
//   - "partial coverage is not establishment" (R24/R25)

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(
  __dirname,
  "..",
  "..",
  "schemas",
  "test",
  "fixtures",
  "design-options",
  "v1",
  "fixtures",
);

function loadDoc(filename: string): DesignOptionsDoc {
  return DesignOptionsDocSchema.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, filename), "utf-8")));
}

describe("evaluateReview / summarizeIndependence (R12-R26)", () => {
  it("different_lineage + none_observed_in_recorded_scope qualifies (R23 both dimensions)", () => {
    const doc = loadDoc("accept-derivation-different_lineage.json");
    const result = evaluateReview(doc, 0);
    expect(result.derivedStatus).toBe("different_lineage");
    expect(result.qualifying).toBe(true);
  });

  it("human_third_party + none_observed_in_recorded_scope qualifies", () => {
    const doc = loadDoc("accept-derivation-human_third_party.json");
    const result = evaluateReview(doc, 0);
    expect(result.derivedStatus).toBe("human_third_party");
    expect(result.qualifying).toBe(true);
  });

  it("same_provider_different_family does not qualify even with clean involvement (lineage dimension fails, R23)", () => {
    const doc = loadDoc("accept-derivation-same_provider_different_family.json");
    const result = evaluateReview(doc, 0);
    expect(result.derivedStatus).toBe("same_provider_different_family");
    expect(result.qualifying).toBe(false);
  });

  it("shaped_options prior_involvement fails to qualify regardless of lineage (real living-twin case, zero qualifying reviews)", () => {
    const doc = loadDoc("accept-zero-qualifying-reviews.json");
    const summary = summarizeIndependence(doc);
    expect(summary.qualifyingReviews).toBe(0);
    expect(summary.totalReviews).toBeGreaterThan(0);
    // R25: total and qualifying are reported separately, never a single collapsed count.
    expect(summary.totalReviews).not.toBe(summary.qualifyingReviews);
  });

  it("unresolved provider derives undetermined (unknown), and unknown never qualifies (R19)", () => {
    const doc = loadDoc("accept-unknown-not-qualifying.json");
    const result = evaluateReview(doc, 0);
    expect(result.derivedStatus).toBe("unknown");
    expect(result.qualifying).toBe(false);
  });

  it("a human critic who is also the decision maker derives unknown, not guessed (R19's 'undetermined only if a qualifying relationship is still possible' sibling case)", () => {
    const doc = loadDoc("accept-derivation-unknown-human-decision-maker.json");
    const result = evaluateReview(doc, 0);
    expect(result.derivedStatus).toBe("unknown");
    expect(result.qualifying).toBe(false);
  });

  it("shaped_dependency is a distinct, non-qualifying state from unknown (must not collapse)", () => {
    const doc = loadDoc("accept-derivation-shaped-dependency.json");
    const result = evaluateReview(doc, 0);
    expect(result.qualifying).toBe(false);
    // The vendored module's own reasons name the dimension that failed (R26).
    expect(result.reasons.some((r) => r.includes("involvement"))).toBe(true);
  });

  it("computeCoverage reports per-option coverage with reasons before any count (R24/R25/R26)", () => {
    const doc = loadDoc("accept-derivation-different_lineage.json");
    const summary = summarizeIndependence(doc);
    for (const c of summary.coverage) {
      expect(c.reasons.length).toBeGreaterThan(0);
    }
    expect(summary.everyOptionCovered).toBe(
      summary.coverage.every((c) => c.covered),
    );
  });

  it("real living-twin discovery-scope document: no option is covered (partial/zero coverage, R24)", () => {
    const doc = loadDoc("accept-living-twin-discovery-scope-options.json");
    const summary = summarizeIndependence(doc);
    expect(summary.everyOptionCovered).toBe(false);
  });
});

describe("checkEngineRefCompleteness (R13/R14, delegated to vendored engineRefIssues)", () => {
  it("flags a model engine_ref missing model_id and not declared in unknown_fields", () => {
    // Schema-VALID (semantic-only rejection -- see design-options-fixtures.test.ts's
    // SEMANTIC_ONLY_REASON_CODES): the strict zod parse succeeds, and only this lane-owned
    // completeness check (delegated to the vendored engineRefIssues) catches it.
    const doc = loadDoc("invalid-engine-ref-missing-model-id.json");
    const critic = doc.critic_reviews[0]?.critic;
    expect(critic).toBeDefined();
    const issues = checkEngineRefCompleteness(critic as never, "critic_reviews[0].critic");
    expect(issues.some((i) => i.includes("engine_ref_field_undeclared"))).toBe(true);
  });

  it("does not flag a field that is missing but honestly declared in unknown_fields", () => {
    const doc = loadDoc("accept-unknown-not-qualifying.json");
    const critic = doc.critic_reviews[0]?.critic;
    expect(critic).toBeDefined();
    const issues = checkEngineRefCompleteness(critic as never, "critic_reviews[0].critic");
    expect(issues).toEqual([]);
  });
});

describe("checkReviewOutputReachable (R15)", () => {
  it("a review with content_digest+uri is reachable", () => {
    const doc = loadDoc("accept-self-referential-digest.json");
    expect(checkReviewOutputReachable(doc.critic_reviews[0] as never)).toBe(true);
  });

  it("a review with digest_omitted_reason is still honestly reachable (not a fabricated ref)", () => {
    const doc = loadDoc("accept-living-twin-pivot-options.json");
    for (const review of doc.critic_reviews) {
      expect(checkReviewOutputReachable(review)).toBe(true);
    }
  });
});
