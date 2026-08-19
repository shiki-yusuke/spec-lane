import { z } from "zod";
import { Iso8601Schema } from "./common.js";

// I-2026-08-18-design-critic-injection R6/R7 — the companion artifact this lane owns.
// `artifact_shapers[]` and `critic_reviews[]` already live inside the upstream-conforming
// design-options/v1 document itself (design-options.ts) -- R6 forbids adding fields to
// that document, so everything lane-specific (the override record R30/R31, and the
// decision record R35/R36) lives here instead, versioned independently
// (`design-critic-attestation/v0`) from the upstream contract.
//
// R7: since design-options/v1 gives no per-review identifier, every reference this
// artifact makes back into that document binds to BOTH a location (design_options_id +
// which option_ids) AND the document's own content digest (DesignOptionsRefSchema) -- a
// later revision at the same design_options_id is a different content_digest, so a
// reference recorded against an old revision cannot silently be read as still applying to
// a new one (R41).
//
// R17: the derived independence classification has NO field anywhere in this schema (or in
// design-options.ts, or in lane-state.ts) -- `.strict()` on every object here means an
// producer-written extra key (e.g. a smuggled `independence_status`) is rejected by parsing
// alone, not just "not read." It is computed fresh at validate/display time by
// core/design-independence.ts and never written back.

const ContentDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const DesignOptionsRefSchema = z
  .object({
    design_options_id: z.string().min(1),
    content_digest: ContentDigestSchema,
  })
  .strict();
export type DesignOptionsRef = z.infer<typeof DesignOptionsRefSchema>;

// R30/R31 — the override is its own operation record, never a field an authoring agent can
// set inside an artifact it also writes. `scope` binds it to one specific revision plus the
// options that were uncovered at override time; `selected_option_id` is populated only when
// the override is being used at the implement gate (R31: "and -- at the implementation
// gate -- the selected option").
export const DesignOverrideSchema = z
  .object({
    reason: z.string().min(1),
    actor: z.string().min(1),
    overridden_at: Iso8601Schema,
    policy_basis: z.string().min(1),
    scope: z
      .object({
        design_options_ref: DesignOptionsRefSchema,
        uncovered_option_ids: z.array(z.string().min(1)).min(1),
        selected_option_id: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
export type DesignOverride = z.infer<typeof DesignOverrideSchema>;

// R35/R36 — the decision record. Bound to one design_options_ref the same way an override
// is; a decision recorded against a revision that is no longer the active pointer is
// treated as stale (R41: establishment/decisions do not carry forward across a pointer
// move) rather than being read as if it still applied to the new revision.
export const DesignDecisionSchema = z
  .object({
    design_options_ref: DesignOptionsRefSchema,
    selected_option_id: z.string().min(1),
    recorded_at: Iso8601Schema,
    recorded_by: z.string().min(1),
  })
  .strict();
export type DesignDecision = z.infer<typeof DesignDecisionSchema>;

export const DesignCriticAttestationSchema = z
  .object({
    schema_version: z.literal("design-critic-attestation/v0"),
    intent_id: z.string().min(1),
    overrides: z.array(DesignOverrideSchema).default([]),
    decision: DesignDecisionSchema.nullable().default(null),
  })
  .strict();
export type DesignCriticAttestation = z.infer<typeof DesignCriticAttestationSchema>;

export function emptyDesignCriticAttestation(intentId: string): DesignCriticAttestation {
  return {
    schema_version: "design-critic-attestation/v0",
    intent_id: intentId,
    overrides: [],
    decision: null,
  };
}
