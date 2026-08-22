#!/usr/bin/env node
// Derives design-options/v1's `independence_status` (and the boolean `qualifying` gate built on
// top of it) from `artifact_shapers[]` + a `critic_reviews[].critic` engine_ref, instead of
// accepting it as a producer-asserted field. See contracts/design-options/v1/CHANGELOG.md
// (2026-08-18) for why: the field's original design let a producer assert a single lineage-distance
// label that actually conflated three different, independent questions --
//   (A) lineage distance from whoever shaped the artifact being reviewed,
//   (B) redundancy between critics reviewing the same document (not modeled by this module --
//       see that CHANGELOG's "not solved here" note),
//   (C) prior_involvement -- whether THIS critic already had a hand in shaping the very options
//       it is now reviewing.
// A real fixture in this repo shipped with a self-contradictory pair of asserted labels
// (`different_lineage` for one critic, `same_lineage_different_order` for another, measured
// against two different reference points) because the enum had no way to express (C) at all.
// This module computes (A) mechanically from recorded engine identities, and combines it with a
// producer-asserted-but-conjunctively-gated (C) to decide whether a review counts as independent
// verification ("qualifying") -- it never lets a producer simply assert the answer.
//
// `unknown` (2026-08-18 refinement): means "qualifying cannot be ruled out", not "some field
// happens to be missing". A missing `provider` is genuinely `unknown`, because a provider that
// turns out to differ would be the one QUALIFYING outcome (`different_lineage`). Once `provider`
// is confirmed equal, no missing `family`/`model_id`/`session_ref` can ever produce a qualifying
// result, so those fields are skipped rather than treated as blocking -- the derivation instead
// finds the closest non-qualifying relation still consistent with what is confirmed. See
// relationBetween's own comment for the mechanics, and design-options/v1's CHANGELOG.md for the
// real fixture defect ("`unknown` fired for a field gap that could never have been qualifying
// anyway") this refinement corrects.
//
// Zero npm dependencies by design, same as every verify-fixtures.mjs / shared module in this repo.
//
// Usage as a library:
//   import { evaluateCriticReview, deriveIndependenceStatus, evaluateQualifying, engineRefIssues }
//     from "./derive-independence.mjs";
//   const { derived_status, qualifying, reasons } =
//     evaluateCriticReview({ artifactShapers: doc.artifact_shapers, criticReview: doc.critic_reviews[0] });
//
// Usage as a CLI (no install step, no network access):
//   node derive-independence.mjs <design-options.json> [<design-options.json> ...]
// Prints, per document, the derived_status/qualifying/reasons for every critic_reviews[] entry,
// then a total review count and qualifying count across all files given.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Closed set this module actually derives. `same_lineage_different_order` is design-options/v1's
// OLD producer-asserted enum value -- kept recognizable in read/description contexts (a document
// written before this derivation existed may still carry it as a historical curiosity in prose,
// though the field itself no longer exists in the schema) but this module never emits it: the
// distinction it tried to draw ("same engine, only reading order changed") is not something a
// derivation over engine_ref + session_ref can observe, and guessing it would be exactly the kind
// of unverified assertion this whole module exists to stop making.
export const DEPRECATED_STATUS_VALUES = Object.freeze(["same_lineage_different_order"]);

// ---------------------------------------------------------------------------------------------
// Structured reasons (2026-08-22): every reason this module emits is a {code, params} record,
// and the human-readable `reasons` strings are a PROJECTION of those records via
// formatReasonRecord below -- never the other way around. Rationale: a downstream consumer
// (spec-lane's R46: "reason text is composed entirely from catalogued messages") cannot brand a
// raw sentence with a catalog identity without lying about its provenance; it CAN catalog a
// closed code set and compose its own text from params. The records are additive: `reasons`
// keeps its exact previous wording, so existing consumers observe no change.
// ---------------------------------------------------------------------------------------------
export const REASON_CODES = Object.freeze([
  "critic_ref_missing",
  "human_third_party",
  "human_is_decision_maker",
  "human_missing_decision_maker_flag",
  "no_artifact_shapers",
  "shaper_relation",
  "unknown_shaper_comparison",
  "closest_relation",
  "no_shared_lineage_possible",
  "provider_unknown",
  "different_provider",
  "same_provider_different_family",
  "same_family_different_model",
  "same_session_ref",
  "different_session_ref",
  "session_ref_one_side",
  "session_ref_neither_side",
  "lineage_dimension",
  "involvement_dimension",
  "conjunction",
]);

function rec(code, params = {}) {
  return { code, params };
}

/** Renders one reason record to the exact wording this module has always emitted. */
export function formatReasonRecord(record) {
  const p = record.params ?? {};
  switch (record.code) {
    case "critic_ref_missing":
      return "critic engine_ref is missing or malformed";
    case "human_third_party":
      return "critic.kind=human and is_decision_maker=false -> human_third_party, independent of artifact_shapers";
    case "human_is_decision_maker":
      return "critic.kind=human and is_decision_maker=true: the critic IS the decision maker -- not covered by this contract's derivation table, reported as unknown rather than guessed (see docs/protocols/design-options-v1.md)";
    case "human_missing_decision_maker_flag":
      return "critic.kind=human but is_decision_maker is not recorded -- cannot determine human_third_party vs decision-maker self-review";
    case "no_artifact_shapers":
      return "no artifact_shapers recorded -- cannot derive a lineage relationship for a model critic";
    case "shaper_relation":
      return `vs shaper ${p.shaper_desc} (how=${p.how}): ${p.relation} -- ${formatReasonRecord(p.inner)}`;
    case "unknown_shaper_comparison":
      return "at least one shaper comparison is unknown -- the true closest relationship across all shapers cannot be shown to be no closer than what is already known, so the overall result is unknown rather than guessed";
    case "closest_relation":
      return `closest (least independent) relationship across all shapers: ${p.relation}`;
    case "no_shared_lineage_possible":
      return `no shared engine lineage possible (shaper kind=${p.shaper_kind}, critic kind=${p.critic_kind})`;
    case "provider_unknown":
      return "provider unknown on at least one side -- different_lineage (qualifying) cannot be ruled out";
    case "different_provider":
      return `different provider (shaper=${p.shaper_provider}, critic=${p.critic_provider})`;
    case "same_provider_different_family":
      return `same provider (${p.provider}), different family (shaper=${p.shaper_family}, critic=${p.critic_family})`;
    case "same_family_different_model":
      return `same provider${p.family_confirmed ? "+family" : ""} (${p.provider}), different model_id (shaper=${p.shaper_model_id}, critic=${p.critic_model_id})`;
    case "same_session_ref":
      return "same session_ref";
    case "different_session_ref":
      return "different session_ref";
    case "session_ref_one_side":
      return "session_ref recorded on only one side -- not assumed equal to an unrecorded value";
    case "session_ref_neither_side":
      return "session_ref recorded on neither side -- closest possibility assumed";
    case "lineage_dimension":
      return p.clears
        ? `derived_status=${p.derived_status} clears the lineage dimension`
        : `derived_status=${p.derived_status} does NOT clear the lineage dimension (needs different_lineage or human_third_party)`;
    case "involvement_dimension":
      return p.clears
        ? `prior_involvement=${p.prior_involvement} clears the involvement dimension`
        : `prior_involvement=${p.prior_involvement} does NOT clear the involvement dimension (needs none_observed_in_recorded_scope)`;
    case "conjunction":
      return p.qualifying
        ? "qualifying: both dimensions satisfied (conjunction)"
        : "not qualifying: the conjunction requires both dimensions, and at least one failed";
    default:
      // fail-closed: an unknown code is a bug in THIS module, not something to render politely.
      throw new Error(`formatReasonRecord: unknown reason code "${record?.code}"`);
  }
}

// Ranked closest (0, least independent) to farthest (4, most independent) -- used to pick the
// single "closest across all shapers" relationship the M2 derivation rule calls for.
// `human_third_party` and `unknown` are deliberately NOT in this table: both are decided by a
// critic-level short-circuit in deriveIndependenceStatus below, before any per-shaper ranking
// happens (see that function's own comments for why).
const RELATION_RANK = Object.freeze({
  same_session: 0,
  same_lineage_different_session: 1,
  same_family_different_model: 2,
  same_provider_different_family: 3,
  different_lineage: 4,
});

const MODEL_REQUIRED_FIELDS = Object.freeze(["provider", "family", "model_id"]);
const HUMAN_REQUIRED_FIELDS = Object.freeze(["human_ref", "is_decision_maker"]);

function present(value) {
  return value !== undefined && value !== null;
}

// Structural + semantic completeness check for one $defs/engine_ref object: per-kind required
// fields are NOT enforced by the schema's own `required` keyword (unlike every other required
// field in this repo) -- a field can legitimately be unrecorded, provided the producer says so by
// naming it in `unknown_fields` rather than just leaving it out. A field that is neither present
// nor named in `unknown_fields` IS a gap: this is what invalid-engine-ref-missing-model-id.json
// (contracts/design-options/v1/fixtures/) exercises. Every returned string is prefixed with a
// stable reason-code token before its first colon, matching this repo's `reasonCodesOf` convention
// (contracts/design-options/v1/verify-fixtures.mjs).
export function engineRefIssues(engineRef, label = "engine_ref") {
  const issues = [];
  if (engineRef === null || typeof engineRef !== "object" || Array.isArray(engineRef)) {
    issues.push(`engine_ref_not_an_object: ${label}: expected an object, got ${JSON.stringify(engineRef)}`);
    return issues;
  }
  if (engineRef.kind !== "model" && engineRef.kind !== "human") {
    issues.push(`engine_ref_unknown_kind: ${label}: kind is ${JSON.stringify(engineRef.kind)}, expected "model" or "human"`);
    return issues;
  }
  const declaredUnknown = new Set(Array.isArray(engineRef.unknown_fields) ? engineRef.unknown_fields : []);
  const requiredFields = engineRef.kind === "model" ? MODEL_REQUIRED_FIELDS : HUMAN_REQUIRED_FIELDS;
  for (const field of requiredFields) {
    if (!present(engineRef[field]) && !declaredUnknown.has(field)) {
      issues.push(
        `engine_ref_field_undeclared: ${label}: "${field}" is required for kind=${engineRef.kind} but is missing and not listed in unknown_fields`,
      );
    }
  }
  return issues;
}

export function describeEngineRef(engineRef) {
  if (!engineRef || typeof engineRef !== "object") return "unknown engine_ref";
  if (engineRef.kind === "model") {
    if (present(engineRef.model_id)) return engineRef.model_id;
    const provider = present(engineRef.provider) ? engineRef.provider : "provider?";
    const family = present(engineRef.family) ? engineRef.family : "family?";
    return `${provider}/${family} (model_id unknown)`;
  }
  if (engineRef.kind === "human") {
    return present(engineRef.human_ref) ? `human:${engineRef.human_ref}` : "human (ref unknown)";
  }
  return `engine_ref(kind=${JSON.stringify(engineRef.kind)})`;
}

// Compares ONE shaper's engine_ref against the critic's engine_ref. `unknown` here means
// something specific (2026-08-18 revision, see design-options/v1 CHANGELOG.md "unknown means
// 'qualifying cannot be ruled out', not 'a field is missing'"): it is returned ONLY when the
// missing information could still hide a QUALIFYING outcome (`different_lineage`) -- i.e. when
// `provider` itself is unresolved, since providers differing is the one fact this table treats
// as qualifying. Once `provider` is confirmed EQUAL, `different_lineage` is impossible no matter
// what `family`/`model_id`/`session_ref` turn out to be, so an unknown value at any of THOSE
// fields is skipped (treated as "possibly equal, keep narrowing") rather than blocking the
// derivation -- every relation reachable past that point is non-qualifying already, and this
// module's job at that stage is only to find the CLOSEST (least independent) one still
// consistent with what is confirmed, per the same "closest across all shapers" principle
// `deriveIndependenceStatus` applies across shapers. It never stacks a SECOND unverified
// assumption on top of a first, though: see the session_ref step below for the one place that
// distinction has a concrete effect (an explicitly recorded session_ref on one side is not
// assumed to coincidentally equal an unrecorded value on the other).
function relationBetween(shaperRef, criticRef) {
  if (shaperRef.kind !== "model" || criticRef.kind !== "model") {
    // A human and a model share no engine lineage by construction -- this is the one relation
    // this function can state with certainty regardless of which side is missing which field.
    return { relation: "different_lineage", reason_record: rec("no_shared_lineage_possible", { shaper_kind: shaperRef.kind, critic_kind: criticRef.kind }) };
  }

  if (!present(shaperRef.provider) || !present(criticRef.provider)) {
    return { relation: "unknown", reason_record: rec("provider_unknown") };
  }
  if (shaperRef.provider !== criticRef.provider) {
    return { relation: "different_lineage", reason_record: rec("different_provider", { shaper_provider: shaperRef.provider, critic_provider: criticRef.provider }) };
  }

  // provider confirmed equal from here on -- different_lineage is off the table, so an unknown
  // family/model_id no longer needs to block the derivation; it is skipped, not treated as
  // indeterminate.
  if (present(shaperRef.family) && present(criticRef.family) && shaperRef.family !== criticRef.family) {
    return { relation: "same_provider_different_family", reason_record: rec("same_provider_different_family", { provider: shaperRef.provider, shaper_family: shaperRef.family, critic_family: criticRef.family }) };
  }

  if (present(shaperRef.model_id) && present(criticRef.model_id) && shaperRef.model_id !== criticRef.model_id) {
    return { relation: "same_family_different_model", reason_record: rec("same_family_different_model", { provider: shaperRef.provider, family_confirmed: present(shaperRef.family) && present(criticRef.family), shaper_model_id: shaperRef.model_id, critic_model_id: criticRef.model_id }) };
  }

  if (present(shaperRef.session_ref) && present(criticRef.session_ref)) {
    return shaperRef.session_ref === criticRef.session_ref
      ? { relation: "same_session", reason_record: rec("same_session_ref") }
      : { relation: "same_lineage_different_session", reason_record: rec("different_session_ref") };
  }
  if (present(shaperRef.session_ref) !== present(criticRef.session_ref)) {
    // Asymmetric: one side recorded a specific session_ref value and the other simply was never
    // asked to record one (e.g. a shaper whose `how: authored` role was never given a session
    // label at all). Assuming these coincidentally match would stack a second unverified
    // assumption on top of whatever family/model_id gaps were already skipped above -- this
    // module declines to do that, and instead treats a recorded value as evidence the sessions
    // differ.
    return { relation: "same_lineage_different_session", reason_record: rec("session_ref_one_side") };
  }
  // Neither side ever recorded a session_ref: no evidence distinguishes them at all, so the
  // closest (least independent) possibility is assumed, consistent with every field skipped
  // above.
  return { relation: "same_session", reason_record: rec("session_ref_neither_side") };
}

// Core derivation: the "closest (least independent) relationship across ALL shapers" rule from
// design-options/v1's CHANGELOG (2026-08-18), plus the two critic-level short-circuits the M2
// derivation table calls for before any shaper comparison happens at all.
export function deriveIndependenceStatus({ artifactShapers, critic }) {
  const records = [];
  const done = (derived_status) => ({
    derived_status,
    reason_records: records,
    reasons: records.map(formatReasonRecord),
  });
  if (!critic || typeof critic !== "object") {
    records.push(rec("critic_ref_missing"));
    return done("unknown");
  }
  if (critic.kind === "human") {
    if (critic.is_decision_maker === false) {
      records.push(rec("human_third_party"));
      return done("human_third_party");
    }
    if (critic.is_decision_maker === true) {
      // Not covered by the derivation table this contract ships with: a human critic who is
      // ALSO the decision maker is neither an outside third party nor comparable to a model
      // lineage. Reported honestly as unknown rather than guessed -- see this contract's own
      // docs/protocols/design-options-v1.md "Open questions" for this gap, flagged rather than
      // silently resolved one way or the other.
      records.push(rec("human_is_decision_maker"));
      return done("unknown");
    }
    records.push(rec("human_missing_decision_maker_flag"));
    return done("unknown");
  }

  if (!Array.isArray(artifactShapers) || artifactShapers.length === 0) {
    records.push(rec("no_artifact_shapers"));
    return done("unknown");
  }

  const perShaper = artifactShapers.map((shaper) => {
    const { relation, reason_record } = relationBetween(shaper.engine_ref ?? {}, critic);
    return { shaper, relation, reason_record };
  });
  for (const p of perShaper) {
    records.push(
      rec("shaper_relation", {
        shaper_desc: describeEngineRef(p.shaper.engine_ref),
        how: p.shaper.how,
        relation: p.relation,
        inner: p.reason_record,
      }),
    );
  }
  if (perShaper.some((p) => p.relation === "unknown")) {
    records.push(rec("unknown_shaper_comparison"));
    return done("unknown");
  }
  let closest = perShaper[0];
  for (const p of perShaper) {
    if (RELATION_RANK[p.relation] < RELATION_RANK[closest.relation]) closest = p;
  }
  records.push(rec("closest_relation", { relation: closest.relation }));
  return done(closest.relation);
}

// The conjunctive qualifying gate (M2): a review counts as independent verification only if BOTH
// the lineage dimension AND the prior_involvement dimension clear the bar. Either alone is not
// sufficient -- e.g. a `different_lineage` critic that also appears in `artifact_shapers[]`
// (this repo's own real fixture: sol both shaped and "reviewed" the same discovery-scope options)
// is not independent verification no matter how distant its lineage looks on paper.
export function evaluateQualifying({ derived_status, prior_involvement }) {
  const records = [];
  const lineageQualifies = derived_status === "different_lineage" || derived_status === "human_third_party";
  const involvementQualifies = prior_involvement === "none_observed_in_recorded_scope";
  records.push(rec("lineage_dimension", { derived_status, clears: lineageQualifies }));
  records.push(rec("involvement_dimension", { prior_involvement, clears: involvementQualifies }));
  const qualifying = lineageQualifies && involvementQualifies;
  records.push(rec("conjunction", { qualifying }));
  return { qualifying, reason_records: records, reasons: records.map(formatReasonRecord) };
}

// Convenience wrapper combining the two steps above for one criticReview object.
export function evaluateCriticReview({ artifactShapers, criticReview }) {
  const lineage = deriveIndependenceStatus({ artifactShapers, critic: criticReview?.critic });
  const gate = evaluateQualifying({ derived_status: lineage.derived_status, prior_involvement: criticReview?.prior_involvement });
  return {
    derived_status: lineage.derived_status,
    qualifying: gate.qualifying,
    reasons: [...lineage.reasons, ...gate.reasons],
    reason_records: [...lineage.reason_records, ...gate.reason_records],
  };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function runCli() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: node derive-independence.mjs <design-options.json> [<design-options.json> ...]");
    process.exit(1);
  }

  let totalReviews = 0;
  let totalQualifying = 0;
  const statusCounts = {};

  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, "utf-8"));
    console.log(`\n${file}  (design_options_id=${JSON.stringify(doc.design_options_id ?? null)})`);
    const shapers = Array.isArray(doc.artifact_shapers) ? doc.artifact_shapers : [];
    const reviews = Array.isArray(doc.critic_reviews) ? doc.critic_reviews : [];
    if (shapers.length === 0) console.log("  (no artifact_shapers recorded)");
    reviews.forEach((review, i) => {
      const { derived_status, qualifying, reasons } = evaluateCriticReview({ artifactShapers: shapers, criticReview: review });
      totalReviews++;
      if (qualifying) totalQualifying++;
      statusCounts[derived_status] = (statusCounts[derived_status] ?? 0) + 1;
      console.log(`  critic_reviews[${i}] critic=${describeEngineRef(review.critic)}  derived_status=${derived_status}  qualifying=${qualifying}`);
      for (const r of reasons) console.log(`      - ${r}`);
    });
  }

  console.log(`\n${totalReviews} review(s) evaluated across ${files.length} file(s), ${totalQualifying} qualifying.`);
  console.log("derived_status breakdown:", JSON.stringify(statusCounts));
}

if (isMainModule()) {
  runCli();
}
