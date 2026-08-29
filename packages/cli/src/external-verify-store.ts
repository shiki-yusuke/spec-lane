import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// I-2026-08-29-external-verify-gate — the operator's own authorization store.
//
// Authorization deliberately does NOT live in the profile, and cannot be pointed at by
// `--profile` or `LANE_PROFILE_PATH`. Three earlier designs put it somewhere selectable and all
// three were broken in review by the same move: the attacker controls the paths too. See the
// design note at the top of packages/core/src/external-verify.ts.
//
// This file is expected to be created and edited by a human, on their own machine, outside any
// repository. It is not a lane artifact: nothing writes it, no lane command manages it, and it
// is not part of any spec directory.

export const EXTERNAL_VERIFY_STORE_FILENAME = "external-verify.yaml";

const StoreSchema = z.object({
  allowed_command_digests: z.array(z.string().min(1)).default([]),
});

/**
 * `~/.config/lane/external-verify.yaml`, derived from `homedir()` ONLY.
 *
 * Deliberately does not use `resolveConfigDir()`, and therefore honors neither `LANE_CONFIG_DIR`
 * nor `XDG_CONFIG_HOME`, even though the rest of lane does. That inconsistency is the point:
 * this file was exploitable through exactly that indirection. With the store on
 * `resolveConfigDir()`, an attacker-controlled checkout could ship its own store and have the
 * launcher point `LANE_CONFIG_DIR` at it -- reproduced end to end, a fourth variant of the same
 * "trust derived from a path someone else chooses" mistake this feature kept making.
 *
 * `HOME` is itself an environment variable, so this is a bar, not a wall. The difference that
 * matters: `LANE_CONFIG_DIR` is a lane-specific knob a repository could plausibly set in
 * `.envrc`/mise/npm scripts alongside other project settings, whereas an environment that
 * rewrites `HOME` can equally rewrite `PATH` and replace the `lane` binary, at which point no
 * check inside lane is load-bearing. Tests inject a store through the seam in gate-check.ts
 * rather than moving this path.
 */
export function externalVerifyStorePath(): string {
  return join(homedir(), ".config", "lane", EXTERNAL_VERIFY_STORE_FILENAME);
}

export interface ExternalVerifyStore {
  path: string;
  digests: readonly string[];
}

/**
 * Reads the store, treating "absent" and "empty" identically: no digests, therefore nothing is
 * authorized. A malformed store throws rather than being read as empty -- silently degrading a
 * broken authorization file into "authorize nothing" would be the safe direction, but it would
 * also hide the operator's own typo behind an `unauthorized` message pointing at the wrong
 * problem, which is the failure mode this feature has already hit twice in review.
 */
export function readExternalVerifyStore(): ExternalVerifyStore {
  const path = externalVerifyStorePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { path, digests: [] };
  }
  const parsed = StoreSchema.parse(parseYaml(raw) ?? {});
  return { path, digests: parsed.allowed_command_digests };
}
