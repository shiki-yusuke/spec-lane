import { describe, expect, it } from "vitest";
import { compareToolVersion, parseToolVersion } from "../src/tool-version.js";

// issue #50, spec A3 (issue50-spec.md lines 27) — SemVer 2.0 precedence for the
// forward-compat write guard. Expected values are taken directly from A3's own worked
// examples, not from tool-version.ts's implementation.
describe("parseToolVersion / compareToolVersion (issue #50 A3)", () => {
  it("0.10.0 > 0.9.1 (A3)", () => {
    expect(compareToolVersion("0.10.0", "0.9.1")).toBe(1);
    expect(compareToolVersion("0.9.1", "0.10.0")).toBe(-1);
  });

  it("0.12.0-beta.1 > 0.11.0 (A3)", () => {
    expect(compareToolVersion("0.12.0-beta.1", "0.11.0")).toBe(1);
    expect(compareToolVersion("0.11.0", "0.12.0-beta.1")).toBe(-1);
  });

  it("0.11.0 > 0.11.0-rc.1 -- a release always outranks a prerelease of the same major.minor.patch (A3)", () => {
    expect(compareToolVersion("0.11.0", "0.11.0-rc.1")).toBe(1);
    expect(compareToolVersion("0.11.0-rc.1", "0.11.0")).toBe(-1);
  });

  // A3's full prerelease ordering chain: alpha < alpha.1 < beta.2 < beta.11 < rc.1 < (release).
  // beta.2 < beta.11 pins numeric (not lexical/ASCII) comparison of prerelease identifiers,
  // since "11" < "2" lexically but not numerically.
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];

  it("orders the full A3 prerelease chain strictly ascending", () => {
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i] as string;
      const b = chain[i + 1] as string;
      expect(compareToolVersion(a, b), `${a} vs ${b}`).toBe(-1);
      expect(compareToolVersion(b, a), `${b} vs ${a}`).toBe(1);
    }
  });

  it("1.0.0+build.1 == 1.0.0 -- build metadata is ignored for precedence (A3)", () => {
    expect(compareToolVersion("1.0.0+build.1", "1.0.0")).toBe(0);
  });

  it("equal versions compare equal", () => {
    expect(compareToolVersion("0.11.0", "0.11.0")).toBe(0);
  });

  // A3: malformed versions ("dev", "1.0", "", "01.0.0" -- leading zero, forbidden by
  // SemVer 2.0 §2) must fail to parse (null, never throw), so a fail-closed guard can
  // distinguish "not comparable" from a thrown exception.
  it.each(["dev", "1.0", "", "01.0.0"])("parseToolVersion(%j) is null (A3 malformed)", (bad) => {
    expect(parseToolVersion(bad)).toBeNull();
  });

  // A3 + S9: "parse 不能は throw" -- compareToolVersion itself throws (rather than
  // returning some sentinel) when either side isn't valid SemVer; callers that need
  // fail-closed behavior over an unparseable version (assertDoneOverlayWritable) check
  // parseToolVersion themselves first, per done-overlay.ts's own contract.
  it.each(["dev", "1.0", "", "01.0.0"])(
    "compareToolVersion throws when one side is malformed (%j)",
    (bad) => {
      expect(() => compareToolVersion(bad, "1.0.0")).toThrow();
      expect(() => compareToolVersion("1.0.0", bad)).toThrow();
    },
  );

  it("parseToolVersion returns the parsed fields for a well-formed version", () => {
    expect(parseToolVersion("1.2.3-rc.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["rc", "1"],
    });
  });
});
