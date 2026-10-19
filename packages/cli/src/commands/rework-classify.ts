import {
  DoneOverlayMissingError,
  DoneOverlayUnreadableError,
  DoneOverlayVersionError,
  ReworkClassificationExistsError,
  setReworkClassification,
} from "@lane/core";
import type { ReworkFlags } from "../rework-flags.js";
import { parseReworkFlags } from "../rework-flags.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists } from "../state-store.js";
import { LANE_VERSION } from "../version.js";
import type { CommandResult } from "./start.js";

export interface ReworkClassifyOptions extends ReworkFlags {
  specDir?: string;
  toolVersion?: string;
}

/**
 * `lane rework-classify <id>` (合意 §B3) — records a rework classification on an existing
 * done overlay after the fact (e.g. `--detected-at post_release`, which advance can't know).
 * Write-once: parses the flags with the same parser as `advance --rework-*`, then calls
 * setReworkClassification (advance itself writes through createDoneOverlay); never overwrites. Exit 2 = usage / fail-closed refusals (schema violation, unreadable
 * overlay, newer-binary overlay -- matching calibrate's own exits), and -- like every other
 * command -- an intent id with no lane state at all (`Lane state not found`); exit 3 = the lane
 * exists but has no done overlay to classify, or is already classified. Nothing is written on
 * any non-zero exit.
 */
export function runReworkClassify(intentId: string, opts: ReworkClassifyOptions): CommandResult {
  const parsed = parseReworkFlags(opts);
  if (!parsed.ok) {
    return { exitCode: 2, message: `rework-classify: ${parsed.message} -- nothing was recorded` };
  }
  const specDir = resolveSpecDir({ override: opts.specDir });
  if (!laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: `Lane state not found: ${intentId}` };
  }
  try {
    setReworkClassification(specDir, intentId, parsed.value, opts.toolVersion ?? LANE_VERSION);
  } catch (err) {
    if (err instanceof DoneOverlayUnreadableError) {
      return {
        exitCode: 2,
        message: `rework-classify: done overlay for ${intentId} at ${err.path} is unreadable (${err.reason}) -- nothing was recorded -- run in a fresh lane, or inspect the overlay file directly`,
      };
    }
    if (err instanceof DoneOverlayVersionError) {
      return {
        exitCode: 2,
        message: `rework-classify: refusing to write -- ${err.message} -- nothing was recorded`,
      };
    }
    if (err instanceof DoneOverlayMissingError || err instanceof ReworkClassificationExistsError) {
      return { exitCode: 3, message: `rework-classify: ${err.message} -- nothing was recorded` };
    }
    throw err;
  }
  return {
    exitCode: 0,
    message: `Recorded rework classification (${parsed.value.classification_status}) for ${intentId}`,
  };
}
