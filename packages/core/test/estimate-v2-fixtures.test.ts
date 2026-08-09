import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EstimateV2DecisionSchema } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { scanAgentMetricsPersonalDimensions } from "../src/agent-metrics-goodhart.js";

// M0 spec-lane 0.5.0 — replays ai-agent-skills-playbook's own
// contracts/estimate/v2/verify-fixtures.mjs conformance checks against the vendored
// fixtures (packages/core/test/fixtures/estimate/v2/, see
// packages/core/test/fixtures/estimate/UPSTREAM), using this repo's own EstimateV2DecisionSchema.
//
// The playbook's own checker enforces several tagged-union MUSTs structurally (JSON
// Schema allOf/if/then/not), so its fixture manifest's reason_code for those is a raw
// JSON path (e.g. "$.applicability", "$.decision.status"). This repo's zod mirror
// expresses the same MUSTs via superRefine custom issues instead (named codes like
// "predicted_out_of_domain") -- REASON_CODE_ALIASES below maps each such raw-path
// expectation onto the custom code(s) that actually fire for it, so this test still
// verifies the real rejection reason, not just "some path under that object failed."

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "estimate", "v2", "fixtures");

function readFixtureJson(filename: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, filename), "utf-8"));
}

function reasonCodesOf(reasons: string[]): string[] {
  return reasons.map((r) => r.split(":")[0]?.trim() ?? r);
}

function zodPathToken(path: (string | number)[]): string {
  let token = "$";
  for (const segment of path) {
    token += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return token;
}

function checkDecision(instance: unknown): string[] {
  const parsed = EstimateV2DecisionSchema.safeParse(instance);
  const reasons: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reasons.push(
        issue.code === "custom" ? issue.message : `${zodPathToken(issue.path)}: ${issue.message}`,
      );
    }
  }
  reasons.push(
    ...scanAgentMetricsPersonalDimensions(instance).map(
      (v) => `personal_dimension_forbidden_key: ${v}`,
    ),
  );
  return [...new Set(reasons)];
}

const REASON_CODE_ALIASES: Record<string, string[]> = {
  $: ["abstained_must_not_carry_predicted"],
  "$.decision.status": ["abstained_must_not_have_available_interval"],
  "$.applicability": ["predicted_out_of_domain"],
  "$.prediction_interval": [
    "prediction_interval_available_incomplete",
    "prediction_interval_insufficient_data_has_value_field",
  ],
};

function expectReasonCode(codes: string[], expected: string): void {
  const candidates = REASON_CODE_ALIASES[expected] ?? [expected];
  const matches = codes.some((c) =>
    candidates.some((cand) => c === cand || c.startsWith(`${cand}.`) || c.startsWith(`${cand}[`)),
  );
  expect(matches, `expected one of ${JSON.stringify(codes)} to match "${expected}"`).toBe(true);
}

interface ManifestEntry {
  id: string;
  files: { record: string };
  expected: "accept" | "reject";
  reason_code: string | null;
}

const manifest = readFixtureJson("expected-results.json") as { fixtures: ManifestEntry[] };

describe("estimate:v2 vendored fixture parity (packages/core/test/fixtures/estimate/UPSTREAM)", () => {
  it("vendored expected-results.json is non-empty", () => {
    expect(manifest.fixtures.length).toBeGreaterThan(0);
  });

  for (const entry of manifest.fixtures) {
    it(`${entry.id} (expected=${entry.expected}${entry.reason_code ? `, reason=${entry.reason_code}` : ""})`, () => {
      const instance = readFixtureJson(entry.files.record);
      const reasons = checkDecision(instance);
      const category = reasons.length > 0 ? "reject" : "accept";
      expect(category, reasons.join("; ")).toBe(entry.expected);
      if (entry.expected === "reject" && entry.reason_code) {
        expectReasonCode(reasonCodesOf(reasons), entry.reason_code);
      }
    });
  }
});
