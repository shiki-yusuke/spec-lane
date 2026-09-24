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
 * (issue #50: both literals now live in one constant, src/version.ts, which calibrate /
 * usage-import also fall back to; the tests below pin the constant and forbid a literal.)
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

  it("the source's LANE_VERSION constant is the declared version", () => {
    // issue #50 moved both literals into one constant (src/version.ts), because a third copy
    // appeared: calibrate / usage-import compare it against a done overlay's tool_version, so
    // a fallback older than advance's would refuse every post-done write.
    const version = readSource("src", "version.ts");
    const match = version.match(/export const LANE_VERSION = "([^"]+)";/);
    expect(match, "no LANE_VERSION constant found in src/version.ts").not.toBeNull();
    expect(match?.[1]).toBe(declaredVersion);
  });

  it("`lane --version` reports LANE_VERSION, not a literal of its own", () => {
    const main = readSource("src", "main.ts");
    expect(main).toMatch(/\.version\(LANE_VERSION\)/);
    expect(main).not.toMatch(/\.version\("[^"]+"\)/);
  });

  it("every recorded/compared toolVersion fallback is LANE_VERSION, not a stale literal", () => {
    for (const file of ["advance.ts", "calibrate.ts", "usage-import.ts"]) {
      const source = readSource("src", "commands", file);
      expect(source, `${file} has no LANE_VERSION fallback`).toMatch(
        /opts\.toolVersion \?\? LANE_VERSION/,
      );
      expect(source, `${file} still has a literal toolVersion fallback`).not.toMatch(
        /opts\.toolVersion \?\? "[^"]+"/,
      );
    }
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
