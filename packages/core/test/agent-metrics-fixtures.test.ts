import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentMetricsEnvelopeSchema, TokenUsagePayloadSchema } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { scanAgentMetricsPersonalDimensions } from "../src/agent-metrics-goodhart.js";
import { computeAgentMetricsUpsertKey } from "../src/jcs.js";

// design.md §4.5/§5.5 DEP-07 — replays ai-agent-skills-playbook's own
// contracts/agent-metrics/v1/verify-fixtures.mjs conformance checks against the vendored
// fixtures (packages/core/test/fixtures/agent-metrics/v1/, see contracts/agent-metrics/
// UPSTREAM for the exact commit/tree hash), but using *this repo's own* production
// primitives (TokenUsagePayloadSchema, scanAgentMetricsPersonalDimensions,
// computeAgentMetricsUpsertKey) instead of re-deriving the checks independently. The
// point of this test is "do lane's own building blocks combine to reach the same
// accept/reject/reason as the contract's own reference checker," not "does a
// reimplementation of the contract agree with itself."

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "fixtures", "agent-metrics", "v1");
const FIXTURES_DIR = join(FIXTURES_ROOT, "fixtures");

function readFixtureText(filename: string): string {
  return readFileSync(join(FIXTURES_DIR, filename), "utf-8");
}
function readFixtureJson(filename: string): unknown {
  return JSON.parse(readFixtureText(filename));
}

const MARKER_RE = /<!--\s*agent-metrics:v1\s+([\s\S]*?)\s*-->/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseMarker(markerText: string): { ignored: boolean; fields?: Record<string, string> } {
  const m = markerText.match(MARKER_RE);
  if (!m) return { ignored: true };
  const body = m[1] ?? "";
  const fields = Object.fromEntries(
    [...body.matchAll(/([a-z_][a-z0-9_]*)=(\S+)/g)].map(([, k, v]) => [k, v]),
  );
  return { ignored: false, fields };
}

interface DecodedMarker {
  reasons: string[];
  payload?: unknown;
  bytes?: Buffer;
}

function decodeMarkerPayload(fields: Record<string, string>): DecodedMarker {
  if (!fields.payload_b64 || !fields.sha256) return { reasons: ["envelope_fields_missing"] };
  if (fields.payload_b64.length % 4 !== 0 || !BASE64_RE.test(fields.payload_b64)) {
    return { reasons: ["envelope_base64_decode_failed"] };
  }
  const bytes = Buffer.from(fields.payload_b64, "base64");
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== fields.sha256.toLowerCase()) return { reasons: ["envelope_hash_mismatch"] };
  try {
    return { reasons: [], payload: JSON.parse(bytes.toString("utf-8")), bytes };
  } catch {
    return { reasons: ["payload_not_valid_json"] };
  }
}

function checkPayload(payload: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (payload.schema !== "token-usage/v1") {
    reasons.push("unsupported_schema_kind");
    if (!AgentMetricsEnvelopeSchema.safeParse(payload).success)
      reasons.push("envelope_schema_invalid");
    reasons.push(
      ...scanAgentMetricsPersonalDimensions(payload).map(
        (v) => `personal_dimension_forbidden_key: ${v}`,
      ),
    );
    return [...new Set(reasons)];
  }

  const validated = TokenUsagePayloadSchema.safeParse(payload);
  if (!validated.success) reasons.push("token_usage_schema_invalid");
  reasons.push(
    ...scanAgentMetricsPersonalDimensions(payload).map(
      (v) => `personal_dimension_forbidden_key: ${v}`,
    ),
  );

  if (
    typeof payload.upsert_key === "string" &&
    typeof payload.schema === "string" &&
    payload.repository &&
    payload.subject
  ) {
    const recomputed = computeAgentMetricsUpsertKey({
      schema: payload.schema,
      repository: payload.repository,
      subject: payload.subject,
    });
    if (recomputed !== payload.upsert_key) {
      reasons.push(`upsert_key_mismatch: declared=${payload.upsert_key} recomputed=${recomputed}`);
    }
  }
  return [...new Set(reasons)];
}

function reasonCodesOf(reasons: string[]): string[] {
  return reasons.map((r) => r.split(":")[0]?.trim() ?? r);
}

interface ManifestEntry {
  id: string;
  kind: "marker" | "ignored-marker" | "payload" | "correction-pair";
  files: Record<string, string>;
  expected: "accept" | "reject" | "ignore";
  reason_code: string | null;
  assert?: string;
}

const manifest = readFixtureJson("expected-results.json") as { fixtures: ManifestEntry[] };

describe("agent-metrics:v1 vendored fixture parity (contracts/agent-metrics/UPSTREAM)", () => {
  it("vendored expected-results.json is non-empty", () => {
    expect(manifest.fixtures.length).toBeGreaterThan(0);
  });

  for (const entry of manifest.fixtures) {
    it(`${entry.id} (expected=${entry.expected}${entry.reason_code ? `, reason=${entry.reason_code}` : ""})`, () => {
      if (entry.kind === "marker" || entry.kind === "ignored-marker") {
        const markerText = readFixtureText(entry.files.marker as string);
        const parsed = parseMarker(markerText);
        if (parsed.ignored) {
          expect(entry.expected).toBe("ignore");
          return;
        }
        const decoded = decodeMarkerPayload(parsed.fields as Record<string, string>);
        if (decoded.reasons.length > 0) {
          expect(entry.expected).toBe("reject");
          expect(reasonCodesOf(decoded.reasons)).toContain(entry.reason_code);
          return;
        }
        const reasons = checkPayload(decoded.payload as Record<string, unknown>);
        if (reasons.length === 0) {
          expect(entry.expected).toBe("accept");
        } else {
          expect(entry.expected).toBe("reject");
          expect(reasonCodesOf(reasons)).toContain(entry.reason_code);
        }
        return;
      }

      if (entry.kind === "payload") {
        const payload = readFixtureJson(entry.files.payload as string) as Record<string, unknown>;
        const reasons = checkPayload(payload);
        if (reasons.length === 0) {
          expect(entry.expected).toBe("accept");
        } else {
          expect(entry.expected).toBe("reject");
          expect(reasonCodesOf(reasons)).toContain(entry.reason_code);
        }
        return;
      }

      // correction-pair
      const first = readFixtureJson(entry.files.first as string) as Record<string, unknown>;
      const second = readFixtureJson(entry.files.second as string) as Record<string, unknown>;
      expect(checkPayload(first)).toHaveLength(0);
      expect(checkPayload(second)).toHaveLength(0);

      const firstKey = computeAgentMetricsUpsertKey({
        schema: first.schema as string,
        repository: first.repository,
        subject: first.subject,
      });
      const secondKey = computeAgentMetricsUpsertKey({
        schema: second.schema as string,
        repository: second.repository,
        subject: second.subject,
      });
      expect(firstKey).toBe(secondKey);
      expect(first.upsert_key).toBe(firstKey);
      expect(second.upsert_key).toBe(secondKey);

      if (entry.assert === "same_upsert_key_different_content") {
        expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
      }
      if (entry.assert === "same_upsert_key_record_removed") {
        const firstRecords = ((first.data as Record<string, unknown>)?.records ?? []) as unknown[];
        const secondRecords = ((second.data as Record<string, unknown>)?.records ??
          []) as unknown[];
        const secondSet = new Set(secondRecords.map((r) => JSON.stringify(r)));
        const removed = firstRecords.filter((r) => !secondSet.has(JSON.stringify(r)));
        expect(removed.length).toBeGreaterThan(0);
      }
    });
  }
});
