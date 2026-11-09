import type { AgentCostRow } from "@lane/schemas";

// I-2026-10-15-cohort-producer (D2/RULE-11/RULE-15) -- the closed (agent, model) ->
// cohort-identity table calibrate uses to decide which estimate/v2 cohort an observation
// was measured under. Vendored from agent-cost 0.3.x rates.json's `model_key` set
// (agent-cost rows already carry the canonical key, facts.normalize_model_key). Explicit
// allowlist only: no pattern matching, no inference from naming -- a model key that is not
// listed here is unknown, and its observations stay k-NN ineligible until a lane release
// adds the entry (fail-closed, intent constraint 2). gpt-image-2* are deliberately absent:
// image models never carry lane coding cost.

export interface CohortIdentity {
  agent_type: "claude" | "codex";
  model_provider: "anthropic" | "openai";
  model_generation: string;
  model_id: string;
}

const CLAUDE_MODEL_GENERATIONS: ReadonlyMap<string, string> = new Map([
  ["claude-fable-5", "claude-5"],
  ["claude-fable-5-1", "claude-5"],
  ["claude-mythos-5", "claude-5"],
  ["claude-opus-4-6", "claude-4"],
  ["claude-opus-4-7", "claude-4"],
  ["claude-opus-4-8", "claude-4"],
  ["claude-opus-5", "claude-5"],
  ["claude-opus-5-5", "claude-5"],
  ["claude-sonnet-4-6", "claude-4"],
  ["claude-sonnet-5", "claude-5"],
  ["claude-sonnet-5-5", "claude-5"],
  ["claude-haiku-4-5", "claude-4"],
  ["claude-haiku-5-5", "claude-5"],
]);

const CODEX_MODEL_GENERATIONS: ReadonlyMap<string, string> = new Map([
  ["gpt-5.2", "gpt-5"],
  ["gpt-5.2-codex", "gpt-5"],
  ["gpt-5.3-codex", "gpt-5"],
  ["gpt-5.4", "gpt-5"],
  ["gpt-5.4-mini", "gpt-5"],
  ["gpt-5.5", "gpt-5"],
  ["gpt-5.5-cyber", "gpt-5"],
  ["gpt-5.6-sol", "gpt-5"],
  ["gpt-5.6-terra", "gpt-5"],
  ["gpt-5.6-luna", "gpt-5"],
  ["gpt-6-astra", "gpt-6"],
  ["gpt-6.1-terra", "gpt-6"],
  ["gpt-6.1-sol", "gpt-6"],
]);

// I-2026-11-09 (design 2, option B) -- the closed table of *auxiliary* (agent, model)
// pairs: rows a primary session spends on a helper model (e.g. Codex's built-in auto
// review) that must not by themselves turn an otherwise single-identity measurement into
// "mixed". Exact (agent, model) match only -- no prefix, no case folding, no inference; a
// near-miss name stays a primary row. These rows are excluded from the identity decision
// ONLY: the observation's actual tokens/cost (calibrate-service's totals) still include
// them. Every addition here is a reviewed contract change (it moves helper-model spend
// into the primary model's cohort).
const AUXILIARY_MODEL_PAIRS: readonly { agent: string; model: string }[] = [
  { agent: "codex", model: "codex-auto-review" },
];

/** True only for an exact (agent, model) pair listed in AUXILIARY_MODEL_PAIRS. */
export function isAuxiliaryModel(agent: string | null, model: string | null): boolean {
  return AUXILIARY_MODEL_PAIRS.some((pair) => pair.agent === agent && pair.model === model);
}

/**
 * D2 -- looks `(agent, model)` up in the closed table above. Returns the cohort identity
 * (`model_id` is the key verbatim) or `null` for anything not listed: a null agent or
 * model, a key listed only under the other agent, or any unlisted key.
 */
export function normalizeModelIdentity(
  agent: string | null,
  model: string | null,
): CohortIdentity | null {
  if (model === null) return null;
  if (agent === "claude") {
    const generation = CLAUDE_MODEL_GENERATIONS.get(model);
    if (generation === undefined) return null;
    return {
      agent_type: "claude",
      model_provider: "anthropic",
      model_generation: generation,
      model_id: model,
    };
  }
  if (agent === "codex") {
    const generation = CODEX_MODEL_GENERATIONS.get(model);
    if (generation === undefined) return null;
    return {
      agent_type: "codex",
      model_provider: "openai",
      model_generation: generation,
      model_id: model,
    };
  }
  return null;
}

export type CohortIdentityResult =
  | { resolved: true; identity: CohortIdentity }
  | { resolved: false; reason: "MIXED_OR_UNATTRIBUTED_USAGE"; detail: string };

/** RULE-39 vocabulary -- the only agent text a detail line may carry. */
function agentPlaceholder(agent: string | null): "claude" | "codex" | "null" | "other" {
  if (agent === "claude" || agent === "codex") return agent;
  if (agent === null) return "null";
  return "other";
}

/**
 * D1/D3 (D-S2a) -- the single-identity rule. Only rows with `tokens > 0` count, and of
 * those only *primary* rows (not an exact auxiliary pair, see AUXILIARY_MODEL_PAIRS); the
 * identity resolves only when the primary rows carry exactly one distinct `(agent, model)`
 * pair and that pair is in the table. Auxiliary rows alone (no primary row) are
 * ineligible. Anything else is an explicit ineligibility with one
 * fixed-template detail line: never a dominant model picked by token share, never a
 * per-session split. Detail lines interpolate only allowlisted model keys, the literals
 * claude / codex / null / other, and integers -- a raw payload string never appears.
 */
export function deriveCohortIdentity(rows: readonly AgentCostRow[]): CohortIdentityResult {
  const pairs = new Map<string, { agent: string | null; model: string | null }>();
  let auxiliaryRows = 0;
  for (const row of rows) {
    if (!(row.tokens > 0)) continue;
    const agent: string | null = row.agent;
    if (isAuxiliaryModel(agent, row.model)) {
      auxiliaryRows += 1;
      continue;
    }
    pairs.set(JSON.stringify([agent, row.model]), { agent, model: row.model });
  }

  const ineligible = (detail: string): CohortIdentityResult => ({
    resolved: false,
    reason: "MIXED_OR_UNATTRIBUTED_USAGE",
    detail,
  });

  if (pairs.size === 0) {
    return ineligible(
      auxiliaryRows > 0
        ? "cohort_identity: auxiliary rows only"
        : "cohort_identity: no priced rows",
    );
  }

  const known: CohortIdentity[] = [];
  const unknownAgents: (string | null)[] = [];
  for (const pair of pairs.values()) {
    const identity = normalizeModelIdentity(pair.agent, pair.model);
    if (identity === null) {
      unknownAgents.push(pair.agent);
    } else {
      known.push(identity);
    }
  }

  if (pairs.size === 1) {
    const identity = known[0];
    if (identity !== undefined) return { resolved: true, identity };
    return ineligible(
      `cohort_identity: unknown model (agent ${agentPlaceholder(unknownAgents[0] ?? null)})`,
    );
  }

  const labels = known.map((identity) => `${identity.agent_type}/${identity.model_id}`).sort();
  const parts = unknownAgents.length > 0 ? [...labels, `+${unknownAgents.length} unknown`] : labels;
  return ineligible(`cohort_identity: mixed rows: ${parts.join(", ")}`);
}
