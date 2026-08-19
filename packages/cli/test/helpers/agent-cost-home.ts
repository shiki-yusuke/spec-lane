import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points agent-cost at an empty, throwaway log root for the duration of a test.
 *
 * Why this exists: agent-cost reads the developer's real Claude/Codex history, and that history
 * grows every time the developer works. Measured on this machine: a single `agent-cost report`
 * over the real roots took **26 seconds** against 722 session files and 4,495 Codex threads; the
 * same command against an empty root took **0 seconds**. `--since`/`--until` do not help, because
 * the scan happens before the date filter can apply -- the test that first hit this had already
 * recorded that observation in a comment and sized its timeouts "for the slow case".
 *
 * The consequence was a test whose runtime grew without bound, so it flaked more often over time
 * -- and it flaked *only* for the one person who has agent-cost installed, i.e. the maintainer,
 * whose logs are the largest. A test that goes red for reasons unrelated to the change teaches
 * that red can be ignored, which is how a real regression gets waved through.
 *
 * agent-cost already supports this: CLAUDE_HOME and CODEX_HOME are documented overrides with a
 * stated resolution order (env > config file > defaults). Nothing upstream had to change.
 *
 * This makes the run hermetic, not comprehensive: with an empty root there is no usage to find, so
 * these tests exercise the plumbing (the binary runs, its output parses, the contract shape holds)
 * and not aggregation over real data. That is the honest scope -- asserting values over the
 * developer's own live history was never reproducible anyway.
 */
export function emptyAgentCostHome(): { CLAUDE_HOME: string; CODEX_HOME: string } {
  const root = mkdtempSync(join(tmpdir(), "lane-agent-cost-home-"));
  return { CLAUDE_HOME: join(root, "claude"), CODEX_HOME: join(root, "codex") };
}
