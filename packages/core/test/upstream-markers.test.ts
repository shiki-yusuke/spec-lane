import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diagnosePin, verifyTreeHash } from "../src/pin-verify.js";
import {
  type ParsedUpstreamMarker,
  discoverUpstreamMarkers,
  hashedFilesForMarker,
  parseUpstreamMarker,
} from "../src/upstream-markers.js";

// 2026-08-20 pin-verify audit (fix/upstream-pin-verification) — broadens pin verification
// from the single design-critic pin pin-verify.test.ts already covers to EVERY UPSTREAM
// marker in this repo, discovered from the filesystem rather than a hardcoded list (so a
// newly-added marker is automatically covered). The low-level three-way reachability
// semantics (unresolvable/not_on_main/on_main) and the self-contained negative fixtures for
// them already have dedicated coverage in pin-verify.test.ts; this file focuses on the layer
// pin-verify.test.ts does NOT cover: discovering markers from disk, parsing their free-text
// prose, and dispatching file-vs-directory vendoring -- then sweeping every real marker
// through that pipeline.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const UPSTREAM_REPO_PATH = process.env.LANE_UPSTREAM_PLAYBOOK_PATH;

// The complete, known set of UPSTREAM markers in this repo as of this audit (2026-08-20).
// This list exists ONLY as this test's own expectation of what discovery should find --
// production code (discoverUpstreamMarkers) never hardcodes it; a newly-added marker makes
// this assertion fail until the list below is updated, which is the intended signal (a
// human should notice and consciously extend coverage, not have it silently happen or
// silently not happen).
const EXPECTED_MARKER_PATHS = [
  "contracts/agent-metrics/UPSTREAM",
  "packages/adapters/test/fixtures/measure/UPSTREAM",
  "packages/core/src/vendor/derive-independence/UPSTREAM",
  "packages/core/test/fixtures/attribution/UPSTREAM",
  "packages/core/test/fixtures/estimate/UPSTREAM",
  "packages/core/test/fixtures/trace/UPSTREAM",
  "packages/schemas/test/fixtures/design-options/UPSTREAM",
].sort();

describe("discoverUpstreamMarkers (real repo)", () => {
  it("finds exactly the known 7 markers, none silently missed or duplicated", () => {
    expect(discoverUpstreamMarkers(REPO_ROOT)).toEqual(EXPECTED_MARKER_PATHS);
  });
});

function asSupported(
  marker: ParsedUpstreamMarker,
): Extract<ParsedUpstreamMarker, { supported: true }> {
  if (!marker.supported) {
    throw new Error(`expected ${marker.markerPath} to parse; reason: ${marker.reason}`);
  }
  return marker;
}

describe("parseUpstreamMarker + hashedFilesForMarker (all 7 real markers)", () => {
  const markers = EXPECTED_MARKER_PATHS.map((markerPath) =>
    asSupported(parseUpstreamMarker(REPO_ROOT, markerPath)),
  );

  it("every real marker parses as supported (none fall into the unsupported/unknown-format path)", () => {
    // asSupported() above already throws with the specific reason for any marker that
    // doesn't parse -- reaching this line at all is the assertion.
    expect(markers).toHaveLength(EXPECTED_MARKER_PATHS.length);
  });

  it.each(markers.map((m) => [m.markerPath, m] as const))(
    "%s: vendored bytes match the recorded tree hash (content check, always runs)",
    (_markerPath, marker) => {
      const files = hashedFilesForMarker(REPO_ROOT, marker);
      expect(files.length).toBeGreaterThan(0);
      const result = verifyTreeHash(files, marker.recordedHash);
      console.log(
        `[upstream-markers] ${marker.markerPath}: commit=${marker.commit} vendoredInto=${marker.vendoredInto} files=${files.length} treeHash=${result}`,
      );
      expect(result).toBe("match");
    },
  );

  it.each(markers.map((m) => [m.markerPath, m] as const))(
    "%s: pin resolves and is an ancestor of upstream main (opt-in, LANE_UPSTREAM_PLAYBOOK_PATH)",
    (_markerPath, marker) => {
      if (!UPSTREAM_REPO_PATH) return; // same opt-in gate as pin-verify.test.ts's own checks
      const files = hashedFilesForMarker(REPO_ROOT, marker);
      const diagnosis = diagnosePin({
        files,
        recordedHash: marker.recordedHash,
        commit: marker.commit,
        upstreamRepoPath: UPSTREAM_REPO_PATH,
        markerPath: marker.markerPath,
      });
      console.log(
        `[upstream-markers] ${marker.markerPath}: healthy=${diagnosis.healthy}${diagnosis.problem ? ` problem=${diagnosis.problem.code}: ${diagnosis.problem.message}` : ""}`,
      );
      expect(diagnosis.healthy).toBe(true);
      expect(diagnosis.problem).toBeUndefined();
    },
  );
});

describe("parseUpstreamMarker — unsupported formats are reported explicitly, never silently dropped", () => {
  function writeMarker(dir: string, relPath: string, contents: string): void {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }

  it("a marker missing 'Vendored commit:' is supported:false with a specific reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-upstream-marker-parse-"));
    try {
      writeMarker(dir, "UPSTREAM", `Vendored into: some/dir/\n\n  ${"1".repeat(64)}\n`);
      const parsed = parseUpstreamMarker(dir, "UPSTREAM");
      expect(parsed.supported).toBe(false);
      if (!parsed.supported) expect(parsed.reason).toMatch(/Vendored commit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a marker missing 'Vendored into:' is supported:false with a specific reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-upstream-marker-parse-"));
    try {
      writeMarker(dir, "UPSTREAM", `Vendored commit: ${"a".repeat(40)}\n\n  ${"b".repeat(64)}\n`);
      const parsed = parseUpstreamMarker(dir, "UPSTREAM");
      expect(parsed.supported).toBe(false);
      if (!parsed.supported) expect(parsed.reason).toMatch(/Vendored into/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a marker with zero or multiple 64-hex-char hash lines is supported:false, never guesses", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-upstream-marker-parse-"));
    try {
      writeMarker(
        dir,
        "UPSTREAM",
        `Vendored commit: ${"a".repeat(40)}\nVendored into: some/dir/\n\n  ${"b".repeat(64)}\n  ${"c".repeat(64)}\n`,
      );
      const parsed = parseUpstreamMarker(dir, "UPSTREAM");
      expect(parsed.supported).toBe(false);
      if (!parsed.supported) expect(parsed.reason).toMatch(/found 2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("discoverUpstreamMarkers — excludes node_modules/dist/dot-directories, still finds nested markers", () => {
  it("finds a marker several directories deep, skips markers planted under excluded directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-upstream-discover-"));
    try {
      mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
      writeFileSync(join(dir, "a", "b", "c", "UPSTREAM"), "irrelevant\n");
      for (const excluded of ["node_modules", "dist", ".git", ".hidden"]) {
        mkdirSync(join(dir, excluded), { recursive: true });
        writeFileSync(join(dir, excluded, "UPSTREAM"), "should not be found\n");
      }
      expect(discoverUpstreamMarkers(dir)).toEqual(["a/b/c/UPSTREAM"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hashedFilesForMarker — file vs. directory dispatch", () => {
  it("a marker whose vendoredInto names a single file (derive-independence's own shape) hashes exactly that file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-upstream-hashfiles-file-"));
    try {
      mkdirSync(join(dir, "src", "vendor"), { recursive: true });
      writeFileSync(join(dir, "src", "vendor", "thing.mjs"), "export const x = 1;\n");
      const marker = asSupported(
        (() => {
          writeFileSync(
            join(dir, "UPSTREAM"),
            `Vendored commit: ${"a".repeat(40)}\nVendored into: src/vendor/thing.mjs\n\n  ${"b".repeat(64)}\n`,
          );
          return parseUpstreamMarker(dir, "UPSTREAM");
        })(),
      );
      const files = hashedFilesForMarker(dir, marker);
      expect(files).toEqual([
        { path: "src/vendor/thing.mjs", absolutePath: join(dir, "src", "vendor", "thing.mjs") },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a marker whose vendoredInto names a directory hashes every file under it, sorted, recursively", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-upstream-hashfiles-dir-"));
    try {
      mkdirSync(join(dir, "fixtures", "v1", "nested"), { recursive: true });
      writeFileSync(join(dir, "fixtures", "v1", "b.json"), "{}\n");
      writeFileSync(join(dir, "fixtures", "v1", "a.json"), "{}\n");
      writeFileSync(join(dir, "fixtures", "v1", "nested", "c.json"), "{}\n");
      writeFileSync(
        join(dir, "UPSTREAM"),
        `Vendored commit: ${"a".repeat(40)}\nVendored into: fixtures/v1/\n\n  ${"b".repeat(64)}\n`,
      );
      const marker = asSupported(parseUpstreamMarker(dir, "UPSTREAM"));
      const files = hashedFilesForMarker(dir, marker);
      expect(files.map((f) => f.path)).toEqual([
        "fixtures/v1/a.json",
        "fixtures/v1/b.json",
        "fixtures/v1/nested/c.json",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Same throwaway-git-repo technique as pin-verify.test.ts's own buildFixtureRepo, but driven
 * through the FULL marker pipeline (discover -> parse -> hashedFilesForMarker -> diagnosePin)
 * instead of calling diagnosePin's primitives directly -- this is the integration surface
 * this file exists to cover, per "対象が7件に広がったことの検証に集中する" (the individual
 * reachability states themselves are pin-verify.test.ts's job). */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function buildUpstreamFixtureRepo(): {
  path: string;
  onMainCommit: string;
  branchOnlyCommit: string;
} {
  const path = mkdtempSync(join(tmpdir(), "lane-upstream-marker-e2e-upstream-"));
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.email", "test@example.com"]);
  git(path, ["config", "user.name", "test"]);
  writeFileSync(join(path, "vendored.txt"), "hello\n");
  git(path, ["add", "vendored.txt"]);
  git(path, ["commit", "-q", "-m", "init"]);
  const onMainCommit = git(path, ["rev-parse", "HEAD"]).trim();
  git(path, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(path, "vendored.txt"), "hello-from-branch\n");
  git(path, ["commit", "-q", "-am", "branch-only change"]);
  const branchOnlyCommit = git(path, ["rev-parse", "HEAD"]).trim();
  git(path, ["checkout", "-q", "main"]);
  git(path, ["update-ref", "refs/remotes/origin/main", "main"]);
  return { path, onMainCommit, branchOnlyCommit };
}

function buildDownstreamMarkerRepo(onMainCommit: string): { path: string; recordedHash: string } {
  const path = mkdtempSync(join(tmpdir(), "lane-upstream-marker-e2e-downstream-"));
  mkdirSync(join(path, "vendored"), { recursive: true });
  writeFileSync(join(path, "vendored", "file.txt"), "hello\n");
  const recordedHash = createHash("sha256")
    .update("vendored/file.txt\n", "utf-8")
    .update("hello\n")
    .digest("hex");
  writeFileSync(
    join(path, "UPSTREAM"),
    `Vendored commit: ${onMainCommit}\nVendored into: vendored/\n\n  ${recordedHash}\n`,
  );
  return { path, recordedHash };
}

describe("end-to-end marker pipeline (discover -> parse -> hashedFilesForMarker -> diagnosePin)", () => {
  const upstream = buildUpstreamFixtureRepo();

  it("discovers, parses, and diagnoses a healthy synthetic marker as healthy", () => {
    const downstream = buildDownstreamMarkerRepo(upstream.onMainCommit);
    try {
      expect(discoverUpstreamMarkers(downstream.path)).toEqual(["UPSTREAM"]);
      const marker = asSupported(parseUpstreamMarker(downstream.path, "UPSTREAM"));
      const files = hashedFilesForMarker(downstream.path, marker);
      const diagnosis = diagnosePin({
        files,
        recordedHash: marker.recordedHash,
        commit: marker.commit,
        upstreamRepoPath: upstream.path,
        markerPath: "UPSTREAM",
      });
      expect(diagnosis).toEqual({ healthy: true });
    } finally {
      rmSync(downstream.path, { recursive: true, force: true });
    }
  });

  it("pin changed by one character -> unresolvable, surfaced as pin_unresolvable", () => {
    const downstream = buildDownstreamMarkerRepo(upstream.onMainCommit);
    try {
      const marker = asSupported(parseUpstreamMarker(downstream.path, "UPSTREAM"));
      const flipped = `${marker.commit.slice(0, -1)}${marker.commit.endsWith("0") ? "1" : "0"}`;
      const files = hashedFilesForMarker(downstream.path, marker);
      const diagnosis = diagnosePin({
        files,
        recordedHash: marker.recordedHash,
        commit: flipped,
        upstreamRepoPath: upstream.path,
        markerPath: "UPSTREAM",
      });
      expect(diagnosis.healthy).toBe(false);
      expect(diagnosis.problem?.code).toBe("pin_unresolvable");
    } finally {
      rmSync(downstream.path, { recursive: true, force: true });
    }
  });

  it("pin points at a branch-only commit -> not_on_main, surfaced as pin_not_on_main", () => {
    const downstream = buildDownstreamMarkerRepo(upstream.branchOnlyCommit);
    try {
      const marker = asSupported(parseUpstreamMarker(downstream.path, "UPSTREAM"));
      const files = hashedFilesForMarker(downstream.path, marker);
      const diagnosis = diagnosePin({
        files,
        recordedHash: marker.recordedHash,
        commit: marker.commit,
        upstreamRepoPath: upstream.path,
        markerPath: "UPSTREAM",
      });
      expect(diagnosis.healthy).toBe(false);
      expect(diagnosis.problem?.code).toBe("pin_not_on_main");
    } finally {
      rmSync(downstream.path, { recursive: true, force: true });
    }
  });

  it("vendored byte mutated -> content_mismatch, surfaced as pin_content_mismatch", () => {
    const downstream = buildDownstreamMarkerRepo(upstream.onMainCommit);
    try {
      const marker = asSupported(parseUpstreamMarker(downstream.path, "UPSTREAM"));
      writeFileSync(join(downstream.path, "vendored", "file.txt"), "tampered\n");
      const files = hashedFilesForMarker(downstream.path, marker);
      const diagnosis = diagnosePin({
        files,
        recordedHash: marker.recordedHash,
        commit: marker.commit,
        upstreamRepoPath: upstream.path,
        markerPath: "UPSTREAM",
      });
      expect(diagnosis.healthy).toBe(false);
      expect(diagnosis.problem?.code).toBe("pin_content_mismatch");
    } finally {
      rmSync(downstream.path, { recursive: true, force: true });
    }
  });
});
