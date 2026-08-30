import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

function describeFileType(entry: import("node:fs").Stats): string {
  if (entry.isDirectory()) return "a directory";
  if (entry.isFIFO()) return "a FIFO";
  if (entry.isSocket()) return "a socket";
  if (entry.isBlockDevice() || entry.isCharacterDevice()) return "a device";
  return "a special file";
}

export const EXTERNAL_VERIFY_STORE_FILENAME = "external-verify.yaml";

// `.strict()`, not zod's default key-stripping. A misspelled `allowed_command_digest` would
// otherwise parse cleanly into `{ allowed_command_digests: [] }`, and the operator would be told
// their command is `unauthorized` -- sending them to add a digest that is already sitting in the
// file, under a key nothing reads. That is precisely the "hide the operator's typo behind the
// wrong diagnosis" failure the throwing behaviour below exists to avoid, so the two have to
// agree.
const StoreSchema = z
  .object({
    allowed_command_digests: z.array(z.string().min(1)).default([]),
  })
  .strict();

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
  /**
   * Whether the file was actually read. False means "no store yet", which is the ordinary state
   * for anyone who has not enabled this feature and must stay distinguishable from "the store
   * is there but lane could not resolve where it is" -- the first deserves the `unauthorized`
   * message naming the digest to add, the second is a refusal about the store itself.
   */
  exists: boolean;
}

/**
 * Reads the store, treating "absent" and "empty" identically: no digests, therefore nothing is
 * authorized. A malformed store throws rather than being read as empty -- silently degrading a
 * broken authorization file into "authorize nothing" would be the safe direction, but it would
 * also hide the operator's own typo behind an `unauthorized` message pointing at the wrong
 * problem, which is the failure mode this feature has already hit twice in review.
 */
/**
 * True when the pathname does not exist because a SYMLINK somewhere along it dangles, rather
 * than because nothing was ever created there.
 *
 * `lstat` on the store path itself only catches a dangling FINAL component. If `~/.config` is
 * the broken link -- the more likely shape, since that is the component dotfiles managers
 * actually symlink -- then both `readFileSync` and `lstat` on the full path report ENOENT, and
 * it looks identical to "no store". So walk up until something exists, and ask whether that
 * something is a link that leads nowhere.
 */
function hasDanglingAncestorLink(path: string): boolean {
  let current = dirname(path);
  let previous = "";
  while (current !== previous) {
    let entry: import("node:fs").Stats;
    try {
      entry = lstatSync(current);
    } catch {
      // Not there at all -- keep walking up toward something that is.
      previous = current;
      current = dirname(current);
      continue;
    }
    if (!entry.isSymbolicLink()) return false; // A real directory: the gap below it is a genuine absence.
    try {
      statSync(current);
      return false; // A link that resolves; whatever is missing below it is genuinely missing.
    } catch {
      return true;
    }
  }
  return false;
}

export function readExternalVerifyStore(): ExternalVerifyStore {
  const path = externalVerifyStorePath();

  // Checked BEFORE the read, because `readFileSync` on a FIFO (or another blocking special
  // file) waits forever -- and nothing bounds that wait. The verify command's timeout is no
  // help: the child has not been started yet, so `lane advance` simply hangs. Measured: a
  // readFileSync against a FIFO was still blocked when an external 4s kill ended it.
  //
  // `statSync` follows links but does not open anything, so it is safe against the same file.
  let target: import("node:fs").Stats;
  try {
    target = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw error;
    // ENOENT from a FOLLOWING stat means the path does not resolve. Either the final component
    // dangles (lstat still sees the link), an ancestor link dangles, or nothing is there.
    let finalComponentExists = true;
    try {
      lstatSync(path);
    } catch {
      finalComponentExists = false;
    }
    if (finalComponentExists || hasDanglingAncestorLink(path)) {
      return { path, digests: [], exists: true };
    }
    return { path, digests: [], exists: false };
  }

  if (!target.isFile()) {
    // A directory, FIFO, socket or device where the store should be. Refusing by name beats
    // both reading it (which may never return) and treating it as absent (which would report
    // `unauthorized`, a message about digests for a problem that is not about digests).
    throw new Error(
      `${path} is not a regular file (found ${describeFileType(target)}); the authorization store must be a plain YAML file`,
    );
  }

  // Deliberately UNCAUGHT. Absence is already decided above, by a stat that distinguishes "not
  // there", "dangling link" and "not a regular file"; anything that fails here is a read error
  // on a file that existed a moment ago -- EACCES, or a race with something deleting it. An
  // earlier revision caught everything and returned an empty allow-list, so an operator whose
  // store was present and full of valid digests but unreadable was told their command was
  // `unauthorized` and would go add a digest already in the file. The throw becomes an
  // `authorization_store_unreadable` refusal at the gate boundary (gate-check.ts).
  const raw = readFileSync(path, "utf-8");
  const parsed = StoreSchema.parse(parseYaml(raw) ?? {});
  return { path, digests: parsed.allowed_command_digests, exists: true };
}
