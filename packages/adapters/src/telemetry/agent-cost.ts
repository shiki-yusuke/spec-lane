import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanAgentMetricsPersonalDimensions } from "@lane/core";
import type { TelemetryAdapter, TelemetryMeasureOptions } from "@lane/core";
import { type AgentCostMeasureResult, AgentCostMeasureResultSchema } from "@lane/schemas";

const execFileAsync = promisify(execFile);

/**
 * agent-cost's --since/--until parse via Python's `datetime.fromisoformat` (agent-cost
 * cli.py's `_parse_window_bound`), which on the Python version agent-cost targets does not
 * accept a "Z" UTC suffix — only an explicit numeric offset. `Date.toISOString()` always
 * emits "Z", so it is not directly usable as this flag's value.
 */
function toPythonIsoformat(date: Date): string {
  return date.toISOString().replace("Z", "+00:00");
}

export class TelemetryImportFailed extends Error {}

export interface AgentCostTelemetryAdapterOptions {
  /** Binary name (resolved via PATH) or absolute path. Defaults to "agent-cost". */
  bin?: string;
  timeoutMs?: number;
}

// design.md §4.1 — thin subprocess wrapper around agent-cost's real `measure/v1` contract.
// No log-scanning, no window-to-session discovery: the caller already knows which
// session ids to ask about (see ports/telemetry.ts's doc comment for why).
export class AgentCostTelemetryAdapter implements TelemetryAdapter {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: AgentCostTelemetryAdapterOptions = {}) {
    this.bin = opts.bin ?? "agent-cost";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async measure(
    sessionIds: readonly string[],
    opts: TelemetryMeasureOptions = {},
  ): Promise<AgentCostMeasureResult> {
    if (sessionIds.length === 0) {
      throw new TelemetryImportFailed("measure requires at least one session id");
    }

    const args = ["measure", "--format", "json"];
    for (const id of sessionIds) args.push("--session-id", id);
    if (opts.since) args.push("--since", toPythonIsoformat(opts.since));
    if (opts.until) args.push("--until", toPythonIsoformat(opts.until));
    if (opts.agents?.length) args.push("--agent", opts.agents.join(","));

    let stdout: string;
    let stderr: string;
    try {
      const result = await execFileAsync(this.bin, args, {
        timeout: this.timeoutMs,
        encoding: "utf-8",
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      throw new TelemetryImportFailed(
        `agent-cost measure failed (bin=${this.bin}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (stderr) {
      // agent-cost's own contract: exit 0 means success, and it only writes error
      // detail to stderr on a non-zero exit. A non-empty stderr alongside exit 0 is
      // unexpected and worth surfacing rather than silently ignoring.
      throw new TelemetryImportFailed(
        `agent-cost measure wrote to stderr on a successful exit: ${stderr}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new TelemetryImportFailed("agent-cost measure did not return valid JSON on stdout");
    }
    const validated = AgentCostMeasureResultSchema.safeParse(parsed);
    if (!validated.success) {
      throw new TelemetryImportFailed(
        `agent-cost measure output failed schema validation: ${validated.error.message}`,
      );
    }
    if (validated.data.protocol_version !== "measure/v1") {
      throw new TelemetryImportFailed(
        `unsupported agent-cost protocol_version: ${validated.data.protocol_version} (lane supports measure/v1)`,
      );
    }

    // sol review must3 (#51) — measure/v1's own schema is deliberately open
    // (no additionalProperties:false anywhere, see
    // ai-agent-skills-playbook's docs/protocols/measure-v1.md), so
    // AgentCostMeasureResultSchema above (a plain, non-.strict() z.object())
    // silently strips an unrecognized key rather than rejecting it — it will
    // never itself catch a forbidden personal-dimension key. Scanned here,
    // in the actual subprocess boundary that receives untrusted agent-cost
    // output, not only in this repo's own fixture-conformance test — an open
    // schema means there is no additionalProperties:false doing this for
    // free. Scans `parsed` (the raw, pre-Zod-strip JSON), not
    // `validated.data`, for exactly that reason. Reuses the same 11-key
    // agent-metrics/v1 denylist already used elsewhere in this repo, since
    // measure/v1 carries no legitimate per-actor identity of its own.
    const personalDimensionViolations = scanAgentMetricsPersonalDimensions(parsed);
    if (personalDimensionViolations.length > 0) {
      throw new TelemetryImportFailed(
        `agent-cost measure output contains forbidden personal-dimension key(s): ${personalDimensionViolations.join(", ")}`,
      );
    }

    return validated.data;
  }
}
