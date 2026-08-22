import { join } from "node:path";
import { ClaudeBudgetAdapter, CodexBudgetAdapter, CodexBudgetConfigError } from "@lane/adapters";
import {
  buildNextRow,
  degradedQualities,
  findBaselineRevision,
  formatResourceSnapshot,
  loadStateWithOverlay,
} from "@lane/core";
import type { ResourceSnapshot } from "@lane/core";
import { resolveConfigDir } from "@lane/core";
import { readEstimateIfExists } from "../estimate-store.js";
import { listIntentIds, readIntent } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { readLaneState } from "../state-store.js";
import type { CommandResult } from "./start.js";

export interface NextOptions {
  specDir?: string;
  configDir?: string;
  agentCostBin?: string;
  claudeRateLimitsPath?: string;
  codexBudgetPath?: string;
}

/**
 * `lane next` (design.md §5.2) — decision table + reasoned candidates. Never scores or
 * auto-prioritizes: every row is one intent *with an adopted baseline estimate*, shown
 * with why it fits/doesn't/is merely advisory (buildNextRow, core/application/
 * next-service.ts) — a lane with no adopted baseline has nothing to compare against a
 * budget, so it never enters the table at all; it's only counted in a footer line
 * (must-1, Codex M3 review). If any ResourceSnapshot is degraded (stale rate-limits data,
 * or agent-cost couldn't fully price the underlying Codex usage), the verdict is
 * suppressed for *every* candidate and only the raw snapshots are shown, with the
 * suppression message naming the actual degraded quality/qualities — this command never
 * papers over a low-confidence input with a confident-looking recommendation.
 */
export async function runNext(opts: NextOptions): Promise<CommandResult> {
  const specDir = resolveSpecDir({ override: opts.specDir });
  const configDir = opts.configDir ?? resolveConfigDir();

  const claudeAdapter = new ClaudeBudgetAdapter({ rateLimitsPath: opts.claudeRateLimitsPath });
  const codexAdapter = new CodexBudgetAdapter({
    configPath: opts.codexBudgetPath ?? join(configDir, "budgets", "codex.yaml"),
    agentCostBin: opts.agentCostBin,
  });

  let snapshots: ResourceSnapshot[];
  try {
    const [claudeSnapshots, codexSnapshots] = await Promise.all([
      claudeAdapter.snapshot(),
      codexAdapter.snapshot(),
    ]);
    snapshots = [...claudeSnapshots, ...codexSnapshots];
  } catch (err) {
    if (err instanceof CodexBudgetConfigError) {
      return { exitCode: 2, message: `codex budget: ${err.message}` };
    }
    throw err;
  }

  const degraded = degradedQualities(snapshots);
  const suppressVerdict = degraded.length > 0;

  // must-1 (Codex M3 review): only lanes with an adopted baseline estimate go into the
  // decision table at all — a lane with no baseline has nothing for buildNextRow to
  // compare against a budget, so listing it as a same-shaped "unknown" row among real
  // fits/not_fit/advisory verdicts made the table read as if it were still evaluating
  // something. Lanes without a baseline are counted and surfaced in a footer line instead,
  // so they stay visible without cluttering the table itself.
  //
  // M4 (team review, 2026-07-31): "what should I work on next" has nothing to say about a
  // lane that's already finished or aborted — completed (5_done, via the local done
  // overlay same as `lane status`/loadStateWithOverlay) and aborted lanes are excluded
  // entirely, not counted in the table *or* the footer.
  const intentIds = listIntentIds(specDir);
  let lanesWithoutBaseline = 0;
  const rows = intentIds.flatMap((intentId) => {
    const rawState = readLaneState(specDir, intentId);
    const [effectiveState] = loadStateWithOverlay(specDir, intentId, rawState);
    if (effectiveState.status === "completed" || effectiveState.status === "aborted") {
      return [];
    }

    const intent = readIntent(specDir, intentId);
    const estimate = readEstimateIfExists(specDir, intentId);
    const baseline = estimate ? findBaselineRevision(intent, estimate) : undefined;
    if (!baseline || baseline.predicted === undefined) {
      // `baseline.predicted === undefined` is defensive, not expected in practice:
      // `lane estimate --adopt` refuses to adopt an abstained (predicted-less) revision
      // as baseline (AbstainedRevisionCannotBeBaselineError, estimate-service.ts) --
      // treated the same as "no baseline" here rather than crashing `lane next`.
      lanesWithoutBaseline++;
      return [];
    }
    return [
      buildNextRow(
        {
          intentId,
          // The estimator only ever predicts a single, provider-agnostic dollar figure
          // (predicted.cost_usd -- design.md §2.6), never a per-provider breakdown, so
          // provider is always "any" here: buildNextRow's matching already treats "any" as
          // a wildcard, and a genuine unit mismatch (e.g. a credits-only budget) correctly
          // falls through to "advisory" rather than a fabricated conversion.
          predictedCostP80: {
            value: baseline.predicted.cost_usd.p80,
            unit: "usd",
            provider: "any",
          },
          budget: intent.budget,
        },
        { suppressVerdict, degradedQualities: degraded },
      ),
    ];
  });

  const lines = [
    ...snapshots.map((s) => formatResourceSnapshot(s)),
    ...(snapshots.length === 0 ? ["(no resource snapshot available yet)"] : []),
    "",
    ...(rows.length === 0
      ? ["(no lanes with an adopted baseline)"]
      : rows.map((r) => `[${r.intentId}] ${r.verdict}: ${r.detail}`)),
    ...(lanesWithoutBaseline > 0
      ? [
          `${lanesWithoutBaseline} lane(s) without an adopted baseline — run \`lane estimate --adopt\` first`,
        ]
      : []),
  ];

  return { exitCode: 0, message: lines.join("\n") };
}
