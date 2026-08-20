import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Violation,
  scanCommandSource,
  scanGateSource,
} from "./helpers/design-message-scan.js";

/**
 * Tests for the scanners themselves, in two halves that answer two different questions.
 *
 * The synthetic half answers "does the scanner classify by membership rather than by position?"
 * It cannot be answered against the real gate.ts, because the real file has no unrelated gate
 * sitting in the design gates' old positional range -- the gate that triggered this work was moved
 * out of that range to make the previous check pass, so the evidence was removed by the workaround.
 *
 * The mutation half answers "does the scanner still reach the real source?" A synthetic fixture
 * proves nothing about that: it is written to match the scanner, so the two can agree with each
 * other while both have drifted away from the file that actually ships. Each mutation therefore
 * edits the shipping source in memory, asserts the edit landed in exactly one place, and asserts
 * the scan goes from clean to reporting that specific violation.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const gateSrc = readFileSync(join(repoRoot, "packages", "core", "src", "gate.ts"), "utf-8");
const designCommandsSrc = readFileSync(
  join(repoRoot, "packages", "cli", "src", "commands", "design.ts"),
  "utf-8",
);

function kinds(violations: Violation[]): string[] {
  return violations.map((v) => v.kind);
}

/**
 * Applies one edit to real source, failing if the anchor is not unique.
 *
 * Without the uniqueness assertion a mutation test degrades silently: an anchor that stops matching
 * (someone reformatted the file) mutates nothing, the scan legitimately reports no violation, and
 * the test that was supposed to detect a blind scanner passes because nothing was ever injected.
 */
function replaceExactlyOnce(src: string, anchor: RegExp, replacement: string): string {
  const matches = [...src.matchAll(new RegExp(anchor.source, `${anchor.flags.replace("g", "")}g`))];
  expect(matches.length, `mutation anchor ${anchor} must match exactly once`).toBe(1);
  return src.replace(anchor, replacement);
}

// A gate.ts-shaped source with THREE gates: two design gates and, between them and the
// `GateEvaluation` marker, an unrelated gate whose diagnostics are deliberately hand-written
// strings. This is the exact arrangement the previous positional check rejected.
const GATE_FIXTURE = `
export interface Gate {
  id: string;
  appliesTo(ctx: GateContext): boolean;
  evaluate(ctx: GateContext): Diagnostic[];
}

function diagnostic(gateId: string, code: string, severity: Severity, message: string): Diagnostic {
  return { gateId, code, severity, message };
}

export const designEstablishmentGate: Gate = {
  id: "design_establishment",
  appliesTo: () => true,
  evaluate: () => [
    diagnostic("design_establishment", "options_missing", "error", formatDesignMessage("a", {})),
  ],
};

export const designDecisionGate: Gate = {
  id: "design_decision",
  appliesTo: () => true,
  evaluate: () => [
    // A comment that mentions "error", and a decoy call in prose: diagnostic("x", "y", "error", \`z\`)
    diagnostic("design_decision", "decision_missing", 'warning', formatDesignMessage("b", {})),
  ],
};

// The unrelated gate: sits inside the old positional range, emits plain strings on purpose.
export const unrelatedNewGate: Gate = {
  id: "unrelated_new",
  appliesTo: () => true,
  evaluate: (ctx) => [
    diagnostic("unrelated_new", "weakened", "error", \`plain text with \${ctx.count} interpolated\`),
    diagnostic("unrelated_new", "other", "warning", "an ordinary string literal"),
  ],
};

export interface GateEvaluation {
  diagnostics: Diagnostic[];
}
`;

describe("membership, not position: an unrelated gate in the old range does not implicate the design track", () => {
  it("accepts a source where a plain-string gate sits between the design gates and GateEvaluation", () => {
    const result = scanGateSource(GATE_FIXTURE);
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });

  it("still finds both design gates and every design diagnostic in that same source", () => {
    const result = scanGateSource(GATE_FIXTURE);
    expect(result.gateIdsFound).toEqual([
      "design_establishment",
      "design_decision",
      "unrelated_new",
    ]);
    expect(result.designDiagnosticsExamined).toEqual([
      ["design_establishment", "options_missing"],
      ["design_decision", "decision_missing"],
    ]);
  });

  it("is not fooled into counting the unrelated gate's messages as design messages", () => {
    // The regression this whole change is about: the plain-string diagnostics above must be
    // examined by NO design rule, which is visible as their absence from what was examined.
    const examined = scanGateSource(GATE_FIXTURE).designDiagnosticsExamined.map(([id]) => id);
    expect(examined).not.toContain("unrelated_new");
  });
});

describe("the scan rejects what it is supposed to reject (synthetic violations)", () => {
  it("a design gate emitting a template literal is a violation", () => {
    const mutated = GATE_FIXTURE.replace(
      'diagnostic("design_establishment", "options_missing", "error", formatDesignMessage("a", {}))',
      'diagnostic("design_establishment", "options_missing", "error", `design options are missing`)',
    );
    expect(kinds(scanGateSource(mutated).violations)).toEqual(["non_catalog_message"]);
  });

  it("a catalog message with text concatenated onto it is a violation", () => {
    // The specific hole in the regex predecessor: it matched the leading token and stopped, so
    // this passed a `startsWith("formatDesignMessage(")` test while being fragment assembly.
    const mutated = GATE_FIXTURE.replace(
      'formatDesignMessage("a", {})',
      'formatDesignMessage("a", {}) + " (see docs)"',
    );
    expect(kinds(scanGateSource(mutated).violations)).toEqual(["non_catalog_message"]);
  });

  it("a diagnostic whose gate id is a variable is a violation, not an exemption", () => {
    const mutated = GATE_FIXTURE.replace(
      'diagnostic("design_decision", "decision_missing"',
      'diagnostic(gateId, "decision_missing"',
    );
    expect(kinds(scanGateSource(mutated).violations)).toEqual(["non_literal_gate_id"]);
  });

  it("a diagnostic labelled with another gate's id is a violation", () => {
    const mutated = GATE_FIXTURE.replace(
      'diagnostic("unrelated_new", "weakened"',
      'diagnostic("design_decision", "weakened"',
    );
    expect(kinds(scanGateSource(mutated).violations)).toEqual(["gate_id_mismatch"]);
  });

  it("a Diagnostic built without the factory is a violation", () => {
    const mutated = GATE_FIXTURE.replace(
      'diagnostic("design_establishment", "options_missing", "error", formatDesignMessage("a", {}))',
      '{ gateId: "design_establishment", code: "options_missing", severity: "error", message: `plain` }',
    );
    expect(kinds(scanGateSource(mutated).violations)).toContain("raw_diagnostic_object");
  });

  it("a design gate that disappears is a violation, not a silently empty scan", () => {
    const mutated = GATE_FIXTURE.replace('id: "design_decision"', 'id: "design_decision_renamed"');
    expect(kinds(scanGateSource(mutated).violations)).toContain("design_gate_missing");
  });

  it("unparsable source is a violation, not a clean result", () => {
    expect(kinds(scanGateSource("export const broken: Gate = { id: ").violations)).toContain(
      "parse_error",
    );
  });
});

describe("command scan rejects the ways a joined message array can be seeded by hand", () => {
  const COMMAND_FIXTURE = `
export function designStatus(): CommandResult {
  const lines: string[] = [];
  lines.push(formatDesignMessage("design_status_header", {}));
  return { exitCode: 0, message: lines.join("\\n") };
}
`;

  it("accepts the shape commands/design.ts actually uses", () => {
    const result = scanCommandSource(COMMAND_FIXTURE);
    expect(result.violations).toEqual([]);
    expect(result.messageSitesExamined).toBe(1);
    expect(result.messageArrayPushesExamined).toBe(1);
  });

  it("rejects an array seeded with a hand-written line at declaration", () => {
    const mutated = COMMAND_FIXTURE.replace(
      "const lines: string[] = [];",
      'const lines: string[] = ["Design status:"];',
    );
    expect(kinds(scanCommandSource(mutated).violations)).toEqual([
      "unapproved_message_array_mutation",
    ]);
  });

  it("rejects a line added by unshift rather than push", () => {
    const mutated = COMMAND_FIXTURE.replace(
      'lines.push(formatDesignMessage("design_status_header", {}));',
      'lines.unshift("Design status:");',
    );
    expect(kinds(scanCommandSource(mutated).violations)).toEqual([
      "unapproved_message_array_mutation",
    ]);
  });

  it("rejects a pushed template literal", () => {
    const mutated = COMMAND_FIXTURE.replace(
      'formatDesignMessage("design_status_header", {})',
      "`Design status: ${id}`",
    );
    expect(kinds(scanCommandSource(mutated).violations)).toEqual(["non_catalog_message_line"]);
  });
});

describe("the scan still reaches the shipping source (mutation of the real files)", () => {
  it("gate.ts and commands/design.ts are clean as committed", () => {
    const gate = scanGateSource(gateSrc);
    expect(gate.violations, JSON.stringify(gate.violations, null, 2)).toEqual([]);
    const command = scanCommandSource(designCommandsSrc);
    expect(command.violations, JSON.stringify(command.violations, null, 2)).toEqual([]);
  });

  it("catches a hand-written message injected into the real designEstablishmentGate", () => {
    const mutated = replaceExactlyOnce(
      gateSrc,
      /formatDesignMessage\("establishment_blocked_no_override", \{\}\)/,
      "`design establishment is blocked and no override is recorded`",
    );
    const violations = scanGateSource(mutated).violations;
    expect(kinds(violations)).toEqual(["non_catalog_message"]);
    expect(violations[0]?.detail).toContain("design_establishment");
  });

  it("catches a hand-written message injected into the real designDecisionGate", () => {
    const mutated = replaceExactlyOnce(
      gateSrc,
      /formatDesignMessage\("decision_missing", \{\}\)/,
      "`no decision has been recorded`",
    );
    const violations = scanGateSource(mutated).violations;
    expect(kinds(violations)).toEqual(["non_catalog_message"]);
    expect(violations[0]?.detail).toContain("design_decision");
  });

  it("catches text concatenated onto a real design gate message", () => {
    const mutated = replaceExactlyOnce(
      gateSrc,
      /formatDesignMessage\("establishment_blocked_no_override", \{\}\)/,
      'formatDesignMessage("establishment_blocked_no_override", {}) + " -- see docs/design.md"',
    );
    expect(kinds(scanGateSource(mutated).violations)).toEqual(["non_catalog_message"]);
  });

  it("catches a hand-written line pushed into the real status message", () => {
    const mutated = replaceExactlyOnce(
      designCommandsSrc,
      /formatDesignMessage\("design_status_header", \{/,
      "`Design status for ${(",
    );
    // The mutation makes the file unparsable rather than merely non-catalog, which is itself a
    // reported violation -- the point of the assertion is that a clean result is impossible.
    expect(scanCommandSource(mutated).violations.length).toBeGreaterThan(0);
  });

  it("accepts an unrelated plain-string gate inserted INTO the old positional range of the real file", () => {
    // This is the acceptance condition for the rework, stated against the shipping source rather
    // than a fixture: a gate that has nothing to do with the design track, written in the span the
    // previous check sliced out, must not be implicated by a design-track rule.
    const UNRELATED_GATE = [
      "export const unrelatedInsertedGate: Gate = {",
      '  id: "unrelated_inserted",',
      "  appliesTo: () => true,",
      "  evaluate: (ctx) => [",
      '    diagnostic("unrelated_inserted", "weakened", "error", `plain text ${ctx.state.phase}`),',
      '    diagnostic("unrelated_inserted", "noted", "warning", "an ordinary string literal"),',
      "  ],",
      "};",
      "",
      "export const designDecisionGate: Gate = {",
    ].join("\n");
    const mutated = replaceExactlyOnce(
      gateSrc,
      /export const designDecisionGate: Gate = \{/,
      UNRELATED_GATE,
    );

    // Prove the insertion really landed in the old range instead of asserting it in a comment:
    // the previous check sliced from `designEstablishmentGate` to `interface GateEvaluation`.
    const rangeStart = mutated.indexOf("export const designEstablishmentGate");
    const rangeEnd = mutated.indexOf("export interface GateEvaluation");
    const insertedAt = mutated.indexOf("export const unrelatedInsertedGate");
    expect(rangeStart).toBeGreaterThan(-1);
    expect(insertedAt).toBeGreaterThan(rangeStart);
    expect(insertedAt).toBeLessThan(rangeEnd);

    const result = scanGateSource(mutated);
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
    expect(result.gateIdsFound).toContain("unrelated_inserted");
    expect(result.designDiagnosticsExamined.map(([id]) => id)).not.toContain("unrelated_inserted");
  });

  it("the previous positional check would have failed on that same source (the defect, reproduced)", () => {
    // Without this, "the new scan passes" is only half the claim -- it does not show the old one
    // failed, so it cannot show anything was actually fixed. Reproduces the old extractor exactly:
    // slice by position, take the head of every argument following a severity literal.
    const mutated = gateSrc.replace(
      "export const designDecisionGate: Gate = {",
      [
        "export const unrelatedInsertedGate: Gate = {",
        '  id: "unrelated_inserted",',
        "  appliesTo: () => true,",
        "  evaluate: (ctx) => [",
        '    diagnostic("unrelated_inserted", "weakened", "error", `plain text ${ctx.state.phase}`),',
        "  ],",
        "};",
        "",
        "export const designDecisionGate: Gate = {",
      ].join("\n"),
    );
    const section = mutated.slice(
      mutated.indexOf("export const designEstablishmentGate"),
      mutated.indexOf("export interface GateEvaluation"),
    );
    const oldExtractorHeads = [...section.matchAll(/"(?:error|warning)",\s*/g)].map((m) =>
      section.slice(m.index + m[0].length, m.index + m[0].length + 40).trim(),
    );
    const oldOffenders = oldExtractorHeads.filter((h) => !h.startsWith("formatDesignMessage("));
    expect(
      oldOffenders.length,
      "the old positional check should have flagged the unrelated gate",
    ).toBeGreaterThan(0);
  });
});
