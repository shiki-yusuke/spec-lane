import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { BudgetAdapter, ResourceSnapshot } from "@lane/core";
import { AgentCostReportResultSchema } from "@lane/schemas";
import { parse as parseYaml } from "yaml";
import { DEFAULT_AGENT_COST_TIMEOUT_MS, describeAgentCostFailure } from "../agent-cost-exec.js";

const execFileAsync = promisify(execFile);

// design.md §4.2/M3 — Codex has no rate-limit API to read from (unlike Claude), so its
// "budget" is a manually-entered limit (this YAML file) minus agent-cost's own measured
// consumption for the same period. `quality` is always at best "computed_low_confidence"
// (sol: never claim measured-grade certainty for a number this indirect).

export interface CodexBudgetConfig {
  weekly_limit_credits: number;
  period_start: string; // date-only, e.g. "2026-07-27"
  period_end: string; // date-only, exclusive boundary (the next period's period_start)
  reset_rule: string;
  timezone: string;
}

export class CodexBudgetConfigError extends Error {}

// v1 scope (design.md §1/§8): only the timezone this repo's own conventions already commit
// to (Asia/Tokyo, e.g. migrate-legacy-knowledge.ts's date-only timestamps) plus UTC are
// supported. A full IANA tz database is out of scope for a single-user budget config; an
// unsupported zone fails loudly rather than silently assuming UTC.
const FIXED_OFFSETS: Record<string, string> = {
  "Asia/Tokyo": "+09:00",
  UTC: "+00:00",
  "Etc/UTC": "+00:00",
};

function resolveFixedOffset(timezone: string): string {
  const offset = FIXED_OFFSETS[timezone];
  if (!offset) {
    throw new CodexBudgetConfigError(
      `unsupported timezone in codex.yaml: "${timezone}" (v1 supports: ${Object.keys(FIXED_OFFSETS).join(", ")})`,
    );
  }
  return offset;
}

function parseCodexBudgetConfig(raw: unknown): CodexBudgetConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new CodexBudgetConfigError("codex.yaml does not parse to an object");
  }
  const v = raw as Record<string, unknown>;
  const required: Array<keyof CodexBudgetConfig> = [
    "weekly_limit_credits",
    "period_start",
    "period_end",
    "reset_rule",
    "timezone",
  ];
  for (const key of required) {
    if (v[key] === undefined) {
      throw new CodexBudgetConfigError(`codex.yaml is missing required field: ${key}`);
    }
  }
  if (typeof v.weekly_limit_credits !== "number" || v.weekly_limit_credits <= 0) {
    throw new CodexBudgetConfigError("codex.yaml: weekly_limit_credits must be a positive number");
  }
  for (const key of ["period_start", "period_end", "reset_rule", "timezone"] as const) {
    if (typeof v[key] !== "string" || (v[key] as string).length === 0) {
      throw new CodexBudgetConfigError(`codex.yaml: ${key} must be a non-empty string`);
    }
  }
  const periodStart = v.period_start as string;
  const periodEnd = v.period_end as string;
  const resetRule = v.reset_rule as string;

  // should-4 (Codex M3 review): period integrity. Dates are compared as UTC midnight --
  // this is purely a calendar-day arithmetic check, done before resolveFixedOffset() is
  // even consulted, so a config with a nonsensical period is rejected regardless of
  // timezone support.
  const startMs = Date.parse(`${periodStart}T00:00:00Z`);
  const endMs = Date.parse(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new CodexBudgetConfigError(
      `codex.yaml: period_start/period_end must be valid dates (got period_start=${periodStart}, period_end=${periodEnd})`,
    );
  }
  if (endMs <= startMs) {
    throw new CodexBudgetConfigError(
      `codex.yaml: period_end (${periodEnd}) must be after period_start (${periodStart})`,
    );
  }
  if (resetRule === "weekly") {
    const diffDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
    if (diffDays !== 7) {
      throw new CodexBudgetConfigError(
        `codex.yaml: reset_rule=weekly requires period_end - period_start to be exactly 7 days (got ${diffDays} day(s): ${periodStart}..${periodEnd})`,
      );
    }
  }

  return {
    weekly_limit_credits: v.weekly_limit_credits,
    period_start: periodStart,
    period_end: periodEnd,
    reset_rule: resetRule,
    timezone: v.timezone as string,
  };
}

export interface CodexBudgetAdapterOptions {
  /** Defaults to `$LANE_CONFIG_DIR/budgets/codex.yaml` via resolveConfigDir(). */
  configPath: string;
  /** agent-cost binary name (PATH lookup) or absolute path. Defaults to "agent-cost". */
  agentCostBin?: string;
  /** Milliseconds before the agent-cost subprocess is sent SIGTERM. Defaults to
   * DEFAULT_AGENT_COST_TIMEOUT_MS (180_000). */
  timeoutMs?: number;
}

export class CodexBudgetAdapter implements BudgetAdapter {
  private readonly configPath: string;
  private readonly bin: string;
  readonly timeoutMs: number;

  constructor(opts: CodexBudgetAdapterOptions) {
    this.configPath = opts.configPath;
    this.bin = opts.agentCostBin ?? "agent-cost";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_COST_TIMEOUT_MS;
  }

  async snapshot(): Promise<ResourceSnapshot[]> {
    if (!existsSync(this.configPath)) {
      // no manually-entered limit configured — never fabricate one (project-wide "never
      // guess" principle); the caller (lane next) just won't have a Codex row to show.
      return [];
    }
    // should-5 (Codex M3 review): every failure mode from here on — a malformed YAML file,
    // an agent-cost invocation that returns non-JSON, or a response that no longer matches
    // AgentCostReportResultSchema (schema drift) — is normalized into CodexBudgetConfigError
    // rather than letting a raw YAMLParseError/SyntaxError/ZodError escape uncaught. This
    // keeps every caller (runNext's own catch only knows about CodexBudgetConfigError) on
    // the same controlled exit-2 path instead of crashing.
    let rawConfig: unknown;
    try {
      rawConfig = parseYaml(readFileSync(this.configPath, "utf-8"));
    } catch (err) {
      throw new CodexBudgetConfigError(
        `failed to read/parse ${this.configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const config = parseCodexBudgetConfig(rawConfig);
    const offset = resolveFixedOffset(config.timezone);

    const args = [
      "report",
      "--agent",
      "codex",
      "--format",
      "json",
      "--group-by",
      "agent",
      "--since",
      config.period_start,
      "--until",
      config.period_end,
      "--timezone",
      config.timezone,
    ];
    let stdout: string;
    try {
      const result = await execFileAsync(this.bin, args, {
        timeout: this.timeoutMs,
        encoding: "utf-8",
      });
      stdout = result.stdout;
    } catch (err) {
      throw new CodexBudgetConfigError(
        describeAgentCostFailure("report", this.bin, this.timeoutMs, err),
      );
    }
    let stdoutJson: unknown;
    try {
      stdoutJson = JSON.parse(stdout);
    } catch (err) {
      throw new CodexBudgetConfigError(
        `agent-cost report did not return valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const validated = AgentCostReportResultSchema.safeParse(stdoutJson);
    if (!validated.success) {
      throw new CodexBudgetConfigError(
        `agent-cost report output failed schema validation (possible agent-cost version drift): ${validated.error.message}`,
      );
    }
    const parsed = validated.data;
    // --group-by agent + --agent codex guarantees at most one row.
    const row = parsed.rows[0];
    const consumedCredits = row?.credits ?? 0;
    const remaining = config.weekly_limit_credits - consumedCredits;

    // A row is only absent when there was zero Codex usage in the period at all — that's
    // not a pricing problem, so quality stays at the CodexBudgetAdapter baseline.
    const quality: ResourceSnapshot["quality"] =
      row?.pricing_status === "unpriced"
        ? "unpriced"
        : row?.pricing_status === "lower_bound"
          ? "lower_bound"
          : "computed_low_confidence";

    return [
      {
        provider: "codex",
        metric: "credit_balance",
        value: remaining,
        unit: "credits",
        observedAt: new Date(),
        expiresAt: new Date(`${config.period_end}T00:00:00${offset}`),
        quality,
        source: `${this.configPath} (limit) - agent-cost report (consumed)`,
      },
    ];
  }
}
