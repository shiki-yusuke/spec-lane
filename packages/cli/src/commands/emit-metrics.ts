import { AgentCostTelemetryAdapter, GithubCommentMetricsPublisher } from "@lane/adapters";
import {
  AgentMetricsPayloadTooLarge,
  buildAgentMetricsMarker,
  buildCoverage,
  buildTokenUsagePayload,
  detectAmbiguousSessionAttribution,
  effectiveLedger,
  groupLedgerForMetrics,
  tokenUsageRecordsFromRows,
} from "@lane/core";
import type { Omission, TokenUsageRecord } from "@lane/schemas";
import { currentGitCommit, deriveRepoIdFromGitRemote } from "../git-info.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, readLaneState } from "../state-store.js";
import type { CommandResult } from "./start.js";

export interface EmitMetricsOptions {
  specDir?: string;
  agentCostBin?: string;
  /** Override the `gh` binary GithubCommentMetricsPublisher shells out to (defaults to PATH lookup). */
  ghBin?: string;
  /** Post the marker as a PR comment (upsert by identity) instead of only printing it. */
  post?: boolean;
  /** Overrides lane-state's own pr_url for --post. */
  pr?: number;
  /** Overrides git-remote-derived "owner/repo". */
  repository?: string;
  /** Overrides `git rev-parse HEAD`. */
  headSha?: string;
  cwd?: string;
  emitterVersion: string;
}

/**
 * design.md §4.5/§5.5 — `lane emit-metrics <intent-id> [--post] [--pr N]`. Builds an
 * agent-metrics:v1/token-usage:v1 snapshot from the lane's cost_ledger and either prints
 * it (marker to stdout, diagnostics to stderr) or posts/upserts it to the lane's PR.
 *
 * Orchestrates I/O (telemetry.measure() per activity, optional gh publish) around the
 * pure core/application/metrics-service.ts functions — mirrors calibrate.ts's own split
 * between CLI-side fetching and core-side pure building.
 */
export async function runEmitMetrics(
  intentId: string,
  opts: EmitMetricsOptions,
): Promise<CommandResult> {
  const specDir = resolveSpecDir({ override: opts.specDir });
  if (!laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: `Lane state not found: ${intentId}` };
  }
  const state = readLaneState(specDir, intentId);
  // MP-8 (2026-08-08, sol ruling point 4): reads the *effective* ledger (in-repo
  // cost_ledger composed with any done-overlay ledger_delta), not state.cost_ledger
  // directly -- a lane calibrated after its done overlay was created never touches
  // in-repo state (calibrate.ts's own Rule 7), so this is the only way emit-metrics
  // sees that measurement.
  const ledger = effectiveLedger(specDir, intentId, state);

  const { groups, structuralOmissions } = groupLedgerForMetrics(ledger);
  const ambiguous = detectAmbiguousSessionAttribution(groups);
  if (ambiguous.length > 0) {
    return {
      exitCode: 3,
      message: `ambiguous_session_attribution: session id(s) [${ambiguous.join(", ")}] appear in more than one activity — aborting without printing or posting anything`,
    };
  }

  const telemetry = new AgentCostTelemetryAdapter({ bin: opts.agentCostBin });
  const omissions: Omission[] = [...structuralOmissions];
  const records: TokenUsageRecord[] = [];
  let eligibleEntries = structuralOmissions.length;

  for (const group of groups) {
    eligibleEntries += group.ledgerEntryIds.length;
    let measured: Awaited<ReturnType<typeof telemetry.measure>>;
    try {
      // spec.md Rule 6: replay the exact selector calibrate recorded for this
      // scope:"lane" activity (if any) -- never a bare session_ids-only query for it,
      // so a value drift between calibrate time and emit time can't silently change the
      // measured window. Phase-scoped activities carry no selector and are unaffected.
      const measureOpts = group.selector
        ? {
            since: group.selector.since ? new Date(group.selector.since) : undefined,
            until: group.selector.until ? new Date(group.selector.until) : undefined,
            agents: group.selector.agents ?? undefined,
          }
        : undefined;
      measured = await telemetry.measure(group.sessionIds, measureOpts);
    } catch (err) {
      return {
        exitCode: 2,
        message: `telemetry measurement failed for activity "${group.activityName}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (measured.total.rows.length === 0) {
      for (const entryId of group.ledgerEntryIds) {
        omissions.push({
          entry_id: entryId,
          reason: "agent_cost_no_matching_rows",
          detail: `agent-cost returned no rows for session_ids=[${group.sessionIds.join(",")}]`,
        });
      }
      continue;
    }
    const {
      records: activityRecords,
      unknownTokenKinds,
      nullFieldRows,
    } = tokenUsageRecordsFromRows(group.activityName, measured.total.rows);
    if (nullFieldRows.length > 0) {
      return {
        exitCode: 3,
        message: `measure_protocol_violation: agent-cost returned ${nullFieldRows.length} row(s) with a null agent/model/token_kind for activity "${group.activityName}" (measure/v1 rows are documented as always pre-grouped) — aborting without printing or posting anything`,
      };
    }
    if (unknownTokenKinds.length > 0) {
      return {
        exitCode: 3,
        message: `unknown_token_kind: agent-cost returned unrecognized token_kind(s) [${[...new Set(unknownTokenKinds)].join(", ")}] for activity "${group.activityName}" — aborting without printing or posting anything`,
      };
    }
    records.push(...activityRecords);
  }

  const measuredEntries = eligibleEntries - omissions.length;
  const coverage = buildCoverage({ eligibleEntries, measuredEntries, omissions });

  const repository = opts.repository ?? deriveRepoIdFromGitRemote(opts.cwd ?? process.cwd());
  if (!repository) {
    return {
      exitCode: 2,
      message:
        "could not determine repository (no --repository given and `git remote get-url origin` failed) — pass --repository owner/repo explicitly",
    };
  }
  const prNumber = opts.pr ?? extractPrNumber(state.pr_url);
  const change =
    prNumber != null
      ? {
          type: "pull_request",
          number: prNumber,
          url: state.pr_url ?? `https://github.com/${repository}/pull/${prNumber}`,
          head_sha: opts.headSha ?? currentGitCommit(opts.cwd ?? process.cwd()),
        }
      : undefined;

  let payload: ReturnType<typeof buildTokenUsagePayload>;
  try {
    payload = buildTokenUsagePayload({
      emitter: { name: "spec-lane", version: opts.emitterVersion },
      subject: { namespace: "spec-lane", type: "delivery-run", id: intentId },
      repository: { provider: "github", id: repository },
      change,
      generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      records,
      coverage,
    });
  } catch (err) {
    return {
      exitCode: 3,
      message: `payload failed validation (personal-dimension violation or schema error) — nothing printed or posted: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let marker: string;
  try {
    marker = buildAgentMetricsMarker(payload);
  } catch (err) {
    if (err instanceof AgentMetricsPayloadTooLarge) {
      return { exitCode: 3, message: `payload_too_large: ${err.message}` };
    }
    throw err;
  }

  // spec.md Rule 1: marker to stdout, diagnostics to stderr, never mixed on one stream —
  // a caller piping stdout to a harvester or a file must get exactly the marker, nothing
  // else, and only once the marker is actually known-good and (for --post) successfully
  // posted. Diagnostics always go straight to stderr via console.error() here rather than
  // through CommandResult.message (which main.ts's report() only ever sends to one stream
  // at a time -- console.log on exitCode:0, console.error otherwise). Review round
  // 2026-08-07 (must-1): every --post precondition (PR number resolved, publish actually
  // succeeded) must be satisfied *before* anything reaches stdout -- a failed --post must
  // leave stdout completely empty, and a successful --post's own "created/updated <url>"
  // status text must go to stderr, not stdout, so stdout carries the marker and nothing
  // else on every path, --post or not.
  for (const omission of omissions) {
    console.error(`omission ${omission.entry_id}: ${omission.reason} — ${omission.detail ?? ""}`);
  }
  console.error(`built ${records.length} record(s), coverage.status=${coverage.status}`);

  if (!opts.post) {
    return { exitCode: 0, message: marker };
  }

  if (prNumber == null) {
    return {
      exitCode: 2,
      message:
        "--post requires a PR number (lane-state has no pr_url and --pr was not given) — nothing printed or posted",
    };
  }
  const publisher = new GithubCommentMetricsPublisher({ ghBin: opts.ghBin });
  try {
    const result = await publisher.upsert(marker, {
      repository: { provider: "github", id: repository },
      prNumber,
    });
    console.error(`${result.action} ${result.url}`);
    return { exitCode: 0, message: marker };
  } catch (err) {
    return {
      exitCode: 2,
      message: `posting failed, nothing printed or posted: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function extractPrNumber(prUrl: string | null): number | undefined {
  const match = prUrl?.match(/\/pull\/(\d+)\s*$/);
  const n = match?.[1] ? Number(match[1]) : undefined;
  return n != null && !Number.isNaN(n) ? n : undefined;
}
