import { DESIGN_MESSAGE_CATALOG, formatDesignMessage } from "@lane/core";
import { describe, expect, it } from "vitest";

// I-2026-08-18-design-critic-injection R45/R46, Gherkin: "every emitted message resolves
// to a catalog identifier" / "no message was assembled from sentence fragments".
//
// R45/R46 used to be checked here by reading the source of gate.ts and commands/design.ts and
// classifying every message expression. That scan is gone: the same guarantee is now carried by
// `CatalogBackedDesignMessage`, which the type checker enforces at every point a message is
// produced, passed or printed -- including across files, which a single-file scan could not reach.
//
// Removing it was gated on showing the types catch what the scan caught, one violation class at a
// time, by injecting each into the real source (see the retirement PR for the table):
//
//   design gate labelled with another gate's id  -> TS2322
//   gate id passed as a `string` variable        -> TS2345 / TS2322
//   diagnostic() called with the wrong arity     -> TS2554
//   a Diagnostic built without the factory       -> TS2322
//   a hand-written message in a design gate      -> TS2345
//   a hand-written line pushed into the output   -> TS2345
//   the message array seeded at its declaration  -> TS2322
//   `DesignGate<Id>` downgraded to `Gate`        -> TS2322 (at the DESIGN_GATES registry)
//
// The last one is why the annotation is not a soft convention: `DESIGN_GATES` is a mapped type
// over `DesignGateId`, so a gate whose declared type is widened back to `Gate` stops being
// assignable to its own registry slot.
//
// What no type can state is kept, here and in two sibling files:
//   - this file: the catalog's own integrity (unknown ids, unfilled placeholders, R25's paired
//     counts) -- properties of the catalog data, not of any call site
//   - packages/core/test/catalog-backed-message.test.ts: the `@ts-expect-error` negatives, which
//     fail if the brand is ever widened back to `string`
//   - packages/cli/test/design-message-cast.test.ts: that no third `as CatalogBackedDesignMessage`
//     appears in shipped source, since an assertion is the one thing the brand cannot refuse

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
