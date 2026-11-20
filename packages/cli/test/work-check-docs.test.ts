import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// I-2026-11-20-pre-merge-bind-gap-warning -- TEST-07, TEST-10, TEST-14 (RULE-05, D6,
// PATH-10). Repo-doc-as-text tests, following agent-cost-timeout-docs.test.ts's precedent.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const readmeText = readFileSync(join(repoRoot, "README.md"), "utf-8");
const changelogText = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf-8");

const SAFE_FORM =
  "lane work bind --intent=<intent-id> --task-run=<task-run-id> --session-id=<session-id> --agent=<claude|codex>";

/** The README subsection documenting the check (heading to the next heading). */
function readmeSection(text: string): string {
  const heading = "### SessionStart bind check (`lane work check`)";
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^#{2,3} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The `## Unreleased` section of CHANGELOG.md (up to the next `## ` heading). */
function unreleasedSection(text: string): string {
  const start = text.indexOf("## Unreleased");
  if (start < 0) return "";
  const rest = text.slice(start + "## Unreleased".length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Problems that must never appear in the check's documentation: a suggested `lane work bind`
 * without `--task-run`, a positional-value option form, or a claim that the cwd is
 * normalized to the git/repository root.
 */
function forbiddenDocProblems(text: string): string[] {
  const problems: string[] = [];
  for (const m of text.matchAll(/lane work bind[^\n`]*/g)) {
    const cmd = m[0];
    if (!/--(intent|task-run|session-id|agent)/.test(cmd)) continue; // prose mention only
    if (!cmd.includes("--task-run=")) problems.push(`bind command without --task-run=: ${cmd}`);
    if (/--(intent|task-run|session-id|agent)[ \t]/.test(cmd)) {
      problems.push(`positional-value option form: ${cmd}`);
    }
  }
  if (/git[- ]root|worktree root|repo(sitory)? root|rev-parse --show-toplevel/i.test(text)) {
    problems.push("claims git-root normalization");
  }
  return problems;
}

/** Required content for the README section. */
function readmeProblems(section: string): string[] {
  const problems = forbiddenDocProblems(section);
  const required = [
    "SessionStart",
    ".claude/settings.json",
    ".codex/hooks.json",
    '"command": "lane work check --agent claude"',
    '"command": "lane work check --agent codex"',
    SAFE_FORM,
    "subdirectory",
    "same cwd",
    "always\nexits 0",
  ];
  for (const r of required) {
    if (!section.includes(r)) problems.push(`missing: ${r}`);
  }
  return problems;
}

/** Required content for the CHANGELOG Unreleased entry. */
function changelogProblems(section: string): string[] {
  const problems = forbiddenDocProblems(section);
  for (const r of [
    "`lane work check`",
    "--agent claude",
    "--agent codex",
    "--task-run=<id>",
    "subdirectory",
    "same cwd",
  ]) {
    if (!section.includes(r)) problems.push(`missing: ${r}`);
  }
  return problems;
}

describe("TEST-10: README and Unreleased CHANGELOG document the SessionStart check", () => {
  it("TEST-10: README has Claude Code and Codex hook examples, explicit agents, the safe form and the cwd limitation", () => {
    const section = readmeSection(readmeText);
    expect(section.length).toBeGreaterThan(0);
    expect(readmeProblems(section)).toEqual([]);
  });

  it("TEST-10: CHANGELOG ## Unreleased records lane work check with the safe form and limitation", () => {
    const section = unreleasedSection(changelogText);
    expect(section).toContain("lane work check");
    expect(changelogProblems(section)).toEqual([]);
  });
});

describe("TEST-14: documentation negative fixtures are rejected", () => {
  const section = readmeSection(readmeText);

  it("TEST-14: a bind command that omits --task-run is rejected", () => {
    const bad = section.replace(" --task-run=<task-run-id>", "");
    expect(readmeProblems(bad).some((p) => p.startsWith("bind command without --task-run="))).toBe(
      true,
    );
    expect(
      forbiddenDocProblems("run lane work bind --intent=I-1 --session-id=s --agent=claude"),
    ).toHaveLength(1);
  });

  it("TEST-14: a positional-value command form is rejected", () => {
    const bad = section.replace("--intent=<intent-id>", "--intent <intent-id>");
    expect(readmeProblems(bad).some((p) => p.startsWith("positional-value option form"))).toBe(
      true,
    );
    expect(
      forbiddenDocProblems(
        "lane work bind --intent I-1 --task-run=twr-1 --session-id=s --agent=claude",
      ),
    ).toEqual([
      "positional-value option form: lane work bind --intent I-1 --task-run=twr-1 --session-id=s --agent=claude",
    ]);
  });

  it("TEST-14: a git-root normalization claim is rejected", () => {
    const bad = `${section}\nThe hook cwd is normalized to the git root, so subdirectories work.\n`;
    expect(readmeProblems(bad)).toContain("claims git-root normalization");
    expect(forbiddenDocProblems("resolved from the repository root")).toEqual([
      "claims git-root normalization",
    ]);
  });

  it("TEST-14: missing hook examples or limitation text are reported", () => {
    const bad = section
      .replace('"command": "lane work check --agent codex"', '"command": "lane work check"')
      .replaceAll("subdirectory", "folder");
    expect(readmeProblems(bad)).toEqual(
      expect.arrayContaining([
        'missing: "command": "lane work check --agent codex"',
        "missing: subdirectory",
      ]),
    );
    expect(changelogProblems("")).toContain("missing: `lane work check`");
  });

  it("TEST-14: the real documents pass the same validators the fixtures fail", () => {
    expect(readmeProblems(section)).toEqual([]);
    expect(changelogProblems(unreleasedSection(changelogText))).toEqual([]);
  });
});

describe("TEST-07: test, typecheck and Biome stay wired and green for the feature", () => {
  it("TEST-07: root scripts define pnpm test, typecheck and lint (Biome)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toBe("pnpm -r --if-present run test");
    expect(pkg.scripts.typecheck).toBe("tsc -b");
    expect(pkg.scripts.lint).toBe("biome check .");
  });

  it("TEST-07: the CLI package typechecks and the feature files pass Biome", () => {
    const bin = join(repoRoot, "node_modules", ".bin");
    execFileSync(
      join(bin, "tsc"),
      ["--noEmit", "-p", join(repoRoot, "packages/cli/tsconfig.json")],
      {
        cwd: repoRoot,
        stdio: "pipe",
      },
    );
    execFileSync(
      join(bin, "biome"),
      [
        "check",
        "packages/cli/src/commands/work.ts",
        "packages/cli/src/main.ts",
        "packages/cli/test/work-check.test.ts",
        "packages/cli/test/work-check-docs.test.ts",
        "packages/cli/test/work-check-characterization.test.ts",
        "packages/cli/test/helpers/work-check-harness.ts",
      ],
      { cwd: repoRoot, stdio: "pipe" },
    );
  }, 120_000);
});
