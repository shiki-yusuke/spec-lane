import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EffectiveRiskEvaluation, GateOverride, LaneState, LedgerEntry } from "@lane/schemas";
import {
  EffectiveRiskEvaluationSchema,
  LedgerEntrySchema,
  RulesetMigrationSchema,
  WeakeningAcknowledgementSchema,
} from "@lane/schemas";
import { z } from "zod";
import { recomputeIncludedInKpi, upsertLedgerEntry } from "./ledger.js";
import { compareToolVersion, parseToolVersion } from "./tool-version.js";
import { resolveDataDir } from "./xdg.js";

// design.md §3.6 — done overlay, ported unchanged (logic-wise) from the Python reference implementation
// orchestrator.py (v0.2.0 design, lines 87-255): `advance --phase 5_done` can only run
// after the PR has merged, so if it wrote into the in-repo lane-state.json it would force
// a docs-only commit + direct push to main after every merge. Instead the merge itself is
// treated as the done signal, and 5_done is recorded only in a local overlay file outside
// the repo; the in-repo state's terminal phase stays 4_verify and status/list/stats/
// export-evidence merge the overlay in at read time.
//
// The on-disk overlay schema_version ("1.0") is independent of LaneState's
// schema_version and is not expected to change in lockstep with it.
export const DONE_OVERLAY_SCHEMA_VERSION = "1.0";

// issue #50 — 0.10.x's outer schema was a plain z.object() (unknown keys stripped), so a
// 0.11+ binary's new fields (e.g. state_delta) were silently discarded by any 0.10.x
// read-then-rewrite. 0.10.x itself can't be fixed post-release; from 0.11 on the schema is
// `.passthrough()` (outer and state_delta both) so an unknown-to-this-binary field survives
// a read/rewrite round trip instead of being dropped -- known fields are still fully
// type-checked, only genuinely unrecognized keys pass through untouched.
const DoneOverlaySchema = z
  .object({
    schema_version: z.literal(DONE_OVERLAY_SCHEMA_VERSION),
    intent_id: z.string(),
    verify_ended_at: z.string(),
    done_recorded_at: z.string(),
    pr_url: z.string().nullable(),
    merge_sha: z.string().nullable(),
    spec_dir: z.string(),
    spec_dir_fingerprint: z.string(),
    tool_version: z.string(),
    // issue #50 — the SemVer of whichever binary last successfully wrote this file (via
    // updateDoneOverlay), stamped fresh on every rewrite; `tool_version` above stays the
    // *creating* binary's version and is never touched again. Additive/defaulted (`.optional()`,
    // no default): does not bump DONE_OVERLAY_SCHEMA_VERSION, since a pre-existing overlay
    // simply parses with this field absent, and assertDoneOverlayWritable already treats an
    // absent value as "same as tool_version".
    last_writer_tool_version: z.string().optional(),
    done_source: z.literal("local_overlay"),
    usage_import_gate_overrides: z.array(z.unknown()),
    // MP-8 (2026-08-08, sol ruling point 4) — a lane can be calibrated after its done
    // overlay already exists (the documented lane-finish flow does exactly this: 5_done
    // first, then calibrate). Rewriting in-repo lane-state.json at that point would defeat
    // the whole reason this overlay exists (design.md's own "merge is the done signal,
    // don't force a docs-only commit + direct push to main" principle) -- so a post-done
    // calibrate's ledger entry is upserted here instead. Additive/defaulted: does not bump
    // DONE_OVERLAY_SCHEMA_VERSION, since an *existing* overlay file's meaning is unchanged
    // by this field's mere presence or absence.
    ledger_delta: z.array(LedgerEntrySchema).default([]),
    // issue #46 — the in-repo `lane-state.json` byte-identical contract (design.md §3.6) was
    // only half-kept: `current_phase` never moved off `4_verify`, but `advance --phase
    // 5_done` still wrote `stateForDone` (the 5_done-time effective_risk_log entry, plus any
    // R5 ruleset-migration ack / R8 weakening-rationale acceptance) back into the in-repo
    // file. Those records now live here instead, the same way `ledger_delta` above already
    // holds a post-done calibrate's ledger entry rather than rewriting in-repo state.
    // Additive/defaulted: does not bump DONE_OVERLAY_SCHEMA_VERSION, since an *existing*
    // overlay file's meaning is unchanged by this field's mere presence or absence -- a
    // pre-fix overlay simply parses with every array empty and no gate_ruleset_version.
    state_delta: z
      .object({
        effective_risk_log: z.array(EffectiveRiskEvaluationSchema).default([]),
        ruleset_migrations: z.array(RulesetMigrationSchema).default([]),
        weakening_acknowledgements: z.array(WeakeningAcknowledgementSchema).default([]),
        gate_ruleset_version: z.string().optional(),
      })
      // issue #50 — was `.strict()`; a 0.10.x binary's outer z.object() (no passthrough)
      // already dropped any field this schema didn't know about, so state_delta itself never
      // needed to reject unknown keys to prevent data loss -- it only needed to keep validating
      // its own known fields. `.passthrough()` here (matching the outer object, above) lets a
      // future binary's state_delta addition survive an 0.11.x read/rewrite instead of being
      // stripped or rejected.
      .passthrough()
      .default({
        effective_risk_log: [],
        ruleset_migrations: [],
        weakening_acknowledgements: [],
      }),
  })
  // issue #50 — see the field-level comments above: unknown top-level keys (a future
  // binary's addition this one doesn't recognize yet) must survive a read/rewrite by this
  // binary, not be silently stripped.
  .passthrough();
export type DoneOverlay = z.infer<typeof DoneOverlaySchema>;
export type DoneOverlayStateDelta = DoneOverlay["state_delta"];

function specDirFingerprint(specDir: string): string {
  const real = realpathSync(specDir);
  return createHash("sha1").update(real, "utf-8").digest("hex").slice(0, 16);
}

export function doneOverlayPath(specDir: string, intentId: string): string {
  return join(resolveDataDir(), "done", specDirFingerprint(specDir), `${intentId}.json`);
}

/** ISO 8601 parse that requires a timezone offset (naive/local timestamps are rejected). */
function parseIsoAware(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!/[+-]\d{2}:\d{2}$|Z$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * issue #50 — result of inspecting whatever is (or isn't) on disk for this overlay path,
 * distinguishing "no overlay was ever written" (`absent`, a normal, common state -- most
 * lanes simply haven't finished yet) from "a file exists but this binary can't trust it"
 * (`unreadable`: bad JSON, a schema mismatch, an `intent_id` that doesn't match, or an
 * invalid `verify_ended_at`). Mutating CLI commands must fail closed on `unreadable` (never
 * treat it the same as `absent`, which would silently proceed as if the lane weren't done
 * yet) -- `readDoneOverlay` below collapses both into `null` for read-only call sites
 * (status/list/stats/evidence export) that have always treated "not confirmed done" as one
 * case.
 */
export type DoneOverlayInspection =
  | { kind: "absent" }
  | { kind: "valid"; overlay: DoneOverlay }
  | { kind: "unreadable"; path: string; reason: string };

export function inspectDoneOverlay(specDir: string, intentId: string): DoneOverlayInspection {
  const path = doneOverlayPath(specDir, intentId);
  if (!existsSync(path)) return { kind: "absent" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return {
      kind: "unreadable",
      path,
      reason: `invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const parsed = DoneOverlaySchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "unreadable", path, reason: "does not match the done overlay schema" };
  }
  if (parsed.data.intent_id !== intentId) {
    return {
      kind: "unreadable",
      path,
      reason: `intent_id mismatch (expected ${intentId}, found ${parsed.data.intent_id})`,
    };
  }
  if (parseIsoAware(parsed.data.verify_ended_at) === null) {
    return {
      kind: "unreadable",
      path,
      reason: `verify_ended_at is not an ISO 8601 timestamp with a timezone offset: ${parsed.data.verify_ended_at}`,
    };
  }
  return { kind: "valid", overlay: parsed.data };
}

/**
 * Reads a done overlay. Returns null (never throws) for anything that is missing,
 * malformed, or does not match `intentId` — an overlay is only ever treated as evidence of
 * "done" when it unambiguously belongs to this intent and carries a valid timestamp; any
 * arbitrary JSON on disk must not be able to fake completion. Read-only call sites
 * (status/list/stats/evidence export) keep this exact, unchanged behavior (issue #50) --
 * only mutating commands need to tell `absent` and `unreadable` apart, via
 * `inspectDoneOverlay` above.
 */
export function readDoneOverlay(specDir: string, intentId: string): DoneOverlay | null {
  const result = inspectDoneOverlay(specDir, intentId);
  return result.kind === "valid" ? result.overlay : null;
}

/**
 * issue #50 — no longer exported: every write must go through `updateDoneOverlay` (which
 * asserts forward-compat before rewriting an *existing* overlay) or `createDoneOverlay`
 * (the one call site allowed to write the first overlay, since there is nothing on disk yet
 * to lose). Atomic write (tmp file + rename). Overlay directory is created with 0700.
 */
function writeDoneOverlayFile(specDir: string, intentId: string, payload: DoneOverlay): string {
  const path = doneOverlayPath(specDir, intentId);
  mkdirSync(join(path, ".."), { recursive: true });
  try {
    chmodSync(join(path, ".."), 0o700);
  } catch {
    // best-effort; non-POSIX filesystems may not support chmod
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, path);
  return path;
}

export interface CreateDoneOverlayInput {
  specDir: string;
  intentId: string;
  /**
   * The final, fully-computed state for this transition (`stateForDone` in advance.ts):
   * the risk evaluation recorded for this 5_done call, plus any R5 ruleset-migration ack
   * / R8 weakening-rationale acceptance recorded alongside it.
   */
  state: LaneState;
  /**
   * The in-repo state exactly as read at the top of this advance call, *before*
   * recordEffectiveRiskEvaluation (or any of the 5_done-only mutations) touched it -- the
   * diff base for `state_delta`. Using `state` itself as the base would lose the very
   * risk-evaluation entry this 5_done call appended, since that entry is already present
   * in `state` by the time this function runs (issue #46).
   */
  originalState: LaneState;
  verifyEndedAt: string;
  prUrl: string | null | undefined;
  mergeSha: string | null;
  toolVersion: string;
}

export function createDoneOverlay(input: CreateDoneOverlayInput): DoneOverlay {
  const { state, originalState } = input;
  const gateRulesetVersion =
    state.gate_ruleset_version !== originalState.gate_ruleset_version
      ? state.gate_ruleset_version
      : undefined;
  const payload: DoneOverlay = {
    schema_version: DONE_OVERLAY_SCHEMA_VERSION,
    intent_id: input.intentId,
    verify_ended_at: input.verifyEndedAt,
    done_recorded_at: new Date().toISOString(),
    pr_url: input.prUrl ?? state.pr_url ?? null,
    merge_sha: input.mergeSha,
    spec_dir: realpathSync(input.specDir),
    spec_dir_fingerprint: specDirFingerprint(input.specDir),
    tool_version: input.toolVersion,
    done_source: "local_overlay",
    // 5_done never touches in-repo state, so any usage-import gate override audit trail is
    // persisted here instead (accountability for a --force-usage-import at 4_verify->5_done).
    usage_import_gate_overrides: state.usage_import_gate_overrides,
    ledger_delta: [],
    // issue #46 — everything advance.ts computed for *this* 5_done call and used to write
    // back into in-repo state: sliced against originalState so only the newly-appended
    // tail of each array is captured here (the rest already lives in-repo from earlier
    // transitions and must not be duplicated by applyDoneOverlay).
    state_delta: {
      effective_risk_log: state.effective_risk_log.slice(originalState.effective_risk_log.length),
      ruleset_migrations: (state.ruleset_migrations ?? []).slice(
        (originalState.ruleset_migrations ?? []).length,
      ),
      weakening_acknowledgements: (state.weakening_acknowledgements ?? []).slice(
        (originalState.weakening_acknowledgements ?? []).length,
      ),
      gate_ruleset_version: gateRulesetVersion,
    },
  };
  writeDoneOverlayFile(input.specDir, input.intentId, payload);
  return payload;
}

/**
 * Composes the in-repo (4_verify) state with a done overlay into a completed view.
 * Does not mutate `state`. Closes the in_progress 4_verify entry using verify_ended_at
 * (not "now") so cycle time reflects the PR's actual merge time, not whenever someone
 * later ran the finish command. Matches the Python reference implementation orchestrator.py's apply_done_overlay
 * (lines 164-191) exactly, including closing only the *first* matching in_progress
 * 4_verify entry (there should only ever be one, but the port stays literal rather than
 * assuming that).
 */
export function applyDoneOverlay(state: LaneState, overlay: DoneOverlay): LaneState {
  let closed = false;
  const phaseHistory = state.phase_history.map((ph) => {
    if (!closed && ph.phase === "4_verify" && ph.result === "in_progress") {
      closed = true;
      return { ...ph, ended_at: overlay.verify_ended_at, result: "completed" as const };
    }
    return ph;
  });
  phaseHistory.push({
    phase: "5_done",
    started_at: overlay.verify_ended_at,
    result: "completed",
    retry_count: 0,
  });
  const delta = overlay.state_delta;
  return {
    ...state,
    phase_history: phaseHistory,
    current_phase: "5_done",
    status: "completed",
    updated_at: overlay.verify_ended_at,
    pr_url: overlay.pr_url ?? state.pr_url,
    pr_provenance: overlay.pr_url ? "done_overlay" : state.pr_provenance,
    // issue #46 — the 5_done-time audit records (risk evaluation, R5 migration ack, R8
    // weakening rationale) never reach in-repo state; append them here so status/list/
    // stats/evidence-export see the same view they did before that fix.
    //
    // issue #47 — `validate` on an in-repo 4_verify state keeps appending
    // effective_risk_log entries after this lane's done overlay was recorded, so by the
    // time this runs those post-done in-repo entries can be dated *after* the delta's own
    // 5_done entry. A plain append would then leave the composed log out of evaluated_at
    // order. Merge-sort instead: stable by evaluated_at, in-repo entries winning ties, so
    // the common case (delta is chronologically last) is unaffected and only the
    // regression case gets reordered.
    effective_risk_log:
      delta.effective_risk_log.length > 0
        ? mergeByEvaluatedAt(state.effective_risk_log, delta.effective_risk_log)
        : state.effective_risk_log,
    ruleset_migrations: appendOverlayDelta(state.ruleset_migrations, delta.ruleset_migrations),
    weakening_acknowledgements: appendOverlayDelta(
      state.weakening_acknowledgements,
      delta.weakening_acknowledgements,
    ),
    gate_ruleset_version: delta.gate_ruleset_version ?? state.gate_ruleset_version,
  };
}

/**
 * issue #47 — stable merge of two already-produced-in-order sequences by `evaluated_at`,
 * ties keeping `inRepo`'s entry first. A plain `Array.prototype.sort` would also work but
 * is not guaranteed stable across engines for equal keys; this is explicit about the tie
 * rule the composed audit log depends on (in-repo entries predate a done overlay's delta
 * in the common case, so ties should preserve that reading order).
 *
 * Compares by parsed instant (`Date.parse`), not lexicographically: the schema allows a
 * numeric offset (`+09:00`) alongside `Z`, and two equal instants written in different
 * offsets (or with different fractional-second precision) don't compare correctly as
 * strings. If either side fails to parse, the comparison is skipped and `fromRepo` is
 * taken -- the merge falls through to appending each list in its own original order
 * instead of throwing or guessing at a reordering from unparseable data.
 */
function mergeByEvaluatedAt(
  inRepo: readonly EffectiveRiskEvaluation[],
  delta: readonly EffectiveRiskEvaluation[],
): EffectiveRiskEvaluation[] {
  const merged: EffectiveRiskEvaluation[] = [];
  let i = 0;
  let j = 0;
  while (i < inRepo.length && j < delta.length) {
    const fromRepo = inRepo[i] as EffectiveRiskEvaluation;
    const fromDelta = delta[j] as EffectiveRiskEvaluation;
    const repoInstant = Date.parse(fromRepo.evaluated_at);
    const deltaInstant = Date.parse(fromDelta.evaluated_at);
    const deltaIsEarlier =
      !Number.isNaN(repoInstant) && !Number.isNaN(deltaInstant) && deltaInstant < repoInstant;
    if (deltaIsEarlier) {
      merged.push(fromDelta);
      j++;
    } else {
      merged.push(fromRepo);
      i++;
    }
  }
  while (i < inRepo.length) merged.push(inRepo[i++] as EffectiveRiskEvaluation);
  while (j < delta.length) merged.push(delta[j++] as EffectiveRiskEvaluation);
  return merged;
}

/**
 * `ruleset_migrations`/`weakening_acknowledgements` are `.optional()` with no default (see
 * lane-state.ts's own comment on that choice) -- an empty delta must leave `base` exactly
 * as it was (including genuinely `undefined`), not coerce it into `[]`.
 */
function appendOverlayDelta<T>(base: T[] | undefined, delta: readonly T[]): T[] | undefined {
  if (delta.length === 0) return base;
  return [...(base ?? []), ...delta];
}

export type DoneSource = "in_repo" | "local_overlay" | null;

/** Returns [state-with-overlay-applied-if-any, doneSource]. */
export function loadStateWithOverlay(
  specDir: string,
  intentId: string,
  state: LaneState,
): [LaneState, DoneSource] {
  if (state.current_phase === "5_done") return [state, "in_repo"];
  if (state.current_phase === "4_verify") {
    const overlay = readDoneOverlay(specDir, intentId);
    if (overlay) return [applyDoneOverlay(state, overlay), "local_overlay"];
  }
  return [state, null];
}

/**
 * True (= reject the mutating command) if this lane has already completed via overlay.
 * Mutating in-repo state after an overlay exists would desync the overlay's
 * verify_ended_at-derived cycle time and status from what's actually on disk.
 */
export function isDoneOverlayGuarded(specDir: string, intentId: string, state: LaneState): boolean {
  return state.current_phase === "4_verify" && readDoneOverlay(specDir, intentId) !== null;
}

/**
 * issue #50 — thrown by `assertDoneOverlayWritable` when the overlay on disk was last
 * touched by a *newer* lane binary than the one about to rewrite it. `overlayVersion` is
 * whichever of the overlay's own `tool_version`/`last_writer_tool_version` is newer (or,
 * when either fails to parse as SemVer, the fail-closed candidate reported); `toolVersion`
 * is the running binary's version that was refused.
 */
export class DoneOverlayVersionError extends Error {
  constructor(
    public readonly overlayVersion: string,
    public readonly toolVersion: string,
  ) {
    super(
      `done overlay was last written by lane ${overlayVersion}, which is newer than (or not comparable to) the running binary's version ${toolVersion} -- refusing to write, since this binary may not understand every field the newer one recorded`,
    );
    this.name = "DoneOverlayVersionError";
  }
}

/**
 * issue #50 (S4) — the forward-compat write guard: refuses (throws) whenever the effective
 * version already recorded on `overlay` -- `max(tool_version, last_writer_tool_version ??
 * tool_version)` -- is strictly newer than `toolVersion` (the running binary), or whenever
 * any of the three versions involved isn't valid SemVer (fail closed, never guess at an
 * ordering `compareToolVersion` can't establish). Equal or older is allowed through
 * silently -- this function only ever throws, it never mutates anything itself.
 */
export function assertDoneOverlayWritable(overlay: DoneOverlay, toolVersion: string): void {
  const lastWriter = overlay.last_writer_tool_version ?? overlay.tool_version;
  const parsedToolVersionField = parseToolVersion(overlay.tool_version);
  const parsedLastWriter = parseToolVersion(lastWriter);
  const parsedRunning = parseToolVersion(toolVersion);

  if (!parsedToolVersionField || !parsedLastWriter || !parsedRunning) {
    // Name the overlay field that actually failed to parse, so a malformed creator version
    // isn't hidden behind a valid last-writer one; only when both overlay fields parse (the
    // running version is the bad one) report the newer of the two.
    const overlayVersion = !parsedToolVersionField
      ? overlay.tool_version
      : !parsedLastWriter
        ? lastWriter
        : compareToolVersion(overlay.tool_version, lastWriter) >= 0
          ? overlay.tool_version
          : lastWriter;
    throw new DoneOverlayVersionError(overlayVersion, toolVersion);
  }

  const overlayVersion =
    compareToolVersion(overlay.tool_version, lastWriter) >= 0 ? overlay.tool_version : lastWriter;
  if (compareToolVersion(overlayVersion, toolVersion) > 0) {
    throw new DoneOverlayVersionError(overlayVersion, toolVersion);
  }
}

/**
 * issue #50 (S4) — the only way to rewrite an *existing* done overlay (creation itself is
 * `createDoneOverlay`'s job, which has nothing on disk yet to guard). Asserts against the
 * overlay as it stands on disk right now (not against `next`, the caller's in-memory
 * payload -- a caller could otherwise race past a version bump that happened between its
 * own read and this write), throws `DoneOverlayVersionError` on a version refusal, and
 * throws a plain `Error` if there is nothing safely readable to assert against at all
 * (`absent`: nothing to update; `unreadable`: this binary can't trust what's already there
 * enough to overwrite it). On success, stamps `last_writer_tool_version` with the running
 * binary's own version (never `tool_version`, which stays whatever binary first created the
 * overlay) and writes atomically.
 */
export function updateDoneOverlay(
  specDir: string,
  intentId: string,
  toolVersion: string,
  next: DoneOverlay,
): DoneOverlay {
  const current = inspectDoneOverlay(specDir, intentId);
  if (current.kind === "absent") {
    throw new Error(
      `updateDoneOverlay: no done overlay exists yet for ${intentId} at ${doneOverlayPath(specDir, intentId)} -- call this only once a done overlay has already been created`,
    );
  }
  if (current.kind === "unreadable") {
    throw new Error(
      `updateDoneOverlay: done overlay for ${intentId} at ${current.path} is unreadable (${current.reason}) -- refusing to overwrite an overlay this binary cannot parse`,
    );
  }
  // Re-checked against the file as it is *now*, not the caller's earlier preflight, so a
  // newer lane that wrote this overlay any time before this read is refused. This is a
  // guard for *sequential* mixed-version use (issue #50's scenario), not a concurrency
  // control: the read-check and the rename below are not atomic, so two lane processes
  // writing the same intent's overlay at the same moment can still clobber each other --
  // exactly as they can for lane-state.json, calibration records and trace events, none of
  // which lane locks either. Concurrent writers on one intent are unsupported repo-wide;
  // making them safe (a per-intent lock or a CAS around every writer) is its own change.
  assertDoneOverlayWritable(current.overlay, toolVersion);
  const payload: DoneOverlay = { ...next, last_writer_tool_version: toolVersion };
  writeDoneOverlayFile(specDir, intentId, payload);
  return payload;
}

/**
 * MP-8 (2026-08-08, sol ruling point 4) — the *ledger* analog of loadStateWithOverlay's
 * state composition, kept as its own function (not folded into that one) since it
 * composes a different thing (cost_ledger, not phase_history/status) for a different
 * caller (emit-metrics, not status/next). Upserts the overlay's ledger_delta (if any)
 * over the in-repo cost_ledger by ledger_entry_id -- an overlay-recorded entry always
 * wins on collision, since it is by construction the more recent measurement (only ever
 * written *after* the overlay itself already existed).
 *
 * MP-8 must-2 fix (2026-08-08, Codex review round) — always recomputes included_in_kpi
 * over the fully-composed result before returning, rather than trusting whichever
 * persisted flag each entry happens to carry (in-repo or overlay). The persisted flag is
 * a cache, never the source of truth: calibrate.ts only ever re-persists the *newly
 * built* entry after a re-calibrate, never every existing entry whose inclusion may have
 * flipped as a byproduct (e.g. a re-calibrate with a new pricing_version creates a new
 * ledger_entry_id rather than upserting in place, which should retroactively supersede —
 * and exclude — the older entry; without a read-time recompute, that older entry's stale
 * `included_in_kpi:true` survives forever in the overlay's ledger_delta and both entries
 * would double-count toward the KPI population). Clones each entry (`{...entry}`) before
 * recomputing, since recomputeIncludedInKpi mutates its array's entries by reference —
 * without cloning, this would silently mutate `state.cost_ledger`'s own entry objects out
 * from under the caller.
 */
export function effectiveLedger(
  specDir: string,
  intentId: string,
  state: LaneState,
): readonly LedgerEntry[] {
  const overlay = readDoneOverlay(specDir, intentId);
  let ledger: readonly LedgerEntry[] = state.cost_ledger;
  if (overlay && overlay.ledger_delta.length > 0) {
    for (const entry of overlay.ledger_delta) {
      ledger = upsertLedgerEntry(ledger, entry);
    }
  }
  return recomputeIncludedInKpi(ledger.map((entry) => ({ ...entry })));
}

/**
 * Upserts `entry` into the done overlay's own ledger_delta (spec.md Rule 7) and persists
 * the overlay via `updateDoneOverlay`. Throws if no overlay exists yet -- callers must only
 * reach this after confirming `isDoneOverlayGuarded` (an overlay is a precondition, not
 * something this function creates) -- or (issue #50) if the overlay on disk was last
 * written by a newer lane binary than `toolVersion` (`DoneOverlayVersionError`, propagated
 * from `updateDoneOverlay`/`assertDoneOverlayWritable`).
 */
export function upsertOverlayLedgerEntry(
  specDir: string,
  intentId: string,
  entry: LedgerEntry,
  toolVersion: string,
): DoneOverlay {
  const overlay = readDoneOverlay(specDir, intentId);
  if (!overlay) {
    throw new Error(
      `upsertOverlayLedgerEntry: no done overlay exists yet for ${intentId} -- call this only after isDoneOverlayGuarded confirms one does`,
    );
  }
  const updated: DoneOverlay = {
    ...overlay,
    ledger_delta: upsertLedgerEntry(overlay.ledger_delta, entry),
  };
  return updateDoneOverlay(specDir, intentId, toolVersion, updated);
}
