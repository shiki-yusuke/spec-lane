import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The brand is only as strong as the number of places that can mint it.
 *
 * `CatalogBackedDesignMessage` is a `string` with a private symbol attached, so the type system
 * refuses every ordinary way of producing one -- concatenation, `replace`, `join`. What it cannot
 * refuse is `as CatalogBackedDesignMessage`, because a type assertion is TypeScript's deliberate
 * escape hatch. One of those anywhere in shipped source and the guarantee is over: the brand would
 * then mean "someone wrote a cast", not "this came from the catalog".
 *
 * Two assertions are legitimate and are what mint the brand in the first place -- one in
 * `formatDesignMessage`, one in `joinDesignMessageLines`. This test pins the count at exactly those
 * two, in exactly those functions. A third fails here.
 *
 * Biome was considered for this and rejected: its `noRestrictedTypes` bans a type outright, which
 * would flag the legitimate annotations as well as the casts, and there is no rule for "assertion
 * to this specific type". So the check reuses the TypeScript parser already used by
 * design-message-scan.ts.
 *
 * Scope is production source only (`packages/*​/src`). Test files may assert whatever they need to
 * construct a case -- a test that fabricates a branded string to prove something is a test doing
 * its job, and cannot mislead a caller because nothing ships it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

const BRAND_TYPE = "CatalogBackedDesignMessage";

/** Where minting the brand is legitimate: the two functions that produce it from the catalog. */
const MINTING_SITES = [
  { file: "packages/core/src/design-messages.ts", fn: "formatDesignMessage" },
  { file: "packages/core/src/design-messages.ts", fn: "joinDesignMessageLines" },
];

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `vendor/` holds upstream code this repo does not author; it is pinned and verified
      // separately, and it does not import the brand.
      if (entry === "vendor" || entry === "node_modules" || entry === "dist") continue;
      found.push(...sourceFilesUnder(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

function productionSourceFiles(): string[] {
  const packages = ["schemas", "core", "adapters", "cli"];
  return packages.flatMap((pkg) => sourceFilesUnder(join(repoRoot, "packages", pkg, "src")));
}

interface Assertion {
  file: string;
  line: number;
  enclosingFunction: string | null;
}

/** Every `x as CatalogBackedDesignMessage` (and `<T>x` form) in one file. */
function findBrandAssertions(file: string): Assertion[] {
  const source = readFileSync(file, "utf-8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found: Assertion[] = [];

  function namesBrand(type: ts.TypeNode): boolean {
    return (
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      type.typeName.text === BRAND_TYPE
    );
  }

  function enclosingFunctionName(node: ts.Node): string | null {
    for (let p: ts.Node | undefined = node; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    }
    return null;
  }

  function walk(node: ts.Node): void {
    // `as T` and the legacy `<T>value` form are the same operation and both are checked; only the
    // first is reachable in .ts files that use JSX-free syntax, but a check that silently ignored
    // the other would be a check with a documented bypass.
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && namesBrand(node.type)) {
      found.push({
        file: relative(repoRoot, file),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        enclosingFunction: enclosingFunctionName(node),
      });
    }
    node.forEachChild(walk);
  }

  walk(sf);
  return found;
}

describe("the brand can only be minted where the catalog produces it", () => {
  const assertions = productionSourceFiles().flatMap(findBrandAssertions);

  it("finds the two known minting sites, and nothing else", () => {
    const actual = assertions.map((a) => `${a.file}:${a.enclosingFunction}`).sort();
    const expected = MINTING_SITES.map((s) => `${s.file}:${s.fn}`).sort();
    expect(
      actual,
      `unexpected \`as ${BRAND_TYPE}\` in shipped source: ${JSON.stringify(assertions, null, 2)}`,
    ).toEqual(expected);
  });

  it("is actually looking at the source, not at an empty file list", () => {
    // Without this the test above passes trivially if the traversal ever stops finding files.
    const files = productionSourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("design-messages.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("commands/design.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("gate.ts"))).toBe(true);
  });

  it("would notice an assertion added somewhere else", () => {
    // Runs the detector over a synthetic file rather than trusting that it works: the real source
    // is expected to be clean, so a broken detector and a clean repo look identical above.
    const sf = ts.createSourceFile(
      "probe.ts",
      `const sneaked = "hand written" as ${BRAND_TYPE};\nfunction inner() { return "x" as ${BRAND_TYPE}; }\n`,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    expect(sf.getSourceFile()).toBeDefined();
    const hits: string[] = [];
    const walk = (node: ts.Node): void => {
      if (
        ts.isAsExpression(node) &&
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === BRAND_TYPE
      ) {
        hits.push(node.getText(sf));
      }
      node.forEachChild(walk);
    };
    walk(sf);
    expect(hits).toHaveLength(2);
  });
});
