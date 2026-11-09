import type { AgentCostRow } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  deriveCohortIdentity,
  isAuxiliaryModel,
  normalizeModelIdentity,
} from "../src/model-cohort.js";

// docs/spec/I-2026-10-15-cohort-producer/spec.md D2/D3 -- TEST-09 (RULE-11, RULE-15).

function row(agent: string | null, model: string | null, tokens: number): AgentCostRow {
  return {
    month: null,
    // Cast at the type level only: the zod enum rejects other agents at the adapter, but
    // the detail templates must stay total over any value (spec D3).
    agent: agent as AgentCostRow["agent"],
    model,
    token_kind: "output",
    tokens,
    priced_tokens: tokens,
    unpriced_tokens: 0,
    estimated_cost_usd: tokens / 1000,
    credits: 0,
    pricing_status: "priced",
  };
}

const CLAUDE_KEYS: readonly [string, string][] = [
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
];

const CODEX_KEYS: readonly [string, string][] = [
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
];

describe("normalizeModelIdentity -- the closed table (TEST-09, RULE-11/RULE-15)", () => {
  it.each(CLAUDE_KEYS)("claude/%s -> anthropic %s, model_id verbatim", (key, generation) => {
    expect(normalizeModelIdentity("claude", key)).toEqual({
      agent_type: "claude",
      model_provider: "anthropic",
      model_generation: generation,
      model_id: key,
    });
  });

  it.each(CODEX_KEYS)("codex/%s -> openai %s, model_id verbatim", (key, generation) => {
    expect(normalizeModelIdentity("codex", key)).toEqual({
      agent_type: "codex",
      model_provider: "openai",
      model_generation: generation,
      model_id: key,
    });
  });

  it("rejects a null model and a null agent", () => {
    expect(normalizeModelIdentity("claude", null)).toBeNull();
    expect(normalizeModelIdentity(null, "claude-sonnet-5-5")).toBeNull();
    expect(normalizeModelIdentity(null, null)).toBeNull();
  });

  it("rejects a key listed only under the other agent", () => {
    expect(normalizeModelIdentity("codex", "claude-sonnet-5-5")).toBeNull();
    expect(normalizeModelIdentity("claude", "gpt-5.6-terra")).toBeNull();
  });

  it("rejects unlisted keys, including ones that look like listed families", () => {
    for (const key of ["gpt-999-x", "gpt-image-2", "gpt-image-2-mini"]) {
      expect(normalizeModelIdentity("codex", key)).toBeNull();
    }
    for (const key of ["claude-opus-5-6", "claude-sonnet-5-5-20261001", "CLAUDE-SONNET-5-5"]) {
      expect(normalizeModelIdentity("claude", key)).toBeNull();
    }
  });

  it("rejects an out-of-enum agent even with a listed key", () => {
    expect(normalizeModelIdentity("gemini", "claude-sonnet-5-5")).toBeNull();
  });
});

describe("deriveCohortIdentity -- single-identity rule and detail templates (TEST-09, D3)", () => {
  it("resolves exactly one known pair, across several rows of it", () => {
    const result = deriveCohortIdentity([
      row("claude", "claude-sonnet-5-5", 100),
      row("claude", "claude-sonnet-5-5", 50),
    ]);
    expect(result).toEqual({
      resolved: true,
      identity: {
        agent_type: "claude",
        model_provider: "anthropic",
        model_generation: "claude-5",
        model_id: "claude-sonnet-5-5",
      },
    });
  });

  it("mixed known pairs -> sorted mixed detail", () => {
    const result = deriveCohortIdentity([
      row("codex", "gpt-5.6-terra", 10),
      row("claude", "claude-sonnet-5-5", 100),
      row("claude", "claude-opus-5-5", 1),
    ]);
    expect(result).toEqual({
      resolved: false,
      reason: "MIXED_OR_UNATTRIBUTED_USAGE",
      detail:
        "cohort_identity: mixed rows: claude/claude-opus-5-5, claude/claude-sonnet-5-5, codex/gpt-5.6-terra",
    });
  });

  it("mixed with unknown pairs counts them instead of naming them", () => {
    const result = deriveCohortIdentity([
      row("claude", "claude-sonnet-5-5", 100),
      row("claude", "llama-3-70b", 1),
      row(null, "secret-model-name", 1),
    ]);
    expect(result).toMatchObject({
      resolved: false,
      detail: "cohort_identity: mixed rows: claude/claude-sonnet-5-5, +2 unknown",
    });
  });

  it("mixed with no known pair at all", () => {
    const result = deriveCohortIdentity([row("claude", "x-1", 1), row("codex", "x-2", 1)]);
    expect(result).toMatchObject({ detail: "cohort_identity: mixed rows: +2 unknown" });
  });

  it.each([
    ["claude", "unknown model (agent claude)"],
    ["codex", "unknown model (agent codex)"],
    [null, "unknown model (agent null)"],
    ["gemini", "unknown model (agent other)"],
  ] as const)("single unknown pair with agent %s", (agent, suffix) => {
    const result = deriveCohortIdentity([row(agent, "llama-3-70b", 10)]);
    expect(result).toMatchObject({ resolved: false, detail: `cohort_identity: ${suffix}` });
  });

  it("no row with tokens -> no priced rows", () => {
    expect(deriveCohortIdentity([])).toMatchObject({
      resolved: false,
      detail: "cohort_identity: no priced rows",
    });
    expect(deriveCohortIdentity([row("claude", "claude-sonnet-5-5", 0)])).toMatchObject({
      resolved: false,
      detail: "cohort_identity: no priced rows",
    });
  });

  it("zero-token rows do not count toward the identity", () => {
    const result = deriveCohortIdentity([
      row("claude", "claude-sonnet-5-5", 100),
      row("codex", "gpt-5.6", 0),
      row("claude", "llama-3-70b", 0),
    ]);
    expect(result.resolved).toBe(true);
  });

  it("RULE-39: no raw model or agent string ever reaches a detail line", () => {
    const rawModel = "raw-model-payload-<script>";
    const rawAgent = "raw-agent-payload";
    const cases: AgentCostRow[][] = [
      [row("claude", rawModel, 1)],
      [row(rawAgent, "claude-sonnet-5-5", 1)],
      [row(rawAgent, rawModel, 1)],
      [row("claude", rawModel, 1), row("claude", "claude-sonnet-5-5", 1)],
      [row(rawAgent, rawModel, 1), row("codex", rawModel, 1)],
    ];
    for (const rows of cases) {
      const result = deriveCohortIdentity(rows);
      expect(result.resolved).toBe(false);
      if (result.resolved) continue;
      expect(result.detail).not.toContain(rawModel);
      expect(result.detail).not.toContain(rawAgent);
      expect(result.detail).toMatch(/^cohort_identity: /);
    }
  });
});

describe("gpt-6.1 allowlist entries -- exact match only (I-2026-11-09 design 1)", () => {
  it("rejects gpt-6.1 near-misses: an unlisted sibling, a suffix, and case differences", () => {
    for (const key of ["gpt-6.1-luna", "gpt-6.1-terra-preview", "GPT-6.1-TERRA", "gpt-6.1-Sol"]) {
      expect(normalizeModelIdentity("codex", key)).toBeNull();
    }
  });

  it("rejects gpt-6.1-terra / gpt-6.1-sol under agent=claude", () => {
    expect(normalizeModelIdentity("claude", "gpt-6.1-terra")).toBeNull();
    expect(normalizeModelIdentity("claude", "gpt-6.1-sol")).toBeNull();
  });
});

describe("auxiliary model rows (I-2026-11-09 design 2, option B)", () => {
  it("isAuxiliaryModel matches only the exact (codex, codex-auto-review) pair", () => {
    expect(isAuxiliaryModel("codex", "codex-auto-review")).toBe(true);
    expect(isAuxiliaryModel("claude", "codex-auto-review")).toBe(false);
    expect(isAuxiliaryModel(null, "codex-auto-review")).toBe(false);
    expect(isAuxiliaryModel("codex", "codex-auto-review-x")).toBe(false);
    expect(isAuxiliaryModel("codex", "Codex-Auto-Review")).toBe(false);
    expect(isAuxiliaryModel("codex", null)).toBe(false);
  });

  it("primary + auxiliary rows resolve to the primary identity", () => {
    const result = deriveCohortIdentity([
      row("codex", "gpt-6.1-terra", 90_000),
      row("codex", "codex-auto-review", 10_000),
    ]);
    expect(result).toEqual({
      resolved: true,
      identity: {
        agent_type: "codex",
        model_provider: "openai",
        model_generation: "gpt-6",
        model_id: "gpt-6.1-terra",
      },
    });
  });

  it("review fix 3: share-independent -- primary 1% / auxiliary 99% still resolves to the primary identity", () => {
    const expected = {
      resolved: true,
      identity: {
        agent_type: "codex",
        model_provider: "openai",
        model_generation: "gpt-6",
        model_id: "gpt-6.1-terra",
      },
    };
    expect(
      deriveCohortIdentity([
        row("codex", "gpt-6.1-terra", 1_000),
        row("codex", "codex-auto-review", 99_000),
      ]),
    ).toEqual(expected);
    // row order does not matter either (auxiliary row first)
    expect(
      deriveCohortIdentity([
        row("codex", "codex-auto-review", 99_000),
        row("codex", "gpt-6.1-terra", 1_000),
      ]),
    ).toEqual(expected);
  });

  it("auxiliary rows only -> ineligible with the fixed 'auxiliary rows only' detail", () => {
    expect(deriveCohortIdentity([row("codex", "codex-auto-review", 10_000)])).toEqual({
      resolved: false,
      reason: "MIXED_OR_UNATTRIBUTED_USAGE",
      detail: "cohort_identity: auxiliary rows only",
    });
  });

  it("a zero-token auxiliary row alone is still 'no priced rows'", () => {
    const result = deriveCohortIdentity([row("codex", "codex-auto-review", 0)]);
    expect(result.resolved).toBe(false);
    if (!result.resolved) expect(result.detail).toBe("cohort_identity: no priced rows");
  });

  it("two primary models + auxiliary stays mixed and never names the auxiliary row", () => {
    const result = deriveCohortIdentity([
      row("codex", "gpt-6.1-terra", 50_000),
      row("codex", "gpt-6.1-sol", 40_000),
      row("codex", "codex-auto-review", 10_000),
    ]);
    expect(result).toEqual({
      resolved: false,
      reason: "MIXED_OR_UNATTRIBUTED_USAGE",
      detail: "cohort_identity: mixed rows: codex/gpt-6.1-sol, codex/gpt-6.1-terra",
    });
  });

  it("near-miss auxiliary names are primary rows, so they make the measurement mixed", () => {
    for (const [agent, model] of [
      ["codex", "codex-auto-review-x"],
      ["codex", "CODEX-AUTO-REVIEW"],
      ["claude", "codex-auto-review"],
    ] as const) {
      const result = deriveCohortIdentity([
        row("codex", "gpt-6.1-terra", 90_000),
        row(agent, model, 10_000),
      ]);
      expect(result).toEqual({
        resolved: false,
        reason: "MIXED_OR_UNATTRIBUTED_USAGE",
        detail: "cohort_identity: mixed rows: codex/gpt-6.1-terra, +1 unknown",
      });
    }
  });
});
