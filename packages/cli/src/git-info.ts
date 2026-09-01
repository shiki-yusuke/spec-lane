import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Current HEAD commit sha, or "unknown" if this isn't a git repo (or git isn't available). */
export function currentGitCommit(cwd: string): string {
  try {
    // stdio: "pipe" for stdout (captured via encoding), "ignore" for stderr — a lane
    // command running outside a git repo (e.g. a scratch spec-dir in a test) is an
    // expected, silently-handled case, not something that should print git's own
    // "fatal: not a git repository" onto this process's stderr.
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * "owner/repo" parsed from `git remote get-url origin`, or `null` if undeterminable (no
 * git repo, no `origin` remote, or a URL shape this doesn't recognize). Used to scope
 * `lane knowledge-query` to the current repo without ever guessing (must-2, Codex M3
 * review) — callers must treat `null` as "exclude every scoped record", never as "assume
 * global" or any other implicit default.
 */
export function deriveRepoIdFromGitRemote(cwd: string): string | null {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  // Matches both "https://github.com/owner/repo.git" and "git@github.com:owner/repo.git"
  // (and either form without the trailing ".git") — host-agnostic, since this repo isn't
  // committed to GitHub specifically as the only possible remote host.
  const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/**
 * The root of the git worktree containing `cwd`, or `null` when there isn't one (or git is
 * unavailable). Realpath'd, because `--show-toplevel` reports the path as git resolved it and
 * callers compare it against other realpath'd paths.
 *
 * Used by the external verify gate to size the "gated tree" correctly. Comparing against `cwd`
 * alone was defeated in review by simply running `lane advance` from a subdirectory: the
 * authorization store sat in the repository, but not under the subdirectory, so the check that
 * refuses a store inside the gated tree passed. The tree an adversary can write is the
 * repository, not the directory the operator happened to be standing in.
 */
export function gitWorktreeRoot(cwd: string): string | null {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top === "") return null;
    return realpathSync(top);
  } catch {
    return null;
  }
}

/** The working tree of the immediate superproject when `cwd` is inside a submodule checkout, or
 * `null` otherwise (not a submodule, not a git repo, or git unavailable). Realpath'd like
 * gitWorktreeRoot for the same reason. */
function gitSuperprojectRoot(cwd: string): string | null {
  try {
    const parent = execFileSync("git", ["rev-parse", "--show-superproject-working-tree"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (parent === "") return null;
    return realpathSync(parent);
  } catch {
    return null;
  }
}

/**
 * The full chain of git worktree roots that CONTAIN `cwd`: its own innermost worktree root plus
 * every superproject working tree above it, outermost last. Empty when `cwd` is not in a git
 * repo (or git is unavailable) -- callers fall back to `cwd` itself, as gitWorktreeRoot's own
 * callers already do.
 *
 * gitWorktreeRoot alone returns only `--show-toplevel`, the INNERMOST worktree. Launched from
 * inside a submodule that is the whole point of the overlap check (sol post-review, issue #35),
 * that shrinks the gated tree to the submodule root, and an authorization store sitting in the
 * OUTER repository -- writable by the same adversary -- falls outside it and the overlap goes
 * unreported. Walking `--show-superproject-working-tree` up the chain restores the outer roots.
 *
 * This improves DETECTION for honest nested layouts; it is not a security boundary (spec.md L14
 * stands). The adversarial variant -- planting a `.git` in a subdirectory to shrink
 * `--show-toplevel` (spec.md §14-1) -- is unaffected, because that manufactures a worktree root
 * this chain has no reason to climb above.
 */
export function gitWorktreeRootChain(cwd: string): string[] {
  const innermost = gitWorktreeRoot(cwd);
  if (innermost === null) return [];
  const chain = [innermost];
  // Walk from each worktree root up to its superproject. Bounded by a seen-set so a pathological
  // cycle (which git should never produce) cannot loop forever.
  const seen = new Set(chain);
  let current = innermost;
  for (;;) {
    const parent = gitSuperprojectRoot(current);
    if (parent === null || seen.has(parent)) break;
    chain.push(parent);
    seen.add(parent);
    current = parent;
  }
  return chain;
}
