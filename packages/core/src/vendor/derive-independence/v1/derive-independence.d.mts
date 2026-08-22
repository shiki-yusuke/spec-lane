// Hand-written type declaration for the vendored derive-independence.mjs (R37: consumed as
// a vendored file, not re-implemented). TypeScript resolves this file for type information
// via NodeNext's colocated-.d.mts-next-to-.mjs convention; Node itself loads the real .mjs
// at runtime. Kept intentionally minimal/untyped-object-shaped (matching the vendored
// module's own zero-dependency, plain-object style) rather than importing @lane/schemas
// types here -- this file describes exactly what the UPSTREAM .mjs exports, nothing lane
// adds on top (that lives in ../../../design-independence.ts).

export type EngineRefLike = {
  kind?: string;
  provider?: string;
  family?: string;
  model_id?: string;
  session_ref?: string;
  human_ref?: string;
  is_decision_maker?: boolean;
  unknown_fields?: string[];
};

export type ArtifactShaperLike = {
  engine_ref: EngineRefLike;
  how: string;
};

export type DerivedStatus =
  | "same_session"
  | "same_lineage_different_session"
  | "same_family_different_model"
  | "same_provider_different_family"
  | "different_lineage"
  | "human_third_party"
  | "unknown";

/** The relation values `relationBetween` (module-private upstream) can produce -- a subset
 * of DerivedStatus that additionally includes "unknown" (which deriveIndependenceStatus
 * itself never returns as a final derived_status once resolved, but a per-shaper
 * `shaper_relation` record can carry before the "any shaper unknown" check runs). */
export type RelationValue =
  | "same_session"
  | "same_lineage_different_session"
  | "same_family_different_model"
  | "same_provider_different_family"
  | "different_lineage"
  | "unknown";

// 2026-08-22 re-vendor (PR #15 "feat/derive-independence-structured-reasons") -- every
// reason this module emits is now a {code, params} record; `reasons: string[]` (below) is
// an unchanged-wording PROJECTION of `reason_records` via formatReasonRecord, kept for
// backward compatibility. REASON_CODES is the closed set formatReasonRecord accepts;
// passing any other code throws (fail-closed, matches this module's own default case).
//
// Discriminated on `code` (upstream itself does not type this; a hand-written declaration
// file is free to be more precise than the untyped runtime shape it describes) so a
// consumer can switch exhaustively over every code without an `as` cast on `params`.
export const REASON_CODES: readonly ReasonCode[];

export type ReasonCode =
  | "critic_ref_missing"
  | "human_third_party"
  | "human_is_decision_maker"
  | "human_missing_decision_maker_flag"
  | "no_artifact_shapers"
  | "shaper_relation"
  | "unknown_shaper_comparison"
  | "closest_relation"
  | "no_shared_lineage_possible"
  | "provider_unknown"
  | "different_provider"
  | "same_provider_different_family"
  | "same_family_different_model"
  | "same_session_ref"
  | "different_session_ref"
  | "session_ref_one_side"
  | "session_ref_neither_side"
  | "lineage_dimension"
  | "involvement_dimension"
  | "conjunction";

export type ReasonRecord =
  | { code: "critic_ref_missing"; params: Record<string, never> }
  | { code: "human_third_party"; params: Record<string, never> }
  | { code: "human_is_decision_maker"; params: Record<string, never> }
  | { code: "human_missing_decision_maker_flag"; params: Record<string, never> }
  | { code: "no_artifact_shapers"; params: Record<string, never> }
  | {
      code: "shaper_relation";
      params: { shaper_desc: string; how: string; relation: RelationValue; inner: ReasonRecord };
    }
  | { code: "unknown_shaper_comparison"; params: Record<string, never> }
  | { code: "closest_relation"; params: { relation: RelationValue } }
  | {
      code: "no_shared_lineage_possible";
      params: { shaper_kind: string | undefined; critic_kind: string | undefined };
    }
  | { code: "provider_unknown"; params: Record<string, never> }
  | {
      code: "different_provider";
      params: { shaper_provider: string; critic_provider: string };
    }
  | {
      code: "same_provider_different_family";
      params: { provider: string; shaper_family: string; critic_family: string };
    }
  | {
      code: "same_family_different_model";
      params: {
        provider: string;
        family_confirmed: boolean;
        shaper_model_id: string;
        critic_model_id: string;
      };
    }
  | { code: "same_session_ref"; params: Record<string, never> }
  | { code: "different_session_ref"; params: Record<string, never> }
  | { code: "session_ref_one_side"; params: Record<string, never> }
  | { code: "session_ref_neither_side"; params: Record<string, never> }
  | { code: "lineage_dimension"; params: { derived_status: DerivedStatus; clears: boolean } }
  | {
      code: "involvement_dimension";
      params: { prior_involvement: string | null | undefined; clears: boolean };
    }
  | { code: "conjunction"; params: { qualifying: boolean } };

/** Renders one reason record to the exact wording this module has always emitted (byte-
 * identical to the pre-2026-08-22 `reasons` strings). Throws on an unrecognized `code` --
 * fail-closed, since an unknown code from a pinned+vendored module is a bug in the pin
 * (vendor drift), never something to render politely. */
export function formatReasonRecord(record: ReasonRecord): string;

export const DEPRECATED_STATUS_VALUES: readonly string[];

export function engineRefIssues(engineRef: unknown, label?: string): string[];

export function describeEngineRef(engineRef: EngineRefLike | null | undefined): string;

export function deriveIndependenceStatus(args: {
  artifactShapers: ArtifactShaperLike[];
  critic: EngineRefLike | null | undefined;
}): { derived_status: DerivedStatus; reason_records: ReasonRecord[]; reasons: string[] };

export function evaluateQualifying(args: {
  derived_status: DerivedStatus;
  prior_involvement: string | null | undefined;
}): { qualifying: boolean; reason_records: ReasonRecord[]; reasons: string[] };

export function evaluateCriticReview(args: {
  artifactShapers: ArtifactShaperLike[];
  criticReview: { critic?: EngineRefLike; prior_involvement?: string } | null | undefined;
}): {
  derived_status: DerivedStatus;
  qualifying: boolean;
  reason_records: ReasonRecord[];
  reasons: string[];
};
