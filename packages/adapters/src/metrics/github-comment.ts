import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type MetricsPublishResult,
  type MetricsPublishTarget,
  type MetricsPublisher,
  decodeAndVerifyAgentMetricsMarker,
} from "@lane/core";

const execFileAsync = promisify(execFile);

export class MetricsPublishFailed extends Error {}

export interface GithubCommentMetricsPublisherOptions {
  /** gh binary, resolved via PATH by default. */
  ghBin?: string;
  timeoutMs?: number;
}

interface GhComment {
  id: number;
  body: string;
}

async function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, encoding: "utf-8" });
    return stdout;
  } catch (err) {
    throw new MetricsPublishFailed(
      `${bin} ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * design.md §4.5 — implements MetricsPublisher via `gh api` directly (not `gh pr comment`,
 * which has no way to find-then-edit a specific existing comment by content; its own
 * `--edit-last` only ever targets "the current user's last comment," not "the comment
 * whose marker matches this exact upsert_key" — see spec.md PATH-05 for why
 * GithubTrackerAdapter.annotatePr is not reused here). Upsert search: list every issue
 * comment on the target PR, decode+verify any agent-metrics:v1 marker found in each
 * (decodeAndVerifyAgentMetricsMarker already recomputes upsert_key independently — this
 * adapter never trusts a comment's declared value), and PATCH the first one whose
 * upsert_key matches ours; POST a new comment only if none matched.
 */
export class GithubCommentMetricsPublisher implements MetricsPublisher {
  private readonly ghBin: string;
  private readonly timeoutMs: number;

  constructor(opts: GithubCommentMetricsPublisherOptions = {}) {
    this.ghBin = opts.ghBin ?? "gh";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async upsert(marker: string, target: MetricsPublishTarget): Promise<MetricsPublishResult> {
    const decoded = decodeAndVerifyAgentMetricsMarker(marker);
    if (!decoded) {
      throw new MetricsPublishFailed("marker does not decode to a valid agent-metrics:v1 payload");
    }
    const repo = target.repository.id;
    const existing = await this.findExistingComment(repo, target.prNumber, decoded.upsert_key);
    if (existing) {
      const stdout = await run(
        this.ghBin,
        [
          "api",
          `repos/${repo}/issues/comments/${existing.id}`,
          "-X",
          "PATCH",
          "-f",
          `body=${marker}`,
        ],
        this.timeoutMs,
      );
      return {
        action: "updated",
        url: this.commentUrl(stdout, repo, target.prNumber, existing.id),
      };
    }
    const stdout = await run(
      this.ghBin,
      ["api", `repos/${repo}/issues/${target.prNumber}/comments`, "-f", `body=${marker}`],
      this.timeoutMs,
    );
    const created = this.parseCreatedComment(stdout);
    return { action: "created", url: created.html_url };
  }

  private async findExistingComment(
    repo: string,
    prNumber: number,
    upsertKey: string,
  ): Promise<GhComment | undefined> {
    const stdout = await run(
      this.ghBin,
      [
        "api",
        `repos/${repo}/issues/${prNumber}/comments`,
        "--paginate",
        "--jq",
        ".[] | {id: .id, body: .body}",
      ],
      this.timeoutMs,
    );
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let comment: GhComment;
      try {
        comment = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const decoded = decodeAndVerifyAgentMetricsMarker(comment.body);
      if (decoded && decoded.upsert_key === upsertKey) {
        return comment;
      }
    }
    return undefined;
  }

  private parseCreatedComment(stdout: string): { html_url: string } {
    try {
      const parsed = JSON.parse(stdout);
      if (typeof parsed.html_url === "string") return { html_url: parsed.html_url };
    } catch {
      // fall through to the generic error below
    }
    throw new MetricsPublishFailed("gh api POST did not return a parseable comment with html_url");
  }

  private commentUrl(stdout: string, repo: string, prNumber: number, commentId: number): string {
    try {
      const parsed = JSON.parse(stdout);
      if (typeof parsed.html_url === "string") return parsed.html_url;
    } catch {
      // fall through to the constructed fallback below
    }
    return `https://github.com/${repo}/pull/${prNumber}#issuecomment-${commentId}`;
  }
}
