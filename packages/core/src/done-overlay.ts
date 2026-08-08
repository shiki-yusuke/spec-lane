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
import type { GateOverride, LaneState, LedgerEntry } from "@lane/schemas";
import { LedgerEntrySchema } from "@lane/schemas";
import { z } from "zod";
import { upsertLedgerEntry } from "./ledger.js";
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

const DoneOverlaySchema = z.object({
  schema_version: z.literal(DONE_OVERLAY_SCHEMA_VERSION),
  intent_id: z.string(),
  verify_ended_at: z.string(),
  done_recorded_at: z.string(),
  pr_url: z.string().nullable(),
  merge_sha: z.string().nullable(),
  spec_dir: z.string(),
  spec_dir_fingerprint: z.string(),
  tool_version: z.string(),
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
});
export type DoneOverlay = z.infer<typeof DoneOverlaySchema>;

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
 * Reads a done overlay. Returns null (never throws) for anything that is missing,
 * malformed, or does not match `intentId` — an overlay is only ever treated as evidence of
 * "done" when it unambiguously belongs to this intent and carries a valid timestamp; any
 * arbitrary JSON on disk must not be able to fake completion.
 */
export function readDoneOverlay(specDir: string, intentId: string): DoneOverlay | null {
  const path = doneOverlayPath(specDir, intentId);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  const parsed = DoneOverlaySchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.intent_id !== intentId) return null;
  if (parseIsoAware(parsed.data.verify_ended_at) === null) return null;
  return parsed.data;
}

/** Atomic write (tmp file + rename). Overlay directory is created with 0700. */
export function writeDoneOverlay(specDir: string, intentId: string, payload: DoneOverlay): string {
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
  state: LaneState;
  verifyEndedAt: string;
  prUrl: string | null | undefined;
  mergeSha: string | null;
  toolVersion: string;
}

export function createDoneOverlay(input: CreateDoneOverlayInput): DoneOverlay {
  const payload: DoneOverlay = {
    schema_version: DONE_OVERLAY_SCHEMA_VERSION,
    intent_id: input.intentId,
    verify_ended_at: input.verifyEndedAt,
    done_recorded_at: new Date().toISOString(),
    pr_url: input.prUrl ?? input.state.pr_url ?? null,
    merge_sha: input.mergeSha,
    spec_dir: realpathSync(input.specDir),
    spec_dir_fingerprint: specDirFingerprint(input.specDir),
    tool_version: input.toolVersion,
    done_source: "local_overlay",
    // 5_done never touches in-repo state, so any usage-import gate override audit trail is
    // persisted here instead (accountability for a --force-usage-import at 4_verify->5_done).
    usage_import_gate_overrides: input.state.usage_import_gate_overrides,
    ledger_delta: [],
  };
  writeDoneOverlay(input.specDir, input.intentId, payload);
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
  return {
    ...state,
    phase_history: phaseHistory,
    current_phase: "5_done",
    status: "completed",
    updated_at: overlay.verify_ended_at,
    pr_url: overlay.pr_url ?? state.pr_url,
    pr_provenance: overlay.pr_url ? "done_overlay" : state.pr_provenance,
  };
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
 * MP-8 (2026-08-08, sol ruling point 4) — the *ledger* analog of loadStateWithOverlay's
 * state composition, kept as its own function (not folded into that one) since it
 * composes a different thing (cost_ledger, not phase_history/status) for a different
 * caller (emit-metrics, not status/next). Upserts the overlay's ledger_delta (if any)
 * over the in-repo cost_ledger by ledger_entry_id -- an overlay-recorded entry always
 * wins on collision, since it is by construction the more recent measurement (only ever
 * written *after* the overlay itself already existed).
 */
export function effectiveLedger(
  specDir: string,
  intentId: string,
  state: LaneState,
): readonly LedgerEntry[] {
  const overlay = readDoneOverlay(specDir, intentId);
  if (!overlay || overlay.ledger_delta.length === 0) return state.cost_ledger;
  let ledger: readonly LedgerEntry[] = state.cost_ledger;
  for (const entry of overlay.ledger_delta) {
    ledger = upsertLedgerEntry(ledger, entry);
  }
  return ledger;
}

/**
 * Upserts `entry` into the done overlay's own ledger_delta (spec.md Rule 7) and persists
 * the overlay. Throws if no overlay exists yet -- callers must only reach this after
 * confirming `isDoneOverlayGuarded` (an overlay is a precondition, not something this
 * function creates).
 */
export function upsertOverlayLedgerEntry(
  specDir: string,
  intentId: string,
  entry: LedgerEntry,
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
  writeDoneOverlay(specDir, intentId, updated);
  return updated;
}
