import { z } from "zod";
import { PHASE_ORDER } from "./phase.js";
import { KnowledgeTaxonomySchema } from "./taxonomy.js";

// design.md §3.6 (合意 §B3) — rework classification recorded on a lane's done overlay.
// The cross-field rules are expressed *structurally* (a discriminated union of two strict
// objects) rather than with superRefine, so the generated JSON Schema carries them too and
// differential.test.ts can assert zod and AJV agree on every fixture.
//
// The origin vocabulary below is an *initial* vocabulary chosen by spec-lane, not one fixed
// by 合意 §B3 (which defines no vocabulary). Changes are additive only (new values), never
// a rename or removal, since an overlay is write-once and never back-filled.
export const REWORK_ORIGINS_KNOWN = [
  "spec_gap",
  "implementation_defect",
  "test_defect",
  "review_miss",
  "environment",
  "dependency",
] as const;
export const REWORK_ORIGINS = [...REWORK_ORIGINS_KNOWN, "unknown"] as const;

// Where the rework was detected: any lane phase, after release (only knowable later, which
// is why `lane rework-classify` exists alongside the advance flags), or unknown.
export const REWORK_DETECTION_STAGES = [...PHASE_ORDER, "post_release", "unknown"] as const;

export const ReworkClassificationSchema = z.discriminatedUnion("classification_status", [
  z
    .object({
      classification_status: z.literal("classified"),
      // `unknown` is only allowed while unclassified: a classified record names its origin.
      origin: z.enum(REWORK_ORIGINS_KNOWN),
      detection_stage: z.enum(REWORK_DETECTION_STAGES),
      evidence_ref: z.string().min(1),
      contributing_factors: z.array(KnowledgeTaxonomySchema).optional(),
    })
    .strict(),
  z
    .object({
      classification_status: z.literal("unclassified"),
      origin: z.enum(REWORK_ORIGINS),
      detection_stage: z.enum(REWORK_DETECTION_STAGES),
      // Explicit null (not omitted): an unclassified record states it has no evidence and
      // says why in unclassified_reason.
      evidence_ref: z.null(),
      unclassified_reason: z.string().min(1),
      contributing_factors: z.array(KnowledgeTaxonomySchema).optional(),
    })
    .strict(),
]);
export type ReworkClassification = z.infer<typeof ReworkClassificationSchema>;
export type ReworkOrigin = (typeof REWORK_ORIGINS)[number];
export type ReworkDetectionStage = (typeof REWORK_DETECTION_STAGES)[number];
