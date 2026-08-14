import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAgentMetricsPersonalDimensions } from "@lane/core";
import {
  type AgentCostMeasureResult,
  AgentCostMeasureResultSchema,
  type AgentCostRow,
} from "@lane/schemas";
import { describe, expect, it } from "vitest";

// #51 -- replays ai-agent-skills-playbook's own contracts/measure/v1/verify-fixtures.mjs
// conformance checks (packages/adapters/test/fixtures/measure/v1/, see
// packages/adapters/test/fixtures/measure/UPSTREAM for the pinned commit) against *this
// repo's own* production primitives: AgentCostMeasureResultSchema (the same Zod schema
// AgentCostTelemetryAdapter.measure() parses every subprocess response through) plus the
// same explicit protocol_version check that adapter performs
// (packages/adapters/src/telemetry/agent-cost.ts), and scanAgentMetricsPersonalDimensions
// (the same personal-dimension denylist agent-metrics/v1 fixtures are checked against) --
// same "do lane's own building blocks combine to reach the same accept/reject call as the
// contract's own reference checker" intent as trace-fixtures.test.ts and
// agent-metrics-fixtures.test.ts.
//
// Deliberately does NOT spawn AgentCostTelemetryAdapter as a subprocess wrapper (there is no
// real `agent-cost` binary to exec against a static fixture file) -- it exercises the same
// parse + protocol_version-check sequence that class's measure() method runs on whatever a
// subprocess actually returns, directly on the vendored fixtures.
//
// measure/v1's schema is deliberately *open* (no additionalProperties:false anywhere -- see
// docs/protocols/measure-v1.md's "Open vs. closed schema"), which AgentCostMeasureResultSchema
// already matches structurally: it's a plain z.object() (Zod's default "strip unknown keys"
// mode, not .strict()), so an extra/forbidden key is silently dropped by schema parsing alone,
// never surfaced as a parse failure. That means the personal-dimension scan below is not a
// defense-in-depth backstop for this contract the way it is for closed-schema ones (trace/
// attribution/agent-metrics) -- it is the *only* layer that can reject
// invalid-personal-dimension, and this test exists specifically to prove that layer is wired
// in, not to prove the schema alone rejects it (the schema alone does not, deliberately).

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "measure", "v1", "fixtures");

function readFixtureJson(filename: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, filename), "utf-8"));
}

function zodPathToken(path: (string | number)[]): string {
  return `$.${path.join(".")}`;
}

interface CheckResult {
  category: "accept" | "reject";
  reasons: string[];
}

const PRICING_STATUS_RANK: Record<string, number> = { unpriced: 0, lower_bound: 1, priced: 2 };

interface DimensionBucket {
  tokens: number;
  priced_tokens: number;
  unpriced_tokens: number;
  estimated_cost_usd: number;
  credits: number;
  pricing_status: number;
}

/** Groups rows by (agent, model, token_kind), summing numeric fields and taking the worst
 * pricing_status per bucket -- mirrors agent_cost/aggregate.py's own build_rows bucketing/
 * ranking (sol review must2). Not backed by any existing lane production primitive (lane
 * does not yet independently re-aggregate measure's rows anywhere), so hand-implemented here
 * the same way ai-agent-skills-playbook's verify-fixtures.mjs and agent-cost's
 * test_measure_v1_contract.py both do. */
function aggregateRowsByDimension(rows: readonly AgentCostRow[]): Map<string, DimensionBucket> {
  const buckets = new Map<string, DimensionBucket>();
  for (const row of rows) {
    const key = JSON.stringify([row.agent, row.model, row.token_kind]);
    const bucket: DimensionBucket = buckets.get(key) ?? {
      tokens: 0,
      priced_tokens: 0,
      unpriced_tokens: 0,
      estimated_cost_usd: 0,
      credits: 0,
      pricing_status: PRICING_STATUS_RANK.priced ?? 2,
    };
    bucket.tokens += row.tokens;
    bucket.priced_tokens += row.priced_tokens;
    bucket.unpriced_tokens += row.unpriced_tokens;
    bucket.estimated_cost_usd += row.estimated_cost_usd;
    bucket.credits += row.credits;
    const rank = PRICING_STATUS_RANK[row.pricing_status];
    if (rank !== undefined && rank < bucket.pricing_status) bucket.pricing_status = rank;
    buckets.set(key, bucket);
  }
  return buckets;
}

/** sol review must2: total.rows MUST equal the (agent, model, token_kind)-dimensional
 * re-aggregation of the union of every sessions[*].rows, not just a scalar totals-sum match
 * (a same-totals-different-attribution tamper, see invalid-total-rows-wrong-dimension, can
 * pass a scalar-only check undetected). */
function checkTotalRowsMatchDimensionalAggregate(
  sessions: AgentCostMeasureResult["sessions"],
  totalRows: readonly AgentCostRow[],
  reasons: string[],
): void {
  const allSessionRows = Object.values(sessions).flatMap((entry) => entry.rows);
  const expected = aggregateRowsByDimension(allSessionRows);
  const actual = aggregateRowsByDimension(totalRows);

  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    const exp = expected.get(key);
    const act = actual.get(key);
    if (!exp || !act) {
      reasons.push(
        `total_rows_dimension_mismatch: bucket ${key} present in only one of expected/actual`,
      );
      continue;
    }
    for (const field of ["tokens", "priced_tokens", "unpriced_tokens", "pricing_status"] as const) {
      if (exp[field] !== act[field]) {
        reasons.push(
          `total_rows_dimension_mismatch: bucket ${key}.${field} = ${act[field]}, expected ${exp[field]}`,
        );
      }
    }
    for (const field of ["estimated_cost_usd", "credits"] as const) {
      if (Math.abs((exp[field] as number) - (act[field] as number)) > 1e-9) {
        reasons.push(
          `total_rows_dimension_mismatch: bucket ${key}.${field} = ${act[field]}, expected ${exp[field]}`,
        );
      }
    }
  }
}

/** sol review must2: a matched:false session entry MUST have an empty rows array and
 * all-zero totals -- "no usage matched" and "usage matched but netted to zero" are different
 * facts. */
function checkMatchedFalseIsEmpty(
  sessions: AgentCostMeasureResult["sessions"],
  reasons: string[],
): void {
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (entry.matched !== false) continue;
    if (entry.rows.length > 0) {
      reasons.push(
        `matched_false_must_have_no_rows: sessions.${sessionId} has ${entry.rows.length} row(s)`,
      );
    }
    for (const [field, value] of Object.entries(entry.totals)) {
      if (value !== 0) {
        reasons.push(
          `matched_false_must_have_zero_totals: sessions.${sessionId}.totals.${field} = ${value}`,
        );
      }
    }
  }
}

/** Mirrors AgentCostTelemetryAdapter.measure()'s own parse + protocol_version-check +
 * personal-dimension-scan sequence (packages/adapters/src/telemetry/agent-cost.ts), applied
 * directly to a fixture instead of a subprocess's stdout, plus two semantic checks
 * (matched:false emptiness, total.rows dimensional match) that no lane production code
 * independently implements yet -- hand-written here the same way the contract's own
 * verify-fixtures.mjs and agent-cost's test_measure_v1_contract.py both do. */
function checkMeasurePayload(raw: unknown): CheckResult {
  const reasons: string[] = [];

  const parsed = AgentCostMeasureResultSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reasons.push(`${zodPathToken(issue.path)}: ${issue.message}`);
    }
  } else if (parsed.data.protocol_version !== "measure/v1") {
    // Same check AgentCostTelemetryAdapter.measure() performs after a successful parse --
    // the schema itself only requires protocol_version to be *a* string (crossing a
    // subprocess/version boundary, per packages/schemas/src/agent-cost.ts's own comment), so
    // an unsupported version is an application-level rejection, not a schema-level one.
    reasons.push(
      `protocol_version_mismatch: unsupported agent-cost protocol_version: ${parsed.data.protocol_version} (lane supports measure/v1)`,
    );
  } else {
    checkMatchedFalseIsEmpty(parsed.data.sessions, reasons);
    checkTotalRowsMatchDimensionalAggregate(parsed.data.sessions, parsed.data.total.rows, reasons);
  }

  reasons.push(
    ...scanAgentMetricsPersonalDimensions(raw).map((v) => `personal_dimension_forbidden_key: ${v}`),
  );

  return { category: reasons.length > 0 ? "reject" : "accept", reasons: [...new Set(reasons)] };
}

interface ManifestEntry {
  id: string;
  files: Record<string, string>;
  expected: "accept" | "reject";
  reason_code?: string | null;
  all_forbidden_keys_flagged?: boolean;
}

// Maps the playbook's own schema-level reason_code token to how *this* checker (Zod +
// AgentCostTelemetryAdapter's own protocol_version check, not the playbook's hand-rolled JS
// schema validator) actually reports the same underlying fixture defect. The two validators
// necessarily diverge here: "$.protocol_version" is a `const` schema violation in the
// playbook's schema, but AgentCostMeasureResultSchema deliberately types protocol_version as
// a plain string (packages/schemas/src/agent-cost.ts: "crosses a subprocess/version
// boundary"), so the same defect is only ever caught by the adapter's own explicit
// post-parse check, not by schema validation -- a real, intentional difference between the
// two layers, not a bug in either one.
const REASON_CODE_PREFIX_FOR: Record<string, string> = {
  "$.protocol_version": "protocol_version_mismatch:",
  "$.total.totals": "$.total.totals",
};

const manifest = readFixtureJson("expected-results.json") as { fixtures: ManifestEntry[] };

describe("measure:v1 vendored fixture parity (packages/adapters/test/fixtures/measure/UPSTREAM)", () => {
  it("vendored expected-results.json declares exactly 3 accept + 6 reject fixtures", () => {
    const accepted = manifest.fixtures.filter((f) => f.expected === "accept");
    const rejected = manifest.fixtures.filter((f) => f.expected === "reject");
    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(6);
  });

  for (const entry of manifest.fixtures) {
    it(`${entry.id} (expected=${entry.expected}${entry.reason_code ? `, reason=${entry.reason_code}` : ""})`, () => {
      const payload = readFixtureJson(entry.files.record as string);
      const result = checkMeasurePayload(payload);
      expect(result.category, result.reasons.join("; ")).toBe(entry.expected);

      if (entry.expected === "accept") {
        // The adapter's own return type: a successfully parsed, protocol_version-checked
        // AgentCostMeasureResult -- proves lane's TelemetryAdapter boundary actually consumes
        // this fixture, not just that some check function returns "accept".
        const parsed = AgentCostMeasureResultSchema.parse(payload);
        expect(parsed.protocol_version).toBe("measure/v1");
        return;
      }

      // reject: reason-code granularity/vocabulary legitimately differs from the playbook's
      // own hand-rolled JS schema-validator (different validator, different layer -- see
      // REASON_CODE_PREFIX_FOR's own comment) -- checked here as a prefix match against this
      // repo's own equivalent token, not exact equality against the playbook's token.
      if (entry.reason_code) {
        const expectedPrefix = REASON_CODE_PREFIX_FOR[entry.reason_code] ?? entry.reason_code;
        expect(
          result.reasons.some((r) => r.startsWith(expectedPrefix)),
          `expected a reason starting with "${expectedPrefix}" (playbook reason_code: ${entry.reason_code}), got: ${result.reasons.join("; ")}`,
        ).toBe(true);
      }
      if (entry.all_forbidden_keys_flagged) {
        for (const key of [
          "author",
          "reviewer",
          "assignee",
          "owner",
          "user_id",
          "username",
          "email",
          "display_name",
          "handle",
          "chat_id",
          "real_name",
        ]) {
          expect(result.reasons).toContain(`personal_dimension_forbidden_key: ${key}`);
        }
      }
    });
  }
});
