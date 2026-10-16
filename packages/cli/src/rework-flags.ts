import type { ReworkClassification } from "@lane/schemas";
import { ReworkClassificationSchema } from "@lane/schemas";

/**
 * 合意 §B3 — the raw rework-classification flags, shared by `advance --phase 5_done
 * --rework-*` and `lane rework-classify` so both build the record the same way and validate
 * it against the same schema (the only write path is still createDoneOverlay /
 * setReworkClassification).
 */
export interface ReworkFlags {
  origin?: string;
  detectedAt?: string;
  status?: string;
  evidence?: string;
  reason?: string;
  factors?: string[];
}

export function hasAnyReworkFlag(flags: ReworkFlags | undefined): boolean {
  if (!flags) return false;
  return (
    flags.origin !== undefined ||
    flags.detectedAt !== undefined ||
    flags.status !== undefined ||
    flags.evidence !== undefined ||
    flags.reason !== undefined ||
    (flags.factors?.length ?? 0) > 0
  );
}

/**
 * Builds the record from flags and parses it. `unclassified` gets an explicit
 * `evidence_ref: null` unless `--evidence` was passed (which the schema then rejects);
 * `classified` gets whatever `--evidence` said (absent -> rejected). Flags are copied as-is
 * otherwise, so a mismatched `--reason` on a classified record is rejected by the schema,
 * not silently dropped.
 */
export function parseReworkFlags(
  flags: ReworkFlags,
): { ok: true; value: ReworkClassification } | { ok: false; message: string } {
  const candidate: Record<string, unknown> = {
    classification_status: flags.status,
    origin: flags.origin,
    detection_stage: flags.detectedAt,
    evidence_ref:
      flags.evidence !== undefined
        ? flags.evidence
        : flags.status === "unclassified"
          ? null
          : undefined,
  };
  if (flags.reason !== undefined) candidate.unclassified_reason = flags.reason;
  if ((flags.factors?.length ?? 0) > 0) candidate.contributing_factors = flags.factors;
  const parsed = ReworkClassificationSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, message: `invalid rework classification -- ${issues}` };
}
