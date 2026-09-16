// MP-8 (2026-08-08, sol ruling point 7) — a single, explicit accounting basis for every
// token/cost number the calibration and estimation loop touches: agent-cost's own raw
// total (cache tokens included, no per-tool re-normalization). Kept as its own tiny
// module (not inlined into calibration.ts/estimate.ts) since both schemas reference the
// same literal and core/estimator.ts needs to import it too, without creating a
// calibration<->estimate coupling neither module otherwise has.
//
// I-2026-09-10-agent-cost-v2-basis-gate (D2/D3/RULE-30) — two literals, two different
// roles now, the opposite of this module's original "single-value union" framing:
// - `TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V2` is the *current* basis (agent-cost 0.2.0's
//   dedup fix). It is what a fresh measurement stamps and what the k-NN population, the
//   estimator's cohort match and both revision write sites compare against
//   (`CURRENT_ACCOUNTING_BASIS` below is its alias, so a producer-declared value and an
//   estimator-compared value can never drift apart independently).
// - `TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1` is now read-only: it stays exported only so
//   code that reads a record already on disk (written before this lane) can recognize
//   its value; nothing in this codebase writes it anymore.
// An observation/revision recorded under any other value, under v1, or under none at all
// is basis-mismatched and must be excluded from the k-NN population (core/estimator.ts),
// never silently treated as comparable.
export const TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1 = "agent-cost-raw-total/v1" as const;
export const TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V2 = "agent-cost-raw-total/v2" as const;
export type TokenBasis =
  | typeof TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1
  | typeof TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V2;

// RULE-30: the literal every write site stamps and every comparison site compares
// against. D2 also names `CURRENT_ACCOUNTING_BASIS` as living "in agent-cost.ts" as an
// alias of this same constant; it is defined here instead (see
// `packages/schemas/src/agent-cost.ts`'s own comment for why re-exporting it there would
// collide with this package's barrel `export *`), so
// `packages/core/src/estimator.ts` / `estimator-v2.ts` / `estimate-service.ts` (which
// have no reason to depend on the agent-cost measure/v1 payload shape) can import just
// the basis constant.
export const CURRENT_ACCOUNTING_BASIS = TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V2;
