import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// R25, third clause: "SHALL present per-option coverage and derived status BEFORE either count".
//
// The other two clauses of R25 (never a lone count; total and qualifying always together) are
// covered catalog-wide in design-message-catalog.test.ts. Presentation ORDER is not visible to a
// value-level assertion on the catalog -- the templates are individually fine no matter what order
// they are emitted in -- so it is checked against the assembly order in runDesignStatus.
//
// Read from source rather than through the built package on purpose: this asserts a property of
// the code as written. A committed-but-stale build would make the check pass while the source had
// regressed.
const src = readFileSync(new URL("../src/commands/design.ts", import.meta.url), "utf-8");

describe("R25: coverage and derived status are presented before any count", () => {
  it("runDesignStatus pushes per-option coverage and per-review status before the totals line", () => {
    const iCoverage = src.indexOf('"design_status_option_coverage"');
    const iReview = src.indexOf('"design_status_review_summary"');
    const iTotals = src.indexOf('"design_status_totals"');

    expect(iCoverage, "design_status_option_coverage is not emitted at all").toBeGreaterThan(-1);
    expect(iReview, "design_status_review_summary is not emitted at all").toBeGreaterThan(-1);
    expect(iTotals, "design_status_totals is not emitted at all").toBeGreaterThan(-1);

    expect(iCoverage).toBeLessThan(iTotals);
    expect(iReview).toBeLessThan(iTotals);
  });
});
