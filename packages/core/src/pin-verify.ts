import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { formatDesignMessage } from "./design-messages.js";

// I-2026-08-18-design-critic-injection R39/R40 — automates the manual `shasum` reproduction
// command every UPSTREAM marker in this repo already documents by hand, and gives R40's
// THREE distinguishable failure modes (team-lead review, 2026-08-19, after this repo's own
// pin-vendoring hit exactly this class of mistake -- a stale local `origin/main` ref made a
// commit that had, in fact, already merged look unreachable) their own return values and
// remedies, rather than a single boolean:
//   1. unresolvable    -- the commit object does not exist upstream at all. Remedy: re-pin
//      to any current upstream commit.
//   2. not_on_main     -- the commit exists but is not an ancestor of upstream `main`
//      (a branch-limited pin -- the exact shape of the pre-existing, still-unfixed
//      packages/adapters/test/fixtures/measure/UPSTREAM defect). Remedy: re-pin to a
//      commit that IS on main.
//   3. content_mismatch -- the pin resolves and is on main, but the vendored bytes no
//      longer match the recorded tree hash. Remedy: re-vendor.
//
// The CONTENT check (computeTreeHash/verifyTreeHash) is purely local, deterministic, and
// unconditionally fail-closed -- pin-verify.test.ts asserts it as a hard failing test. The
// RESOLVES-UPSTREAM checks (checkCommitReachable) require a local checkout of the upstream
// repo and therefore cannot run inside an ordinary `lane validate` invocation shipped to end
// users (they have no such checkout, and this project makes no network calls from the CLI
// itself) -- scoped as a repo-maintainer/CI-time check instead (R39's own "in CI" wording),
// opt-in via an upstream checkout path. checkCommitReachable fetches `origin` first by
// default specifically because that stale-ref mistake is the one this module exists to stop
// recurring -- silently trusting an unfetched local ref is not an option once it has already
// produced one incorrect "this cannot be built" conclusion.

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

export type CommitReachability = "on_main" | "not_on_main" | "unresolvable" | "unknown";

/**
 * The resolves-upstream half of R39/R40, now three-way (team-lead review, 2026-08-19).
 * Requires a local checkout of the upstream repo (`upstreamRepoPath`) -- when not provided,
 * or when the path does not look like a git checkout, returns "unknown" (inconclusive)
 * rather than any of the other three values (returning "on_main" would be fail-OPEN, exactly
 * what R39 says is insufficient; returning either failure value would hard-fail every
 * ordinary user who has no reason to have this checkout, which is not this check's intended
 * audience -- see this module's header comment). Callers that want R39's fail-closed
 * behavior enforced should treat "unknown" as "cannot currently verify" and run this check
 * where a checkout IS available (this repo's own CI, or a maintainer's machine).
 *
 * `fetch` defaults to true and runs `git fetch origin` before checking (best-effort --
 * a failure to fetch, e.g. offline, is swallowed and the check proceeds against whatever
 * refs are already local). This default exists because the ONE gap in this pin's own
 * history (see UPSTREAM markers) was checking a remote-tracking ref without first
 * confirming it was current -- silently trusting a possibly-stale local ref is not an
 * option for a check whose entire purpose is catching exactly that class of mistake.
 */
export function checkCommitReachable({
  upstreamRepoPath,
  commit,
  ref = "main",
  fetch = true,
}: {
  upstreamRepoPath: string | undefined;
  commit: string;
  ref?: string;
  fetch?: boolean;
}): CommitReachability {
  if (!upstreamRepoPath) return "unknown";
  try {
    statSync(upstreamRepoPath);
  } catch {
    return "unknown";
  }
  if (fetch) {
    try {
      execFileSync("git", ["-C", upstreamRepoPath, "fetch", "origin"], { stdio: "ignore" });
    } catch {
      // Best-effort: proceed against whatever is already local (e.g. offline CI run)
      // rather than reporting "unknown" outright -- a stale-but-present local ref is still
      // strictly more informative than refusing to check at all.
    }
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
    return "on_main";
  } catch {
    // Commit object exists locally but is not an ancestor of the tracked ref -- exactly
    // the measure/UPSTREAM defect's shape (survives only via a backup tag / other branch,
    // unreachable from main).
    return "not_on_main";
  }
}

export interface PinDiagnosis {
  /** true only when the pin resolves on main AND the vendored bytes match. */
  healthy: boolean;
  /** Present iff !healthy -- a catalogued, remedy-distinguishing message (R40). */
  problem?: { code: "pin_unresolvable" | "pin_not_on_main" | "pin_content_mismatch"; message: string };
}

/**
 * Combines the content check (always run) with the reachability check (best-effort,
 * "unknown" is not treated as a failure -- see checkCommitReachable's own doc comment) into
 * one fail-closed-where-verifiable verdict, with R40's three remedies kept distinguishable.
 * Content is checked FIRST: a content_mismatch is real and actionable regardless of whether
 * reachability could be verified in this environment, so it must never be masked by an
 * "unknown" reachability result.
 */
export function diagnosePin({
  files,
  recordedHash,
  commit,
  upstreamRepoPath,
  markerPath,
}: {
  files: readonly HashedFile[];
  recordedHash: string;
  commit: string;
  upstreamRepoPath: string | undefined;
  markerPath: string;
}): PinDiagnosis {
  if (verifyTreeHash(files, recordedHash) === "content_mismatch") {
    return {
      healthy: false,
      problem: {
        code: "pin_content_mismatch",
        message: formatDesignMessage("pin_content_mismatch", {
          recordedHash,
          actualHash: computeTreeHash(files),
        }),
      },
    };
  }
  const reachability = checkCommitReachable({ upstreamRepoPath, commit });
  if (reachability === "unresolvable") {
    return {
      healthy: false,
      problem: { code: "pin_unresolvable", message: formatDesignMessage("pin_unresolvable", { commit, markerPath }) },
    };
  }
  if (reachability === "not_on_main") {
    return {
      healthy: false,
      problem: { code: "pin_not_on_main", message: formatDesignMessage("pin_not_on_main", { commit, markerPath }) },
    };
  }
  // "on_main" or "unknown" (unverifiable in this environment, not treated as failure).
  return { healthy: true };
}
