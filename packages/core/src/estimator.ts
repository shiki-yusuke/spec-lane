import {
  type CalibrationObservation,
  type EstimateRevision,
  type Predictors,
  type Profile,
  TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
} from "@lane/schemas";

// design.md §3.5 — Gower-style mixed-type distance (sol: normalized Euclidean + risk
// one-hot was rejected — numeric dims are skew-sensitive and risk is an ordinal, not a
// categorical, so one-hot throws away order information).

const NUMERIC_DIMS = ["files_touched_estimate", "layers_crossed", "spec_rule_count"] as const;
const RISK_ORDER: Record<Predictors["risk_class"], number> = { low: 0, medium: 1, high: 2 };

// design.md §3.5 — the minimum number of knn-eligible neighbors (among the nearest 7)
// required before `estimate()` will produce a knn_quantile prediction at all; below this,
// it falls back to reference_table. Shared with leaveOneOutValidate() below so a
// leave-one-out fold is only scored when the neighbors it would refit from could actually
// have produced a knn_quantile prediction in production (must-3, M2 review, 2026-07-31).
const MIN_USABLE_FOR_KNN = 5;

export function neighborDistance(
  a: Predictors,
  b: Predictors,
  caps: Record<string, number>,
): number {
  const dims: number[] = [];
  for (const key of NUMERIC_DIMS) {
    const av = a[key];
    const bv = b[key];
    if (av == null || bv == null) continue; // missing dimension excluded from the denominator
    const cap = caps[key] ?? 1;
    dims.push(Math.abs(Math.log1p(av) - Math.log1p(bv)) / Math.log1p(cap));
  }
  dims.push(Math.abs(RISK_ORDER[a.risk_class] - RISK_ORDER[b.risk_class]) / 2); // ordinal
  if (a.novel_surface !== "unknown" && b.novel_surface !== "unknown") {
    dims.push(a.novel_surface === b.novel_surface ? 0 : 1); // match/mismatch
  }
  if (dims.length === 0) return Number.POSITIVE_INFINITY;
  return dims.reduce((s, d) => s + d, 0) / dims.length; // Gower-style average, missing dims excluded
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] as number;
}

interface NeighborCandidate {
  observation: CalibrationObservation;
  distance: number;
}

export interface PopulationCondition {
  populationSize: number;
  method: "knn_quantile" | "reference_table" | "manual_fallback";
  experimental: boolean;
  leaveOneOutP50Error?: number;
  leaveOneOutP80Coverage?: number;
}

export interface EstimatorResult {
  predicted: EstimateRevision["predicted"];
  neighbors: EstimateRevision["neighbors"];
  populationCondition: PopulationCondition;
}

/**
 * MP-8 (2026-08-08, sol ruling point 7) — thrown when the (basis-filtered) population is
 * too small for a k-NN prediction and no reference table was given. Previously
 * `estimate()` silently defaulted to placeholder numbers (50 000/150 000 tokens, $1/$4)
 * whenever a caller omitted `--reference-*`; that default is now gone, and the caller
 * (the CLI) must supply one explicitly, or accept this thrown error surfacing as a clear
 * failure instead.
 */
export class ReferenceTableRequiredError extends Error {}

/**
 * M1 skeleton: population < 8 falls back to a manual reference table the caller supplies
 * (no learned model at this population size, per design.md §5.1/§1 non-scope: regression
 * estimator is a v2 decision).
 *
 * `populationSize` is the *real*, observed size of the population this fallback was
 * evaluated against (should-6, M2 review, 2026-07-31) — not a fixed placeholder. Recording
 * the true number (which may be 0, or anywhere up to 7 when the top-7-ranked usable count
 * dropped below MIN_USABLE_FOR_KNN) is what lets an audit of the <8 population boundary
 * distinguish "no data at all" from "some data, just not enough eligible neighbors".
 */
export function referenceTableEstimate(
  predictors: Predictors,
  referenceTable: { predicted: EstimateRevision["predicted"] } | undefined,
  populationSize: number,
): EstimatorResult {
  if (!referenceTable) {
    throw new ReferenceTableRequiredError(
      `population of ${populationSize} basis-eligible observation(s) is too small for a k-NN prediction, and no reference table was given -- pass --reference-tokens-p50, --reference-tokens-p80, --reference-cost-p50, and --reference-cost-p80 explicitly (all four together)`,
    );
  }
  return {
    predicted: referenceTable.predicted,
    neighbors: [],
    populationCondition: { populationSize, method: "reference_table", experimental: true },
  };
}

export function estimate(
  predictors: Predictors,
  population: readonly CalibrationObservation[],
  profile: Profile,
  referenceTable?: { predicted: EstimateRevision["predicted"] },
): EstimatorResult {
  // MP-8 (2026-08-08, sol ruling point 7) — only observations recorded under the one
  // basis this codebase currently knows how to compare (core/token-basis.js) may
  // contribute to a k-NN prediction. A missing token_basis (a pre-MP-8 observation, or a
  // legacy import) is excluded the same as a genuinely mismatched one -- never assumed
  // to match by default. `populationSize` below reflects this *filtered* count, not the
  // raw population.length, so an audit of the <8 boundary sees the real addressable
  // population, not one inflated by observations that could never actually be used.
  const eligiblePopulation = population.filter(
    (o) => o.actual.token_basis === TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
  );
  if (eligiblePopulation.length < 8) {
    return referenceTableEstimate(predictors, referenceTable, eligiblePopulation.length);
  }

  const ranked: NeighborCandidate[] = eligiblePopulation
    .map((observation) => ({
      observation,
      distance: neighborDistance(predictors, observation.predictors, profile.distance_caps),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 7);
  const usable = ranked.filter((r) => r.observation.eligible_for_knn);
  if (usable.length < MIN_USABLE_FOR_KNN) {
    return referenceTableEstimate(predictors, referenceTable, eligiblePopulation.length);
  }

  const tokens = usable
    .map((r) => r.observation.actual.tokens)
    .filter((t): t is number => t != null)
    .sort((a, b) => a - b);
  const cost = usable
    .map((r) => r.observation.actual.estimated_cost_usd)
    .filter((c): c is number => c != null)
    .sort((a, b) => a - b);

  const looResult = leaveOneOutValidate(usable);

  return {
    predicted: {
      tokens: { p50: quantile(tokens, 0.5), p80: quantile(tokens, 0.8) },
      cost_usd: { p50: quantile(cost, 0.5), p80: quantile(cost, 0.8) },
    },
    neighbors: usable.map((r) => ({
      intent_id: r.observation.intent_id,
      distance: r.distance,
      measurement_quality: r.observation.measurement_quality,
    })),
    populationCondition: {
      populationSize: eligiblePopulation.length,
      method: "knn_quantile",
      experimental: eligiblePopulation.length < 30,
      ...looResult,
    },
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/**
 * design.md §3.5/M2 item 3 ("leave-one-out 誤差の常時記録") — for each usable neighbor,
 * refits the quantile prediction from every *other* usable neighbor and scores that
 * neighbor's own actual tokens against the refit p50/p80. Reported as
 * population_condition.leave_one_out_{p50_error,p80_coverage} on every knn_quantile
 * revision so estimate.json's own history shows the k-NN model's real out-of-sample
 * accuracy rather than an unverified confidence claim. Uses `tokens` as the scored metric
 * (the schema stores one pair of LOO numbers per revision, not one per predicted field)
 * since tokens is the primary predictor here.
 *
 * must-3 (M2 review, 2026-07-31): a fold is only scored when the neighbors remaining after
 * holding one out still meet production's own MIN_USABLE_FOR_KNN gate. `estimate()` never
 * actually produces a knn_quantile prediction from fewer than MIN_USABLE_FOR_KNN usable
 * neighbors — it falls back to reference_table instead — so refitting from fewer than that
 * inside a LOO fold would score an accuracy claim for a configuration production could
 * never select. At the boundary (`usable.length === MIN_USABLE_FOR_KNN`), every fold leaves
 * one fewer than the minimum, so no fold is scored at all and both fields come back
 * `undefined` (schema-optional) rather than a misleadingly precise 0.
 */
function leaveOneOutValidate(usable: readonly NeighborCandidate[]): {
  leaveOneOutP50Error?: number;
  leaveOneOutP80Coverage?: number;
} {
  const relativeErrors: number[] = [];
  let coveredCount = 0;
  let scored = 0;

  for (let i = 0; i < usable.length; i++) {
    const held = usable[i];
    const actual = held?.observation.actual.tokens;
    if (held === undefined || actual == null) continue;

    const rest = usable
      .filter((_, j) => j !== i)
      .map((r) => r.observation.actual.tokens)
      .filter((t): t is number => t != null)
      .sort((a, b) => a - b);
    if (rest.length < MIN_USABLE_FOR_KNN) continue;

    const refitP50 = quantile(rest, 0.5);
    const refitP80 = quantile(rest, 0.8);
    scored++;
    // MP-8 (2026-08-08, sol ruling point 7) — a refitP50 == 0 with a nonzero actual has
    // no meaningful finite ratio; previously pushed Number.POSITIVE_INFINITY into
    // relativeErrors, which could make the reported leaveOneOutP50Error (median(...))
    // itself Infinity -- the same non-JSON-round-trippable value this fix eliminates
    // elsewhere (calibrate-service.ts's evaluatePrediction). Excluded from the median
    // rather than fabricating a capped substitute; still counted toward `scored` and the
    // p80-coverage check below, both of which remain well-defined regardless.
    if (refitP50 !== 0 || actual === 0) {
      relativeErrors.push(refitP50 === 0 ? 0 : Math.abs(actual - refitP50) / refitP50);
    }
    if (actual <= refitP80) coveredCount++;
  }

  if (scored === 0) return {};
  return {
    leaveOneOutP50Error: median(relativeErrors),
    leaveOneOutP80Coverage: coveredCount / scored,
  };
}
