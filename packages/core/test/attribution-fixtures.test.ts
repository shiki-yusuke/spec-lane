import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AttributionAuditResultSchema, BindingRecordSchema } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { scanAgentMetricsPersonalDimensions } from "../src/agent-metrics-goodhart.js";
import { checkBindingCollectionViolations } from "../src/attribution.js";

// M0 spec-lane 0.5.0 — replays ai-agent-skills-playbook's own
// contracts/attribution/v1/verify-fixtures.mjs conformance checks against the vendored
// fixtures (packages/core/test/fixtures/attribution/v1/, see
// packages/core/test/fixtures/attribution/UPSTREAM), using this repo's own production
// primitives (BindingRecordSchema, AttributionAuditResultSchema,
// checkBindingCollectionViolations, scanAgentMetricsPersonalDimensions).

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "attribution", "v1", "fixtures");

function readFixtureJson(filename: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, filename), "utf-8"));
}

function reasonCodesOf(reasons: string[]): string[] {
  return reasons.map((r) => r.split(":")[0]?.trim() ?? r);
}

/** A raw schema-validator reason code (e.g. "$.violations[0]") may legitimately be
 * reported one level more specific by zod (e.g. "$.violations[0].session_id" for a
 * missing required field) -- both name the same underlying rejection, so a prefix match
 * is accepted, not just an exact string match. */
function expectReasonCode(codes: string[], expected: string): void {
  const matches = codes.some(
    (c) => c === expected || c.startsWith(`${expected}.`) || c.startsWith(`${expected}[`),
  );
  expect(matches, `expected one of ${JSON.stringify(codes)} to match "${expected}"`).toBe(true);
}

function zodPathToken(path: (string | number)[]): string {
  let token = "$";
  for (const segment of path) {
    token += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return token;
}

function schemaReasons(parsed: ReturnType<typeof BindingRecordSchema.safeParse>): string[] {
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) =>
    issue.code === "custom" ? issue.message : `${zodPathToken(issue.path)}: ${issue.message}`,
  );
}

function checkBindingRecord(record: unknown): string[] {
  const parsed = BindingRecordSchema.safeParse(record);
  const reasons = schemaReasons(parsed);
  reasons.push(
    ...scanAgentMetricsPersonalDimensions(record).map(
      (v) => `personal_dimension_forbidden_key: ${v}`,
    ),
  );
  return [...new Set(reasons)];
}

function checkAuditResult(record: unknown): string[] {
  const parsed = AttributionAuditResultSchema.safeParse(record);
  const reasons: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reasons.push(
        issue.code === "custom" ? issue.message : `${zodPathToken(issue.path)}: ${issue.message}`,
      );
    }
  }
  const scanTarget = record as Record<string, unknown>;
  const forbiddenKeys = Object.keys(scanTarget).filter((k) =>
    scanAgentMetricsPersonalDimensions({ [k]: scanTarget[k] }).includes(k),
  );
  reasons.push(...forbiddenKeys.map((k) => `personal_dimension_forbidden_key: ${k}`));
  return [...new Set(reasons)];
}

interface ManifestEntry {
  id: string;
  type: "binding-record" | "binding-collection" | "audit-result";
  files: { record?: string; records?: string[] };
  expected: "accept" | "reject";
  reason_code: string | null;
  all_forbidden_keys_flagged?: boolean;
}

const manifest = readFixtureJson("expected-results.json") as { fixtures: ManifestEntry[] };

describe("attribution:v1 vendored fixture parity (packages/core/test/fixtures/attribution/UPSTREAM)", () => {
  it("vendored expected-results.json is non-empty", () => {
    expect(manifest.fixtures.length).toBeGreaterThan(0);
  });

  for (const entry of manifest.fixtures) {
    it(`${entry.id} (expected=${entry.expected}${entry.reason_code ? `, reason=${entry.reason_code}` : ""})`, () => {
      if (entry.type === "binding-record") {
        const record = readFixtureJson(entry.files.record as string);
        const reasons = checkBindingRecord(record);
        const category = reasons.length > 0 ? "reject" : "accept";
        expect(category, reasons.join("; ")).toBe(entry.expected);
        if (entry.expected === "reject" && entry.reason_code) {
          expect(reasonCodesOf(reasons)).toContain(entry.reason_code);
        }
        return;
      }

      if (entry.type === "binding-collection") {
        const records = (entry.files.records as string[]).map((f) => readFixtureJson(f));
        const perRecordReasons = records.flatMap((r) => checkBindingRecord(r));
        const collectionReasons = checkBindingCollectionViolations(records as never);
        const reasons = [...perRecordReasons, ...collectionReasons];
        const category = reasons.length > 0 ? "reject" : "accept";
        expect(category, reasons.join("; ")).toBe(entry.expected);
        if (entry.expected === "reject" && entry.reason_code) {
          expect(reasonCodesOf(reasons)).toContain(entry.reason_code);
        }
        return;
      }

      // audit-result
      const record = readFixtureJson(entry.files.record as string);
      const reasons = checkAuditResult(record);
      if (entry.all_forbidden_keys_flagged) {
        const flaggedKeys = reasons
          .filter((r) => r.startsWith("personal_dimension_forbidden_key"))
          .map((r) => r.split(":")[1]?.trim());
        // Every one of the 11 forbidden keys planted in this fixture must be individually
        // flagged, not just the first one a validator happens to stop at.
        expect(flaggedKeys.length).toBeGreaterThanOrEqual(11);
        expect(reasons.length).toBeGreaterThan(0);
        return;
      }
      const category = reasons.length > 0 ? "reject" : "accept";
      expect(category, reasons.join("; ")).toBe(entry.expected);
      if (entry.expected === "reject" && entry.reason_code) {
        expectReasonCode(reasonCodesOf(reasons), entry.reason_code);
      }
    });
  }
});
