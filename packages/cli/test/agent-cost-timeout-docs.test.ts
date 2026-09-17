import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// issue #42 / spec I-2026-09-17-calibrate-agent-cost-timeout -- TEST-09 (spec.md "Tests"
// table, Scenario "the operator docs name the flag and the default"). RULE-07: README.md's
// agent-cost paragraph documents --agent-cost-timeout-ms and the default 180000 next to
// --agent-cost-bin; CHANGELOG.md records the flag in the section directly above "## 0.10.0"
// ("## Unreleased" before release, the release heading after). Precedent: skill-md-examples.test.ts (repo-doc-as-text test).

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const readmeText = readFileSync(join(repoRoot, "README.md"), "utf-8");
const changelogText = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf-8");

// A "paragraph" is a block of text separated by blank lines -- the same unit RULE-07's
// "in the same paragraph as --agent-cost-bin" phrasing describes.
function paragraphs(text: string): string[] {
  return text.split(/\r?\n\s*\r?\n/);
}

describe("TEST-09: README.md and CHANGELOG.md name the flag and the default (RULE-07)", () => {
  it("README.md documents --agent-cost-timeout-ms and 180000 in the same paragraph as --agent-cost-bin", () => {
    const target = paragraphs(readmeText).find(
      (p) => p.includes("--agent-cost-bin") && p.includes("--agent-cost-timeout-ms"),
    );
    expect(target).toBeDefined();
    expect(target).toContain("180000");
  });

  it("CHANGELOG.md records --agent-cost-timeout-ms in the section immediately above '## 0.10.0' (## Unreleased until release, then that release's own heading)", () => {
    // RULE-07 / D8: the entry is written under "## Unreleased" and renamed to the release's
    // version heading at release time (docs/releasing.md step 1), so this asserts the section
    // *position* (directly above 0.10.0) rather than a fixed heading text.
    const versionIndex = changelogText.indexOf("## 0.10.0");
    expect(versionIndex).toBeGreaterThan(0);
    const headingsAbove = [...changelogText.slice(0, versionIndex).matchAll(/^## .+$/gm)];
    expect(headingsAbove.length).toBeGreaterThan(0);
    const sectionStart = headingsAbove[headingsAbove.length - 1]?.index ?? -1;
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    const section = changelogText.slice(sectionStart, versionIndex);
    expect(section).toMatch(/^## (Unreleased|0\.10\.[1-9]\d*)/);
    expect(section).toContain("--agent-cost-timeout-ms");
  });
});
