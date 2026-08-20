import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_MESSAGE_CATALOG, formatDesignMessage } from "@lane/core";
import { describe, expect, it } from "vitest";
import {
  DESIGN_TRACK_GATE_IDS,
  scanCommandSource,
  scanGateSource,
} from "./helpers/design-message-scan.js";

// I-2026-08-18-design-critic-injection R45/R46, Gherkin: "every emitted message resolves
// to a catalog identifier" / "no message was assembled from sentence fragments" (team-lead
// review, 2026-08-19: this scenario was previously uncovered).
//
// Rather than exercising every runtime branch of every new command/gate (which would only
// prove the branches this test happens to think of are catalog-based, and say nothing
// about a future branch someone adds without going through the catalog), this is a STATIC
// check over the actual source of the new commands (commands/design.ts) and the two design
// gates in gate.ts. A future PR that adds a hand-written message to either fails this test
// immediately, which is the guarantee R45/R46 asks for ("every message ... SHALL be").
//
// The design gates are identified by the id they declare, NOT by where they sit in the
// file. The first version of this test sliced gate.ts between `designEstablishmentGate` and
// `export interface GateEvaluation`, which made an unrelated gate's plain-string diagnostics
// fail a design-track check as soon as one was written in that range -- and one was, so it
// was moved out of the range to get green. See test/helpers/design-message-scan.ts for the
// scanners, and design-message-scan.test.ts for the fixtures and real-source mutations that
// show membership (not position) is what the scanners key on.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const designCommandsSrc = readFileSync(
  join(repoRoot, "packages", "cli", "src", "commands", "design.ts"),
  "utf-8",
);
const gateSrc = readFileSync(join(repoRoot, "packages", "core", "src", "gate.ts"), "utf-8");

describe("R45/R46: every design-command/design-gate message is catalog-backed, not a hand-written literal", () => {
  it("commands/design.ts: every `message:` value is formatDesignMessage(...) or a catalog-only join", () => {
    const result = scanCommandSource(designCommandsSrc);
    expect(
      result.violations,
      `non-catalog message expression(s): ${JSON.stringify(result.violations, null, 2)}`,
    ).toEqual([]);
    // Fail-closed: a scan that examined nothing reports no violations too.
    expect(result.messageSitesExamined).toBeGreaterThan(5);
    expect(result.messageArrayElementsExamined).toBeGreaterThan(0);
  });

  it("gate.ts: every diagnostic in a design gate carries a formatDesignMessage(...) message", () => {
    const result = scanGateSource(gateSrc);
    expect(
      result.violations,
      `non-catalog or unclassifiable diagnostic(s): ${JSON.stringify(result.violations, null, 2)}`,
    ).toEqual([]);
    for (const id of DESIGN_TRACK_GATE_IDS) {
      expect(result.gateIdsFound, `design gate "${id}" was not found in gate.ts`).toContain(id);
      expect(
        result.designDiagnosticsExamined.filter(([gateId]) => gateId === id).length,
        `no diagnostics were examined for design gate "${id}"`,
      ).toBeGreaterThan(0);
    }
  });

  it("gate.ts: non-design gates are outside this rule, whatever order the gates are written in", () => {
    // The reach of the design rule is exactly the design gates. Asserting that some non-design
    // gate exists and contributed no examined diagnostic is what keeps a future re-broadening
    // (or a re-introduced positional slice) from passing silently.
    const result = scanGateSource(gateSrc);
    const nonDesign = result.gateIdsFound.filter(
      (id) => !DESIGN_TRACK_GATE_IDS.includes(id as (typeof DESIGN_TRACK_GATE_IDS)[number]),
    );
    expect(nonDesign.length).toBeGreaterThan(0);
    const examinedIds = new Set(result.designDiagnosticsExamined.map(([gateId]) => gateId));
    for (const id of nonDesign) {
      expect(examinedIds, `non-design gate "${id}" was swept into the design check`).not.toContain(
        id,
      );
    }
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
