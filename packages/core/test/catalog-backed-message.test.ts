import { describe, expect, it } from "vitest";
import {
  type CatalogBackedDesignMessage,
  DESIGN_GATES,
  type DesignDiagnostic,
  type DesignGateId,
  formatDesignMessage,
  joinDesignMessageLines,
} from "../src/index.js";

/**
 * The negative half of the catalog guarantee: what must NOT compile.
 *
 * `@ts-expect-error` is an assertion, not a comment -- the line fails the build if the code under
 * it turns out to be legal. That makes this file the thing that keeps the brand meaningful: a
 * refactor that widened `CatalogBackedDesignMessage` back to `string` would leave every positive
 * test passing (a branded string *is* a string) and only these lines would go red, because the
 * error they expect would stop occurring.
 *
 * It runs under vitest so it is visible in the suite, but the real assertions here are made by
 * `tsc` at typecheck time, which is a separate CI step from `test`. The runtime `expect`s below
 * cover the parts a type cannot state: what the functions do at run time.
 */

describe("the brand cannot be obtained by writing a string", () => {
  it("rejects a plain string where a catalogued message is required", () => {
    function requiresCatalogued(_message: CatalogBackedDesignMessage): void {}
    // @ts-expect-error a hand-written string is not catalog-backed
    requiresCatalogued("design options are missing");
    const intentId = "I-1";
    // @ts-expect-error an interpolated template literal is not catalog-backed either
    requiresCatalogued(`design options are missing for ${intentId}`);
    requiresCatalogued(formatDesignMessage("design_options_missing", {}));
  });

  it("rejects text concatenated onto a catalogued message", () => {
    function requiresCatalogued(_message: CatalogBackedDesignMessage): void {}
    // @ts-expect-error `+` returns a plain string, dropping the brand -- this is R46's fragment
    // assembly, and it is the case the previous regex check let through by matching only the
    // leading token of the expression.
    requiresCatalogued(`${formatDesignMessage("design_options_missing", {})} -- see docs`);
  });

  it("rejects a catalogued message that has been rewritten", () => {
    function requiresCatalogued(_message: CatalogBackedDesignMessage): void {}
    const message = formatDesignMessage("design_options_missing", {});
    // @ts-expect-error String.prototype.replace returns a plain string
    requiresCatalogued(message.replace("options", "choices"));
  });

  it("rejects an ordinary join of catalogued messages", () => {
    function requiresCatalogued(_message: CatalogBackedDesignMessage): void {}
    const lines = [formatDesignMessage("design_options_missing", {})];
    // @ts-expect-error Array.prototype.join returns a plain string; the separator is unconstrained
    requiresCatalogued(lines.join(" -- "));
    requiresCatalogued(joinDesignMessageLines(lines));
  });
});

describe("design diagnostics cannot be built from an uncatalogued message", () => {
  it("rejects a hand-written message in a design diagnostic", () => {
    const diagnostic: DesignDiagnostic<"design_decision"> = {
      gateId: "design_decision",
      code: "option_unknown",
      severity: "error",
      message: formatDesignMessage("design_options_missing", {}),
    };
    expect(diagnostic.gateId).toBe("design_decision");

    const bad: DesignDiagnostic<"design_decision"> = {
      gateId: "design_decision",
      code: "option_unknown",
      severity: "error",
      // @ts-expect-error the message must come from the catalog
      message: "that option does not exist",
    };
    expect(bad.code).toBe("option_unknown");
  });

  it("rejects a design diagnostic labelled with another gate's id", () => {
    const crossLabelled: DesignDiagnostic<"design_decision"> = {
      // @ts-expect-error this diagnostic's type says design_decision
      gateId: "design_establishment",
      code: "option_unknown",
      severity: "error",
      message: formatDesignMessage("design_options_missing", {}),
    };
    expect(crossLabelled.code).toBe("option_unknown");
  });
});

describe("the design gate registry is exhaustive by construction", () => {
  it("every DesignGateId has a registered gate that declares it", () => {
    // Not a list of ids repeated by hand: `DESIGN_GATES` is a mapped type over `DesignGateId`, so
    // adding a member to that union without registering a gate fails to compile. This test pins
    // the other direction -- that each registered gate actually declares the id it is filed under.
    for (const [id, gate] of Object.entries(DESIGN_GATES)) {
      expect(gate.id, `DESIGN_GATES["${id}"] is filed under the wrong id`).toBe(id);
    }
    expect(Object.keys(DESIGN_GATES).sort()).toEqual(["design_decision", "design_establishment"]);
  });

  it("a design gate id is not silently accepted as any string", () => {
    const id: DesignGateId = "design_decision";
    expect(id).toBe("design_decision");
    // @ts-expect-error not a design gate
    const notADesignGate: DesignGateId = "promotion_weakening";
    expect(notADesignGate).toBe("promotion_weakening");
  });
});

describe("joinDesignMessageLines at run time", () => {
  it("joins on a newline and keeps each line whole", () => {
    const joined = joinDesignMessageLines([
      formatDesignMessage("design_options_missing", {}),
      formatDesignMessage("design_not_activated", { intentId: "I-1" }),
    ]);
    expect(joined.split("\n")).toHaveLength(2);
    expect(joined).toContain(formatDesignMessage("design_options_missing", {}));
  });

  it("refuses to mint a catalogued message out of nothing", () => {
    // An empty result would carry the brand while nothing from the catalog produced it.
    expect(() => joinDesignMessageLines([])).toThrow(/refusing to produce/);
  });
});
