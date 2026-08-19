import { readFileSync } from "node:fs";
import {
  checkEngineRefCompleteness,
  checkEngineRefFormats,
  checkReviewOutputReachable,
  formatDesignMessage,
  summarizeIndependence,
} from "@lane/core";
import type { DesignOptionsDoc } from "@lane/schemas";
import { readDesignAttestation, writeDesignAttestation } from "../design-attestation-store.js";
import {
  moveActiveDesignPointer,
  readActiveDesignOptionsIfExists,
  writeDesignOptionsRevision,
} from "../design-options-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, readLaneState } from "../state-store.js";
import type { CommandResult } from "./start.js";

// I-2026-08-18-design-critic-injence -- CLI surface for the design track. Every command
// here operates purely on artifacts the operator (or a wrapper script) already produced;
// none of them spawn a model (Non-goals: "lane does not invoke models").

function requireDesignActivated(specDir: string, intentId: string): CommandResult | null {
  if (!laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: formatDesignMessage("design_lane_not_found", { intentId }) };
  }
  const state = readLaneState(specDir, intentId);
  if (state.design_track?.activated !== true) {
    return { exitCode: 2, message: formatDesignMessage("design_not_activated", { intentId }) };
  }
  return null;
}

/**
 * R4/R5/R8-R11/R13-R15/R43-R44 — validates a design-options/v1 document beyond bare schema
 * conformance (design-options.ts's zod mirror already covers structural conformance; this
 * adds the lane-owned layers that would otherwise break upstream conformance parity if
 * folded into that schema, per design-options.ts's own header comment) and writes it as the
 * new active revision.
 */
export interface DesignSubmitOptions {
  specDir?: string;
  file: string;
  by: string;
}

export function runDesignSubmit(intentId: string, opts: DesignSubmitOptions): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir });
  const blocked = requireDesignActivated(specDir, intentId);
  if (blocked) return blocked;

  let doc: DesignOptionsDoc;
  try {
    doc = JSON.parse(readFileSync(opts.file, "utf-8"));
  } catch (err) {
    return {
      exitCode: 1,
      message: formatDesignMessage("design_file_read_failed", {
        file: opts.file,
        detail: (err as Error).message,
      }),
    };
  }

  const problems: string[] = [];

  for (const [i, shaper] of (doc.artifact_shapers ?? []).entries()) {
    problems.push(
      ...checkEngineRefCompleteness(shaper.engine_ref, `artifact_shapers[${i}].engine_ref`),
    );
    problems.push(
      ...checkEngineRefFormats(shaper.engine_ref, `artifact_shapers[${i}].engine_ref`).map(
        (v) => v.message,
      ),
    );
  }
  for (const [i, review] of (doc.critic_reviews ?? []).entries()) {
    problems.push(...checkEngineRefCompleteness(review.critic, `critic_reviews[${i}].critic`));
    problems.push(
      ...checkEngineRefFormats(review.critic, `critic_reviews[${i}].critic`).map((v) => v.message),
    );
    if (!checkReviewOutputReachable(review)) {
      problems.push(formatDesignMessage("review_output_ref_missing", { reviewIndex: i }));
    }
  }
  const knownOptionIds = new Set((doc.options ?? []).map((o) => o.option_id));
  const dangling = (doc.decision_request?.option_ids ?? []).filter((id) => !knownOptionIds.has(id));
  if (dangling.length > 0) {
    problems.push(
      formatDesignMessage("design_decision_request_dangling_option", { ids: dangling.join(", ") }),
    );
  }

  let digest: string;
  try {
    ({ digest } = writeDesignOptionsRevision(specDir, intentId, doc));
  } catch (err) {
    return {
      exitCode: 2,
      message: formatDesignMessage("design_submit_schema_invalid", {
        file: opts.file,
        detail: (err as Error).message,
      }),
    };
  }

  if (problems.length > 0) {
    return {
      exitCode: 3,
      message: formatDesignMessage("design_submit_rejected", { problems: problems.join("; ") }),
    };
  }

  moveActiveDesignPointer(specDir, intentId, {
    design_options_id: doc.design_options_id,
    content_digest: digest,
    moved_at: new Date().toISOString(),
    moved_by: opts.by,
  });

  return {
    exitCode: 0,
    message: formatDesignMessage("design_submit_success", {
      intentId,
      digest,
      designOptionsId: doc.design_options_id,
    }),
  };
}

export interface DesignStatusOptions {
  specDir?: string;
}

/** R25/R26: per-option coverage + derived status + reasons, THEN totals -- never a bare count. */
export function runDesignStatus(intentId: string, opts: DesignStatusOptions): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir });
  const blocked = requireDesignActivated(specDir, intentId);
  if (blocked) return blocked;

  const active = readActiveDesignOptionsIfExists(specDir, intentId);
  if (!active) {
    return { exitCode: 2, message: formatDesignMessage("design_options_missing", {}) };
  }
  const attestation = readDesignAttestation(specDir, intentId);
  const summary = summarizeIndependence(active.doc);

  const lines: string[] = [];
  lines.push(
    formatDesignMessage("design_status_header", {
      designOptionsId: active.pointer.design_options_id,
      contentDigest: active.pointer.content_digest,
    }),
  );
  for (const c of summary.coverage) {
    lines.push(
      formatDesignMessage("design_status_option_coverage", {
        optionId: c.optionId,
        covered: c.covered,
        reasons: c.reasons.join("; "),
      }),
    );
  }
  for (const e of summary.evaluations) {
    lines.push(
      formatDesignMessage("design_status_review_summary", {
        reviewIndex: e.reviewIndex,
        derivedStatus: e.derivedStatus,
        qualifying: e.qualifying,
      }),
    );
  }
  lines.push(
    formatDesignMessage("design_status_totals", {
      totalReviews: summary.totalReviews,
      qualifyingReviews: summary.qualifyingReviews,
    }),
  );

  const relevantOverride = attestation.overrides.find(
    (o) => o.scope.design_options_ref.content_digest === active.pointer.content_digest,
  );
  if (summary.everyOptionCovered) {
    lines.push(formatDesignMessage("establishment_established", {}));
  } else if (relevantOverride) {
    lines.push(
      formatDesignMessage("establishment_not_established_override", {
        actor: relevantOverride.actor,
        overriddenAt: relevantOverride.overridden_at,
        reason: relevantOverride.reason,
      }),
    );
  } else {
    lines.push(formatDesignMessage("establishment_blocked_no_override", {}));
  }

  return { exitCode: 0, message: lines.join("\n") };
}

export interface DesignOverrideOptions {
  specDir?: string;
  reason: string;
  actor: string;
  policyBasis: string;
  uncoveredOptionIds: string[];
  selectedOptionId?: string;
}

/** R30/R31: a distinct operation, never a field on an artifact the same agent authors. */
export function runDesignOverride(intentId: string, opts: DesignOverrideOptions): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir });
  const blocked = requireDesignActivated(specDir, intentId);
  if (blocked) return blocked;

  const active = readActiveDesignOptionsIfExists(specDir, intentId);
  if (!active) {
    return { exitCode: 2, message: formatDesignMessage("design_options_missing", {}) };
  }
  const attestation = readDesignAttestation(specDir, intentId);
  attestation.overrides.push({
    reason: opts.reason,
    actor: opts.actor,
    overridden_at: new Date().toISOString(),
    policy_basis: opts.policyBasis,
    scope: {
      design_options_ref: {
        design_options_id: active.pointer.design_options_id,
        content_digest: active.pointer.content_digest,
      },
      uncovered_option_ids: opts.uncoveredOptionIds,
      selected_option_id: opts.selectedOptionId,
    },
  });
  writeDesignAttestation(specDir, intentId, attestation);
  return {
    exitCode: 0,
    message: formatDesignMessage("design_override_recorded", {
      intentId,
      digest: active.pointer.content_digest,
    }),
  };
}

export interface DesignDecideOptions {
  specDir?: string;
  optionId: string;
  by: string;
}

/** R35/R36: bound to the CURRENT active revision digest (R41). */
export function runDesignDecide(intentId: string, opts: DesignDecideOptions): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir });
  const blocked = requireDesignActivated(specDir, intentId);
  if (blocked) return blocked;

  const active = readActiveDesignOptionsIfExists(specDir, intentId);
  if (!active) {
    return { exitCode: 2, message: formatDesignMessage("design_options_missing", {}) };
  }
  if (!active.doc.options.some((o) => o.option_id === opts.optionId)) {
    return {
      exitCode: 1,
      message: formatDesignMessage("decision_option_unknown", { selectedOptionId: opts.optionId }),
    };
  }
  const attestation = readDesignAttestation(specDir, intentId);
  attestation.decision = {
    design_options_ref: {
      design_options_id: active.pointer.design_options_id,
      content_digest: active.pointer.content_digest,
    },
    selected_option_id: opts.optionId,
    recorded_at: new Date().toISOString(),
    recorded_by: opts.by,
  };
  writeDesignAttestation(specDir, intentId, attestation);
  return {
    exitCode: 0,
    message: formatDesignMessage("design_decide_recorded", {
      intentId,
      optionId: opts.optionId,
      digest: active.pointer.content_digest,
    }),
  };
}
