// MP-8 (2026-08-08, sol ruling point 7) — a single, explicit accounting basis for every
// token/cost number the calibration and estimation loop touches: agent-cost's own raw
// total (cache tokens included, no per-tool re-normalization). Kept as its own tiny
// module (not inlined into calibration.ts/estimate.ts) since both schemas reference the
// same literal and core/estimator.ts needs to import it too, without creating a
// calibration<->estimate coupling neither module otherwise has.
//
// This is deliberately a single-value union today, not "the first of several basis
// options" — there is currently exactly one basis this codebase knows how to produce.
// An observation/revision recorded under any other value (or none at all) is basis-
// mismatched and must be excluded from the k-NN population (core/estimator.ts), never
// silently treated as comparable.
export const TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1 = "agent-cost-raw-total/v1" as const;
export type TokenBasis = typeof TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1;
