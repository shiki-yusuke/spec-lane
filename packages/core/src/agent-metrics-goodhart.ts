// agent-metrics:v1 protocol doc section 7's own forbidden personal-dimension key set —
// deliberately a *separate* list from core/goodhart.ts's PERSONAL_DIMENSION_KEYS (7 keys,
// spec-lane's own internal ledger/export feature). This one has 11 keys and is versioned
// by the external contract (ai-agent-skills-playbook's agent-metrics-v1.md), not by this
// repo — using the smaller internal list here would silently under-protect against the
// public contract's own MUST requirement (username/display_name/handle/chat_id/real_name
// are not in goodhart.ts's list at all).
//
// team-lead review (2026-08-07): two personal-dimension scanners now exist in this
// codebase. This is deliberate for v1 (see docs/design.md §4.5), not an oversight — but if
// you are changing either key set, read core/goodhart.ts's own matching cross-reference
// comment first and check whether the change should apply to both.
export const AGENT_METRICS_FORBIDDEN_PERSONAL_DIMENSION_KEYS: ReadonlySet<string> = new Set([
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
]);

/**
 * Recursively walks a payload (object/array nesting) and returns the violation paths
 * where a protocol-forbidden personal-dimension key was found. Mirrors
 * core/goodhart.ts's validateNoPersonalDimensions in shape (not by import — the two key
 * sets are independent per the module comment above), and
 * ai-agent-skills-playbook's own verify-fixtures.mjs scanPersonalDimensions logic.
 */
export function scanAgentMetricsPersonalDimensions(payload: unknown, path = ""): string[] {
  const violations: string[] = [];
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => {
      violations.push(...scanAgentMetricsPersonalDimensions(item, `${path}[${i}]`));
    });
    return violations;
  }
  if (payload !== null && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (AGENT_METRICS_FORBIDDEN_PERSONAL_DIMENSION_KEYS.has(key)) {
        violations.push(here);
      }
      violations.push(...scanAgentMetricsPersonalDimensions(value, here));
    }
  }
  return violations;
}

export class AgentMetricsGoodhartViolationError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(
      `agent-metrics:v1 payload contains forbidden personal-dimension key(s) (protocol doc section 7): ${[...new Set(violations)].sort().join(", ")}`,
    );
    this.name = "AgentMetricsGoodhartViolationError";
  }
}

/** Throws AgentMetricsGoodhartViolationError if payload contains any forbidden key. */
export function assertNoAgentMetricsPersonalDimensions(payload: unknown): void {
  const violations = scanAgentMetricsPersonalDimensions(payload);
  if (violations.length > 0) {
    throw new AgentMetricsGoodhartViolationError(violations);
  }
}
