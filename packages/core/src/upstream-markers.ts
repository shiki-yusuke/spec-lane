import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix as posixPath } from "node:path";
import type { HashedFile } from "./pin-verify.js";

// 2026-08-20 pin-verify audit (fix/upstream-pin-verification) — until now, pin-verify.test.ts
// only ever exercised diagnosePin() against ONE hand-picked UPSTREAM marker (the
// design-critic derive-independence pin). A repo-wide audit found this repo actually has
// SEVEN UPSTREAM markers, and four of them had silently gone stale in two different ways
// (a branch-limited pin that was never re-pinned after merge; three pins invalidated
// wholesale by an upstream `git filter-branch` history rewrite) with nothing checking them.
// This module makes the marker set itself discovered from the filesystem (never a hardcoded
// list) so a newly-added UPSTREAM marker is automatically brought under test, and parses
// each marker's own hand-written prose well enough to feed diagnosePin() -- without assuming
// every marker lives next to what it vendors (contracts/agent-metrics/UPSTREAM vendors INTO
// a different package entirely) or that every marker vendors a whole directory (the
// derive-independence pin vendors exactly one file, deliberately excluding its sibling
// hand-written .d.mts from the hash).

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist"]);

/**
 * Finds every file literally named `UPSTREAM` under `repoRoot`, skipping build output and
 * dependency directories (and any dot-directory, e.g. `.git`, `.serena`) -- the filesystem
 * equivalent of the `find <repo> -name UPSTREAM` every marker's own convention assumes a
 * maintainer could run by hand. Returns repo-root-relative, forward-slash paths, sorted.
 */
export function discoverUpstreamMarkers(repoRoot: string): string[] {
  const found: string[] = [];
  const walk = (dirAbsolute: string, dirRelative: string): void => {
    for (const entry of readdirSync(dirAbsolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(join(dirAbsolute, entry.name), posixPath.join(dirRelative, entry.name));
      } else if (entry.isFile() && entry.name === "UPSTREAM") {
        found.push(posixPath.join(dirRelative, entry.name));
      }
    }
  };
  walk(repoRoot, "");
  found.sort();
  return found;
}

export type ParsedUpstreamMarker =
  | {
      markerPath: string;
      supported: true;
      commit: string;
      /** Repo-root-relative, forward-slash path to what this marker vendors -- may be a
       * directory (most markers) or a single file (derive-independence). Not necessarily
       * co-located with the marker itself (contracts/agent-metrics/UPSTREAM vendors into
       * packages/core/test/fixtures/agent-metrics/v1/). */
      vendoredInto: string;
      recordedHash: string;
    }
  | {
      markerPath: string;
      supported: false;
      /** Why this marker could not be parsed -- surfaced explicitly (never a silent skip)
       * per this module's own discovery contract: a marker whose format pin-verify cannot
       * yet handle must still show up in the list, flagged, not disappear from it. */
      reason: string;
    };

const COMMIT_RE = /^Vendored commit:\s*([0-9a-f]{40})\b/m;
const VENDORED_INTO_RE = /^Vendored into:\s*(\S+)/m;
const HASH_LINE_RE = /^[ \t]*([0-9a-f]{64})[ \t]*$/gm;

/**
 * Parses one UPSTREAM marker's free-text prose just far enough to run diagnosePin() against
 * it: the pinned commit, where the vendored bytes live, and the recorded content hash. Every
 * marker in this repo documents these three facts in roughly the same shape (see this
 * module's header comment for the two axes of variation this deliberately tolerates), but a
 * marker that does NOT match is reported as `supported: false` with a reason -- never
 * dropped from discoverUpstreamMarkers's output.
 */
export function parseUpstreamMarker(repoRoot: string, markerPath: string): ParsedUpstreamMarker {
  const text = readFileSync(join(repoRoot, markerPath), "utf-8");

  const commitMatch = COMMIT_RE.exec(text);
  if (!commitMatch) {
    return {
      markerPath,
      supported: false,
      reason: 'no "Vendored commit: <40-hex-char sha>" line found',
    };
  }

  const vendoredIntoMatch = VENDORED_INTO_RE.exec(text);
  if (!vendoredIntoMatch) {
    return { markerPath, supported: false, reason: 'no "Vendored into: <path>" line found' };
  }

  const hashMatches = [...text.matchAll(HASH_LINE_RE)];
  if (hashMatches.length !== 1) {
    return {
      markerPath,
      supported: false,
      reason: `expected exactly one recorded 64-hex-char hash line, found ${hashMatches.length}`,
    };
  }

  return {
    markerPath,
    supported: true,
    commit: commitMatch[1] as string,
    vendoredInto: vendoredIntoMatch[1]?.replace(/\/+$/, "") ?? "",
    recordedHash: hashMatches[0]?.[1] as string,
  };
}

/**
 * Builds the HashedFile[] a supported marker's `vendoredInto` describes, dispatching on
 * whether it resolves to a file or a directory on disk (the derive-independence pin points
 * at a single .mjs file; every other marker points at a directory of fixtures). Each file's
 * `path` is repo-root-relative with forward slashes, matching what the marker's own
 * documented `find <path> -type f | sort` command would print when run from the repo root --
 * see pin-verify.ts's HashedFile doc comment. Files are returned sorted by that path, which
 * is exactly what piping `find`'s output through `sort` produces.
 */
export function hashedFilesForMarker(
  repoRoot: string,
  marker: Extract<ParsedUpstreamMarker, { supported: true }>,
): HashedFile[] {
  const absolute = join(repoRoot, marker.vendoredInto);
  const stat = statSync(absolute);
  if (stat.isFile()) {
    return [{ path: marker.vendoredInto, absolutePath: absolute }];
  }

  const files: HashedFile[] = [];
  const walk = (dirAbsolute: string, dirRelative: string): void => {
    for (const entry of readdirSync(dirAbsolute, { withFileTypes: true })) {
      const childAbsolute = join(dirAbsolute, entry.name);
      const childRelative = posixPath.join(dirRelative, entry.name);
      if (entry.isDirectory()) {
        walk(childAbsolute, childRelative);
      } else if (entry.isFile()) {
        files.push({ path: childRelative, absolutePath: childAbsolute });
      }
    }
  };
  walk(absolute, marker.vendoredInto);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}
