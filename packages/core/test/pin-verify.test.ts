import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCommitReachable, verifyTreeHash } from "../src/pin-verify.js";

// I-2026-08-18-design-critic-injection R39/R40 — automates the manual shasum command every
// UPSTREAM marker in this repo documents by hand. The content half (verifyTreeHash) is
// fully local/deterministic and asserted as a hard failing test below (R39 "fail closed,
// not merely warn"); the commit-reachability half is asserted as a skip-when-unavailable
// check (see checkCommitReachable's own doc comment for why an offline, always-on version
// of that check is not attempted here).

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(__dirname, "..", "src", "vendor", "derive-independence", "v1");
// Repo-root-relative path, matching packages/core/src/vendor/derive-independence/UPSTREAM's
// own documented `find packages/core/src/vendor/derive-independence/v1 -name
// 'derive-independence.mjs' ...` reproduction command -- the hash is over this logical path
// string, not this process's absolute filesystem path (see pin-verify.ts's HashedFile doc).
const MJS_REPO_RELATIVE_PATH = "packages/core/src/vendor/derive-independence/v1/derive-independence.mjs";
const RECORDED_MJS_HASH = "f1d890987a2a63992b3f8e1f5ee8f96bfa14d301043d8d120bd8f86d39053a46";
const PIN_COMMIT = "6b4f4233cf07e79040d0b8b65d7fe658d497112d";

const mjsFile = { path: MJS_REPO_RELATIVE_PATH, absolutePath: join(VENDOR_DIR, "derive-independence.mjs") };

describe("derive-independence vendored pin (packages/core/src/vendor/derive-independence/UPSTREAM)", () => {
  it("vendored bytes match the recorded tree hash (R39 content check, fails closed)", () => {
    const result = verifyTreeHash([mjsFile], RECORDED_MJS_HASH);
    expect(result, "vendored derive-independence.mjs no longer matches its recorded hash").toBe("match");
  });

  it("distinguishes content_mismatch from a genuinely different file (R40)", () => {
    // Same file, deliberately wrong recorded hash -- must report content_mismatch, not
    // silently pass and not throw.
    const result = verifyTreeHash([mjsFile], "0".repeat(64));
    expect(result).toBe("content_mismatch");
  });

  // Opt-in: set LANE_UPSTREAM_PLAYBOOK_PATH to a local checkout of
  // ai-agent-skills-playbook to actually exercise commit reachability (this is the check
  // that would have caught the pre-existing packages/adapters/test/fixtures/measure/
  // UPSTREAM defect, had it existed then -- see pin-verify.ts's header comment for why it
  // cannot run unconditionally in every environment this repo's tests run in).
  const upstreamRepoPath = process.env.LANE_UPSTREAM_PLAYBOOK_PATH;
  it.skipIf(!upstreamRepoPath)(
    "pinned commit is reachable from upstream main (opt-in, LANE_UPSTREAM_PLAYBOOK_PATH)",
    () => {
      const result = checkCommitReachable({ upstreamRepoPath, commit: PIN_COMMIT });
      expect(result).toBe("resolvable");
    },
  );

  it("checkCommitReachable returns 'unknown' (not a false pass) with no checkout configured", () => {
    expect(checkCommitReachable({ upstreamRepoPath: undefined, commit: PIN_COMMIT })).toBe("unknown");
    expect(
      checkCommitReachable({ upstreamRepoPath: "/definitely/not/a/real/path", commit: PIN_COMMIT }),
    ).toBe("unknown");
  });
});
