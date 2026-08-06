import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentMetricsMarker, buildCoverage, buildTokenUsagePayload } from "@lane/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GithubCommentMetricsPublisher,
  MetricsPublishFailed,
} from "../src/metrics/github-comment.js";

// Dedicated fake `gh` for this suite (not fixtures/fake-cli-recorder.mjs, which only ever
// returns one static stdout value for every call -- this adapter makes two genuinely
// different `gh api` calls in sequence, list-then-act, and needs each to return different
// JSON). The fake differentiates purely on argv shape: a GET-style listing call (no -X)
// returns the configured comments; a PATCH/POST returns a synthetic created/updated
// comment object.
function writeFakeGh(dir: string, existingComments: { id: number; body: string }[]): string {
  const path = join(dir, "gh");
  const jsonLines = existingComments.map((c) => JSON.stringify(c)).join("\n");
  const script = `#!/usr/bin/env bash
set -e
args=("$@")
for arg in "$@"; do
  if [ "$arg" = "-X" ]; then
    echo '{"html_url": "https://github.com/octo-org/spec-lane-demo/pull/1#issuecomment-999"}'
    exit 0
  fi
done
# no -X flag => either the listing call, or the create (POST) call
if [[ "$*" == *"comments"* && "$*" != *"-f"* ]]; then
cat <<'JSONLINES'
${jsonLines}
JSONLINES
  exit 0
fi
echo '{"html_url": "https://github.com/octo-org/spec-lane-demo/pull/1#issuecomment-1000"}'
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function buildMarker(subjectId: string): string {
  const payload = buildTokenUsagePayload({
    emitter: { name: "spec-lane", version: "0.3.0" },
    subject: { namespace: "spec-lane", type: "delivery-run", id: subjectId },
    repository: { provider: "github", id: "octo-org/spec-lane-demo" },
    generatedAt: "2026-08-07T00:00:00Z",
    records: [],
    coverage: buildCoverage({ eligibleEntries: 0, measuredEntries: 0, omissions: [] }),
  });
  return buildAgentMetricsMarker(payload);
}

describe("GithubCommentMetricsPublisher", () => {
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "lane-metrics-publisher-bin-"));
  });

  it("creates a new comment when no existing comment matches this marker's upsert_key", async () => {
    const marker = buildMarker("I-2026-08-07-a");
    const bin = writeFakeGh(binDir, []); // no existing comments at all
    const publisher = new GithubCommentMetricsPublisher({ ghBin: bin });
    const result = await publisher.upsert(marker, {
      repository: { provider: "github", id: "octo-org/spec-lane-demo" },
      prNumber: 1,
    });
    expect(result.action).toBe("created");
    expect(result.url).toContain("issuecomment-1000");
  });

  it("updates the existing comment whose decoded upsert_key matches, rather than creating a duplicate", async () => {
    const marker = buildMarker("I-2026-08-07-b");
    const bin = writeFakeGh(binDir, [
      { id: 555, body: `Some preamble.\n\n${marker}\n` }, // the matching one
      { id: 556, body: "An unrelated comment with no marker at all." },
    ]);
    const publisher = new GithubCommentMetricsPublisher({ ghBin: bin });
    const result = await publisher.upsert(marker, {
      repository: { provider: "github", id: "octo-org/spec-lane-demo" },
      prNumber: 1,
    });
    expect(result.action).toBe("updated");
  });

  it("does not match a comment whose marker decodes to a different subject (different upsert_key)", async () => {
    const markerA = buildMarker("I-2026-08-07-a");
    const markerB = buildMarker("I-2026-08-07-different-subject");
    const bin = writeFakeGh(binDir, [{ id: 777, body: markerB }]);
    const publisher = new GithubCommentMetricsPublisher({ ghBin: bin });
    const result = await publisher.upsert(markerA, {
      repository: { provider: "github", id: "octo-org/spec-lane-demo" },
      prNumber: 1,
    });
    expect(result.action).toBe("created"); // markerB's comment does not match markerA's identity
  });

  it("throws MetricsPublishFailed if the marker itself doesn't decode (defensive; buildAgentMetricsMarker never produces this)", async () => {
    const bin = writeFakeGh(binDir, []);
    const publisher = new GithubCommentMetricsPublisher({ ghBin: bin });
    await expect(
      publisher.upsert("<!-- agent-metrics:v1 payload_b64=bogus sha256=bogus -->", {
        repository: { provider: "github", id: "octo-org/spec-lane-demo" },
        prNumber: 1,
      }),
    ).rejects.toThrow(MetricsPublishFailed);
  });
});
