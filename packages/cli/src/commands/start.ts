import { appendFileSync } from "node:fs";
import type { Intent, LaneState } from "@lane/schemas";
import { intentExists, intentPath, writeIntent } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, writeLaneState } from "../state-store.js";

// Real-world scaffold mistakes this guards against (all three shipped `premise_evidence`
// or `critic.yaml` in a shape `lane validate` rejects, even though the *content* was
// right): `premise_evidence` written as a list under a `premises:` key instead of the
// single object PremiseEvidenceSchema actually is, and `method` set to a value
// (`static_trace`) that isn't one of the schema's three (`live`/`data`/`code-only`). A
// freshly scaffolded intent.yaml carrying the exact shape inline -- not just prose in
// skills/lane/SKILL.md -- means an agent editing this file sees the real constraint at
// the point of use, instead of having to have already read (and correctly recalled) the
// skill doc. This is appended as a raw comment after writeIntent's own
// IntentSchema-validated write, not folded into the `Intent` object itself: the object
// has no way to represent "field omitted, but here's a comment explaining the two shapes
// it can take" -- YAML comments have no equivalent in a parsed JS value.
const PREMISE_EVIDENCE_GUIDE_COMMENT = `
# premise_evidence:            # <- record this at Phase 1 (gate 1), before writing spec.md.
#                               #    Exactly one of these two shapes -- a single object, never a list:
#   required: true             # this change's premise needs its real-world existence confirmed
#   method: code-only          # live | data | code-only ONLY -- no other value (live/data are stronger evidence)
#   reproduced: true           # boolean -- was it actually confirmed?
#   evidence: "..."            # a single string (not a list) -- what was checked and how
# --- or ---
# premise_evidence:
#   required: false
#   reason: "..."              # string -- why this doesn't apply
`;

export interface StartOptions {
  specDir?: string;
  businessGoal?: string;
  userVisibleIntent?: string;
  primaryUser?: string;
  risk?: "low" | "medium" | "high";
  affectedLayer?: string[];
  allowedPath?: string[];
  owner?: string;
}

export interface CommandResult {
  exitCode: number;
  message: string;
}

/**
 * Creates docs/spec/<intent-id>/intent.yaml + lane-state.json and moves the lane straight
 * to phase=1_intent, status=running (design.md carries the Python reference implementation's pending->running
 * transition on Phase 1 start). Placeholder intent fields are schema-valid on their own
 * (satisfy minLength etc.) so a freshly started lane can be advanced/validated
 * non-interactively; real content is expected to replace them before Phase 2 in normal
 * (non-e2e-test) use.
 */
export function runStart(intentId: string, opts: StartOptions): CommandResult {
  const specDir = resolveSpecDir({ override: opts.specDir });

  if (laneStateExists(specDir, intentId)) {
    return { exitCode: 2, message: `Lane already exists: ${intentId}` };
  }

  if (!intentExists(specDir, intentId)) {
    const intent: Intent = {
      schema_version: "1.0",
      intent_id: intentId,
      execution_mode: "manual",
      budget: [],
      intent: {
        business_goal: opts.businessGoal ?? "Describe the business goal for this lane.",
        user_visible_intent: opts.userVisibleIntent ?? "Describe what the user will see change.",
        success: ["Describe at least one success criterion."],
        non_goal: [],
        constraints: [],
        primary_user: opts.primaryUser ?? "unspecified",
        state_segments: [],
        known_affected_behavior: [],
        declared_risk: opts.risk ?? "low",
      },
      ai_inferred_scope: {
        affected_layers: opts.affectedLayer?.length ? opts.affectedLayer : ["unspecified"],
        related_files: [],
        required_docs: [],
        confidence: "low",
        open_questions: [],
        allowed_paths: opts.allowedPath?.length ? opts.allowedPath : ["**"],
        forbidden_paths: [],
      },
    };
    writeIntent(specDir, intentId, intent);
    appendFileSync(intentPath(specDir, intentId), PREMISE_EVIDENCE_GUIDE_COMMENT);
  }

  const now = new Date().toISOString();
  const state: LaneState = {
    schema_version: "3.0",
    intent_id: intentId,
    tracker_url: null,
    pr_url: null,
    pr_provenance: null,
    owner: opts.owner ?? null,
    current_phase: "1_intent",
    status: "running",
    created_at: now,
    updated_at: now,
    phase_history: [{ phase: "1_intent", started_at: now, result: "in_progress", retry_count: 0 }],
    halt_info: null,
    retry_log: [],
    effective_risk_log: [],
    mode_resolution_log: [],
    cost_ledger: [],
    usage_import_attempts: [],
    usage_import_gate_overrides: [],
  };
  writeLaneState(specDir, intentId, state);

  return { exitCode: 0, message: `Started lane ${intentId} at 1_intent (${specDir}/${intentId})` };
}
