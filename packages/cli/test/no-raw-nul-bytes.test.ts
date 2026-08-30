import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No tracked text file may contain a raw NUL byte.
 *
 * A single NUL makes git treat the file as binary and grep skip it silently. Neither says
 * anything: `git diff` prints "Binary files a/... and b/... differ" instead of the change, and
 * `grep` returns nothing rather than reporting that it declined to look. So a file in this state
 * is one nobody can review and nobody can search, and the tooling reports success either way.
 *
 * This is not hypothetical here. Two NULs sat in `packages/cli/src/gate-check.ts` from before
 * the external-verify lane (issue #27), hiding that lane's own edits to the file from its PR
 * diff. During that lane I hit the same thing three more times in files I was editing, each time
 * noticing only because a grep I expected to match came back empty. And a third instance was
 * live in `packages/core/src/attribution.ts`, where a NUL was used deliberately as a Map key
 * separator -- correct at runtime, and it made the whole module unreviewable and unsearchable.
 *
 * The fix in every case is the same and costs nothing: write `\\u0000` in the source. It is
 * byte-identical at runtime (verified) and leaves the file as text.
 *
 * A check rather than a note, for the reason this repository keeps rediscovering: guidance to
 * remember something has failed every time it has been tried here, and the failure mode of a
 * raw NUL is that nothing tells you.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

/**
 * Formats where a NUL is the file being what it is, rather than a defect.
 *
 * A DENY-list, not an allow-list of text extensions, and the direction is the point. The first
 * version of this test listed nine extensions and therefore quietly ignored the repository's
 * `.py`, `.txt`, `.mts`, `LICENSE`, `UPSTREAM` and `.gitignore` files while claiming to cover
 * every tracked text file. An allow-list must be extended for each new format anyone adds,
 * covers nothing until someone remembers to, and reports success the whole time -- which is the
 * failure this test exists to catch, one level up from where it was catching it.
 *
 * Inverted, a format nobody anticipated is scanned by default, and coverage can only be lost by
 * adding an entry here deliberately. The repository currently tracks no binary files at all, so
 * this list is empty and every tracked file is read.
 */
const BINARY_EXTENSIONS: readonly string[] = [];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  })
    .toString("utf-8")
    .split("\u0000")
    .filter((path) => path.length > 0)
    .filter((path) => !BINARY_EXTENSIONS.some((extension) => path.endsWith(extension)));
}

describe("source hygiene", () => {
  it("no tracked file contains a raw NUL byte", () => {
    const files = trackedFiles();
    // Guard against the check silently passing because the listing came back empty -- the same
    // shape of failure it exists to catch.
    expect(files.length).toBeGreaterThan(100);

    const offenders = files.filter((path) => readFileSync(join(REPO_ROOT, path)).includes(0));
    expect(offenders).toEqual([]);
  });
});
