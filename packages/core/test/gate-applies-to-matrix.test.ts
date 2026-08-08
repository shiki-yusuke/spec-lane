import {
  type Intent,
  IntentSchema,
  type LaneState,
  LaneStateSchemaV3,
  PHASE_TRANSITIONS,
  type Phase,
  type Profile,
  ProfileSchema,
} from "@lane/schemas";
import { describe, expect, it } from "vitest";
import {
  type Gate,
  type GateContext,
  type GateTrigger,
  premiseEvidenceGate,
  specConsensusGate,
  successCriteriaGate,
} from "../src/gate.js";

// Gate-port review (2026-08-06), item 6 required acceptance test 3: verifies the full
// appliesTo() matrix across *every* transition edge PHASE_TRANSITIONS actually allows
// (not just the three edges each gate's own doc comment calls out), plus every
// before_pr_publish{phase} value -- so a future edit to any gate's appliesTo can't
// silently start (or stop) firing on an edge nobody wrote a targeted test for.

const intent: Intent = IntentSchema.parse({
  schema_version: "1.0",
  intent_id: "I-2026-08-06-matrix",
  intent: {
    business_goal: "Reduce onboarding time by clarifying setup docs.",
    user_visible_intent: "New users see setup steps in order.",
    success: ["ok"],
    primary_user: "new_developer",
    declared_risk: "low",
  },
  ai_inferred_scope: {
    affected_layers: ["docs"],
    confidence: "medium",
    allowed_paths: ["docs/**"],
  },
});
const profile: Profile = ProfileSchema.parse({ schema_version: "1.0", profile_id: "generic" });
const state: LaneState = LaneStateSchemaV3.parse({
  schema_version: "3.0",
  intent_id: intent.intent_id,
  tracker_url: null,
  pr_url: null,
  owner: null,
  current_phase: "1_intent",
  status: "running",
  created_at: "2026-08-06T09:00:00+09:00",
});

function ctxFor(trigger: GateTrigger): GateContext {
  return { trigger, state, profile, artifacts: { intent } };
}

// Every phase_advance edge PHASE_TRANSITIONS actually allows (forward and the two
// documented rework/re-entry edges), derived from the transition table itself rather than
// hand-typed, so this test can't drift from PHASE_TRANSITIONS if that table ever changes.
const ALL_PHASE_ADVANCE_TRIGGERS: GateTrigger[] = Object.entries(PHASE_TRANSITIONS).flatMap(
  ([from, targets]) =>
    targets.map((to) => ({ type: "phase_advance" as const, from: from as Phase, to })),
);
const ALL_PHASES: Phase[] = ["1_intent", "2_spec", "3_implement", "4_verify", "5_done"];
const ALL_BEFORE_PR_PUBLISH_TRIGGERS: GateTrigger[] = ALL_PHASES.map((phase) => ({
  type: "before_pr_publish" as const,
  phase,
}));
const ALL_TRIGGERS: GateTrigger[] = [
  ...ALL_PHASE_ADVANCE_TRIGGERS,
  ...ALL_BEFORE_PR_PUBLISH_TRIGGERS,
];

function triggerLabel(t: GateTrigger): string {
  return t.type === "phase_advance"
    ? `phase_advance ${t.from}->${t.to}`
    : `before_pr_publish@${t.phase}`;
}

function expectedApplies(gateId: string, t: GateTrigger): boolean {
  if (gateId === "premise_evidence") {
    return t.type === "phase_advance" && t.from === "1_intent" && t.to === "2_spec";
  }
  if (gateId === "success_criteria") {
    return (
      t.type === "before_pr_publish" ||
      (t.type === "phase_advance" && t.from === "3_implement" && t.to === "4_verify")
    );
  }
  if (gateId === "spec_consensus") {
    return (
      (t.type === "before_pr_publish" && (t.phase === "4_verify" || t.phase === "5_done")) ||
      (t.type === "phase_advance" && t.to === "5_done")
    );
  }
  throw new Error(`unknown gate id: ${gateId}`);
}

const GATES: Gate[] = [premiseEvidenceGate, successCriteriaGate, specConsensusGate];

describe("DEFAULT_GATES appliesTo() matrix — every registered gate x every transition/checkpoint trigger", () => {
  it(`covers all ${ALL_PHASE_ADVANCE_TRIGGERS.length} phase_advance edges and all ${ALL_BEFORE_PR_PUBLISH_TRIGGERS.length} before_pr_publish phases (sanity on the fixture itself)`, () => {
    expect(ALL_PHASE_ADVANCE_TRIGGERS.length).toBe(7); // 5 forward/rework edges the table allows, +2 re-entry edges
    expect(ALL_BEFORE_PR_PUBLISH_TRIGGERS.length).toBe(5);
  });

  for (const gate of GATES) {
    for (const trigger of ALL_TRIGGERS) {
      const expected = expectedApplies(gate.id, trigger);
      it(`${gate.id}.appliesTo(${triggerLabel(trigger)}) === ${expected}`, () => {
        expect(gate.appliesTo(ctxFor(trigger))).toBe(expected);
      });
    }
  }

  it("exactly one gate applies to the 1_intent->2_spec edge (premise_evidence only)", () => {
    const trigger: GateTrigger = { type: "phase_advance", from: "1_intent", to: "2_spec" };
    const applying = GATES.filter((g) => g.appliesTo(ctxFor(trigger))).map((g) => g.id);
    expect(applying).toEqual(["premise_evidence"]);
  });

  it("exactly one gate applies to the 3_implement->4_verify edge (success_criteria only)", () => {
    const trigger: GateTrigger = { type: "phase_advance", from: "3_implement", to: "4_verify" };
    const applying = GATES.filter((g) => g.appliesTo(ctxFor(trigger))).map((g) => g.id);
    expect(applying).toEqual(["success_criteria"]);
  });

  it("exactly one gate applies to the 4_verify->5_done edge (spec_consensus only)", () => {
    const trigger: GateTrigger = { type: "phase_advance", from: "4_verify", to: "5_done" };
    const applying = GATES.filter((g) => g.appliesTo(ctxFor(trigger))).map((g) => g.id);
    expect(applying).toEqual(["spec_consensus"]);
  });

  it("no gate applies to either backward/re-entry edge (2_spec->1_intent, 4_verify->3_implement, 3_implement->2_spec)", () => {
    for (const trigger of [
      { type: "phase_advance" as const, from: "2_spec" as Phase, to: "1_intent" as Phase },
      { type: "phase_advance" as const, from: "3_implement" as Phase, to: "2_spec" as Phase },
      { type: "phase_advance" as const, from: "4_verify" as Phase, to: "3_implement" as Phase },
    ]) {
      const applying = GATES.filter((g) => g.appliesTo(ctxFor(trigger)));
      expect(applying).toEqual([]);
    }
  });

  it("before_pr_publish at an early phase (1_intent/2_spec/3_implement) only ever risks success_criteria (as a warning), never spec_consensus", () => {
    for (const phase of ["1_intent", "2_spec", "3_implement"] as Phase[]) {
      const trigger: GateTrigger = { type: "before_pr_publish", phase };
      const applying = GATES.filter((g) => g.appliesTo(ctxFor(trigger))).map((g) => g.id);
      expect(applying).toEqual(["success_criteria"]);
    }
  });

  it("before_pr_publish at 4_verify/5_done applies both success_criteria and spec_consensus", () => {
    for (const phase of ["4_verify", "5_done"] as Phase[]) {
      const trigger: GateTrigger = { type: "before_pr_publish", phase };
      const applying = GATES.filter((g) => g.appliesTo(ctxFor(trigger))).map((g) => g.id);
      expect(applying.sort()).toEqual(["spec_consensus", "success_criteria"]);
    }
  });
});
