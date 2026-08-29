import { z } from "zod";
import { RiskLevelSchema } from "./common.js";

// design.md does not list `profile` among the 7 named schemas (§2), but §3.4/§3.5/§3.7
// all type project profile fields (risk_auto_upgrade rules, distance_caps, extra_lenses,
// required_commands, ...) that are consumed by both packages/core (gate.ts, risk.ts,
// estimator.ts, profile.ts) and buildCriticSchema() in critic.ts. Per the fixed dependency
// direction (schemas -> none, core -> schemas) this type has to live in schemas so core can
// import it without schemas depending back on core. Placed here as an explicit addition;
// flagged to the team for confirmation since design.md left the location unstated (§12).

// design.md §3.4 — replaces the Python reference implementation's flat 3-bucket `risk_auto_upgrade: {high:[],...}`
// with an auditable rule array.
export const RiskUpgradeRuleSchema = z.object({
  id: z.string(),
  when: z
    .object({
      layers: z.array(z.string()).optional(),
      paths: z.array(z.string()).optional(),
    })
    .default({}),
  upgrade_to: RiskLevelSchema,
  reason: z.string(),
});
export type RiskUpgradeRule = z.infer<typeof RiskUpgradeRuleSchema>;

const IsomorphismRulesSchema = z.object({
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  enforced_in: z.array(z.string()).default([]),
});

// NOTE: nothing in this repo ever executes these. They are declarative documentation of the
// commands a project expects a human/agent to run at each phase; `grep -rn required_commands
// packages/*/src` finds only this definition. Do not confuse them with
// ExternalVerifySchema below, which authorizes a command lane actually spawns
// (I-2026-08-29-external-verify-gate, spec.md L4).
const RequiredCommandsSchema = z.object({
  pre_implement: z.array(z.string()).default([]),
  during_implement: z.array(z.string()).default([]),
  pre_pr: z.array(z.string()).default([]),
  post_implement: z.array(z.string()).default([]),
});

// I-2026-08-29-external-verify-gate — the operator-side authorization half of the two-key
// design (spec.md D1, key 2). intent.yaml declares WHAT command a lane wants run; this says
// whether that exact command may run at all. Authorization is by digest over the WHOLE
// command (argv + timeout, core/external-verify.ts's computeExternalVerifyDigest), never by
// executable name alone: an `argv[0]`-only allow-list would authorize every possible argument
// list for an authorized interpreter, so allowing `/usr/bin/node` once would allow
// `node -e "<anything>"` forever (architect review 9-2).
//
// CRITICAL: `.optional()` with NO `.default()`, and the shipped profile must not carry the key
// either. `effective_risk_log[].profile_digest` is `computeDigest(JSON.stringify(profile))`
// (core/src/risk.ts) computed over the *parsed* profile -- a `.default({})` here would
// materialize this key on every profile ever parsed and change that digest for every existing
// lane, breaking the "configuring nothing changes nothing" invariant this feature must
// preserve (architect review 9-4; regression-tested by TEST-32/33).
const ExternalVerifySchema = z.object({
  allowed_command_digests: z.array(z.string().min(1)).optional(),
});

const TestCoverageFloorSchema = z.object({
  unit_test_per_ears_rule_minimum: z.number().int().nonnegative().default(1),
});

// design.md §3.5/§12.1 — log1p normalization caps for the Gower-style neighbor distance.
// Defaults below are the M1 implementation-time defaults called out as an open item in
// §12.1; they are not derived from any real calibration data and should be revisited once
// real calibration observations exist.
const DistanceCapsSchema = z
  .object({
    files_touched_estimate: z.number().positive().default(50),
    layers_crossed: z.number().positive().default(10),
    spec_rule_count: z.number().positive().default(30),
  })
  .default({});

// M0 spec-lane 0.5.0 — estimate/v2's cohort identity for THIS repo/profile (M0 spec §6).
// Deliberately optional and with no defaults of any kind: a missing field here is never
// silently defaulted or "assumed to match" -- core/estimator-v2.ts treats an unconfigured
// cohort as a hard prerequisite gap (the operator has not yet declared what cohort this
// profile's estimates belong to), never as license to fabricate one. `measure_contract_version`
// and `token_basis` are NOT configured here -- both are real, already-fixed facts about
// this codebase (agent-cost's own protocol_version constant, token-basis.ts's constant),
// not per-deployment operator choices, so core/estimator-v2.ts fills them in itself.
const EstimateCohortConfigSchema = z
  .object({
    agent_type: z.string().min(1),
    model_provider: z.string().min(1),
    model_generation: z.string().min(1),
    model_id: z.string().min(1),
    routing_policy_digest: z.string().regex(/^[0-9a-f]{64}$/),
    prompt_policy_digest: z.string().regex(/^[0-9a-f]{64}$/),
    execution_profile_digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .optional();
export type EstimateCohortConfig = z.infer<typeof EstimateCohortConfigSchema>;

// `.optional()`, deliberately not `.default({})`: a `ZodDefault`-wrapped field's *output*
// TS type still requires the key (only its *input* type treats it as omittable) -- every
// existing `Profile` object literal in this codebase (test fixtures, mainly) would then
// need `estimate: {}` added for no behavioral reason, and a pre-0.5.0 profile.yaml with no
// `estimate:` key at all must keep parsing exactly as it always did. `.optional()` gives
// the same runtime result every consumer here already handles (`profile.estimate?.cohort`,
// core/estimator-v2.ts) while actually making the key optional at the type level too.
const EstimateConfigSchema = z
  .object({
    cohort: EstimateCohortConfigSchema,
  })
  .optional();

export const ProfileSchema = z.object({
  schema_version: z.string(),
  profile_id: z.string(),
  applies_to_repo: z.string().default(""),
  existing_ssot: z.record(z.string(), z.string()).default({}),
  // buildCriticSchema() (critic.ts) allows CORE_9_LENSES plus at most the first 3 entries
  // here; the cap is enforced there, not in this schema, so a profile can carry more than
  // 3 candidates without failing validation.
  extra_lenses: z.array(z.string()).default([]),
  layer_ownership: z.record(z.string(), z.array(z.string())).default({}),
  risk_auto_upgrade: z.array(RiskUpgradeRuleSchema).default([]),
  required_commands: RequiredCommandsSchema.default({}),
  forbidden_paths_for_low_risk: z.array(z.string()).default([]),
  isomorphism_rules: IsomorphismRulesSchema.default({}),
  test_coverage_floor: TestCoverageFloorSchema.default({}),
  distance_caps: DistanceCapsSchema,
  estimate: EstimateConfigSchema,
  // I-2026-08-18-design-critic-injection R33 — "Where the profile forbids the override, the
  // system SHALL block instead of accepting it." Defaults to false (the pilot is opt-in via
  // `--design`; a profile that never mentions this key must not silently gain a new
  // blocking behavior).
  design_override_forbidden: z.boolean().default(false),
  // See ExternalVerifySchema: `.optional()`, never `.default()` -- materializing this key on
  // every parsed profile would change every existing lane's recorded profile_digest.
  external_verify: ExternalVerifySchema.optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;
