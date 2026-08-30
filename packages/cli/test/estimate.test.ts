import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runEstimate } from "../src/commands/estimate.js";
import { runStart } from "../src/commands/start.js";
import { readEstimateIfExists } from "../src/estimate-store.js";
import { intentPath, readIntent, writeIntent } from "../src/intent-store.js";

/** Mutates the raw YAML on disk directly (bypassing writeIntent's own IntentSchema
 * validation) -- the only way to reproduce a schema-external key on intent.yaml, since
 * writeIntent itself now refuses to write one (see intent-store.test.ts). This is exactly
 * how the real-world bug arose: a hand-edited or pre-schema-upgrade intent.yaml carrying a
 * key IntentSchema doesn't (yet) recognize. */
function addRawIntentKey(
  specDir: string,
  intentId: string,
  mutate: (raw: Record<string, unknown>) => void,
) {
  const path = intentPath(specDir, intentId);
  const raw = parseYaml(readFileSync(path, "utf-8"));
  mutate(raw);
  writeFileSync(path, stringifyYaml(raw));
}

// MP-8 (2026-08-08, sol ruling point 7): there is no more silent reference_table
// default -- every test below that doesn't specifically exercise the "no reference table
// given" failure path needs to supply one explicitly to reach exitCode 0 at all.
//
// M0 spec-lane 0.5.0: estimate/v2 additionally requires profile.estimate.cohort to be
// configured before buildEstimateRevision will produce any revision at all (never a
// v1-only write) -- every test below that reaches that point needs `profile` pointed at
// a cohort-configured profile file, set up in beforeEach.
let REFERENCE_TABLE_OPTS: {
  referenceTokensP50: number;
  referenceTokensP80: number;
  referenceCostP50: number;
  referenceCostP80: number;
  profile: string;
};

describe("runEstimate", () => {
  let specDir: string;
  let dataDir: string;
  const intentId = "I-2026-07-31-estimate-flow";

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), "lane-estimate-spec-"));
    dataDir = mkdtempSync(join(tmpdir(), "lane-estimate-data-"));
    process.env.LANE_DATA_DIR = dataDir;
    runStart(intentId, { specDir });

    const profilePath = join(specDir, "test.profile.yaml");
    writeFileSync(
      profilePath,
      stringifyYaml({
        schema_version: "1.0",
        profile_id: "test",
        estimate: {
          cohort: {
            agent_type: "claude",
            model_provider: "anthropic",
            model_generation: "claude-5",
            model_id: "claude-sonnet-5",
            routing_policy_digest: "a".repeat(64),
            prompt_policy_digest: "b".repeat(64),
            execution_profile_digest: "c".repeat(64),
          },
        },
      }),
    );
    REFERENCE_TABLE_OPTS = {
      referenceTokensP50: 50_000,
      referenceTokensP80: 150_000,
      referenceCostP50: 1,
      referenceCostP80: 4,
      profile: profilePath,
    };
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to the string "undefined", not real deletion
    delete process.env.LANE_DATA_DIR;
  });

  it("creates revision r1 via the reference_table fallback when there is no calibration population", () => {
    const result = runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("revision r1");
    expect(result.message).toContain("reference_table");

    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions).toHaveLength(1);
    expect(estimate?.revisions[0]?.revision_id).toBe("r1");
  });

  // MP-8 (2026-08-08, sol ruling point 7) / spec.md Rule 10: the behavior the removed
  // silent default used to paper over -- if the caller doesn't declare novel_surface AT
  // ALL, estimate/v2 abstains NOVEL_SURFACE_UNKNOWN before it ever reaches the
  // population-size question, so this test declares novel_surface to reach the
  // population gate specifically.
  //
  // Abstain-first fix (2026-08-2x): population too small + no reference table given used
  // to throw and discard the whole call (exitCode 1, no estimate.json at all). Now it is
  // recorded as an honest estimate/v2-abstained revision instead (exitCode 0) -- see
  // core/application/estimate-service.ts's buildEstimateRevision.
  it("records an estimate/v2-abstained revision when the population is too small and no reference table is given (never discards the call)", () => {
    const result = runEstimate(intentId, {
      specDir,
      profile: REFERENCE_TABLE_OPTS.profile,
      novelSurface: "established",
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("revision r1");
    expect(result.message).toContain("estimate/v2 abstained (INSUFFICIENT_POPULATION)");
    expect(result.message).toContain("population=0");
    expect(result.message).toContain("k-NN には最低 8 件必要");
    expect(result.message).toContain("reference table を渡せば predicted を作れる");
    expect(result.message).not.toMatch(/p50=/);

    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions).toHaveLength(1);
    const revision = estimate?.revisions[0];
    expect(revision?.revision_id).toBe("r1");
    expect(revision?.population_condition.method).toBe("abstained");
    expect(revision?.predicted).toBeUndefined();
    expect(revision?.decision_v2?.decision.status).toBe("abstained");
    expect(revision?.decision_v2?.decision.reason_codes).toContain("INSUFFICIENT_POPULATION");
  });

  // requirement 3: an abstained revision has no predicted value and must never become
  // the baseline. Bare `--adopt` (create + adopt in one call) still records the revision
  // (the primary action succeeded) but explicitly declines to adopt it.
  it("--adopt records but does not adopt an abstained revision (recorded at exitCode 0, adoption refused)", () => {
    const result = runEstimate(intentId, {
      specDir,
      profile: REFERENCE_TABLE_OPTS.profile,
      adopt: true,
      novelSurface: "established",
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("not adopted");
    expect(result.message).toMatch(/refused to adopt it as baseline/);
    expect(result.message).toMatch(/abstained/);

    const intent = readIntent(specDir, intentId);
    expect(intent.baseline_estimate_revision_id).toBeUndefined();
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions).toHaveLength(1);
  });

  // requirement 3: `--adopt <revision-id>` re-pointing at an already-abstained revision
  // must be refused outright (nothing else happens in that call, so it fails cleanly).
  it("--adopt <revision-id> refuses to adopt an already-abstained revision", () => {
    runEstimate(intentId, {
      specDir,
      profile: REFERENCE_TABLE_OPTS.profile,
      novelSurface: "established",
    }); // r1, abstained

    const result = runEstimate(intentId, { specDir, adopt: "r1" });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/r1/);
    expect(result.message).toMatch(/abstained/);
    expect(result.message).toMatch(/no predicted value/);

    const intent = readIntent(specDir, intentId);
    expect(intent.baseline_estimate_revision_id).toBeUndefined();
  });

  it("fails cleanly when only some of the four --reference-* flags are given (all-or-none)", () => {
    const result = runEstimate(intentId, { specDir, referenceTokensP50: 10_000 });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("must all be given together, or none");
  });

  it("appends r2 on a second call, never rewriting r1", () => {
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions.map((r) => r.revision_id)).toEqual(["r1", "r2"]);
  });

  it("does not adopt a baseline unless --adopt is passed", () => {
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    const intent = readIntent(specDir, intentId);
    expect(intent.baseline_estimate_revision_id).toBeUndefined();
  });

  it("--adopt sets intent.baseline_estimate_revision_id to the new revision, stamping baseline_adopted_at", () => {
    runEstimate(intentId, { specDir, adopt: true, ...REFERENCE_TABLE_OPTS });
    const intent = readIntent(specDir, intentId);
    expect(intent.baseline_estimate_revision_id).toBe("r1");
    expect(intent.baseline_adopted_at).toBeDefined();
  });

  it("--adopt <revision-id> (must-2): re-points baseline to an existing revision without creating a new one", () => {
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r1
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r2, not adopted

    const result = runEstimate(intentId, { specDir, adopt: "r1" });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("no new revision created");

    const intent = readIntent(specDir, intentId);
    expect(intent.baseline_estimate_revision_id).toBe("r1");
    expect(intent.baseline_adopted_at).toBeDefined();

    // still only r1/r2 -- the adopt-by-id call must not have appended r3
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions.map((r) => r.revision_id)).toEqual(["r1", "r2"]);
  });

  it("--adopt <revision-id> fails cleanly when no estimate.json exists yet", () => {
    const result = runEstimate(intentId, { specDir, adopt: "r1" });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/no estimate\.json/);
  });

  it("--adopt <revision-id> fails cleanly when the revision id doesn't exist", () => {
    runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r1
    const result = runEstimate(intentId, { specDir, adopt: "r99" });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("r99");
  });

  it("uses --reference-* flags instead of the generic default when given", () => {
    const result = runEstimate(intentId, {
      specDir,
      profile: REFERENCE_TABLE_OPTS.profile,
      referenceTokensP50: 10_000,
      referenceTokensP80: 20_000,
      referenceCostP50: 0.5,
      referenceCostP80: 1,
    });
    expect(result.exitCode).toBe(0);
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions[0]?.predicted?.tokens).toEqual({ p50: 10_000, p80: 20_000 });
  });

  it("parses an impact-scan:v1 block from --impact-scan-file into the revision's predictors", () => {
    const impactScanPath = join(specDir, "impact-scan-report.md");
    writeFileSync(
      impactScanPath,
      [
        "# Impact Scan",
        "```impact-scan:v1",
        JSON.stringify({
          scan_version: "1.0",
          repo_commit: "abc1234",
          candidate_paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
          candidate_layers: ["ui", "domain"],
        }),
        "```",
      ].join("\n"),
    );
    const result = runEstimate(intentId, {
      specDir,
      impactScanFile: impactScanPath,
      ...REFERENCE_TABLE_OPTS,
    });
    expect(result.exitCode).toBe(0);
    const estimate = readEstimateIfExists(specDir, intentId);
    expect(estimate?.revisions[0]?.predictors.files_touched_estimate).toBe(3);
    expect(estimate?.revisions[0]?.predictors.layers_crossed).toBe(2);
    expect(estimate?.revisions[0]?.impact_scan_snapshot?.candidate_paths).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("estimate/v2 abstains NOVEL_SURFACE_UNKNOWN by default, and --novel-surface resolves it (recorded with provenance)", () => {
    const withoutDeclaration = runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    expect(withoutDeclaration.exitCode).toBe(0);
    // gpt-5.4 review should: an abstained decision_v2 must not print v1's own predicted
    // p50/p80 next to it -- the whole point of abstaining is "no point estimate."
    expect(withoutDeclaration.message).toContain("estimate/v2 abstained");
    expect(withoutDeclaration.message).not.toMatch(/p50=/);
    const withoutRevision = readEstimateIfExists(specDir, intentId)?.revisions[0];
    expect(withoutRevision?.decision_v2?.decision.reason_codes).toContain("NOVEL_SURFACE_UNKNOWN");
    expect(withoutRevision?.novel_surface_declaration).toBeUndefined();
    // v1's own predicted number is still computed and stored on disk -- only the CLI's
    // own display of it is suppressed while abstained.
    expect(withoutRevision?.predicted?.tokens.p50).toBeDefined();

    const declared = runEstimate(intentId, {
      specDir,
      ...REFERENCE_TABLE_OPTS,
      novelSurface: "established",
    });
    expect(declared.exitCode).toBe(0);
    const declaredRevision = readEstimateIfExists(specDir, intentId)?.revisions[1];
    expect(declaredRevision?.decision_v2?.decision.reason_codes).not.toContain(
      "NOVEL_SURFACE_UNKNOWN",
    );
    expect(declaredRevision?.novel_surface_declaration).toMatchObject({
      value: "established",
      source: "manual_declaration",
    });
  });

  it("fails cleanly (exitCode 1) when profile.estimate.cohort is not configured", () => {
    const genericProfilePath = join(specDir, "no-cohort.profile.yaml");
    writeFileSync(genericProfilePath, "schema_version: '1.0'\nprofile_id: no-cohort\n");
    const result = runEstimate(intentId, {
      specDir,
      profile: genericProfilePath,
      referenceTokensP50: 50_000,
      referenceTokensP80: 150_000,
      referenceCostP50: 1,
      referenceCostP80: 4,
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/estimate\/v2 requires a fully declared cohort/);
  });

  it("fails with exitCode 1 and a clear message when --impact-scan-file has no valid block", () => {
    const impactScanPath = join(specDir, "bad-report.md");
    writeFileSync(impactScanPath, "# Impact Scan\n\nno block here\n");
    const result = runEstimate(intentId, { specDir, impactScanFile: impactScanPath });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/impact-scan-file/);
  });

  it("fails when the lane was never started", () => {
    const result = runEstimate("I-2026-07-31-never-started", { specDir });
    expect(result.exitCode).toBe(2);
  });

  // Data-loss fix (2026-08-29): `--adopt` re-serializes the *entire* intent.yaml via
  // writeIntent, so any field it carries must survive the round trip untouched -- not just
  // the fields this command itself intends to update (baseline_estimate_revision_id /
  // baseline_adopted_at). critical_invariants is exercised here specifically because it
  // used to be exactly the kind of schema-external field this bug silently deleted, before
  // it was first-classed onto IntentSchema.
  describe("--adopt preserves the full intent.yaml (data-loss fix)", () => {
    function withoutAdoptStamp(intent: ReturnType<typeof readIntent>) {
      const { baseline_estimate_revision_id, baseline_adopted_at, ...rest } = intent;
      return rest;
    }

    it("bare --adopt preserves intent.critical_invariants and every other field", () => {
      const before = readIntent(specDir, intentId);
      writeIntent(specDir, intentId, {
        ...before,
        intent: { ...before.intent, critical_invariants: ["must never delete user data"] },
      });
      const beforeAdopt = readIntent(specDir, intentId);

      const result = runEstimate(intentId, { specDir, adopt: true, ...REFERENCE_TABLE_OPTS });
      expect(result.exitCode).toBe(0);

      const after = readIntent(specDir, intentId);
      expect(after.baseline_estimate_revision_id).toBe("r1");
      expect(after.baseline_adopted_at).toBeDefined();
      expect(withoutAdoptStamp(after)).toEqual(withoutAdoptStamp(beforeAdopt));
      expect(after.intent.critical_invariants).toEqual(["must never delete user data"]);
    });

    it("--adopt <revision-id> preserves intent.critical_invariants and every other field", () => {
      runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r1, not adopted

      const before = readIntent(specDir, intentId);
      writeIntent(specDir, intentId, {
        ...before,
        intent: { ...before.intent, critical_invariants: ["must never delete user data"] },
      });
      const beforeAdopt = readIntent(specDir, intentId);

      const result = runEstimate(intentId, { specDir, adopt: "r1" });
      expect(result.exitCode).toBe(0);

      const after = readIntent(specDir, intentId);
      expect(after.baseline_estimate_revision_id).toBe("r1");
      expect(after.baseline_adopted_at).toBeDefined();
      expect(withoutAdoptStamp(after)).toEqual(withoutAdoptStamp(beforeAdopt));
      expect(after.intent.critical_invariants).toEqual(["must never delete user data"]);
    });
  });

  // Data-loss fix (2026-08-29): a schema-external key on intent.yaml (e.g. one added by
  // hand, or written by a future schema version this binary doesn't know about yet) must
  // abort *both* --adopt paths before either estimate.json or intent.yaml is touched --
  // never adopt-then-silently-strip.
  describe("--adopt fails closed when intent.yaml carries a schema-unrecognized key", () => {
    it("bare --adopt: exits non-zero, estimate.json and intent.yaml are both unchanged", () => {
      runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r1 recorded, not adopted
      addRawIntentKey(specDir, intentId, (raw) => {
        (raw.intent as Record<string, unknown>).made_up_field = "oops";
      });
      const beforeEstimate = readEstimateIfExists(specDir, intentId);
      const beforeIntentYaml = readFileSync(intentPath(specDir, intentId), "utf-8");

      const result = runEstimate(intentId, { specDir, adopt: true, ...REFERENCE_TABLE_OPTS });
      expect(result.exitCode).not.toBe(0);
      expect(result.message).toContain("intent.made_up_field");

      expect(readEstimateIfExists(specDir, intentId)).toEqual(beforeEstimate);
      expect(readFileSync(intentPath(specDir, intentId), "utf-8")).toBe(beforeIntentYaml);
    });

    it("--adopt <revision-id>: exits non-zero, estimate.json and intent.yaml are both unchanged", () => {
      runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r1 recorded, not adopted
      addRawIntentKey(specDir, intentId, (raw) => {
        (raw.intent as Record<string, unknown>).made_up_field = "oops";
      });
      const beforeEstimate = readEstimateIfExists(specDir, intentId);
      const beforeIntentYaml = readFileSync(intentPath(specDir, intentId), "utf-8");

      const result = runEstimate(intentId, { specDir, adopt: "r1" });
      expect(result.exitCode).not.toBe(0);
      expect(result.message).toContain("intent.made_up_field");

      expect(readEstimateIfExists(specDir, intentId)).toEqual(beforeEstimate);
      expect(readFileSync(intentPath(specDir, intentId), "utf-8")).toBe(beforeIntentYaml);
    });
  });

  // sol review (2nd round, 2026-08-29): regression for the `key in parsedObj` prototype-
  // chain bug in intent-store.ts's diffDroppedPaths -- an unrecognized key that happens to
  // share a name with an Object.prototype property (constructor/toString/...) must be
  // detected exactly like any other unrecognized key, not silently treated as "present on
  // the parsed object" and let through.
  describe("--adopt fails closed when the unrecognized key collides with an Object.prototype property name", () => {
    it.each(["constructor", "toString"] as const)(
      "bare --adopt: exits non-zero, estimate.json and intent.yaml are both unchanged (intent.%s)",
      (key) => {
        runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r1 recorded, not adopted
        addRawIntentKey(specDir, intentId, (raw) => {
          (raw.intent as Record<string, unknown>)[key] = "oops";
        });
        const beforeEstimate = readEstimateIfExists(specDir, intentId);
        const beforeIntentYaml = readFileSync(intentPath(specDir, intentId), "utf-8");

        const result = runEstimate(intentId, { specDir, adopt: true, ...REFERENCE_TABLE_OPTS });
        expect(result.exitCode).not.toBe(0);
        expect(result.message).toContain(`intent.${key}`);

        expect(readEstimateIfExists(specDir, intentId)).toEqual(beforeEstimate);
        expect(readFileSync(intentPath(specDir, intentId), "utf-8")).toBe(beforeIntentYaml);
      },
    );

    it.each(["constructor", "toString"] as const)(
      "--adopt <revision-id>: exits non-zero, estimate.json and intent.yaml are both unchanged (intent.%s)",
      (key) => {
        runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS }); // r1 recorded, not adopted
        addRawIntentKey(specDir, intentId, (raw) => {
          (raw.intent as Record<string, unknown>)[key] = "oops";
        });
        const beforeEstimate = readEstimateIfExists(specDir, intentId);
        const beforeIntentYaml = readFileSync(intentPath(specDir, intentId), "utf-8");

        const result = runEstimate(intentId, { specDir, adopt: "r1" });
        expect(result.exitCode).not.toBe(0);
        expect(result.message).toContain(`intent.${key}`);

        expect(readEstimateIfExists(specDir, intentId)).toEqual(beforeEstimate);
        expect(readFileSync(intentPath(specDir, intentId), "utf-8")).toBe(beforeIntentYaml);
      },
    );
  });

  // (c) readIntent (the read-only path -- e.g. the main flow when --adopt is not passed at
  // all) must keep working (warn, don't throw) when intent.yaml carries a schema-
  // unrecognized key: intent-store.test.ts covers this directly against readIntent itself;
  // this covers it at the `lane estimate` (no --adopt) call site.
  it("without --adopt, a schema-unrecognized key on intent.yaml only warns -- the call still succeeds", () => {
    addRawIntentKey(specDir, intentId, (raw) => {
      (raw.intent as Record<string, unknown>).made_up_field = "oops";
    });
    const result = runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS });
    expect(result.exitCode).toBe(0);
  });

  it("TEST-14: --adopt round-trips external_verify instead of dropping it", () => {
    // spec.md's test matrix named this test, and nothing implemented it. `estimate --adopt`
    // reserializes intent.yaml, so a field the write path does not carry through is silently
    // lost -- and losing external_verify means a lane that was gated on a command quietly stops
    // being gated, which is the one failure mode this feature must not have. Schema parsing
    // alone cannot show it: the field parses fine, the question is whether the command path
    // writes it back.
    const intent = readIntent(specDir, intentId);
    writeIntent(specDir, intentId, {
      ...intent,
      external_verify: { argv: ["/usr/local/bin/verify", "--flag"], timeout_seconds: 45 },
    });

    const result = runEstimate(intentId, { specDir, ...REFERENCE_TABLE_OPTS, adopt: true });
    expect(result.exitCode).toBe(0);

    const after = readIntent(specDir, intentId);
    expect(after.external_verify).toEqual({
      argv: ["/usr/local/bin/verify", "--flag"],
      timeout_seconds: 45,
    });
    // And it survives on disk as real YAML, not just through the reader's own defaults.
    const raw = parseYaml(readFileSync(intentPath(specDir, intentId), "utf-8"));
    expect(raw.external_verify.argv).toEqual(["/usr/local/bin/verify", "--flag"]);
    expect(raw.external_verify.timeout_seconds).toBe(45);
  });
});
