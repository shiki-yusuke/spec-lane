import { buildAttributionAuditResult, readTraceEvents } from "@lane/core";
import type { AttributionAuditResult } from "@lane/schemas";
import { effectiveLedgerSessionIds } from "../attribution-store.js";
import { listIntentIds } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, readLaneState } from "../state-store.js";
import type { CommandResult } from "./start.js";

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
  for (const intentId of listIntentIds(specDir)) {
    if (!laneStateExists(specDir, intentId)) continue;
    for (const id of effectiveLedgerSessionIds(
      specDir,
      intentId,
      readLaneState(specDir, intentId),
    )) {
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
