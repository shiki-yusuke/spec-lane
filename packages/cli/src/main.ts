#!/usr/bin/env node
import { PHASE_ORDER, type Phase } from "@lane/schemas";
import { Command } from "commander";
import { runAdvance } from "./commands/advance.js";
import { runCalibrate } from "./commands/calibrate.js";
import { runConsensus } from "./commands/consensus.js";
import { runEmitMetrics } from "./commands/emit-metrics.js";
import { runEstimate } from "./commands/estimate.js";
import { runKnowledgeAppend, runKnowledgeQuery } from "./commands/knowledge.js";
import { runMigrateLegacyKnowledge } from "./commands/migrate-legacy-knowledge.js";
import { runMigrateLegacyLedger } from "./commands/migrate-legacy-ledger.js";
import { runNext } from "./commands/next.js";
import { runStart } from "./commands/start.js";
import type { CommandResult } from "./commands/start.js";
import { runStatus } from "./commands/status.js";
import { runValidate } from "./commands/validate.js";

const program = new Command();
program.name("lane").description("Delivery lane orchestrator (TS)").version("0.4.0");

function report(result: CommandResult): never {
  if (result.exitCode === 0) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }
  process.exit(result.exitCode);
}

function isPhase(value: string): value is Phase {
  return (PHASE_ORDER as readonly string[]).includes(value);
}

program
  .command("start")
  .argument("<intent-id>")
  .option("--spec-dir <path>")
  .option("--business-goal <text>")
  .option("--user-visible-intent <text>")
  .option("--primary-user <text>")
  .option("--risk <level>")
  .option(
    "--affected-layer <layer>",
    "repeatable",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option(
    "--allowed-path <glob>",
    "repeatable",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option("--owner <name>")
  .action((intentId: string, opts) => {
    if (opts.risk && !["low", "medium", "high"].includes(opts.risk)) {
      report({ exitCode: 1, message: `--risk must be one of low|medium|high (got: ${opts.risk})` });
    }
    report(
      runStart(intentId, {
        specDir: opts.specDir,
        businessGoal: opts.businessGoal,
        userVisibleIntent: opts.userVisibleIntent,
        primaryUser: opts.primaryUser,
        risk: opts.risk,
        affectedLayer: opts.affectedLayer,
        allowedPath: opts.allowedPath,
        owner: opts.owner,
      }),
    );
  });

program
  .command("status")
  .argument("<intent-id>")
  .option("--spec-dir <path>")
  .action((intentId: string, opts) => {
    report(runStatus(intentId, { specDir: opts.specDir }));
  });

program
  .command("advance")
  .argument("<intent-id>")
  .requiredOption("--phase <phase>")
  .option("--spec-dir <path>")
  .option("--profile <idOrPath>")
  .option("--pr-url <url>")
  .option("--merge-sha <sha>")
  .option("--merged-at <isoTimestamp>", "required when --phase 5_done")
  .action((intentId: string, opts) => {
    if (!isPhase(opts.phase)) {
      report({
        exitCode: 1,
        message: `--phase must be one of ${PHASE_ORDER.join(", ")} (got: ${opts.phase})`,
      });
    }
    report(
      runAdvance(intentId, opts.phase, {
        specDir: opts.specDir,
        profile: opts.profile,
        prUrl: opts.prUrl,
        mergeSha: opts.mergeSha,
        mergedAt: opts.mergedAt,
      }),
    );
  });

program
  .command("validate")
  .argument("<intent-id>")
  .option("--spec-dir <path>")
  .option("--profile <idOrPath>")
  .action((intentId: string, opts) => {
    report(runValidate(intentId, { specDir: opts.specDir, profile: opts.profile }));
  });

program
  .command("estimate")
  .argument("<intent-id>")
  .option("--spec-dir <path>")
  .option("--profile <idOrPath>")
  .option("--impact-scan-file <path>", "markdown report containing an impact-scan:v1 block")
  .option(
    "--adopt [revisionId]",
    "bare: adopt the new revision just created; with a value: adopt an already-existing revision id without creating a new one",
  )
  .option(
    "--reference-tokens-p50 <n>",
    "reference_table fallback: tokens p50 (all 4 reference-* flags required together)",
    Number,
  )
  .option(
    "--reference-tokens-p80 <n>",
    "reference_table fallback: tokens p80 (all 4 reference-* flags required together)",
    Number,
  )
  .option(
    "--reference-cost-p50 <n>",
    "reference_table fallback: cost_usd p50 (all 4 reference-* flags required together)",
    Number,
  )
  .option(
    "--reference-cost-p80 <n>",
    "reference_table fallback: cost_usd p80 (all 4 reference-* flags required together)",
    Number,
  )
  .action((intentId: string, opts) => {
    report(
      runEstimate(intentId, {
        specDir: opts.specDir,
        profile: opts.profile,
        impactScanFile: opts.impactScanFile,
        adopt: opts.adopt,
        referenceTokensP50: opts.referenceTokensP50,
        referenceTokensP80: opts.referenceTokensP80,
        referenceCostP50: opts.referenceCostP50,
        referenceCostP80: opts.referenceCostP80,
      }),
    );
  });

program
  .command("calibrate")
  .argument("<intent-id>")
  .requiredOption(
    "--session-id <id>",
    "repeatable; at least one required",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option("--spec-dir <path>")
  .option("--since <isoTimestamp>")
  .option("--until <isoTimestamp>")
  .option("--agent-cost-bin <path>", "override the agent-cost binary (defaults to PATH lookup)")
  .option("--files-touched-observed <n>", "actual diff file count", Number)
  .action(async (intentId: string, opts) => {
    report(
      await runCalibrate(intentId, {
        specDir: opts.specDir,
        sessionIds: opts.sessionId,
        since: opts.since,
        until: opts.until,
        agentCostBin: opts.agentCostBin,
        filesTouchedObserved: opts.filesTouchedObserved,
      }),
    );
  });

program
  .command("emit-metrics")
  .description(
    "build an agent-metrics:v1/token-usage:v1 snapshot from this lane's cost_ledger (design.md §4.5/§5.5)",
  )
  .argument("<intent-id>")
  .option("--spec-dir <path>")
  .option("--agent-cost-bin <path>", "override the agent-cost binary (defaults to PATH lookup)")
  .option("--gh-bin <path>", "override the gh binary (defaults to PATH lookup)")
  .option("--post", "post/upsert the marker as a PR comment instead of only printing it")
  .option("--pr <number>", "overrides lane-state's own pr_url", Number)
  .option("--repository <owner/repo>", "overrides git-remote-derived repository")
  .option("--head-sha <sha>", "overrides `git rev-parse HEAD`")
  .action(async (intentId: string, opts) => {
    report(
      await runEmitMetrics(intentId, {
        specDir: opts.specDir,
        agentCostBin: opts.agentCostBin,
        ghBin: opts.ghBin,
        post: opts.post,
        pr: opts.pr,
        repository: opts.repository,
        headSha: opts.headSha,
        emitterVersion: program.version() ?? "0.0.0",
      }),
    );
  });

program
  .command("next")
  .description("decision table: adopted-baseline lanes vs current Claude/Codex resource snapshots")
  .option("--spec-dir <path>")
  .option("--config-dir <path>", "defaults to $LANE_CONFIG_DIR (or XDG default)")
  .option("--agent-cost-bin <path>", "override the agent-cost binary (defaults to PATH lookup)")
  .option("--claude-rate-limits-path <path>", "defaults to ~/.claude/rate-limits.json")
  .option("--codex-budget-path <path>", "defaults to <config dir>/budgets/codex.yaml")
  .action(async (opts) => {
    report(
      await runNext({
        specDir: opts.specDir,
        configDir: opts.configDir,
        agentCostBin: opts.agentCostBin,
        claudeRateLimitsPath: opts.claudeRateLimitsPath,
        codexBudgetPath: opts.codexBudgetPath,
      }),
    );
  });

program
  .command("consensus")
  .description("file-edit-and-validate support for the spec_consensus hard gate (design.md §5.3)")
  .argument("<intent-id>")
  .option("--spec-dir <path>")
  .option("--spec-ssot-ref <ref>", "required the first time --refresh initializes spec_consensus")
  .option("--refresh", "recompute spec_digest/verification_digest from the current files")
  .option("--add-deviation", "add a new pending deviation (requires --spec-ref/--actual/--action)")
  .option("--spec-ref <ref>")
  .option("--actual <text>")
  .option("--action <accept|fix|update_spec>")
  .option("--evidence-ref <ref>")
  .option(
    "--resolve-deviation <specRef>",
    "mark the deviation at this spec_ref resolved (requires --rationale)",
  )
  .option("--rationale <text>")
  .option("--ack", "record reviewer_ack (requires --reviewer-kind/--reviewer-id)")
  .option("--reviewer-kind <self|independent_agent|human>")
  .option("--reviewer-id <id>")
  .option("--override-reason <text>", "required for a self ack at effective risk=high")
  .option("--note <text>")
  .option("--emit-pr-section", 'read-only: print a "Spec Deviations" PR body section to stdout')
  .action((intentId: string, opts) => {
    if (opts.action && !["accept", "fix", "update_spec"].includes(opts.action)) {
      report({
        exitCode: 1,
        message: `--action must be one of accept|fix|update_spec (got: ${opts.action})`,
      });
    }
    if (opts.reviewerKind && !["self", "independent_agent", "human"].includes(opts.reviewerKind)) {
      report({
        exitCode: 1,
        message: `--reviewer-kind must be one of self|independent_agent|human (got: ${opts.reviewerKind})`,
      });
    }
    report(
      runConsensus(intentId, {
        specDir: opts.specDir,
        specSsotRef: opts.specSsotRef,
        refresh: opts.refresh,
        addDeviation: opts.addDeviation
          ? {
              specRef: opts.specRef,
              actual: opts.actual,
              action: opts.action,
              evidenceRef: opts.evidenceRef,
            }
          : undefined,
        resolveDeviation: opts.resolveDeviation
          ? { specRef: opts.resolveDeviation, rationale: opts.rationale }
          : undefined,
        ack: opts.ack
          ? {
              reviewerKind: opts.reviewerKind,
              reviewerId: opts.reviewerId,
              overrideReason: opts.overrideReason,
              evidenceRef: opts.evidenceRef,
              note: opts.note,
            }
          : undefined,
        emitPrSection: opts.emitPrSection,
      }),
    );
  });

program
  .command("knowledge-append")
  .description("append one knowledge record (design.md §2.8/§5.4)")
  .requiredOption("--type <review_finding|review_decision>")
  .requiredOption("--scope <global|scoped>")
  .requiredOption("--summary <text>")
  .option("--id <id>", "defaults to a generated k-<uuid>")
  .option("--repo-id <id>", "required when --scope scoped")
  .option("--profile-id <id>")
  .option("--detail <text>")
  .option(
    "--paths <path>",
    "repeatable",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option(
    "--path-prefixes <prefix>",
    "repeatable",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option("--tags <tag>", "repeatable", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--source-ref <ref>")
  .option("--source-intent-id <id>")
  .option("--confidence <high|medium|low>")
  .option("--taxonomy <taxonomy>", "required for --type review_finding")
  .option("--evidence <text>", "required for --type review_finding")
  .option("--resolution <fixed|wontfix|deferred>", "required for --type review_finding")
  .option("--context <text>", "required for --type review_decision")
  .option("--rationale <text>", "required for --type review_decision")
  .action((opts) => {
    if (!["review_finding", "review_decision"].includes(opts.type)) {
      report({
        exitCode: 1,
        message: `--type must be one of review_finding|review_decision (got: ${opts.type})`,
      });
    }
    if (!["global", "scoped"].includes(opts.scope)) {
      report({ exitCode: 1, message: `--scope must be one of global|scoped (got: ${opts.scope})` });
    }
    report(
      runKnowledgeAppend({
        id: opts.id,
        type: opts.type,
        scope: opts.scope,
        repoId: opts.repoId,
        profileId: opts.profileId,
        summary: opts.summary,
        detail: opts.detail,
        paths: opts.paths,
        pathPrefixes: opts.pathPrefixes,
        tags: opts.tags,
        sourceRef: opts.sourceRef,
        sourceIntentId: opts.sourceIntentId,
        confidence: opts.confidence,
        taxonomy: opts.taxonomy,
        evidence: opts.evidence,
        resolution: opts.resolution,
        context: opts.context,
        rationale: opts.rationale,
      }),
    );
  });

program
  .command("knowledge-query")
  .description("score knowledge records against paths/taxonomies (design.md §5.4)")
  .requiredOption(
    "--paths <path>",
    "repeatable; at least one required",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option(
    "--taxonomy <taxonomy>",
    "repeatable",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option("--lens <lensId>", "also preview the per-lens top-2 selection for this lens")
  .option(
    "--repo-id <ownerSlashRepo>",
    "scopes which scope=scoped records are eligible; defaults to the cwd's git remote",
  )
  .action((opts) => {
    report(
      runKnowledgeQuery({
        paths: opts.paths,
        taxonomy: opts.taxonomy,
        lensId: opts.lens,
        repoId: opts.repoId,
      }),
    );
  });

program
  .command("migrate-legacy-ledger")
  .description("one-time importer: legacy lane-state.json cost_ledger -> calibration observations")
  .requiredOption(
    "--input <path>",
    "path to a legacy lane-state.json (repeatable; shell-expand globs before passing)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option(
    "--reject-report <path>",
    "defaults to <data dir>/migration-reports/legacy-ledger-reject-report.json",
  )
  .action((opts) => {
    report(runMigrateLegacyLedger({ input: opts.input, rejectReportPath: opts.rejectReport }));
  });

program
  .command("migrate-legacy-knowledge")
  .description("one-time importer: legacy review-memory export -> knowledge records")
  .requiredOption("--input <path>", "path to the legacy memory export (one JSON object per line)")
  .requiredOption("--repo-id <ownerSlashRepo>", "scopes every imported record")
  .option(
    "--reject-report <path>",
    "defaults to <data dir>/migration-reports/legacy-knowledge-reject-report.json",
  )
  .action((opts) => {
    report(
      runMigrateLegacyKnowledge({
        input: opts.input,
        repoId: opts.repoId,
        rejectReportPath: opts.rejectReport,
      }),
    );
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
