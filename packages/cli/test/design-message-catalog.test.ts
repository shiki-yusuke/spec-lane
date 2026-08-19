import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_MESSAGE_CATALOG, formatDesignMessage } from "@lane/core";
import { describe, expect, it } from "vitest";

// I-2026-08-18-design-critic-injection R45/R46, Gherkin: "every emitted message resolves
// to a catalog identifier" / "no message was assembled from sentence fragments" (team-lead
// review, 2026-08-19: this scenario was previously uncovered).
//
// Rather than exercising every runtime branch of every new command/gate (which would only
// prove the branches this test happens to think of are catalog-based, and say nothing
// about a future branch someone adds without going through the catalog), this is a STATIC
// check over the actual source of the new commands (commands/design.ts) and the two new
// gates' section of gate.ts: every `message:`/diagnostic() message argument in that source
// must be either a `formatDesignMessage(...)` call or a `lines.join(...)` of a local array
// built entirely from `formatDesignMessage(...)` push calls. A future PR that adds a
// hand-written template-literal message to either file fails this test immediately,
// which is the actual guarantee R45/R46 asks for ("every message ... SHALL be").

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const designCommandsSrc = readFileSync(
  join(repoRoot, "packages", "cli", "src", "commands", "design.ts"),
  "utf-8",
);
const gateSrc = readFileSync(join(repoRoot, "packages", "core", "src", "gate.ts"), "utf-8");

function extractDesignGatesSection(fullGateSrc: string): string {
  const start = fullGateSrc.indexOf("export const designEstablishmentGate");
  const end = fullGateSrc.indexOf("export interface GateEvaluation");
  expect(start, "designEstablishmentGate not found in gate.ts").toBeGreaterThan(-1);
  expect(end, "GateEvaluation not found after the design gates in gate.ts").toBeGreaterThan(start);
  return fullGateSrc.slice(start, end);
}

/**
 * Every `message:` object-literal value in `src`, identified by just its LEADING token
 * (the next ~40 characters after the colon) -- good enough to classify a value as
 * `formatDesignMessage(...)`, `lines.join(...)`, or "something else" without a real parser,
 * regardless of whether the call happens to be on the same line as `message:` or wrapped
 * onto following lines (this codebase's own biome formatting does both depending on line
 * length, so matching only the single-line shape would silently stop checking anything
 * biome ever reflows).
 */
function findMessageValueHeads(src: string): string[] {
  const heads: string[] = [];
  const re = /message:\s*/g;
  for (const m of src.matchAll(re)) {
    const start = m.index + m[0].length;
    heads.push(src.slice(start, start + 40).trim());
  }
  return heads;
}

/**
 * Every diagnostic() call's message argument, found via its distinctive position: always
 * immediately after the literal severity string ("error"/"warning") + comma, in this
 * codebase's own diagnostic(gateId, code, severity, message) call shape. Simpler and more
 * robust than balancing parens by hand (which a comment containing a stray "(" or ")" --
 * this file has several, e.g. "(R35: ...)" -- silently breaks).
 */
function findDiagnosticFourthArgs(src: string): string[] {
  const heads: string[] = [];
  const re = /"(?:error|warning)",\s*/g;
  for (const m of src.matchAll(re)) {
    const start = m.index + m[0].length;
    heads.push(src.slice(start, start + 40).trim());
  }
  return heads;
}

function isCatalogBacked(expr: string): boolean {
  return expr.startsWith("formatDesignMessage(") || expr.startsWith("lines.join(");
}

describe("R45/R46: every new-command/new-gate message is catalog-backed, not a hand-written literal", () => {
  it("commands/design.ts: every `message:` value is formatDesignMessage(...) or lines.join(...)", () => {
    const heads = findMessageValueHeads(designCommandsSrc);
    expect(heads.length).toBeGreaterThan(5); // sanity: the extractor is actually finding real call sites
    const offenders = heads.filter((h) => !isCatalogBacked(h));
    expect(
      offenders,
      `non-catalog message expression(s) found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("commands/design.ts: `lines` is built ONLY from formatDesignMessage(...) pushes", () => {
    const linesPushes = [...designCommandsSrc.matchAll(/lines\.push\(\s*([\s\S]*?)\n\s*\);/g)].map(
      (m) => m[1]?.trim(),
    );
    expect(linesPushes.length).toBeGreaterThan(0);
    const offenders = linesPushes.filter((e) => e && !e.startsWith("formatDesignMessage("));
    expect(offenders, `non-catalog lines.push() found: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("gate.ts design gates: every diagnostic() message argument is formatDesignMessage(...)", () => {
    const section = extractDesignGatesSection(gateSrc);
    const fourthArgs = findDiagnosticFourthArgs(section);
    expect(fourthArgs.length).toBe(10); // the 10 known diagnostic() call sites across both design gates
    const offenders = fourthArgs.filter((e) => !e.startsWith("formatDesignMessage("));
    expect(
      offenders,
      `non-catalog diagnostic() message(s) found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

// R25, first two clauses: "SHALL NOT emit a single independence count. Where any count is
// shown, it SHALL show total reviews and qualifying reviews separately." Scoped to the
// AGGREGATE (whole-document) count only -- design_status_totals' {totalReviews}/
// {qualifyingReviews} pair -- not a per-option count like coverage_present_for_option's
// {qualifyingCount}, which names how many reviews cover ONE option, not "the independence
// count" for the document R25 is about. Checked catalog-wide (not per-scenario) so a future
// catalog entry that reintroduces a lone aggregate count fails immediately. The third
// clause (presentation ORDER) is checked separately in design-status-order.test.ts, since
// order isn't visible to a value-level check on the templates themselves.
const AGGREGATE_COUNT_PLACEHOLDERS = ["totalReviews", "qualifyingReviews"];

describe("R25: no catalog message emits a lone aggregate independence count", () => {
  it("design_status_totals reports both total and qualifying, never one alone", () => {
    const totals = DESIGN_MESSAGE_CATALOG.design_status_totals;
    expect(totals).toContain("{totalReviews}");
    expect(totals).toContain("{qualifyingReviews}");
  });

  it("no catalog entry anywhere reports an aggregate count without its counterpart", () => {
    const offenders: string[] = [];
    for (const [id, template] of Object.entries(DESIGN_MESSAGE_CATALOG)) {
      const present = AGGREGATE_COUNT_PLACEHOLDERS.filter((ph) => template.includes(`{${ph}}`));
      if (present.length === 1) offenders.push(`${id}: reports only {${present[0]}}`);
    }
    expect(
      offenders,
      `catalog message(s) with a lone aggregate count: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

describe("formatDesignMessage fails closed (backs the static guarantee above with a runtime one)", () => {
  it("throws on an unknown message id rather than returning a best-effort string", () => {
    // @ts-expect-error deliberately invalid id
    expect(() => formatDesignMessage("not_a_real_catalog_id", {})).toThrow(/unknown message id/);
  });

  it("throws when a template's placeholder has no matching param, rather than leaving a literal {placeholder}", () => {
    expect(() => formatDesignMessage("decision_option_unknown", {})).toThrow(/placeholder/);
  });

  it("the catalog is non-empty and every template's placeholders are well-formed", () => {
    const ids = Object.keys(DESIGN_MESSAGE_CATALOG);
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      const template = DESIGN_MESSAGE_CATALOG[id as keyof typeof DESIGN_MESSAGE_CATALOG];
      const placeholders = [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(
        (m) => m[1] as string,
      );
      const params = Object.fromEntries(placeholders.map((p) => [p, "x"]));
      expect(() => formatDesignMessage(id as never, params), `template "${id}"`).not.toThrow();
    }
  });
});
