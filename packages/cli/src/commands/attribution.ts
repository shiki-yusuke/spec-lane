import { buildAttributionAuditResult, readTraceEvents } from "@lane/core";
import type { AttributionAuditResult } from "@lane/schemas";
import { ZodError } from "zod";
import { effectiveLedgerSessionIds } from "../attribution-store.js";
import { listIntentIds } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, readLaneState } from "../state-store.js";
import type { CommandResult } from "./start.js";

/** A raw ZodError's own `.message` is a formatted multi-line JSON dump of every issue --
 * fine for a single, targeted parse failure, but unreadable noise when a global scan
 * like `lane attribution audit` may need to report one per skipped (legacy, unmigrated)
 * intent. Reduced to "N issue(s), first: <path>: <message>" instead. */
function summarizeParseError(err: unknown): string {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const firstSummary = first ? `${first.path.join(".")}: ${first.message}` : "no issues?";
    return `${err.issues.length} validation issue(s), first: ${firstSummary}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface AttributionAuditOptions {
  specDir?: string;
  since?: string;
  until?: string;
  requireCoverage?: number;
}

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

function sessionCoverage(result: AttributionAuditResult): number {
  const total =
    result.sessions.exactly_attributed.length +
    result.sessions.unbound.length +
    result.sessions.mixed.length +
    result.sessions.orphan_usage.length +
    result.sessions.measurement_incomplete.length;
  if (total === 0) return 1;
  return result.sessions.exactly_attributed.length / total;
}

/**
 * `lane attribution audit [--since --until] [--require-coverage <ratio>]` — global (not
 * per-intent: the trace ledger and its binding/usage facts span every lane in this repo),
 * per M0 spec §4. stdout carries only the schema-conformant attribution/v1 audit-result
 * JSON (stdout purity convention); coverage/honesty diagnostics that the frozen contract
 * has no field for go to stderr.
 */
export function runAttributionAudit(opts: AttributionAuditOptions): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir });
  const since = parseTimestampOption("--since", opts.since);
  if (since.error) return { exitCode: 1, message: since.error };
  const until = parseTimestampOption("--until", opts.until);
  if (until.error) return { exitCode: 1, message: until.error };

  const ledgerSessionIds = new Set<string>();
  const skippedIntents: string[] = [];
  for (const intentId of listIntentIds(specDir)) {
    if (!laneStateExists(specDir, intentId)) continue;
    // spec-lane 0.5.1 (dogfood bug report, 2026-08-09): this is the one command that
    // scans *every* intent under specDir rather than one named on the command line, so a
    // single intent whose lane-state.json cannot be parsed -- most commonly real,
    // never-migrated legacy data from the Python reference implementation (an old
    // cost_ledger shape `lane migrate-legacy-ledger` exists specifically to convert, not
    // something the live read path is meant to accept directly) -- must not take down
    // the whole audit for every other, readable intent. Skipped, not zero-filled or
    // silently ignored: reported via both a stderr diagnostic and `coverage_scope`-style
    // honesty (recorded in `diagnostics` below), so the audit's own coverage is never
    // overstated.
    let state: ReturnType<typeof readLaneState>;
    try {
      state = readLaneState(specDir, intentId);
    } catch (err) {
      skippedIntents.push(intentId);
      process.stderr.write(
        `intent ${intentId}: lane-state.json could not be parsed (${summarizeParseError(err)}) -- skipped from this audit's ledger cross-reference. If this is legacy data, try \`lane migrate-legacy-ledger\` first.\n`,
      );
      continue;
    }
    for (const id of effectiveLedgerSessionIds(specDir, intentId, state)) {
      ledgerSessionIds.add(id);
    }
  }

  const { result, diagnostics } = buildAttributionAuditResult({
    since: since.date,
    until: until.date,
    generatedAt: new Date().toISOString(),
    traceEvents: readTraceEvents(),
    ledgerSessionIds: [...ledgerSessionIds],
  });

  for (const line of diagnostics) process.stderr.write(`${line}\n`);
  if (skippedIntents.length > 0) {
    process.stderr.write(
      `coverage_scope: ${skippedIntents.length} intent(s) excluded from this audit's cost_ledger cross-reference because their lane-state.json failed to parse: ${skippedIntents.join(", ")}\n`,
    );
  }

  if (opts.requireCoverage !== undefined) {
    const coverage = sessionCoverage(result);
    if (!result.research_eligible || coverage < opts.requireCoverage) {
      process.stderr.write(
        `coverage gate failed: research_eligible=${result.research_eligible}, coverage=${coverage.toFixed(4)} < required ${opts.requireCoverage}\n`,
      );
      return { exitCode: 3, message: JSON.stringify(result, null, 2) };
    }
  }

  return { exitCode: 0, message: JSON.stringify(result, null, 2) };
}
