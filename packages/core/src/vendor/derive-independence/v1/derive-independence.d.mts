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

export const DEPRECATED_STATUS_VALUES: readonly string[];

export function engineRefIssues(engineRef: unknown, label?: string): string[];

export function describeEngineRef(engineRef: EngineRefLike | null | undefined): string;

export function deriveIndependenceStatus(args: {
  artifactShapers: ArtifactShaperLike[];
  critic: EngineRefLike | null | undefined;
}): { derived_status: DerivedStatus; reasons: string[] };

export function evaluateQualifying(args: {
  derived_status: DerivedStatus;
  prior_involvement: string | null | undefined;
}): { qualifying: boolean; reasons: string[] };

export function evaluateCriticReview(args: {
  artifactShapers: ArtifactShaperLike[];
  criticReview: { critic?: EngineRefLike; prior_involvement?: string } | null | undefined;
}): { derived_status: DerivedStatus; qualifying: boolean; reasons: string[] };
