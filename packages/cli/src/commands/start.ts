import { CURRENT_GATE_RULESET_VERSION } from "@lane/core";
import type { Intent, LaneState } from "@lane/schemas";
import { intentExists, writeIntent } from "../intent-store.js";
import { resolveSpecDir } from "../spec-dir.js";
import { laneStateExists, writeLaneState } from "../state-store.js";

export interface StartOptions {
  specDir?: string;
  businessGoal?: string;
  userVisibleIntent?: string;
  primaryUser?: string;
  risk?: "low" | "medium" | "high";
  affectedLayer?: string[];
  allowedPath?: string[];
  owner?: string;
  /** I-2026-08-18-design-critic-injection R1/R2: when omitted, no design_track field is
   * ever written -- see lane-state.ts's DesignTrackSchema comment for why this is
   * `.optional()` rather than `.default()`/`.nullable()`. */
  design?: boolean;
  /** Who recorded activation (R2 provenance). Defaults to `owner`, then "unspecified". */
  activatedBy?: string;
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
    // I-2026-08-20-promotion-invariants — recorded unconditionally (unlike design_track),
    // since every lane started by this binary genuinely was started under
    // CURRENT_GATE_RULESET_VERSION; only a lane that predates this field has a real reason
    // to omit the key (see gate.ts's gateRulesetVersionGate doc comment).
    gate_ruleset_version: CURRENT_GATE_RULESET_VERSION,
  };
  if (opts.design) {
    // R1: this whole block only runs when --design was actually passed -- a lane started
    // without it never touches `state.design_track` at all, so writeLaneState below
    // serializes byte-identical to pre-R2 behavior for that case.
    state.design_track = {
      activated: true,
      activated_by: opts.activatedBy ?? opts.owner ?? "unspecified",
      activated_at: now,
    };
  }
  writeLaneState(specDir, intentId, state);

  return { exitCode: 0, message: `Started lane ${intentId} at 1_intent (${specDir}/${intentId})` };
}
