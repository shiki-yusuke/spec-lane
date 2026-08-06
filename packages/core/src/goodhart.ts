// design.md §3.6 / §8 v1 core — ported unchanged from the reference implementation's
// orchestrator.py (lines 2724-2799): token/cost telemetry is a process-improvement
// signal, never a per-person one. This module is the machine enforcement of that boundary
// for any payload that gets exported/reported (cost ledger dumps, KPI aggregates, evidence
// exports).

// team-lead review (2026-08-07): a second, separate personal-dimension scanner exists at
// agent-metrics-goodhart.ts (11 keys, versioned by the external agent-metrics:v1 contract,
// used only by the agent-metrics emitter). This list stays internal to spec-lane's own
// ledger/export feature and is not a subset/superset of that one by design — if you're
// changing this key set, check whether agent-metrics-goodhart.ts's list should change too,
// but do not merge the two modules; they answer to different owners.
/** Dimension keys that must never appear in a cost/KPI export payload. */
export const PERSONAL_DIMENSION_KEYS: ReadonlySet<string> = new Set([
  "author",
  "reviewer",
  "assignee",
  "user_id",
  "email",
  "slack_id",
  "owner",
]);

/** group_by dimensions allowed for cost aggregation (author/reviewer etc. excluded). */
export const COST_GROUP_BY_ALLOWED: ReadonlySet<string> = new Set([
  "lane_id",
  "phase",
  "source",
  "confidence",
]);

// Codex credits (2026-07 credit plan) list-price equivalent conversion rate, used to
// back out a credits figure from the USD cost-pricing.yaml entries.
export const USD_PER_CREDIT = 0.04;

function isCodexSource(source: string | null | undefined): boolean {
  return source === "codex_sqlite_auto";
}

/**
 * Derives cost_credits from cost_usd for Codex-sourced ledger entries only. Claude rows
 * stay null (never mixed into a Codex/Claude blended sum); a Codex row with cost_usd===0
 * derives to 0 (not null), matching downstream `!== null` summation semantics.
 */
export function deriveCostCredits(
  costUsd: number | null,
  source: string | null | undefined,
): number | null {
  if (!isCodexSource(source) || costUsd === null) return null;
  return Math.round((costUsd / USD_PER_CREDIT) * 10000) / 10000;
}

/**
 * Recursively walks a payload (object/array nesting) and returns the violation paths
 * where a personal-dimension key was found. Recurses into every object key so a nested
 * addition (e.g. under model_routing) is still caught.
 */
export function validateNoPersonalDimensions(payload: unknown, path = ""): string[] {
  const violations: string[] = [];
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => {
      violations.push(...validateNoPersonalDimensions(item, `${path}[${i}]`));
    });
    return violations;
  }
  if (payload !== null && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (PERSONAL_DIMENSION_KEYS.has(key)) {
        violations.push(here);
      }
      violations.push(...validateNoPersonalDimensions(value, here));
    }
  }
  return violations;
}

export class GoodhartViolationError extends Error {
  constructor(
    readonly context: string,
    readonly violations: readonly string[],
  ) {
    super(
      `Goodhart violation: ${context} contains personal dimension(s) (cost/KPI data is for process ` +
        `improvement, never individual evaluation): ${[...new Set(violations)].sort().join(", ")}`,
    );
    this.name = "GoodhartViolationError";
  }
}

/** Throws GoodhartViolationError if payload contains any personal-dimension key. */
export function assertNoPersonalDimensions(payload: unknown, context = "cost payload"): void {
  const violations = validateNoPersonalDimensions(payload);
  if (violations.length > 0) {
    throw new GoodhartViolationError(context, violations);
  }
}

/** Throws if group_by is not one of the allowed cost-aggregation dimensions. */
export function assertAllowedCostGroupBy(groupBy: string): void {
  if (!COST_GROUP_BY_ALLOWED.has(groupBy)) {
    throw new Error(
      `group_by '${groupBy}' is not allowed (allowed: ${[...COST_GROUP_BY_ALLOWED].sort().join(", ")}; personal dimensions are forbidden)`,
    );
  }
}
