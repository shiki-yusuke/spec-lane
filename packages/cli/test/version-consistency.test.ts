import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The release policy in docs/releasing.md binds three things to one commit: the npm release, the
 * `vX.Y.Z` git tag, and the GitHub Release. What it does not say -- because it was not true until
 * someone checked -- is that the version also lives in the TypeScript source, hardcoded, in two
 * places that no check compared against `package.json`:
 *
 *   - `main.ts`'s `program.version(...)`, which is what `lane --version` prints. Step 8 of the
 *     release process ("clean-room verify `lane --version` reports the new version") would catch a
 *     miss here, but only after the package is already published and the tag is already immutable.
 *   - `advance.ts`'s `opts.toolVersion ?? "..."` fallback, which is worse than cosmetic: a stale
 *     value there is written into the artifacts a lane records, and nothing about the output looks
 *     wrong. Step 8 does not cover it at all.
 *
 * Found while preparing 0.6.0, with both literals still reading 0.5.2 after every `package.json`
 * had been bumped. The bump is a manual, five-file edit; the only reason this did not ship wrong is
 * that someone happened to grep. So this test compares the literals to the package's own version,
 * turning "remember the two extra places" into a red test rather than a habit.
 *
 * It reads the source text rather than importing `main.ts`, because importing it runs commander's
 * top-level program setup, and a test that executes the CLI's entry point to read a string would
 * couple this check to whatever that entry point does at load time.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

function readSource(...segments: string[]): string {
  return readFileSync(join(packageRoot, ...segments), "utf-8");
}

const declaredVersion = (JSON.parse(readSource("package.json")) as { version: string }).version;

describe("the version in the source agrees with the package's own version", () => {
  it("package.json declares a plain SemVer version", () => {
    expect(declaredVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("`lane --version` would report the declared version", () => {
    const main = readSource("src", "main.ts");
    const match = main.match(/\.version\("([^"]+)"\)/);
    expect(match, 'no `.version("...")` call found in main.ts').not.toBeNull();
    expect(match?.[1]).toBe(declaredVersion);
  });

  it("the recorded toolVersion fallback is the declared version, not a stale one", () => {
    const advance = readSource("src", "commands", "advance.ts");
    const match = advance.match(/toolVersion:\s*opts\.toolVersion \?\? "([^"]+)"/);
    expect(match, "no toolVersion fallback found in advance.ts").not.toBeNull();
    expect(match?.[1]).toBe(declaredVersion);
  });

  it("every workspace package is on the same version", () => {
    // A split version would publish a bundle whose parts disagree about what they are.
    const repoRoot = join(packageRoot, "..", "..");
    for (const pkg of ["schemas", "core", "adapters", "cli"]) {
      const version = (
        JSON.parse(readFileSync(join(repoRoot, "packages", pkg, "package.json"), "utf-8")) as {
          version: string;
        }
      ).version;
      expect(version, `packages/${pkg} disagrees about the version`).toBe(declaredVersion);
    }
    const published = (
      JSON.parse(readFileSync(join(repoRoot, "publish", "spec-lane", "package.json"), "utf-8")) as {
        version: string;
      }
    ).version;
    expect(published, "publish/spec-lane is what npm actually receives").toBe(declaredVersion);
  });
});
