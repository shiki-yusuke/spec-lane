import {
  type AgentCostMeasureResult,
  type AgentCostRow,
  CURRENT_ACCOUNTING_BASIS,
  type CalibrationObservation,
  type EstimateRevision,
  type EstimateV2Cohort,
  IntentSchema,
  type LedgerEntry,
  type Predictors,
  type Profile,
  TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
} from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  buildObservationFromMeasurement,
  evaluatePrediction,
} from "../src/application/calibrate-service.js";
import { buildEstimateRevision } from "../src/application/estimate-service.js";
import { buildLaneEvidence } from "../src/application/evidence-export-service.js";
import { type AttributionProjection, buildAttributionProjection } from "../src/attribution.js";
import { buildEstimateV2Decision, classifyCandidateExclusion } from "../src/estimator-v2.js";
import { computeLedgerEntryId } from "../src/ledger.js";
import { buildObservationFromLegacyLaneState } from "../src/migrate-legacy-ledger.js";
import { buildTraceEvent } from "../src/trace.js";

// docs/spec/I-2026-09-10-agent-cost-v2-basis-gate/spec.md -- new coverage for the round-B
// public-surface changes (RULE-11/12/20/30/31/35/37/40/42; TEST-24/45/56/60/61/65/68/69).
// Fixture shapes (buildTraceEvent/buildAttributionProjection, measurement/predictors
// factories, EstimateV2Cohort shape) are copied from this repo's own existing test
// helpers (attribution.test.ts, calibrate-service.test.ts, estimator-v2.test.ts) --
// contracts, not implementation internals.

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Builds the minimal session_bound + matched:true usage_imported trace-event pair per
 * session_id that makes buildAttributionProjection classify every given session as
 * "exactly_attributed" (attribution.ts describe()) -- same pattern as
 * calibrate-service.test.ts's own helper of the same name. */
function exactlyAttributedProjection(sessionIds: readonly string[]): AttributionProjection {
  const sessionBoundEvents = sessionIds.map((sessionId, i) =>
    buildTraceEvent({
      relation: "session_bound",
      fromRef: { logical_id: `task_run:t-${i}` },
      toRef: { logical_id: `session:${sessionId}` },
      occurredAt: "2026-09-10T08:00:00Z",
      actor: { kind: "cli", id: "lane" },
      taskRunId: `t-${i}`,
      sessionId,
      payload: { binding_method: "pre_assigned_session_id", agent: "claude" },
    }),
  );
  const usageImportedEvents = sessionIds.map((sessionId, i) =>
    buildTraceEvent({
      relation: "usage_imported",
      fromRef: { logical_id: `session:${sessionId}` },
      toRef: { logical_id: `task_run:t-${i}` },
      occurredAt: "2026-09-10T08:30:00Z",
      actor: { kind: "cli", id: "lane" },
      taskRunId: `t-${i}`,
      sessionId,
      payload: {
        window: { since: "2026-09-10T00:00:00Z", until: "2026-09-10T08:30:00Z" },
        tokens: 0,
        matched: true,
      },
    }),
  );
  return buildAttributionProjection({ usageImportedEvents, sessionBoundEvents });
}

function measurement(
  overrides: Partial<AgentCostMeasureResult["total"]["totals"]> = {},
  matched = true,
  // I-2026-09-10-agent-cost-v2-basis-gate (RULE-30/31) -- `string | null`, not
  // `string | undefined`: a JS default parameter only kicks in when the caller passes
  // `undefined` (or omits the argument), so `measurement({}, true, undefined)` would
  // silently fall through to the CURRENT_ACCOUNTING_BASIS default instead of expressing
  // "this payload declares no basis at all". `null` is the caller-facing sentinel for
  // that case; the default itself is still the current basis.
  accountingBasis: string | null = CURRENT_ACCOUNTING_BASIS,
): AgentCostMeasureResult {
  const totals = {
    tokens: 120_000,
    priced_tokens: 120_000,
    unpriced_tokens: 0,
    estimated_cost_usd: 3.1,
    credits: 0,
    ...overrides,
  };
  const rows: AgentCostRow[] = [];
  return {
    protocol_version: "measure/v1",
    generated_at: "2026-09-10T09:00:00Z",
    window: { since: null, until: null },
    timezone: "UTC",
    agent: ["claude"],
    rates: { catalog_version: "2026-09-01", sha256: "abc" },
    session_ids: ["sess-1"],
    sessions: { "sess-1": { matched, rows: [], totals } },
    total: { rows, totals },
    ...(accountingBasis !== null ? { accounting_basis: accountingBasis } : {}),
    // I-2026-09-10-agent-cost-v2-basis-gate (RULE-07) -- a dedup counter that is *absent*
    // is dirty (template T-4: "an explicit 0 is required"), not clean-by-default; every
    // test in this file that isn't specifically about a dirty counter needs all three
    // explicitly zeroed so it exercises only the one condition (basis/anyMatched/etc.) it
    // names, without incidentally tripping RULE-07's own MIXED_OR_UNATTRIBUTED_USAGE.
    data_quality: {
      malformed_events: 0,
      skipped_files: 0,
      negative_deltas: 0,
      unpriced_tokens: totals.unpriced_tokens,
      conflicting_duplicate_groups: 0,
      missing_dedup_identity_rows: 0,
      source_quality: { ok: 1, identity_missing: 0 },
    },
  };
}

const predictors: Predictors = {
  files_touched_estimate: 3,
  files_touched_observed: 4,
  layers_crossed: 1,
  risk_class: "low",
  spec_rule_count: 2,
  novel_surface: "false",
};

const cohortConfig = {
  agent_type: "claude",
  model_provider: "anthropic",
  model_generation: "claude-5",
  model_id: "claude-sonnet-5",
  routing_policy_digest: "a".repeat(64),
  prompt_policy_digest: "b".repeat(64),
  execution_profile_digest: "c".repeat(64),
};

const targetCohort: EstimateV2Cohort = {
  ...cohortConfig,
  measure_contract_version: "measure/v1",
  token_basis: CURRENT_ACCOUNTING_BASIS,
};

function candidateObservation(
  id: string,
  tokenBasis: string,
  knnIneligibilityReasons: CalibrationObservation["knn_ineligibility_reasons"] = [],
  withCohort = true,
): CalibrationObservation {
  return {
    schema_version: "1.0",
    record_id: id,
    kind: "observation",
    intent_id: id,
    recorded_at: "2026-09-10T00:00:00Z",
    predictors,
    predictor_quality: "observed",
    actual: { tokens: 100_000, estimated_cost_usd: 3, token_basis: tokenBasis },
    measurement_quality: "observed",
    eligible_for_knn: knnIneligibilityReasons.length === 0,
    accounting_basis: tokenBasis,
    knn_ineligibility_reasons: knnIneligibilityReasons,
    knn_ineligibility_detail: [],
    provenance: "measured",
    ...(withCohort ? { cohort: { ...cohortConfig, measure_contract_version: "measure/v1" } } : {}),
  };
}

// ---------------------------------------------------------------------------
// (1) RULE-12/31 -- token_basis normalization + accounting_basis/reasons/detail written
// on every observation.
// ---------------------------------------------------------------------------

describe("buildObservationFromMeasurement -- basis normalization (RULE-12/31, T-1)", () => {
  it('a measurement that declares no accounting_basis at all normalizes to "unknown" everywhere, with the T-1 detail string', () => {
    const obs = buildObservationFromMeasurement({
      recordId: "cal-basis-0001",
      intentId: "I-2026-09-10-agent-cost-v2-basis-gate",
      recordedAt: "2026-09-10T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement({}, true, null),
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
    });
    // RULE-31: actual.token_basis is the measurement's own normalized accounting_basis.
    expect(obs.actual.token_basis).toBe("unknown");
    // RULE-12: the observation carries its own accounting_basis copy too.
    expect(obs.accounting_basis).toBe("unknown");
    expect(obs.knn_ineligibility_reasons).toEqual(["TOKEN_BASIS_MISMATCH"]);
    // Detail string templates, T-1 (spec.md "Detail string templates").
    expect(obs.knn_ineligibility_detail).toEqual([
      `accounting basis is "unknown" (the measurement declared none); the current basis is "${CURRENT_ACCOUNTING_BASIS}"`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// (2) RULE-11/TEST-56 -- eligible_for_knn = reasons.length===0 && anyMatched && fullyPriced.
// ---------------------------------------------------------------------------

describe("buildObservationFromMeasurement -- eligible_for_knn formula (RULE-11, TEST-56)", () => {
  it("anyMatched===false with empty reasons still yields eligible_for_knn:false", () => {
    // basis correct + session exactly attributed -> reasons is empty; only `matched:false`
    // on the measurement's own session drives anyMatched to false.
    const obs = buildObservationFromMeasurement({
      recordId: "cal-basis-0002",
      intentId: "I-2026-09-10-agent-cost-v2-basis-gate",
      recordedAt: "2026-09-10T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement({ tokens: 0, estimated_cost_usd: 0 }, false),
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
    });
    expect(obs.knn_ineligibility_reasons).toEqual([]);
    expect(obs.eligible_for_knn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (3) RULE-37/D22, TEST-60/61 -- evaluatePrediction basis-mismatch scoring.
// ---------------------------------------------------------------------------

describe("evaluatePrediction -- cross-basis scoring (RULE-37, TEST-60/61)", () => {
  function v2Observation(): CalibrationObservation {
    return buildObservationFromMeasurement({
      recordId: "cal-basis-0003",
      intentId: "I-2026-09-10-agent-cost-v2-basis-gate",
      recordedAt: "2026-09-10T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement(),
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
    });
  }

  function baseline(tokenBasis: string | undefined): EstimateRevision {
    return {
      revision_id: "rev-basis",
      estimated_at: "2026-09-10T08:00:00+09:00",
      as_of_phase: "1_intent",
      repo_commit: "abc",
      estimator_version: "0.1.0",
      predictors,
      ...(tokenBasis !== undefined ? { token_basis: tokenBasis } : {}),
      predicted: { tokens: { p50: 100_000, p80: 150_000 }, cost_usd: { p50: 3, p80: 5 } },
      neighbors: [],
      population_condition: { population_size: 0, method: "reference_table", experimental: true },
    };
  }

  it("TEST-60: a v1 baseline against a v2 observation yields null/token_basis_mismatch for both metrics", () => {
    const evaluation = evaluatePrediction(
      v2Observation(),
      baseline(TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1),
      "eval-basis-1",
      "2026-09-10T09:05:00+09:00",
    );
    expect(evaluation.error.tokens).toEqual({
      relative_error_p50: null,
      covered_by_p80: null,
      reason: "token_basis_mismatch",
    });
    expect(evaluation.error.cost_usd).toEqual({
      relative_error_p50: null,
      covered_by_p80: null,
      reason: "token_basis_mismatch",
    });
  });

  it('TEST-60: an "unknown" baseline against a v2 observation is likewise never scored', () => {
    const evaluation = evaluatePrediction(
      v2Observation(),
      baseline("unknown"),
      "eval-basis-2",
      "2026-09-10T09:05:00+09:00",
    );
    expect(evaluation.error.tokens?.relative_error_p50).toBeNull();
    expect(evaluation.error.tokens?.reason).toBe("token_basis_mismatch");
  });

  it("TEST-60: a baseline with no token_basis at all (absent) is also a mismatch", () => {
    const evaluation = evaluatePrediction(
      v2Observation(),
      baseline(undefined),
      "eval-basis-3",
      "2026-09-10T09:05:00+09:00",
    );
    expect(evaluation.error.tokens?.relative_error_p50).toBeNull();
    expect(evaluation.error.tokens?.reason).toBe("token_basis_mismatch");
  });

  it("TEST-61: same-basis scoring is unchanged (a real number, no mismatch reason)", () => {
    const evaluation = evaluatePrediction(
      v2Observation(),
      baseline(CURRENT_ACCOUNTING_BASIS),
      "eval-basis-4",
      "2026-09-10T09:05:00+09:00",
    );
    expect(evaluation.error.tokens?.relative_error_p50).toBeCloseTo(0.2, 5);
    expect(evaluation.error.tokens?.reason).toBeUndefined();
    expect(evaluation.error.cost_usd?.covered_by_p80).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (4) RULE-20/31, TEST-45 -- estimator-v2's basis check excludes a v1 candidate exactly
// once (never a second bucket from its own recorded reasons), a v2/empty-reasons/cohort-
// matching candidate stays eligible.
// ---------------------------------------------------------------------------

describe("classifyCandidateExclusion / buildEstimateV2Decision -- the basis move (TEST-45)", () => {
  it("a v1-basis candidate (whose own recorded reasons also name TOKEN_BASIS_MISMATCH) is excluded exactly once; a v2/empty-reasons candidate is eligible", () => {
    const v1Candidate = candidateObservation("v1", TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1, [
      "TOKEN_BASIS_MISMATCH",
    ]);
    const v2Candidate = candidateObservation("v2", CURRENT_ACCOUNTING_BASIS, []);

    expect(classifyCandidateExclusion(v1Candidate, targetCohort)).toBe("TOKEN_BASIS_MISMATCH");
    expect(classifyCandidateExclusion(v2Candidate, targetCohort)).toBeNull();

    const decision = buildEstimateV2Decision({
      predictors,
      population: [v1Candidate, v2Candidate],
      profile: profileWithCohort(),
      target: { metric: "tokens", unit: "tokens" },
    });
    expect(decision.population.candidate_count).toBe(2);
    expect(decision.population.eligible_count).toBe(1);
    expect(decision.population.excluded_by_reason.TOKEN_BASIS_MISMATCH).toBe(1);
    // RULE-31: the reasons array must not create a second exclusion path -- the v1
    // candidate is counted exactly once, not once per bucket.
    const excludedSum = Object.values(decision.population.excluded_by_reason).reduce(
      (s, v) => s + (v ?? 0),
      0,
    );
    expect(excludedSum).toBe(1);
  });
});

function profileWithCohort(): Profile {
  return {
    schema_version: "1.0",
    profile_id: "generic",
    applies_to_repo: "",
    existing_ssot: {},
    extra_lenses: [],
    layer_ownership: {},
    risk_auto_upgrade: [],
    required_commands: { pre_implement: [], during_implement: [], pre_pr: [], post_implement: [] },
    forbidden_paths_for_low_risk: [],
    isomorphism_rules: { enabled: true, enforced_in: [] },
    test_coverage_floor: { unit_test_per_ears_rule_minimum: 1 },
    distance_caps: { files_touched_estimate: 50, layers_crossed: 10, spec_rule_count: 30 },
    design_override_forbidden: false,
    estimate: { cohort: cohortConfig },
  };
}

// ---------------------------------------------------------------------------
// (5) RULE-20, TEST-24 -- classifyCandidateExclusion evaluates a candidate's own recorded
// reasons (in ESTIMATE_V2_REASON_CODES order) after the basis check, before the cohort
// checks.
// ---------------------------------------------------------------------------

describe("classifyCandidateExclusion -- recorded reasons take priority over cohort checks (RULE-20, TEST-24)", () => {
  it("a basis-matching candidate whose own recorded reasons include MIXED_OR_UNATTRIBUTED_USAGE is excluded for that reason, even though its cohort also mismatches", () => {
    const candidate = candidateObservation(
      "recorded-reason",
      CURRENT_ACCOUNTING_BASIS,
      ["MIXED_OR_UNATTRIBUTED_USAGE"],
      false, // no cohort at all -- would otherwise be MODEL_GENERATION_MISMATCH
    );
    expect(classifyCandidateExclusion(candidate, targetCohort)).toBe("MIXED_OR_UNATTRIBUTED_USAGE");
  });

  it("two recorded reasons (the only pair deriveKnnIneligibility can actually co-emit): the one earlier in ESTIMATE_V2_REASON_CODES declaration order wins as the single primary code, regardless of array order", () => {
    // ESTIMATE_V2_REASON_CODES declaration order (schemas/estimate-v2.ts) puts
    // TOKEN_BASIS_MISMATCH before MIXED_OR_UNATTRIBUTED_USAGE; the array below lists them
    // in the opposite order to prove this is declaration-order, not array-order.
    const candidate = candidateObservation("multi-reason", CURRENT_ACCOUNTING_BASIS, [
      "MIXED_OR_UNATTRIBUTED_USAGE",
      "TOKEN_BASIS_MISMATCH",
    ]);
    expect(classifyCandidateExclusion(candidate, targetCohort)).toBe("TOKEN_BASIS_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// (6) RULE-40/D25, TEST-65 -- a reference-table revision records "unknown" unless the
// operator declared a real basis with referenceTokenBasis.
// ---------------------------------------------------------------------------

describe('buildEstimateRevision -- reference-table revisions record "unknown" by default (RULE-40, TEST-65)', () => {
  const referenceTable = {
    predicted: { tokens: { p50: 100_000, p80: 200_000 }, cost_usd: { p50: 2, p80: 4 } },
  };

  it('records token_basis: "unknown" without --reference-token-basis', () => {
    const revision = buildEstimateRevision({
      revisionId: "r-ref-default",
      estimatedAt: "2026-09-10T09:00:00+09:00",
      asOfPhase: "1_intent",
      repoCommit: "abc1234",
      estimatorVersion: "0.1.0",
      predictors,
      population: [],
      profile: profileWithCohort(),
      referenceTable,
    });
    expect(revision.population_condition.method).toBe("reference_table");
    expect(revision.token_basis).toBe("unknown");
  });

  it("records the declared basis when --reference-token-basis is given", () => {
    const revision = buildEstimateRevision({
      revisionId: "r-ref-declared",
      estimatedAt: "2026-09-10T09:00:00+09:00",
      asOfPhase: "1_intent",
      repoCommit: "abc1234",
      estimatorVersion: "0.1.0",
      predictors,
      population: [],
      profile: profileWithCohort(),
      referenceTable,
      referenceTokenBasis: "agent-cost-raw-total/v9-custom",
    });
    expect(revision.token_basis).toBe("agent-cost-raw-total/v9-custom");
  });

  it('an "unknown" reference-table revision is then never scored against a real measurement (RULE-37)', () => {
    const revision = buildEstimateRevision({
      revisionId: "r-ref-unknown",
      estimatedAt: "2026-09-10T09:00:00+09:00",
      asOfPhase: "1_intent",
      repoCommit: "abc1234",
      estimatorVersion: "0.1.0",
      predictors,
      population: [],
      profile: profileWithCohort(),
      referenceTable,
    });
    const obs = buildObservationFromMeasurement({
      recordId: "cal-basis-0004",
      intentId: "I-2026-09-10-agent-cost-v2-basis-gate",
      recordedAt: "2026-09-10T09:00:00+09:00",
      predictors,
      predictorQuality: "observed",
      measurement: measurement(),
      sessionIds: ["sess-1"],
      attribution: exactlyAttributedProjection(["sess-1"]),
    });
    const evaluation = evaluatePrediction(
      obs,
      revision,
      "eval-basis-5",
      "2026-09-10T09:05:00+09:00",
    );
    expect(evaluation.error.tokens?.relative_error_p50).toBeNull();
    expect(evaluation.error.tokens?.reason).toBe("token_basis_mismatch");
  });
});

// ---------------------------------------------------------------------------
// (7) RULE-42/D28, TEST-68 -- a legacy-migrated observation.
// ---------------------------------------------------------------------------

describe("buildObservationFromLegacyLaneState -- legacy observations are basis-unknown and knn-ineligible (RULE-42, TEST-68)", () => {
  it('carries "unknown", [TOKEN_BASIS_MISMATCH], the T-11 detail and eligible_for_knn:false, with salvaged numbers unchanged', () => {
    const currentShapeLedgerEntry = {
      ledger_entry_id: "lc_basis0001",
      lane_id: "I-2026-09-10-example",
      phase: "1_intent",
      scope: "phase",
      usage: {
        claude_input_tokens: 5000,
        claude_output_tokens: 20000,
        codex_input_tokens: 0,
        codex_output_tokens: 0,
      },
      cost_usd_estimate: 3.5,
      source: "claude_jsonl_auto",
      pricing_version: "2026-09",
      data_state: "has_usage",
      confidence: "imported_windowed",
      included_in_kpi: true,
    };
    const result = buildObservationFromLegacyLaneState(
      { intent_id: "I-2026-09-10-example", cost_ledger: [currentShapeLedgerEntry] },
      undefined,
      "cal-legacy-basis-0001",
      "2026-09-10T09:00:00+09:00",
    );
    expect("observation" in result).toBe(true);
    if (!("observation" in result)) throw new Error("expected an observation");
    // Salvaged numbers unchanged (5000+20000, 3.5), same as migrate-legacy-ledger.test.ts's
    // own "current-shape entry" assertions.
    expect(result.observation.actual.tokens).toBe(25_000);
    expect(result.observation.actual.estimated_cost_usd).toBe(3.5);
    expect(result.observation.actual.token_basis).toBe("unknown");
    expect(result.observation.accounting_basis).toBe("unknown");
    expect(result.observation.knn_ineligibility_reasons).toEqual(["TOKEN_BASIS_MISMATCH"]);
    // Detail string templates, T-11 (spec.md "Detail string templates").
    expect(result.observation.knn_ineligibility_detail).toEqual([
      'observation reconstructed from a legacy ledger; accounting basis is "unknown"',
    ]);
    expect(result.observation.eligible_for_knn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (8) RULE-35, TEST-69 -- evidence-export's ledger summary accounting_bases/status.
// ---------------------------------------------------------------------------

function evidenceLedgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ledger_entry_id: "lc_e",
    lane_id: "I-2026-09-10-example",
    phase: "1_intent",
    source: "manual",
    scope: "phase",
    session_ids: [],
    data_state: "has_usage",
    confidence: "manual",
    included_in_kpi: true,
    tokens: 100,
    turns: null,
    cost_usd: 1,
    cost_credits: null,
    pricing_version: "v1",
    pricing_as_of: null,
    imported_at: "2026-09-10T00:00:00Z",
    since: null,
    until: null,
    agents: null,
    ...overrides,
  } as LedgerEntry;
}

function laneEvidenceInput(entries: readonly LedgerEntry[]) {
  return {
    intentId: "I-2026-09-10-example",
    generatedAt: "2026-09-10T09:00:00Z",
    currentPhase: "1_intent" as const,
    intent: IntentSchema.parse({
      schema_version: "1.0",
      intent_id: "I-2026-09-10-example",
      intent: {
        business_goal: "Reduce onboarding time by clarifying setup docs.",
        user_visible_intent: "New users see setup steps in order.",
        success: ["ok"],
        primary_user: "dev",
        declared_risk: "low",
      },
      ai_inferred_scope: {
        affected_layers: ["docs"],
        confidence: "medium",
        allowed_paths: ["docs/**"],
      },
    }),
    intentContent: "intent: {}",
    intentPath: "docs/spec/I-2026-09-10-example/intent.yaml",
    specContent: null,
    specPath: "docs/spec/I-2026-09-10-example/spec.md",
    verification: null,
    verificationPath: "docs/spec/I-2026-09-10-example/verification.yaml",
    doneOverlay: null,
    effectiveLedgerEntries: entries,
  };
}

// ---------------------------------------------------------------------------
// (9) TEST-70 -- a fixed hash vector for computeLedgerEntryId, asserted without the
// private Python reference implementation (RULE-18: the id must stay unchanged for every
// input it accepts today).
// ---------------------------------------------------------------------------

describe("computeLedgerEntryId -- fixed hash vector (TEST-70)", () => {
  it('("I-2026-09-10-hash-vector", "3_implement", "claude_jsonl_auto", "2026-09-01") -> a pinned id', () => {
    // Value computed by the team lead from pre-change HEAD 7ef8527's implementation
    // (2026-09-14): key = "lane-cost:v1|imported|I-2026-09-10-hash-vector|3_implement|
    // claude_jsonl_auto|2026-09-01", sha256 hex, first 12 chars, "lc_" prefix. Pins
    // identity across the four (lane, phase, source, pricing_version) arguments even
    // where the Python-parity differential suite (ledger.differential.test.ts) skips for
    // lack of the private reference implementation.
    expect(
      computeLedgerEntryId(
        "I-2026-09-10-hash-vector",
        "3_implement",
        "claude_jsonl_auto",
        "2026-09-01",
      ),
    ).toBe("lc_01d50a6e1f91");
  });
});

describe("buildLaneEvidence -- ledger summary accounting_bases/status (RULE-35, TEST-69)", () => {
  it('a single-basis ledger reports accounting_bases:[basis] and status:"single"', () => {
    const evidence = buildLaneEvidence(
      laneEvidenceInput([
        evidenceLedgerEntry({
          ledger_entry_id: "lc_1",
          accounting_basis: CURRENT_ACCOUNTING_BASIS,
        }),
        // a duplicate of the same basis must not appear twice.
        evidenceLedgerEntry({
          ledger_entry_id: "lc_2",
          accounting_basis: CURRENT_ACCOUNTING_BASIS,
        }),
      ]),
    );
    expect(evidence.artifacts.ledger_summary.accounting_bases).toEqual([CURRENT_ACCOUNTING_BASIS]);
    expect(evidence.artifacts.ledger_summary.accounting_basis_status).toBe("single");
  });

  it('a mixed-basis ledger (including an entry with no accounting_basis key at all) reports both, de-duplicated and lexicographically ascending, and status:"unqualified"', () => {
    const evidence = buildLaneEvidence(
      laneEvidenceInput([
        evidenceLedgerEntry({
          ledger_entry_id: "lc_1",
          accounting_basis: CURRENT_ACCOUNTING_BASIS,
        }),
        // RULE-32: no accounting_basis key at all (evidenceLedgerEntry's own defaults
        // omit it entirely) normalizes to "unknown" on read.
        evidenceLedgerEntry({ ledger_entry_id: "lc_2" }),
      ]),
    );
    // lexicographic ascending: "agent-cost-raw-total/v2" < "unknown".
    expect(evidence.artifacts.ledger_summary.accounting_bases).toEqual([
      CURRENT_ACCOUNTING_BASIS,
      "unknown",
    ]);
    expect(evidence.artifacts.ledger_summary.accounting_basis_status).toBe("unqualified");
  });

  it('no summed (included_in_kpi) entries at all reports accounting_bases:[] and status:"unqualified"', () => {
    const evidence = buildLaneEvidence(
      laneEvidenceInput([evidenceLedgerEntry({ ledger_entry_id: "lc_1", included_in_kpi: false })]),
    );
    expect(evidence.artifacts.ledger_summary.accounting_bases).toEqual([]);
    expect(evidence.artifacts.ledger_summary.accounting_basis_status).toBe("unqualified");
  });
});
