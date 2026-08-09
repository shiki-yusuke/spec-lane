import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TraceEventSchema } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { scanAgentMetricsPersonalDimensions } from "../src/agent-metrics-goodhart.js";
import { checkTraceEventLimits, computeTraceEventId } from "../src/trace.js";

// M0 spec-lane 0.5.0 — replays ai-agent-skills-playbook's own
// contracts/trace/v1/verify-fixtures.mjs conformance checks against the vendored fixtures
// (packages/core/test/fixtures/trace/v1/, see packages/core/test/fixtures/trace/UPSTREAM
// for the exact vendored commit), but using *this repo's own* production primitives
// (TraceEventSchema, computeTraceEventId, checkTraceEventLimits,
// scanAgentMetricsPersonalDimensions) instead of re-deriving the checks independently —
// same "do lane's own building blocks combine to reach the same accept/reject/reason as
// the contract's own reference checker" intent as agent-metrics-fixtures.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "trace", "v1", "fixtures");

function readFixtureJson(filename: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, filename), "utf-8"));
}

/** Leading-token convention shared with agent-metrics/v1's own fixture manifest: a raw
 * schema-validator issue's reason code is its JSON path ("$.relation"); a named semantic
 * check's reason code is a fixed string ("self_supersedes", "event_id_mismatch", ...). */
function reasonCodesOf(reasons: string[]): string[] {
  return reasons.map((r) => r.split(":")[0]?.trim() ?? r);
}

function zodPathToken(path: (string | number)[]): string {
  return `$.${path.join(".")}`;
}

function checkEvent(event: unknown): { category: "accept" | "reject"; reasons: string[] } {
  const reasons: string[] = [];
  const parsed = TraceEventSchema.safeParse(event);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // A custom issue (superRefine's ctx.addIssue) already carries its own leading
      // reason-code token in `message` (e.g. "self_supersedes: ...") -- use it verbatim.
      // A built-in schema issue (enum/regex/strict-object/...) has no such token, so it is
      // given one here from its JSON path, mirroring the playbook's own convention of
      // using a raw validator's JSON path as that error's reason_code.
      reasons.push(
        issue.code === "custom" ? issue.message : `${zodPathToken(issue.path)}: ${issue.message}`,
      );
    }
  }
  reasons.push(
    ...scanAgentMetricsPersonalDimensions(event).map(
      (v) => `personal_dimension_forbidden_key: ${v}`,
    ),
  );
  reasons.push(...checkTraceEventLimits(event));

  // event_id recomputation (layer 2) only makes sense once schema validation confirms every
  // identity field the relation requires is actually present -- never hash an incomplete
  // identity (same MUST the protocol doc states).
  if (parsed.success) {
    const recomputed = computeTraceEventId(parsed.data);
    if (recomputed !== parsed.data.event_id) {
      reasons.push(`event_id_mismatch: declared=${parsed.data.event_id} recomputed=${recomputed}`);
    }
  }

  return { category: reasons.length > 0 ? "reject" : "accept", reasons: [...new Set(reasons)] };
}

interface ManifestEntry {
  id: string;
  kind: "event" | "correction-pair";
  files: Record<string, string>;
  expected: "accept" | "reject";
  reason_code: string | null;
}

const manifest = readFixtureJson("expected-results.json") as { fixtures: ManifestEntry[] };

describe("trace:v1 vendored fixture parity (packages/core/test/fixtures/trace/UPSTREAM)", () => {
  it("vendored expected-results.json is non-empty", () => {
    expect(manifest.fixtures.length).toBeGreaterThan(0);
  });

  for (const entry of manifest.fixtures) {
    it(`${entry.id} (expected=${entry.expected}${entry.reason_code ? `, reason=${entry.reason_code}` : ""})`, () => {
      if (entry.kind === "event") {
        const event = readFixtureJson(entry.files.event as string);
        const result = checkEvent(event);
        expect(result.category, result.reasons.join("; ")).toBe(entry.expected);
        if (entry.expected === "reject" && entry.reason_code) {
          expect(reasonCodesOf(result.reasons)).toContain(entry.reason_code);
        }
        return;
      }

      // correction-pair
      const first = readFixtureJson(entry.files.first as string) as { event_id?: string };
      const second = readFixtureJson(entry.files.second as string) as {
        event_id?: string;
        supersedes_event_id?: string;
      };
      const firstResult = checkEvent(first);
      const secondResult = checkEvent(second);
      const problems: string[] = [];
      if (firstResult.category !== "accept") {
        problems.push(`first event not individually valid: ${firstResult.reasons.join("; ")}`);
      }
      if (secondResult.category !== "accept") {
        problems.push(`second event not individually valid: ${secondResult.reasons.join("; ")}`);
      }
      if (second.supersedes_event_id !== first.event_id) {
        problems.push(
          `second.supersedes_event_id (${second.supersedes_event_id}) does not equal first.event_id (${first.event_id})`,
        );
      }
      if (first.event_id === second.event_id) {
        problems.push("correction pair must not share the same event_id as what it supersedes");
      }
      const category = problems.length > 0 ? "reject" : "accept";
      expect(category, problems.join("; ")).toBe(entry.expected);
    });
  }
});
