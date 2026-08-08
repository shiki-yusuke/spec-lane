import { readFileSync } from "node:fs";
import {
  ImpactScanParseError,
  ReferenceTableRequiredError,
  adoptBaselineRevision,
  appendRevision,
  buildEstimateRevision,
  buildPredictorsFromIntent,
  createEstimate,
  loadProfile,
  parseImpactScanBlock,
  resolveProfilePath,
} from "@lane/core";
import type { EstimateRevision } from "@lane/schemas";
import { listObservations } from "../calibration-store.js";
import { packageDefaultProfilePath } from "../default-profile.js";
import { readEstimateIfExists, writeEstimate } from "../estimate-store.js";
import { currentGitCommit } from "../git-info.js";
import { intentExists, readIntent, writeIntent } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, readLaneState } from "../state-store.js";
import { readVerificationIfExists } from "../verification-store.js";
import type { CommandResult } from "./start.js";

const ESTIMATOR_VERSION = "lane-estimator/0.1.0";

export interface EstimateOptions {
  specDir?: string;
  profile?: string;
  impactScanFile?: string;
  /**
   * `true`: adopt the new revision this call creates (existing behavior). A string: adopt
   * an *already-existing* revision id instead — no new revision is created at all, this
   * call only re-points intent.baseline_estimate_revision_id (must-2, M2 review,
   * 2026-07-31). `undefined`: don't adopt anything.
   */
  adopt?: boolean | string;
  referenceTokensP50?: number;
  referenceTokensP80?: number;
  referenceCostP50?: number;
  referenceCostP80?: number;
}

/**
 * `lane estimate <intent-id>` — always appends a new revision (design.md §2.6: no
 * update/replace, to avoid hindsight bias), *unless* `--adopt <revision-id>` names an
 * existing revision, in which case no new revision is created at all — that mode is a pure
 * baseline re-point (see adoptExistingRevision below). `--adopt` (bare) or `--adopt
 * <revision-id>` are the *only* ways intent.baseline_estimate_revision_id changes; without
 * either, the revision is recorded but not adopted.
 *
 * `--reference-tokens-p50/p80`/`--reference-cost-p50/p80` back the reference_table
 * fallback used whenever the (token_basis-filtered) k-NN population is too small (< 8
 * observations, or < 5 knn-eligible among the nearest 7 — core/estimator.ts). MP-8
 * (2026-08-08, sol ruling point 7): there is no more silent placeholder default (50 000/
 * 150 000 tokens, $1/$4) -- all four flags must be given together, or none. If the
 * estimator actually needs a reference table and none was given, this fails clearly
 * (ReferenceTableRequiredError) instead of guessing.
 */
export function runEstimate(intentId: string, opts: EstimateOptions): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir });

  if (!laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: `Lane state not found: ${intentId}` };
  }
  if (!intentExists(specDir, intentId)) {
    return { exitCode: 2, message: `intent.yaml not found for ${intentId}` };
  }

  const intent = readIntent(specDir, intentId);

  if (typeof opts.adopt === "string") {
    return adoptExistingRevision(specDir, intentId, intent, opts.adopt);
  }

  const state = readLaneState(specDir, intentId);
  const verification = readVerificationIfExists(specDir, intentId);

  let impactScanSnapshot: EstimateRevision["impact_scan_snapshot"];
  if (opts.impactScanFile) {
    let raw: string;
    try {
      raw = readFileSync(opts.impactScanFile, "utf-8");
    } catch (err) {
      return {
        exitCode: 1,
        message: `--impact-scan-file: cannot read ${opts.impactScanFile}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      impactScanSnapshot = parseImpactScanBlock(raw);
    } catch (err) {
      if (err instanceof ImpactScanParseError) {
        return { exitCode: 1, message: `--impact-scan-file: ${err.message}` };
      }
      throw err;
    }
  }

  const { path: profilePath } = resolveProfilePath({
    explicit: opts.profile,
    cwd: process.cwd(),
    packageDefaultPath: packageDefaultProfilePath(),
  });
  const profile = loadProfile(profilePath);

  const predictors = buildPredictorsFromIntent(
    intent,
    impactScanSnapshot,
    verification ?? undefined,
  );
  const population = listObservations();

  const existingEstimate = readEstimateIfExists(specDir, intentId);
  const revisionId = `r${(existingEstimate?.revisions.length ?? 0) + 1}`;
  const now = new Date().toISOString();

  // MP-8 (2026-08-08, sol ruling point 7): all four together, or none -- no silent
  // per-field default, and no mixing an explicit override for one field with a
  // placeholder for another.
  const referenceOpts = [
    opts.referenceTokensP50,
    opts.referenceTokensP80,
    opts.referenceCostP50,
    opts.referenceCostP80,
  ];
  const anyReferenceGiven = referenceOpts.some((v) => v != null);
  const allReferenceGiven = referenceOpts.every((v) => v != null);
  if (anyReferenceGiven && !allReferenceGiven) {
    return {
      exitCode: 1,
      message:
        "--reference-tokens-p50/--reference-tokens-p80/--reference-cost-p50/--reference-cost-p80 " +
        "must all be given together, or none of them -- got only some",
    };
  }
  const referenceTable = allReferenceGiven
    ? {
        predicted: {
          // biome-ignore lint/style/noNonNullAssertion: allReferenceGiven already confirmed every value is non-null
          tokens: { p50: opts.referenceTokensP50!, p80: opts.referenceTokensP80! },
          // biome-ignore lint/style/noNonNullAssertion: allReferenceGiven already confirmed every value is non-null
          cost_usd: { p50: opts.referenceCostP50!, p80: opts.referenceCostP80! },
        },
      }
    : undefined;

  let revision: EstimateRevision;
  try {
    revision = buildEstimateRevision({
      revisionId,
      estimatedAt: now,
      asOfPhase: state.current_phase,
      repoCommit: currentGitCommit(specDir),
      impactScanSnapshot,
      estimatorVersion: ESTIMATOR_VERSION,
      predictors,
      population,
      profile,
      referenceTable,
    });
  } catch (err) {
    if (err instanceof ReferenceTableRequiredError) {
      return { exitCode: 1, message: err.message };
    }
    throw err;
  }

  const updatedEstimate = existingEstimate
    ? appendRevision(existingEstimate, revision)
    : createEstimate(intentId, "1.0", revision);
  writeEstimate(specDir, intentId, updatedEstimate);

  if (opts.adopt === true) {
    writeIntent(specDir, intentId, adoptBaselineRevision(intent, revisionId, updatedEstimate, now));
  }

  const lines = [
    `revision ${revisionId} (${revision.population_condition.method}, population=${revision.population_condition.population_size}, experimental=${revision.population_condition.experimental})`,
    `tokens        p50=${revision.predicted.tokens.p50}  p80=${revision.predicted.tokens.p80}`,
    `cost_usd      p50=${revision.predicted.cost_usd.p50}  p80=${revision.predicted.cost_usd.p80}`,
    revision.population_condition.method === "knn_quantile"
      ? `leave-one-out p50 error=${revision.population_condition.leave_one_out_p50_error} / p80 coverage=${revision.population_condition.leave_one_out_p80_coverage}`
      : `no k-NN population large enough yet (${revision.population_condition.population_size} observations)`,
    opts.adopt === true
      ? `adopted as intent.baseline_estimate_revision_id (adopted_at=${now})`
      : `not adopted (pass --adopt to set ${revisionId} as baseline)`,
  ];
  return { exitCode: 0, message: lines.join("\n") };
}

/**
 * `lane estimate <intent-id> --adopt <revision-id>` — re-points
 * intent.baseline_estimate_revision_id at an *already-existing* revision without creating a
 * new one (must-2, M2 review, 2026-07-31). This is a pure baseline switch: estimate.json's
 * append-only revisions list is never touched, only intent.yaml's baseline pointer + its
 * adoption audit timestamp (baseline_adopted_at) move.
 */
function adoptExistingRevision(
  specDir: string,
  intentId: string,
  intent: ReturnType<typeof readIntent>,
  revisionId: string,
): CommandResult {
  const estimate = readEstimateIfExists(specDir, intentId);
  if (!estimate) {
    return {
      exitCode: 1,
      message: `--adopt ${revisionId}: no estimate.json exists yet for ${intentId} (run \`lane estimate ${intentId}\` first)`,
    };
  }
  const now = new Date().toISOString();
  let updatedIntent: ReturnType<typeof readIntent>;
  try {
    updatedIntent = adoptBaselineRevision(intent, revisionId, estimate, now);
  } catch (err) {
    return { exitCode: 1, message: err instanceof Error ? err.message : String(err) };
  }
  writeIntent(specDir, intentId, updatedIntent);
  return {
    exitCode: 0,
    message: `adopted existing revision ${revisionId} as intent.baseline_estimate_revision_id (adopted_at=${now}); no new revision created`,
  };
}
