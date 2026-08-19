import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCommitReachable, diagnosePin, verifyTreeHash } from "../src/pin-verify.js";

// I-2026-08-18-design-critic-injection R39/R40 — automates the manual shasum command every
// UPSTREAM marker in this repo documents by hand, and (team-lead review, 2026-08-19, after
// this repo's own pin-vendoring hit exactly this failure mode once) distinguishes THREE
// fail-closed states, each with a different remedy:
//   1. unresolvable    -- re-pin to any current upstream commit
//   2. not_on_main     -- re-pin to a commit that IS on upstream main
//   3. content_mismatch -- re-vendor
// The content check is fully local/deterministic and asserted as a hard failing test
// (R39 "fail closed, not merely warn"); the two reachability states are asserted against
// the real vendored derive-independence UPSTREAM pin, opt-in via LANE_UPSTREAM_PLAYBOOK_PATH
// (see checkCommitReachable's own doc comment for why an always-on offline version of that
// half is not possible), plus fully-local negative tests using synthetic commit ids.

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(__dirname, "..", "src", "vendor", "derive-independence", "v1");
const MJS_REPO_RELATIVE_PATH = "packages/core/src/vendor/derive-independence/v1/derive-independence.mjs";
const RECORDED_MJS_HASH = "f1d890987a2a63992b3f8e1f5ee8f96bfa14d301043d8d120bd8f86d39053a46";
// The pin's final state (see UPSTREAM's own "Note on this pin's history"): re-pinned to the
// real upstream main commit once a `git fetch` showed the branch had already merged.
const PIN_COMMIT_ON_MAIN = "5e8884e9294bbac17ba88f21c03bec74f974d5fb";
// The commit this pin was FIRST (incorrectly, per stale-ref) vendored against -- genuinely
// exists upstream and, since the merge, genuinely IS an ancestor of main (it's main~1), so
// it is no longer useful for exercising "not_on_main". Kept only as documentation of what
// happened; the not_on_main test below uses a synthetic, definitely-branch-only commit
// shape instead (a real one would require an upstream branch guaranteed to stay unmerged).
const PREVIOUSLY_VENDORED_BRANCH_COMMIT = "6b4f4233cf07e79040d0b8b65d7fe658d497112d";

const mjsFile = { path: MJS_REPO_RELATIVE_PATH, absolutePath: join(VENDOR_DIR, "derive-independence.mjs") };

describe("verifyTreeHash (R39 content check, fails closed)", () => {
  it("vendored bytes match the recorded tree hash", () => {
    expect(verifyTreeHash([mjsFile], RECORDED_MJS_HASH)).toBe("match");
  });

  it("reports content_mismatch (not a silent pass, not a throw) for a wrong recorded hash", () => {
    expect(verifyTreeHash([mjsFile], "0".repeat(64))).toBe("content_mismatch");
  });
});

describe("checkCommitReachable (R39/R40 three-way reachability)", () => {
  it("returns 'unknown' (not a false pass) with no checkout configured", () => {
    expect(checkCommitReachable({ upstreamRepoPath: undefined, commit: PIN_COMMIT_ON_MAIN })).toBe("unknown");
    expect(
      checkCommitReachable({ upstreamRepoPath: "/definitely/not/a/real/path", commit: PIN_COMMIT_ON_MAIN }),
    ).toBe("unknown");
  });

  const upstreamRepoPath = process.env.LANE_UPSTREAM_PLAYBOOK_PATH;

  it.skipIf(!upstreamRepoPath)(
    "the current pin resolves and IS an ancestor of upstream main (opt-in, LANE_UPSTREAM_PLAYBOOK_PATH)",
    () => {
      expect(checkCommitReachable({ upstreamRepoPath, commit: PIN_COMMIT_ON_MAIN })).toBe("on_main");
    },
  );

  it.skipIf(!upstreamRepoPath)(
    "a syntactically-valid but nonexistent commit id is unresolvable (opt-in)",
    () => {
      expect(checkCommitReachable({ upstreamRepoPath, commit: "0".repeat(40) })).toBe("unresolvable");
    },
  );

  it.skipIf(!upstreamRepoPath)(
    "the pin's OWN prior branch commit is (now, post-merge) on_main -- documents why a fresh not_on_main fixture can't be pinned durably (opt-in)",
    () => {
      // Recorded here as a live demonstration of the exact mistake this check exists to
      // catch: at vendoring time this commit was reachable but NOT an ancestor of main
      // (not_on_main); after the merge it became on_main. A fixture that stays branch-only
      // forever would need an upstream branch this repo doesn't control never to merge.
      expect(checkCommitReachable({ upstreamRepoPath, commit: PREVIOUSLY_VENDORED_BRANCH_COMMIT })).toBe(
        "on_main",
      );
    },
  );
});

/**
 * Self-contained negative-fixture coverage for all THREE reachability states (team-lead
 * review, 2026-08-19: "否定側テストも3件必要です") -- built as a throwaway local git repo
 * rather than depending on the real upstream repo's mutable branch state (which, as this
 * file's own header notes, cannot durably stay in "not_on_main": the branch that WAS
 * not_on_main when this pin was first vendored became on_main the moment it merged).
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function buildFixtureRepo(): { path: string; onMainCommit: string; branchOnlyCommit: string } {
  const path = mkdtempSync(join(tmpdir(), "lane-pin-verify-fixture-"));
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.email", "test@example.com"]);
  git(path, ["config", "user.name", "test"]);
  writeFileSync(join(path, "f.txt"), "1\n");
  git(path, ["add", "f.txt"]);
  git(path, ["commit", "-q", "-m", "init"]);
  const onMainCommit = git(path, ["rev-parse", "HEAD"]).trim();
  git(path, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(path, "f.txt"), "2\n");
  git(path, ["commit", "-q", "-am", "feature-only change"]);
  const branchOnlyCommit = git(path, ["rev-parse", "HEAD"]).trim();
  git(path, ["checkout", "-q", "main"]);
  // checkCommitReachable compares against `origin/main` -- fake a remote-tracking ref
  // pointing at this same local repo's own main, matching real-world shape without a
  // network dependency.
  git(path, ["update-ref", "refs/remotes/origin/main", "main"]);
  return { path, onMainCommit, branchOnlyCommit };
}

describe("checkCommitReachable — self-contained fixture repo (all three reachability states)", () => {
  const fixture = buildFixtureRepo();

  it("on_main: a commit that IS an ancestor of main", () => {
    expect(checkCommitReachable({ upstreamRepoPath: fixture.path, commit: fixture.onMainCommit, fetch: false })).toBe(
      "on_main",
    );
  });

  it("not_on_main: a commit that exists but only on a branch (the measure/UPSTREAM defect's exact shape)", () => {
    expect(
      checkCommitReachable({ upstreamRepoPath: fixture.path, commit: fixture.branchOnlyCommit, fetch: false }),
    ).toBe("not_on_main");
  });

  it("unresolvable: a syntactically-valid commit id that was never committed here", () => {
    expect(checkCommitReachable({ upstreamRepoPath: fixture.path, commit: "1".repeat(40), fetch: false })).toBe(
      "unresolvable",
    );
  });

  it("diagnosePin surfaces pin_not_on_main with a remedy distinct from pin_unresolvable and pin_content_mismatch", () => {
    // Working tree is checked out at `main` (content "1\n") -- the recorded hash matches
    // that current, correctly-vendored content on purpose, so this case isolates the
    // reachability failure (branchOnlyCommit is not on main) from the content check.
    const files = [{ path: "f.txt", absolutePath: join(fixture.path, "f.txt") }];
    const recordedHash = createHash("sha256").update("f.txt\n", "utf-8").update("1\n").digest("hex");
    const result = diagnosePin({
      files,
      recordedHash,
      commit: fixture.branchOnlyCommit,
      upstreamRepoPath: fixture.path,
      markerPath: "test-marker",
    });
    expect(result.healthy).toBe(false);
    expect(result.problem?.code).toBe("pin_not_on_main");
    expect(result.problem?.message).toMatch(/main/);
  });
});

describe("diagnosePin (combines content + reachability, R40 remedy-distinguishing messages)", () => {
  const markerPath = "packages/core/src/vendor/derive-independence/UPSTREAM";

  it("content_mismatch is reported even when reachability can't be checked (content checked first)", () => {
    const result = diagnosePin({
      files: [mjsFile],
      recordedHash: "0".repeat(64),
      commit: PIN_COMMIT_ON_MAIN,
      upstreamRepoPath: undefined,
      markerPath,
    });
    expect(result.healthy).toBe(false);
    expect(result.problem?.code).toBe("pin_content_mismatch");
  });

  it("healthy when content matches and reachability is unverifiable in this environment (unknown is not a failure)", () => {
    const result = diagnosePin({
      files: [mjsFile],
      recordedHash: RECORDED_MJS_HASH,
      commit: PIN_COMMIT_ON_MAIN,
      upstreamRepoPath: undefined,
      markerPath,
    });
    expect(result.healthy).toBe(true);
    expect(result.problem).toBeUndefined();
  });

  it("reports pin_unresolvable with a distinct remedy from content_mismatch", () => {
    const upstreamRepoPath = process.env.LANE_UPSTREAM_PLAYBOOK_PATH;
    if (!upstreamRepoPath) return; // opt-in, same gate as checkCommitReachable's own tests
    const result = diagnosePin({
      files: [mjsFile],
      recordedHash: RECORDED_MJS_HASH,
      commit: "0".repeat(40),
      upstreamRepoPath,
      markerPath,
    });
    expect(result.healthy).toBe(false);
    expect(result.problem?.code).toBe("pin_unresolvable");
    expect(result.problem?.message).toMatch(/re-pin/);
  });
});
