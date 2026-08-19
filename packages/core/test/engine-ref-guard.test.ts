import type { EngineRef } from "@lane/schemas";
import { describe, expect, it } from "vitest";
import { checkEngineRefFormats } from "../src/engine-ref-guard.js";

// I-2026-08-18-design-critic-injection R43/R44/R44a. Gherkin: "an address-shaped human
// reference is rejected" / "an opaque reference passes even if it could denote a person".

describe("checkEngineRefFormats (R43/R44/R44a)", () => {
  it("rejects an email-address-shaped human_ref (R43)", () => {
    const ref: EngineRef = { kind: "human", human_ref: "reviewer@example.com", is_decision_maker: false };
    const violations = checkEngineRefFormats(ref, "critic_reviews[0].critic");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("critic_reviews[0].critic.human_ref");
    expect(violations[0]?.message).toMatch(/email_address/);
  });

  it("rejects an @handle-shaped human_ref", () => {
    const ref: EngineRef = { kind: "human", human_ref: "@shiki-yusuke", is_decision_maker: false };
    expect(checkEngineRefFormats(ref, "x")).toHaveLength(1);
  });

  it("passes an opaque human_ref even though it could denote a person (R44a: format check, not identity detection)", () => {
    const ref: EngineRef = {
      kind: "human",
      human_ref: "independent-review-session",
      is_decision_maker: false,
    };
    expect(checkEngineRefFormats(ref, "x")).toEqual([]);
  });

  it("rejects a JWT-shaped session_ref (R44)", () => {
    const ref: EngineRef = {
      kind: "model",
      provider: "openai",
      session_ref: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123signature",
    };
    const violations = checkEngineRefFormats(ref, "artifact_shapers[0].engine_ref");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("artifact_shapers[0].engine_ref.session_ref");
  });

  it("rejects a Bearer-authorization-header-shaped session_ref", () => {
    const ref: EngineRef = { kind: "model", provider: "openai", session_ref: "Bearer sk-abc123" };
    expect(checkEngineRefFormats(ref, "x").length).toBeGreaterThan(0);
  });

  it("passes an opaque run-id-shaped session_ref", () => {
    const ref: EngineRef = { kind: "model", provider: "anthropic", session_ref: "run-2026-08-19-001" };
    expect(checkEngineRefFormats(ref, "x")).toEqual([]);
  });
});
