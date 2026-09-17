import { AgentCostTelemetryAdapter, TelemetryImportFailed } from "@lane/adapters";
import {
  type DoneOverlay,
  buildAttributionProjection,
  buildLaneScopeLedgerEntries,
  buildObservationFromMeasurement,
  buildPredictorsFromIntent,
  computeDigest,
  effectiveLedger,
  evaluatePrediction,
  findBaselineRevision,
  isDoneOverlayGuarded,
  normalizeEntryBasis,
  planBasisSupersession,
  readDoneOverlay,
  readTraceEvents,
  recomputeIncludedInKpi,
  upsertLedgerEntry,
  writeDoneOverlay,
} from "@lane/core";
import type { LedgerEntry, MeasurementQuality } from "@lane/schemas";
import { listObservations, writeCalibrationRecord } from "../calibration-store.js";
import { readEstimateIfExists } from "../estimate-store.js";
import { intentExists, readIntent } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, readLaneState, writeLaneState } from "../state-store.js";
import { readVerificationIfExists } from "../verification-store.js";
import type { CommandResult } from "./start.js";

export interface CalibrateOptions {
  specDir?: string;
  sessionIds: string[];
  since?: string;
  until?: string;
  agentCostBin?: string;
  /** Milliseconds before agent-cost is sent SIGTERM (default 180000, see @lane/adapters). */
  agentCostTimeoutMs?: number;
  /** Actual diff file count post-implementation (design.md §2.6's files_touched_observed). */
  filesTouchedObserved?: number;
  /** I-2026-09-10-agent-cost-v2-basis-gate (RULE-16/17) -- explicit opt-in to record a
   * re-measurement under a different accounting_basis as a superseding entry (basis_history
   * appended) instead of refusing the whole write. */
  supersedeBasis?: boolean;
}

/**
 * sol impl review 1 must-5 -- a "refuse" here means step 1's own preflight (which already
 * confirmed every one of these entries plans to "write" against the same,
 * unmodified-by-this-call ledger) missed a conflict. Fail closed with a thrown error,
 * never silently fall back to the unmerged entry (which would discard an existing
 * basis_history).
 */
function planOrThrow(
  existing: LedgerEntry | undefined,
  incoming: LedgerEntry,
  supersedeBasis: boolean,
): LedgerEntry {
  const plan = planBasisSupersession({ existing, incoming, supersedeBasis });
  if (plan.action === "refuse") {
    throw new Error(
      `runCalibrate: internal invariant violated -- planBasisSupersession refused at write time for ledger_entry_id ${incoming.ledger_entry_id} after the preflight already confirmed no conflict: ${plan.diagnostic}`,
    );
  }
  return plan.entry;
}

/**
 * Parses a `--since`/`--until` CLI value into a `Date`, or a human-readable error instead
 * of letting an invalid string reach `Date.toISOString()` downstream (should-5, M2 review,
 * 2026-07-31 — `new Date("garbage")` doesn't throw, but the agent-cost adapter's
 * `toPythonIsoformat()` calling `.toISOString()` on the resulting Invalid Date does, with a
 * raw `RangeError` that doesn't say which flag was at fault).
 */
function parseTimestampOption(
  flagName: string,
  raw: string | undefined,
): { date?: Date; error?: string } {
  if (!raw) return {};
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { error: `${flagName}: invalid ISO 8601 timestamp: ${raw}` };
  }
  return { date };
}

/**
 * `lane calibrate <intent-id> --session-id <id> [--session-id <id> ...]` — measures real
 * usage for the given session ids via agent-cost (design.md §4.1), and (MP-8, spec.md
 * Rule 1) records BOTH a CalibrationObservation AND a scope:"lane" cost_ledger entry
 * from that same measurement — the whole point being that `lane emit-metrics` (which
 * reads only cost_ledger, never the calibration store) actually sees what was measured
 * here. Also records a CalibrationPredictionEvaluation, but only if
 * intent.baseline_estimate_revision_id is set. Never touches estimate.json (design.md
 * §5.1: calibrate only ever *reads* the adopted baseline).
 *
 * record_id (observation) and ledger_entry_id (ledger entry) are both derived
 * deterministically -- record_id from (intentId, sessionIds, since, until) (design.md
 * §2.7: "record_id を主キーにすることで lane calibrate の再実行が冪等になる"), ledger_entry_id from
 * (laneId, source, pricing_version) (ledger.ts's computeLaneScopeLedgerEntryId) -- so
 * re-running calibrate for the same measured window upserts both records in place rather
 * than duplicating either one (spec.md Rule 1).
 *
 * Rule 2: if only one of the two writes succeeds, this returns a non-zero exit code
 * naming which half failed -- never a "clean success" message for a partial write. Both
 * writes being upserts makes re-running calibrate (with the same flags) a safe repair
 * for either half.
 *
 * Rule 7: if the lane's done overlay already exists (post-merge calibrate, the
 * documented lane-finish flow), the ledger entry is upserted into the overlay's own
 * ledger_delta instead of rewriting in-repo lane-state.json -- matching done-overlay.ts's
 * "never rewrite in-repo state after merge" principle.
 *
 * I-2026-09-10-agent-cost-v2-basis-gate (D6/D9/RULE-25) -- `deriveKnnIneligibility`'s
 * attribution projection is derived once here, the same way usage-import does (D7/D9: one
 * derivation, reused, never re-derived), window-independent (RULE-24, calibrate writes no
 * trace events of its own). A basis conflict on the ledger entry is preflighted and, if
 * unresolved, refuses before either `writeCalibrationRecord` or any ledger write at all
 * (RULE-25) -- not just before the ledger half.
 */
export async function runCalibrate(
  intentId: string,
  opts: CalibrateOptions,
): Promise<CommandResult> {
  const specDir = resolveSpecDir({ override: opts.specDir });

  if (!laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: `Lane state not found: ${intentId}` };
  }
  if (!intentExists(specDir, intentId)) {
    return { exitCode: 2, message: `intent.yaml not found for ${intentId}` };
  }
  if (opts.sessionIds.length === 0) {
    return { exitCode: 1, message: "at least one --session-id is required" };
  }

  const since = parseTimestampOption("--since", opts.since);
  if (since.error) return { exitCode: 1, message: since.error };
  const until = parseTimestampOption("--until", opts.until);
  if (until.error) return { exitCode: 1, message: until.error };

  const intent = readIntent(specDir, intentId);
  const verification = readVerificationIfExists(specDir, intentId);

  const adapter = new AgentCostTelemetryAdapter({
    bin: opts.agentCostBin,
    timeoutMs: opts.agentCostTimeoutMs,
  });
  let measurement: Awaited<ReturnType<AgentCostTelemetryAdapter["measure"]>>;
  try {
    measurement = await adapter.measure(opts.sessionIds, {
      since: since.date,
      until: until.date,
    });
  } catch (err) {
    if (err instanceof TelemetryImportFailed) {
      return { exitCode: 2, message: `telemetry measurement failed: ${err.message}` };
    }
    throw err;
  }

  // must-1 (M2 review, 2026-07-31): rebuilding predictors from scratch here (as before)
  // always passed impactScan=undefined, silently reverting files_touched_estimate/
  // layers_crossed to null even when the adopted baseline revision *does* carry a real
  // impact-scan snapshot — degrading the k-NN population this very observation feeds back
  // into. When a baseline is adopted, carry its predictors over verbatim instead (they're
  // exactly what was estimated against, so reusing them is more faithful than
  // recomputing); only fall back to a freshly-built (necessarily impact-scan-less)
  // Predictors when there's no baseline to read from, and mark that case `imputed` rather
  // than `observed` since the impact-scan-derived dimensions are then genuinely unknown.
  // Read once and reused below for the prediction_evaluation step too.
  const estimate = readEstimateIfExists(specDir, intentId);
  const baseline = estimate ? findBaselineRevision(intent, estimate) : undefined;
  const predictors = baseline
    ? { ...baseline.predictors }
    : buildPredictorsFromIntent(intent, undefined, verification ?? undefined);
  const predictorQuality: MeasurementQuality = baseline ? "observed" : "imputed";
  if (opts.filesTouchedObserved != null)
    predictors.files_touched_observed = opts.filesTouchedObserved;

  const recordId = `cal-${computeDigest(
    JSON.stringify({
      intentId,
      sessionIds: [...opts.sessionIds].sort(),
      since: opts.since ?? null,
      until: opts.until ?? null,
    }),
  ).slice(0, 16)}`;
  const now = new Date().toISOString();

  // I-2026-09-10-agent-cost-v2-basis-gate (D7/D9) -- the same attribution projection
  // usage-import derives, window-independent (RULE-24: calibrate writes no trace events
  // of its own, so this reads the full, unfiltered trace ledger).
  const allTraceEvents = readTraceEvents();
  const attribution = buildAttributionProjection({
    usageImportedEvents: allTraceEvents.filter((e) => e.relation === "usage_imported"),
    sessionBoundEvents: allTraceEvents.filter((e) => e.relation === "session_bound"),
  });

  const observation = buildObservationFromMeasurement({
    recordId,
    intentId,
    recordedAt: now,
    predictors,
    predictorQuality,
    measurement,
    // PR #41 Copilot review -- the validated measurement's own session_ids (the union
    // agent-cost actually reported on), not opts.sessionIds (the requested ids): the
    // ledger entry below (buildLaneScopeLedgerEntries) already derives its eligibility
    // from measurement.session_ids, so the observation must be derived from the same set
    // or the two could disagree about which sessions this one measurement covers.
    sessionIds: measurement.session_ids,
    attribution,
  });
  // must-1 (Codex review round, 2026-08-08): a measurement can span more than one agent,
  // so this can be more than one entry (one per agent that actually contributed tokens) --
  // never a single entry that blends or misattributes a mixed measurement's cost. See
  // buildLaneScopeLedgerEntries' own doc comment (calibrate-service.ts).
  const ledgerEntries = buildLaneScopeLedgerEntries({
    laneId: intentId,
    measurement,
    since: since.date,
    until: until.date,
    importedAt: now,
    attribution,
  });

  const state = readLaneState(specDir, intentId);
  const doneGuarded = isDoneOverlayGuarded(specDir, intentId, state);
  const supersedeBasis = opts.supersedeBasis ?? false;

  // I-2026-09-10-agent-cost-v2-basis-gate (RULE-25) -- preflight every ledger entry this
  // call would write, before either half is written at all: a refused basis conflict
  // writes neither the observation nor the ledger entry, not just the ledger half.
  const existingLedgerForPreflight: readonly LedgerEntry[] = doneGuarded
    ? effectiveLedger(specDir, intentId, state)
    : state.cost_ledger;
  const conflictDiagnostics: string[] = [];
  for (const entry of ledgerEntries) {
    const existing = existingLedgerForPreflight.find(
      (e) => e.ledger_entry_id === entry.ledger_entry_id,
    );
    const plan = planBasisSupersession({ existing, incoming: entry, supersedeBasis });
    if (plan.action === "refuse") {
      conflictDiagnostics.push(plan.diagnostic);
    }
  }
  if (conflictDiagnostics.length > 0) {
    return { exitCode: 1, message: conflictDiagnostics.join("\n") };
  }

  // sol impl review 2 must-2/3 -- the full ledger-write payload (in-repo cost_ledger, or
  // the done overlay's ledger_delta) is composed entirely in memory *before* either half
  // is persisted. If this computation throws (planOrThrow's fail-closed invariant, or a
  // missing overlay), nothing has been written yet at all -- not the ledger, not the
  // observation -- so that failure is a clean "nothing recorded" error, not the partial
  // write the two separate try/catch blocks below still guard against (a genuine I/O
  // failure on one of the two writes themselves, which composing the payload first cannot
  // eliminate but does shrink to the smallest possible window).
  let ledgerWritePlan: { overlay: DoneOverlay } | { ledger: LedgerEntry[] };
  try {
    if (doneGuarded) {
      // Rule 7: post-done calibrate never rewrites in-repo lane-state.json. Still needs
      // to derive included_in_kpi against the *effective* ledger (in-repo + overlay
      // delta, composed the same way emit-metrics will read it) so the dedup rule
      // (ledger.ts's deriveIncludedInKpi) can see any existing phase-scoped entries --
      // only ledgerEntries themselves are then persisted, into the overlay's own delta.
      // effectiveLedger() already recomputes+clones (must-2 fix, done-overlay.ts), so the
      // second recompute below is over that already-fresh view plus this call's new
      // entries, never over a stale cached flag.
      let effective = effectiveLedger(specDir, intentId, state);
      for (const entry of ledgerEntries) {
        const existing = effective.find((e) => e.ledger_entry_id === entry.ledger_entry_id);
        const toWrite = planOrThrow(existing, entry, supersedeBasis);
        effective = upsertLedgerEntry(effective, toWrite);
      }
      const combined = recomputeIncludedInKpi([...effective]);
      // sol impl review 1 must-3/D8 -- every entry this call writes into the done
      // overlay's ledger_delta is composed in memory first and the overlay file is
      // written exactly once, not once per entry.
      const overlay = readDoneOverlay(specDir, intentId);
      if (!overlay) {
        throw new Error(
          `runCalibrate: isDoneOverlayGuarded reported a done overlay for ${intentId}, but readDoneOverlay found none`,
        );
      }
      let ledgerDelta = overlay.ledger_delta;
      for (const entry of ledgerEntries) {
        const recomputedEntry = combined.find((e) => e.ledger_entry_id === entry.ledger_entry_id);
        ledgerDelta = upsertLedgerEntry(ledgerDelta, recomputedEntry ?? entry);
      }
      ledgerWritePlan = { overlay: { ...overlay, ledger_delta: ledgerDelta } };
    } else {
      let updatedLedger: LedgerEntry[] = state.cost_ledger;
      for (const entry of ledgerEntries) {
        const existing = updatedLedger.find((e) => e.ledger_entry_id === entry.ledger_entry_id);
        const toWrite = planOrThrow(existing, entry, supersedeBasis);
        updatedLedger = upsertLedgerEntry(updatedLedger, toWrite);
      }
      ledgerWritePlan = { ledger: recomputeIncludedInKpi(updatedLedger) };
    }
  } catch (err) {
    return {
      exitCode: 2,
      message: `calibrate: failed to plan the ledger write -- nothing was recorded -- ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // spec.md Rule 1/2: both writes are upserts (safe to retry); if only one succeeds,
  // report a non-zero exit naming which half failed instead of a clean success message.
  // The plan above already succeeded, so the only remaining failure mode here is a
  // genuine I/O error on one of these two persists.
  let observationWritten = false;
  let observationError: unknown;
  try {
    writeCalibrationRecord(observation);
    observationWritten = true;
  } catch (err) {
    observationError = err;
  }

  let ledgerWritten = false;
  let ledgerError: unknown;
  try {
    if ("overlay" in ledgerWritePlan) {
      writeDoneOverlay(specDir, intentId, ledgerWritePlan.overlay);
    } else {
      writeLaneState(specDir, intentId, { ...state, cost_ledger: ledgerWritePlan.ledger });
    }
    ledgerWritten = true;
  } catch (err) {
    ledgerError = err;
  }

  if (!observationWritten || !ledgerWritten) {
    const describe = (label: string, ok: boolean, err: unknown) =>
      ok
        ? `${label}: recorded`
        : `${label}: FAILED (${err instanceof Error ? err.message : String(err)})`;
    return {
      exitCode: 2,
      message: `partial calibrate write -- ${describe("observation", observationWritten, observationError)}; ${describe("ledger entry", ledgerWritten, ledgerError)}. Both writes are idempotent upserts -- re-run the identical \`lane calibrate\` call to repair the missing half without duplicating the half that already succeeded.`,
    };
  }

  const lines = [
    `observation ${recordId}: tokens=${observation.actual.tokens} cost_usd=${observation.actual.estimated_cost_usd} pricing_status=${observation.actual.pricing_status} eligible_for_knn=${observation.eligible_for_knn} accounting_basis=${normalizeEntryBasis(observation).accountingBasis}`,
    ...ledgerEntries.map(
      (ledgerEntry) =>
        `ledger entry ${ledgerEntry.ledger_entry_id}: scope=lane agents=${ledgerEntry.agents?.join("+")} tokens=${ledgerEntry.tokens} cost_usd=${ledgerEntry.cost_usd} included_in_kpi=${ledgerEntry.included_in_kpi} accounting_basis=${normalizeEntryBasis(ledgerEntry).accountingBasis}`,
    ),
  ];

  if (baseline && baseline.predicted !== undefined) {
    const evalRecordId = `eval-${recordId}-${baseline.revision_id}`;
    const evaluation = evaluatePrediction(observation, baseline, evalRecordId, now);
    writeCalibrationRecord(evaluation);
    lines.push(
      `prediction_evaluation ${evalRecordId} vs baseline ${baseline.revision_id}: ` +
        `tokens relative_error_p50=${evaluation.error.tokens?.relative_error_p50} covered_by_p80=${evaluation.error.tokens?.covered_by_p80}`,
    );
  } else if (baseline) {
    // Defensive, not expected in practice: `lane estimate --adopt` refuses to adopt an
    // abstained (predicted-less) revision as baseline
    // (AbstainedRevisionCannotBeBaselineError, estimate-service.ts).
    lines.push(
      `baseline ${baseline.revision_id} is abstained (no predicted value) -- no prediction_evaluation recorded`,
    );
  } else {
    lines.push(
      "intent has no baseline_estimate_revision_id adopted yet — no prediction_evaluation recorded",
    );
  }

  const population = listObservations();
  lines.push(`calibration population is now ${population.length} observation(s)`);

  return { exitCode: 0, message: lines.join("\n") };
}
