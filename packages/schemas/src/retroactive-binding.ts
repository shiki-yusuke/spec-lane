import { z } from "zod";

// I-2026-11-09 cohort-aux-models-retroactive-bind (design 3) -- lane's own vocabulary for a
// `session_bound` / `task_run_started` trace event recorded *after* the intent was already
// done (`lane work start|bind --retroactive --reason <code>`). Kept out of trace.ts on
// purpose: that module mirrors the public trace/v1 contract and carries no
// spec-lane-specific enum. The trace contract leaves `payload` open, so these two keys ride
// in it; a pre-existing trace line simply has neither key and stays readable unchanged.
//
// A retroactive record is audit-only: the k-NN eligibility predicate always treats a
// session whose binding carries `retroactive: true` as ineligible (a self-reported late
// bind cannot prove membership or non-selection), even when its usage later matches.

/** Closed set -- an unlisted code is rejected by the CLI before anything is written. */
export const RETROACTIVE_REASON_CODES = ["missed_bind", "tooling_failure"] as const;
export const RetroactiveReasonCodeSchema = z.enum(RETROACTIVE_REASON_CODES);
export type RetroactiveReasonCode = z.infer<typeof RetroactiveReasonCodeSchema>;

/** The two payload keys a retroactive start/bind adds, alongside the relation's usual
 * payload keys (hence `.passthrough()`, not `.strict()`). */
export const RetroactivePayloadFieldsSchema = z
  .object({
    retroactive: z.literal(true),
    retroactive_reason_code: RetroactiveReasonCodeSchema,
  })
  .passthrough();
export type RetroactivePayloadFields = z.infer<typeof RetroactivePayloadFieldsSchema>;
