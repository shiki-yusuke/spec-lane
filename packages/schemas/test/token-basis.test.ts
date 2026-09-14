import { describe, expect, it } from "vitest";
import {
  CURRENT_ACCOUNTING_BASIS,
  TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1,
  TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V2,
} from "../src/token-basis.js";

// I-2026-09-10-agent-cost-v2-basis-gate — RULE-30/D2/D3 (sol must-1). "One literal, two
// names": CURRENT_ACCOUNTING_BASIS is an alias of the v2 literal, and the v1 literal
// stays exported (read-only, for records already on disk) but at a genuinely different
// value, so the two can never be mistaken for each other by a caller comparing strings.
describe("token-basis — RULE-30/D2 (D3 withdrawal/replacement)", () => {
  it("RULE-30 (spec.md:384-389): CURRENT_ACCOUNTING_BASIS is exactly the v2 literal", () => {
    expect(CURRENT_ACCOUNTING_BASIS).toBe("agent-cost-raw-total/v2");
    expect(CURRENT_ACCOUNTING_BASIS).toBe(TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V2);
  });

  it("D2 (spec.md:100-104): the v1 literal is exported and is a distinct value from v2/current", () => {
    expect(TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1).toBe("agent-cost-raw-total/v1");
    expect(TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1).not.toBe(TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V2);
    expect(TOKEN_BASIS_AGENT_COST_RAW_TOTAL_V1).not.toBe(CURRENT_ACCOUNTING_BASIS);
  });
});
