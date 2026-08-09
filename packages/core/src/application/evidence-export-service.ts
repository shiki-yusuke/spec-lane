import type {
  Intent,
  LaneEvidence,
  LedgerEntry,
  Phase,
  PremiseEvidence,
  Verification,
} from "@lane/schemas";
import { computeDigest } from "../digest.js";
import type { DoneOverlay } from "../done-overlay.js";
import { canonicalVerificationContent } from "./consensus-service.js";

// M0 spec-lane 0.5.0 — `lane evidence export --format lane-evidence:v1` (M0 spec §5).
// Pure assembly: every artifact this needs is passed in already-read/parsed, so this
// module has no filesystem dependency of its own (packages/cli's evidence-export command
// is the one that reads spec.md/intent.yaml/verification.yaml/done-overlay/lane-state and
// calls this).

function summarizePremiseEvidence(
  premiseEvidence: PremiseEvidence | undefined,
): LaneEvidence["artifacts"]["premise_evidence"] {
  if (!premiseEvidence) return null;
  if (premiseEvidence.required) {
    return {
      required: true,
      method: premiseEvidence.method,
      reproduced: premiseEvidence.reproduced,
    };
  }
  return { required: false };
}

function summarizeConsensusAck(
  verification: Verification | null,
): LaneEvidence["artifacts"]["consensus_ack"] {
  const consensus = verification?.spec_consensus;
  const ack = consensus?.reviewer_ack;
  if (!consensus || !ack) return null;
  return {
    reviewer_kind: ack.reviewer_kind,
    reviewer_id: ack.reviewer_id,
    acked_at: ack.acked_at,
    spec_digest: consensus.spec_digest,
    verification_digest: consensus.verification_digest,
    override_reason_present: Boolean(ack.override_reason),
    pending_deviation_count: consensus.deviations.filter((d) => d.status === "pending").length,
  };
}

function summarizeSuccessCriteriaMatrix(
  verification: Verification | null,
): LaneEvidence["artifacts"]["success_criteria_matrix"] {
  const matrix = verification?.success_criteria_matrix;
  if (!matrix) return null;
  return {
    row_count: matrix.length,
    covered_by_none_count: matrix.filter((r) => r.covered_by === "none").length,
    negation_test_missing_count: matrix.filter((r) => !r.negation_test?.trim()).length,
  };
}

function summarizeDoneOverlay(
  overlay: DoneOverlay | null,
): LaneEvidence["artifacts"]["done_overlay"] {
  if (!overlay) return null;
  return {
    done_source: overlay.done_source,
    pr_url: overlay.pr_url,
    merge_sha: overlay.merge_sha,
    verify_ended_at: overlay.verify_ended_at,
    done_recorded_at: overlay.done_recorded_at,
  };
}

function summarizeLedger(
  entries: readonly LedgerEntry[],
): LaneEvidence["artifacts"]["ledger_summary"] {
  const included = entries.filter((e) => e.included_in_kpi);
  const totalTokens = included.reduce((sum, e) => (e.tokens != null ? sum + e.tokens : sum), 0);
  const totalCostUsd = included.reduce(
    (sum, e) => (e.cost_usd != null ? sum + e.cost_usd : sum),
    0,
  );
  const hasAnyRealNumber = included.some((e) => e.tokens != null || e.cost_usd != null);
  return {
    entry_count: entries.length,
    included_in_kpi_count: included.length,
    total_tokens: hasAnyRealNumber ? totalTokens : null,
    total_cost_usd: hasAnyRealNumber ? totalCostUsd : null,
    sources: [...new Set(entries.map((e) => e.source))],
  };
}

export interface BuildLaneEvidenceInput {
  intentId: string;
  generatedAt: string;
  currentPhase: Phase;
  intent: Intent;
  /** Raw intent.yaml file content -- digested directly (not a re-serialization of the
   * parsed object), matching gate-check.ts's own convention of digesting spec.md's actual
   * on-disk bytes rather than a round-tripped representation. */
  intentContent: string;
  intentPath: string;
  specContent: string | null;
  specPath: string;
  verification: Verification | null;
  verificationPath: string;
  doneOverlay: DoneOverlay | null;
  effectiveLedgerEntries: readonly LedgerEntry[];
}

export function buildLaneEvidence(input: BuildLaneEvidenceInput): LaneEvidence {
  return {
    schema_version: "lane-evidence:v1",
    intent_id: input.intentId,
    generated_at: input.generatedAt,
    current_phase: input.currentPhase,
    artifacts: {
      intent: {
        path: input.intentPath,
        digest: computeDigest(input.intentContent),
      },
      spec:
        input.specContent === null
          ? null
          : { path: input.specPath, digest: computeDigest(input.specContent) },
      verification: input.verification
        ? {
            path: input.verificationPath,
            digest: computeDigest(canonicalVerificationContent(input.verification)),
          }
        : null,
      success_criteria_matrix: summarizeSuccessCriteriaMatrix(input.verification),
      consensus_ack: summarizeConsensusAck(input.verification),
      premise_evidence: summarizePremiseEvidence(input.intent.premise_evidence),
      done_overlay: summarizeDoneOverlay(input.doneOverlay),
      ledger_summary: summarizeLedger(input.effectiveLedgerEntries),
    },
  };
}
