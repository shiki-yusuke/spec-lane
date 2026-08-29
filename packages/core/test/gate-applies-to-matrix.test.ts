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
  externalVerifyGate,
  gateRulesetVersionGate,
  premiseEvidenceGate,
  promotionWeakeningGate,
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
// I-2026-08-20-promotion-invariants — the third trigger, fired once alongside
// `phase_advance{to:"5_done"}` (see gate.ts's GateTrigger doc comment). It carries no
// per-trigger identity of its own (unlike phase_advance's from/to or before_pr_publish's
// phase), so there is exactly one of these to enumerate.
const ALL_PROMOTION_TRIGGERS: GateTrigger[] = [{ type: "promotion" }];

const ALL_TRIGGERS: GateTrigger[] = [
  ...ALL_PHASE_ADVANCE_TRIGGERS,
  ...ALL_BEFORE_PR_PUBLISH_TRIGGERS,
  ...ALL_PROMOTION_TRIGGERS,
];

function triggerLabel(t: GateTrigger): string {
  if (t.type === "phase_advance") return `phase_advance ${t.from}->${t.to}`;
  if (t.type === "before_pr_publish") return `before_pr_publish@${t.phase}`;
  return "promotion";
}

function expectedApplies(gateId: string, t: GateTrigger): boolean {
  if (gateId === "premise_evidence") {
    return (
      t.type === "promotion" ||
      (t.type === "phase_advance" && t.from === "1_intent" && t.to === "2_spec")
    );
  }
  if (gateId === "success_criteria") {
    return (
      t.type === "before_pr_publish" ||
      t.type === "promotion" ||
      (t.type === "phase_advance" && t.from === "3_implement" && t.to === "4_verify")
    );
  }
  if (gateId === "spec_consensus") {
    return (
      (t.type === "before_pr_publish" && (t.phase === "4_verify" || t.phase === "5_done")) ||
      t.type === "promotion" ||
      (t.type === "phase_advance" && t.to === "5_done")
    );
  }
  if (gateId === "gate_ruleset_version" || gateId === "promotion_weakening") {
    return t.type === "promotion";
  }
  // I-2026-08-29-external-verify-gate — deliberately NARROWER than success_criteria, which
  // shares the same phase_advance edge: this one must not also match before_pr_publish, because
  // `lane validate` evaluates both triggers in a single run and the command would then be
  // spawned twice per validate (spec.md D4 / TEST-25). It also never matches promotion, so
  // `advance --phase 5_done` re-runs nothing (spec.md L2 / TEST-03).
  if (gateId === "external_verify") {
    return t.type === "phase_advance" && t.from === "3_implement" && t.to === "4_verify";
  }
  throw new Error(`unknown gate id: ${gateId}`);
}

const GATES: Gate[] = [
  premiseEvidenceGate,
  successCriteriaGate,
  specConsensusGate,
  gateRulesetVersionGate,
  promotionWeakeningGate,
  externalVerifyGate,
];

describe("DEFAULT_GATES appliesTo() matrix — every registered gate x every transition/checkpoint trigger", () => {
  it(`covers all ${ALL_PHASE_ADVANCE_TRIGGERS.length} phase_advance edges, all ${ALL_BEFORE_PR_PUBLISH_TRIGGERS.length} before_pr_publish phases, and the ${ALL_PROMOTION_TRIGGERS.length} promotion trigger (sanity on the fixture itself)`, () => {
    expect(ALL_PHASE_ADVANCE_TRIGGERS.length).toBe(7); // 5 forward/rework edges the table allows, +2 re-entry edges
    expect(ALL_BEFORE_PR_PUBLISH_TRIGGERS.length).toBe(5);
    expect(ALL_PROMOTION_TRIGGERS.length).toBe(1);
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

  // I-2026-08-29-external-verify-gate made this edge the only one with two gates on it.
  it("exactly two gates apply to the 3_implement->4_verify edge (success_criteria + external_verify)", () => {
    const trigger: GateTrigger = { type: "phase_advance", from: "3_implement", to: "4_verify" };
    const applying = GATES.filter((g) => g.appliesTo(ctxFor(trigger))).map((g) => g.id);
    expect(applying.sort()).toEqual(["external_verify", "success_criteria"]);
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

  // I-2026-08-20-promotion-invariants — the promotion trigger applies to all five gates
  // registered above: the three ported gates (re-evaluated against current content) plus
  // the two promotion-only gates (ruleset version, weakening diff). Written explicitly so
  // a future gate added to this file's GATES const without a promotion entry in
  // expectedApplies() fails loudly here, rather than silently never firing at promotion
  // (the exact "registered but not wired to the new trigger" trap the brief for this lane
  // warned about).
  //
  // I-2026-08-29-external-verify-gate is the first deliberate exception, and this test is
  // exactly where that decision had to be made consciously rather than by omission: an
  // external verification is a statement about the work at the moment it was verified, and
  // re-running someone's arbitrary command at promotion time was ruled out of scope in that
  // lane's intent (non_goal / spec.md L2). It is registered in GATES above and covered by the
  // full matrix, so this exclusion is asserted, not merely unstated.
  it("promotion applies to every gate registered here except external_verify (see above)", () => {
    const trigger: GateTrigger = { type: "promotion" };
    const applying = GATES.filter((g) => g.appliesTo(ctxFor(trigger))).map((g) => g.id);
    expect(applying.sort()).toEqual(
      [
        "gate_ruleset_version",
        "premise_evidence",
        "promotion_weakening",
        "spec_consensus",
        "success_criteria",
      ].sort(),
    );
    expect(applying).not.toContain("external_verify");
  });
});
