import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanAgentMetricsPersonalDimensions } from "@lane/core";
import type { TelemetryAdapter, TelemetryMeasureOptions } from "@lane/core";
import { type AgentCostMeasureResult, AgentCostMeasureResultSchema } from "@lane/schemas";
import { DEFAULT_AGENT_COST_TIMEOUT_MS, describeAgentCostFailure } from "../agent-cost-exec.js";

const execFileAsync = promisify(execFile);

// I-2026-09-10-agent-cost-v2-basis-gate (RULE-28) -- producer_version/accounting_basis
// are declared optional in the schema (D1) so a present-but-hostile value would otherwise
// reach the ledger; this is the one boundary check that keeps them optional while still
// bounding a present value's length and charset.
const MAX_BASIS_FIELD_LENGTH = 256;
// sol impl review 1 must-4: the full Unicode "Cc" (Control) category -- C0 controls,
// DEL and the C1 controls (U+0080-U+009F) -- not just the C0/DEL subset.
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;

function rejectHostileBasisField(fieldName: string, value: string | undefined): void {
  if (value === undefined) return;
  // RULE-28's "256 characters" means Unicode code points, not UTF-16 code units:
  // `value.length` counts UTF-16 code units, so a string of 129-256 astral characters
  // (each two code units) would be wrongly rejected under that count despite being well
  // within the intended limit. `Array.from` iterates by code point.
  if (Array.from(value).length > MAX_BASIS_FIELD_LENGTH || CONTROL_CHAR_PATTERN.test(value)) {
    throw new TelemetryImportFailed(
      `agent-cost measure output's ${fieldName} exceeds 256 characters or contains a control character`,
    );
  }
}

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
  /** Milliseconds before the agent-cost subprocess is sent SIGTERM. Defaults to
   * DEFAULT_AGENT_COST_TIMEOUT_MS (180_000). */
  timeoutMs?: number;
}

// design.md §4.1 — thin subprocess wrapper around agent-cost's real `measure/v1` contract.
// No log-scanning, no window-to-session discovery: the caller already knows which
// session ids to ask about (see ports/telemetry.ts's doc comment for why).
export class AgentCostTelemetryAdapter implements TelemetryAdapter {
  private readonly bin: string;
  readonly timeoutMs: number;

  constructor(opts: AgentCostTelemetryAdapterOptions = {}) {
    this.bin = opts.bin ?? "agent-cost";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_COST_TIMEOUT_MS;
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
        describeAgentCostFailure("measure", this.bin, this.timeoutMs, err),
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

    // RULE-28 -- a present, hostile producer_version/accounting_basis is rejected rather
    // than persisted; both fields stay optional (absence is never rejected).
    rejectHostileBasisField("producer_version", validated.data.producer_version);
    rejectHostileBasisField("accounting_basis", validated.data.accounting_basis);

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
