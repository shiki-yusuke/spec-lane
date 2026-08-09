import { readFileSync } from "node:fs";
import { buildLaneEvidence, effectiveLedger, readDoneOverlay } from "@lane/core";
import { intentExists, intentPath, readIntent } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { readSpecMdIfExists, specMdPath } from "../spec-store.js";
import { laneStateExists, readLaneState } from "../state-store.js";
import { readVerificationIfExists, verificationPath } from "../verification-store.js";
import type { CommandResult } from "./start.js";

export interface EvidenceExportOptions {
  specDir?: string;
  format?: string;
}

const SUPPORTED_FORMAT = "lane-evidence:v1";

/**
 * `lane evidence export --format lane-evidence:v1 --intent <id>` (M0 spec §5) — a digest
 * bundle of every artifact this lane has produced so far. **Owned by spec-lane, not
 * ai-agent-skills-playbook, for now** (see LaneEvidenceSchema's own doc comment): this is
 * a first-cut shape for the pilot's own consumption, promoted to the playbook's
 * `contracts/` if/when a downstream consumer starts reading it. stdout carries only the
 * schema-conformant JSON (stdout purity convention); diagnostics go to stderr.
 */
export function runEvidenceExport(intentId: string, opts: EvidenceExportOptions): CommandResult {
  const format = opts.format ?? SUPPORTED_FORMAT;
  if (format !== SUPPORTED_FORMAT) {
    return {
      exitCode: 1,
      message: `--format must be ${SUPPORTED_FORMAT} (got: ${format})`,
    };
  }
  const specDir = resolveSpecDir({ override: opts.specDir });
  if (!laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: `Lane state not found: ${intentId}` };
  }
  if (!intentExists(specDir, intentId)) {
    return { exitCode: 2, message: `intent.yaml not found for ${intentId}` };
  }

  const intent = readIntent(specDir, intentId);
  const intentContent = readFileSync(intentPath(specDir, intentId), "utf-8");
  const specContent = readSpecMdIfExists(specDir, intentId);
  const verification = readVerificationIfExists(specDir, intentId);
  const state = readLaneState(specDir, intentId);
  const doneOverlay = readDoneOverlay(specDir, intentId);
  const ledgerEntries = effectiveLedger(specDir, intentId, state);

  const evidence = buildLaneEvidence({
    intentId,
    generatedAt: new Date().toISOString(),
    currentPhase: state.current_phase,
    intent,
    intentContent,
    intentPath: intentPath(specDir, intentId),
    specContent,
    specPath: specMdPath(specDir, intentId),
    verification,
    verificationPath: verificationPath(specDir, intentId),
    doneOverlay,
    effectiveLedgerEntries: ledgerEntries,
  });

  return { exitCode: 0, message: JSON.stringify(evidence, null, 2) };
}
