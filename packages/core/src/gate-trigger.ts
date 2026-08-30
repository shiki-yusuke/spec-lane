import type { Phase } from "@lane/schemas";

/**
 * Gate-port review (2026-08-06) — replaces the old flat `{ phase, targetPhase, event }` shape
 * with a discriminated union so a gate's `appliesTo` can't be handed a nonsensical combination
 * (e.g. an `event: "before_pr_publish"` alongside an unrelated `targetPhase` that was never
 * actually the transition being attempted). `phase_advance` is the one real edge
 * (`from` -> `to`) an `advance` call is attempting; `before_pr_publish` is the standalone
 * pre-publish checkpoint `validate` evaluates independently of any specific transition (see
 * packages/cli/src/gate-check.ts).
 *
 * I-2026-08-20-promotion-invariants adds `promotion`, a third, independent trigger fired once
 * at `advance --phase 5_done`, alongside (not instead of) the `phase_advance` trigger that edge
 * already fires. Where `phase_advance`/`before_pr_publish` each ask "does this one
 * edge/checkpoint's own gate pass", `promotion` asks "do the predicates that must hold in the
 * *final* state still hold, evaluated against current content" — the chain-probe gap this
 * closes (docs/spec/I-2026-08-20-promotion-invariants/intent.yaml) was a lane reaching 5_done
 * with premise_evidence values that would have blocked the very edge they were recorded at,
 * because nothing re-read them afterward. It is deliberately not a replay of every historical
 * gate (the architect's ruling rejected that: "lane が常に通っていたことを証明できない" is not
 * a promotion-safety concern; promotion is a predicate on the state being promoted, not a proof
 * of unbroken history). `weakeningRationale` and `acknowledgeRulesetMigration` are per-attempt
 * inputs the CLI layer threads through from `--weakening-rationale`/`--ack-ruleset-migration`,
 * read only by promotionWeakeningGate and gateRulesetVersionGate respectively.
 *
 * This type lives in its own module rather than in gate.ts because both gate.ts and
 * external-verify.ts need it, and external-verify.ts must be importable BY gate.ts
 * (I-2026-08-29-external-verify-gate) -- keeping the type here is what stops that from being a
 * module cycle, which .dependency-cruiser.cjs's no-package-cycles rule forbids. The alternative
 * (duplicating the "is this the gated edge?" predicate in both files) was rejected: the gate's
 * appliesTo and the runner's own run condition MUST agree exactly, or the command is either
 * spawned twice per `lane validate` or silently never run at all.
 */
export type GateTrigger =
  | { type: "phase_advance"; from: Phase; to: Phase }
  | { type: "before_pr_publish"; phase: Phase }
  | { type: "promotion"; weakeningRationale?: string; acknowledgeRulesetMigration?: boolean };
