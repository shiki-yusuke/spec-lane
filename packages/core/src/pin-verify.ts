import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

// I-2026-08-18-design-critic-injection R39/R40 — automates the manual `shasum` reproduction
// command every UPSTREAM marker in this repo already documents by hand, and gives the two
// failure modes R40 requires be distinguishable (different remedies: re-pin vs re-vendor)
// their own return values instead of a single boolean.
//
// R39's "fail closed, not merely warn" is fully achievable for the CONTENT half
// (computeTreeHash/verifyTreeHash: purely local, deterministic, no network) -- this is what
// pin-verify.test.ts asserts as a hard failing test. The RESOLVES-UPSTREAM half
// (checkCommitReachable) genuinely cannot be verified inside an ordinary `lane validate`
// run shipped to end users: they have no local checkout of the upstream contracts repo, and
// this project does not bundle one or make network calls as part of its own CLI. This is
// scoped as a repo-maintainer/CI-time check instead (same "in CI" wording R39 itself uses),
// opt-in via an upstream checkout path -- see checkCommitReachable's own doc comment. This
// is a real, load-bearing scope limit, not an oversight: see this lane's implementation
// notes for why a fully offline, always-on reachability check was not attempted.

export interface HashedFile {
  /** The path identity fed into the hash -- must match whatever a marker's own documented
   * `find ... | sort` command would print (repo-root-relative, forward slashes), NOT
   * necessarily this process's filesystem path, so the recorded hash stays reproducible
   * from a plain shell one-liner regardless of where the repo happens to be checked out. */
  path: string;
  /** Where to actually read the bytes from (may be absolute; not part of the hash). */
  absolutePath: string;
}

/**
 * Same algorithm every existing UPSTREAM marker in this repo documents by hand: sha256 over
 * each file's path followed by its content, for every file given (already sorted by `path`,
 * caller's responsibility -- mirrors `find ... | sort` in the marker files).
 */
export function computeTreeHash(files: readonly HashedFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\n`, "utf-8");
    hash.update(readFileSync(file.absolutePath));
  }
  return hash.digest("hex");
}

export type TreeHashVerification = "match" | "content_mismatch";

/** The content half of R39/R40: local, deterministic, always able to fail closed. */
export function verifyTreeHash(files: readonly HashedFile[], recordedHash: string): TreeHashVerification {
  return computeTreeHash(files) === recordedHash ? "match" : "content_mismatch";
}

export type CommitReachability = "resolvable" | "unresolvable" | "unknown";

/**
 * The resolves-upstream half of R39/R40. Requires a local checkout of the upstream repo
 * (`upstreamRepoPath`) -- when not provided, or when the path does not look like a git
 * checkout, returns "unknown" (inconclusive) rather than either "resolvable" (that would be
 * fail-OPEN, exactly what R39 says is insufficient) or "unresolvable" (that would hard-fail
 * every ordinary user who has no reason to have this checkout, which is not this check's
 * intended audience -- see this module's header comment). Callers that want R39's fail-
 * closed behavior enforced should treat "unknown" as "cannot currently verify" and run this
 * check where a checkout IS available (this repo's own CI, or a maintainer's machine),
 * exactly as R39 says: "in CI."
 */
export function checkCommitReachable({
  upstreamRepoPath,
  commit,
  ref = "main",
}: {
  upstreamRepoPath: string | undefined;
  commit: string;
  ref?: string;
}): CommitReachability {
  if (!upstreamRepoPath) return "unknown";
  try {
    statSync(upstreamRepoPath);
  } catch {
    return "unknown";
  }
  try {
    execFileSync("git", ["-C", upstreamRepoPath, "cat-file", "-e", `${commit}^{commit}`], {
      stdio: "ignore",
    });
  } catch {
    return "unresolvable";
  }
  try {
    execFileSync("git", ["-C", upstreamRepoPath, "merge-base", "--is-ancestor", commit, `origin/${ref}`], {
      stdio: "ignore",
    });
    return "resolvable";
  } catch {
    // Commit object exists locally but is not an ancestor of the tracked ref -- exactly
    // the measure/UPSTREAM defect's shape (survives only via a backup tag / other branch,
    // unreachable from main).
    return "unresolvable";
  }
}
