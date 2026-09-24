// issue #50 — SemVer 2.0 precedence, used by done-overlay.ts's forward-compat write guard
// (a running binary must never silently clobber fields written by a *newer* binary version).
// No external dependency: a minimal parser + comparator covering exactly the precedence
// rules semver.org §11 defines for `major.minor.patch[-prerelease][+build]`. Build metadata
// is parsed but never affects comparison (semver.org §10).

export interface ParsedToolVersion {
  major: number;
  minor: number;
  patch: number;
  /** Empty when there is no `-prerelease` suffix (a release always outranks any prerelease
   * of the same major.minor.patch). */
  prerelease: string[];
}

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Returns null (never throws) for anything that isn't a well-formed SemVer 2.0 string --
 * including leading-zero numeric fields ("01.0.0"), which §2 explicitly forbids. */
export function parseToolVersion(version: string): ParsedToolVersion | null {
  const match = VERSION_RE.exec(version);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

function isNumericIdentifier(id: string): boolean {
  return /^\d+$/.test(id);
}

/** semver.org §11.4.4 -- a single prerelease identifier pair: numeric identifiers compare
 * numerically and always sort lower than alphanumeric ones; alphanumeric identifiers
 * compare lexically (ASCII). */
function comparePrereleaseIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = isNumericIdentifier(a);
  const bNumeric = isNumericIdentifier(b);
  if (aNumeric && bNumeric) {
    const an = Number(a);
    const bn = Number(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** semver.org §11.3/§11.4 -- a version without a prerelease outranks one with the same
 * major.minor.patch and a prerelease; otherwise identifiers are compared left to right, and
 * the sequence with more identifiers (once every shared prefix is equal) is larger. */
function comparePrerelease(a: readonly string[], b: readonly string[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const cmp = comparePrereleaseIdentifier(a[i] as string, b[i] as string);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * SemVer 2.0 precedence (semver.org §11): major, then minor, then patch, then prerelease.
 * Throws if either `a` or `b` fails to parse -- callers that need to treat an unparseable
 * version as "fail closed" rather than a thrown error (done-overlay.ts's
 * assertDoneOverlayWritable) check `parseToolVersion` themselves before calling this.
 */
export function compareToolVersion(a: string, b: string): -1 | 0 | 1 {
  const pa = parseToolVersion(a);
  const pb = parseToolVersion(b);
  if (!pa || !pb) {
    throw new Error(`compareToolVersion: not a valid SemVer 2.0 version: ${!pa ? a : b}`);
  }
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}
