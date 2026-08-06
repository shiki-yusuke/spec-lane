import { describe, expect, it } from "vitest";
import {
  AGENT_METRICS_FORBIDDEN_PERSONAL_DIMENSION_KEYS,
  AgentMetricsGoodhartViolationError,
  assertNoAgentMetricsPersonalDimensions,
  scanAgentMetricsPersonalDimensions,
} from "../src/agent-metrics-goodhart.js";

// Exercises the scanner directly (raw objects, bypassing zod entirely) -- the actual
// backstop this scan exists for is a future optional field reopening the door around
// TokenUsagePayloadSchema's own `.strict()` (see metrics-service.test.ts's neighboring
// test for why today's every-object-is-strict case is caught by schema validation first).
describe("scanAgentMetricsPersonalDimensions / assertNoAgentMetricsPersonalDimensions", () => {
  it("covers exactly the protocol's own 11-key forbidden set (agent-metrics-v1.md section 7)", () => {
    expect([...AGENT_METRICS_FORBIDDEN_PERSONAL_DIMENSION_KEYS].sort()).toEqual(
      [
        "assignee",
        "author",
        "chat_id",
        "display_name",
        "email",
        "handle",
        "owner",
        "real_name",
        "reviewer",
        "user_id",
        "username",
      ].sort(),
    );
  });

  it("finds a top-level violation", () => {
    expect(scanAgentMetricsPersonalDimensions({ reviewer: "someone" })).toEqual(["reviewer"]);
  });

  it("finds a violation nested arbitrarily deep, including inside arrays", () => {
    const payload = { data: { records: [{ agent: "claude", handle: "@someone" }] } };
    expect(scanAgentMetricsPersonalDimensions(payload)).toEqual(["data.records[0].handle"]);
  });

  it("finds every one of the protocol's own 5 keys goodhart.ts's own 7-key list does not cover", () => {
    // These 5 (username/display_name/handle/chat_id/real_name) are the exact conformance
    // gap using core/goodhart.ts's smaller internal list here would have left open.
    for (const key of ["username", "display_name", "handle", "chat_id", "real_name"]) {
      expect(scanAgentMetricsPersonalDimensions({ [key]: "x" })).toEqual([key]);
    }
  });

  it("finds nothing in a clean payload", () => {
    expect(
      scanAgentMetricsPersonalDimensions({
        subject: { namespace: "spec-lane", type: "delivery-run", id: "I-x" },
        data: { records: [{ agent: "claude", model: "claude-sonnet-5" }] },
      }),
    ).toEqual([]);
  });

  it("assertNoAgentMetricsPersonalDimensions throws AgentMetricsGoodhartViolationError on any violation", () => {
    expect(() => assertNoAgentMetricsPersonalDimensions({ owner: "x" })).toThrow(
      AgentMetricsGoodhartViolationError,
    );
  });

  it("assertNoAgentMetricsPersonalDimensions does not throw for a clean payload", () => {
    expect(() => assertNoAgentMetricsPersonalDimensions({ agent: "claude" })).not.toThrow();
  });
});
