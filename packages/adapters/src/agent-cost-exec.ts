// issue #42 / spec I-2026-09-17-calibrate-agent-cost-timeout (D1, D3, D7) -- shared
// agent-cost subprocess policy used by both AgentCostTelemetryAdapter (telemetry) and
// CodexBudgetAdapter (budget). Lives here rather than in either directory so neither
// adapter has to import from the other's directory (SCOPE-2).
//
// D7: `timeoutMs` is when Node sends `killSignal` (default SIGTERM) to the child -- not a
// hard wall-clock bound. If the child ignores SIGTERM the wait is unbounded, same as
// before this change; this lane does not switch to SIGKILL.

/** Default timeout (ms) before agent-cost's subprocess is sent SIGTERM. D1: 4.4x the
 * slowest observed transcript scan (40.9s) that motivated raising this from 30_000. */
export const DEFAULT_AGENT_COST_TIMEOUT_MS = 180_000;

/** Upper bound (ms) accepted by the CLI's `--agent-cost-timeout-ms` flag (D4). */
export const MAX_AGENT_COST_TIMEOUT_MS = 3_600_000;

export type AgentCostVerb = "measure" | "report";

/**
 * Converts an `execFileAsync` rejection into the human-readable message each adapter
 * throws. Node's `execFile` rejects a timed-out child with `killed: true` and
 * `signal: <killSignal>` (default `"SIGTERM"`) -- when that shape is present (RULE-04),
 * the message names the timeout explicitly instead of folding it into the generic
 * `Command failed` text. Any other failure keeps the pre-change message unchanged
 * (RULE-05).
 */
export function describeAgentCostFailure(
  verb: AgentCostVerb,
  bin: string,
  timeoutMs: number,
  err: unknown,
): string {
  if (typeof err === "object" && err !== null && (err as { killed?: boolean }).killed === true) {
    const signal = (err as { signal?: string }).signal ?? "unknown signal";
    return `agent-cost ${verb} timed out after ${timeoutMs} ms (killed with ${signal}) (bin=${bin})`;
  }
  return `agent-cost ${verb} failed (bin=${bin}): ${err instanceof Error ? err.message : String(err)}`;
}
