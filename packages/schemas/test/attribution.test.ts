import { describe, expect, it } from "vitest";
import { BindingRecordSchema } from "../src/attribution.js";

// cohort-3 measurement fix (2026-08-29) -- BindingRecordSchema became a discriminated
// union (attribution/v1 | attribution/v2) so that requested_model/requested_reasoning_effort/
// capture_status can be recorded on every new binding going forward, without breaking any
// already-existing attribution/v1 data. attribution/v1's own vendored-fixture parity is
// covered separately (packages/core/test/attribution-fixtures.test.ts); these tests cover
// the union shape itself: v1 still accepted as-is, v2 accepted with its extra required
// (nullable) fields, and the cross-cutting manual_bind/actor rule enforced on both.

const V1_BASE = {
  schema_version: "attribution/v1" as const,
  task_run_id: "twr-1",
  lane_id: "I-2026-08-29-attr-v2",
  intent_id: "I-2026-08-29-attr-v2",
  agent: "claude" as const,
  binding_method: "pre_assigned_session_id" as const,
  session_id: "s1",
  bound_at: "2026-08-29T00:00:00Z",
  binding_status: "bound" as const,
};

const V2_BASE = {
  ...V1_BASE,
  schema_version: "attribution/v2" as const,
  requested_model: "claude-sonnet-5",
  requested_reasoning_effort: "high",
  capture_status: "captured" as const,
};

describe("BindingRecordSchema (attribution/v1 | attribution/v2 union)", () => {
  it("accepts a well-formed attribution/v1 record exactly as before (no new fields required)", () => {
    const result = BindingRecordSchema.safeParse(V1_BASE);
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it("rejects an attribution/v1 record carrying v2-only fields (v1 is still .strict())", () => {
    const result = BindingRecordSchema.safeParse({ ...V1_BASE, capture_status: "captured" });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed attribution/v2 record with all three capture fields", () => {
    const result = BindingRecordSchema.safeParse(V2_BASE);
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it("accepts attribution/v2 with both requested_model/requested_reasoning_effort null (capture_status=absent)", () => {
    const result = BindingRecordSchema.safeParse({
      ...V2_BASE,
      requested_model: null,
      requested_reasoning_effort: null,
      capture_status: "absent",
    });
    expect(result.success).toBe(true);
  });

  it("accepts capture_status='captured' with both values non-null", () => {
    const result = BindingRecordSchema.safeParse({ ...V2_BASE, capture_status: "captured" });
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it.each(["absent", "unsupported_syntax", "ambiguous"] as const)(
    "accepts capture_status=%s with both values null (must-2 invariant: non-captured requires at least one null)",
    (capture_status) => {
      const result = BindingRecordSchema.safeParse({
        ...V2_BASE,
        capture_status,
        requested_model: null,
        requested_reasoning_effort: null,
      });
      expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
    },
  );

  it("rejects attribution/v2 missing capture_status (required, not optional)", () => {
    const { capture_status, ...withoutCaptureStatus } = V2_BASE;
    const result = BindingRecordSchema.safeParse(withoutCaptureStatus);
    expect(result.success).toBe(false);
  });

  it("rejects attribution/v2 with requested_model as an empty string (min(1), same as other string fields)", () => {
    const result = BindingRecordSchema.safeParse({ ...V2_BASE, requested_model: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized schema_version entirely", () => {
    const result = BindingRecordSchema.safeParse({ ...V1_BASE, schema_version: "attribution/v3" });
    expect(result.success).toBe(false);
  });

  // sol review (2026-08-29, must 2): capture_status and the two nullable values must
  // agree -- a corrupted/hand-edited record cannot claim one thing on capture_status while
  // the actual values say another.
  describe("capture_status <=> value nullability invariant (must 2)", () => {
    it("rejects capture_status='captured' with both values null", () => {
      const result = BindingRecordSchema.safeParse({
        ...V2_BASE,
        capture_status: "captured",
        requested_model: null,
        requested_reasoning_effort: null,
      });
      expect(result.success).toBe(false);
    });

    it("rejects capture_status='captured' with only requested_model non-null", () => {
      const result = BindingRecordSchema.safeParse({
        ...V2_BASE,
        capture_status: "captured",
        requested_reasoning_effort: null,
      });
      expect(result.success).toBe(false);
    });

    it("rejects capture_status='absent' with both values non-null", () => {
      const result = BindingRecordSchema.safeParse({ ...V2_BASE, capture_status: "absent" });
      expect(result.success).toBe(false);
    });

    it("rejects capture_status='ambiguous' with both values non-null", () => {
      const result = BindingRecordSchema.safeParse({ ...V2_BASE, capture_status: "ambiguous" });
      expect(result.success).toBe(false);
    });

    it("rejects capture_status='unsupported_syntax' with both values non-null", () => {
      const result = BindingRecordSchema.safeParse({
        ...V2_BASE,
        capture_status: "unsupported_syntax",
      });
      expect(result.success).toBe(false);
    });

    it("accepts capture_status='absent' with exactly one value non-null (one field genuinely captured, the other not)", () => {
      const result = BindingRecordSchema.safeParse({
        ...V2_BASE,
        capture_status: "absent",
        requested_reasoning_effort: null,
      });
      expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
    });
  });

  it("enforces manual_bind_requires_human_actor on a v1 record", () => {
    const result = BindingRecordSchema.safeParse({
      ...V1_BASE,
      binding_method: "manual_bind",
      actor: { kind: "cli", id: "lane" },
    });
    expect(result.success).toBe(false);
  });

  it("enforces manual_bind_requires_human_actor on a v2 record", () => {
    const result = BindingRecordSchema.safeParse({
      ...V2_BASE,
      binding_method: "manual_bind",
      actor: { kind: "cli", id: "lane" },
      requested_model: null,
      requested_reasoning_effort: null,
      capture_status: "absent",
    });
    expect(result.success).toBe(false);
  });

  it("accepts manual_bind on a v2 record when actor.kind is human", () => {
    const result = BindingRecordSchema.safeParse({
      ...V2_BASE,
      binding_method: "manual_bind",
      actor: { kind: "human" },
      requested_model: null,
      requested_reasoning_effort: null,
      capture_status: "absent",
    });
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });
});
