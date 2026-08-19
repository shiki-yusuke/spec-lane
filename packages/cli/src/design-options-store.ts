import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalizeJcs, computeDigest } from "@lane/core";
import { type DesignOptionsDoc, DesignOptionsDocSchema } from "@lane/schemas";

// I-2026-08-18-design-critic-injection R4/R41/R42 — content-addressed revisions with a
// separate active pointer. A revision file's name IS its own digest, so it is immutable in
// practice (re-submitting byte-identical content lands on the same path; a real edit always
// produces a new digest and therefore a new file, never an in-place overwrite). Moving
// `active.json` to point at a new digest never touches or deletes any existing revision
// file (R42), and — just as importantly — never touches design-attestation.yaml (R41):
// overrides/decisions recorded there stay bound to whatever content_digest they were
// written against, so a pointer move alone makes them stale without this module (or
// anything else) needing to actively "clear" them.

export interface ActiveDesignPointer {
  design_options_id: string;
  content_digest: string;
  moved_at: string;
  moved_by: string;
}

function designDir(specDir: string, intentId: string): string {
  return join(specDir, intentId, "design");
}

function revisionsDir(specDir: string, intentId: string): string {
  return join(designDir(specDir, intentId), "revisions");
}

function activePointerPath(specDir: string, intentId: string): string {
  return join(designDir(specDir, intentId), "active.json");
}

/** `sha256:<hex>` over the RFC-8785-JCS canonicalization of the validated document. */
export function computeDesignOptionsDigest(doc: DesignOptionsDoc): string {
  return `sha256:${computeDigest(canonicalizeJcs(doc))}`;
}

function revisionPath(specDir: string, intentId: string, digest: string): string {
  const hex = digest.replace(/^sha256:/, "");
  return join(revisionsDir(specDir, intentId), `${hex}.json`);
}

/**
 * Validates + content-addresses a design-options/v1 document. Idempotent: re-submitting
 * byte-identical content (same digest) is a no-op write, not an error -- this is what makes
 * a revision "immutable once written" in R4's sense meaningful in practice (there is no
 * in-place-edit code path at all, only "write a new digest" or "write the same one again").
 */
export function writeDesignOptionsRevision(
  specDir: string,
  intentId: string,
  doc: DesignOptionsDoc,
): { digest: string } {
  const validated = DesignOptionsDocSchema.parse(doc);
  const digest = computeDesignOptionsDigest(validated);
  const path = revisionPath(specDir, intentId, digest);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`);
    renameSync(tmp, path);
  }
  return { digest };
}

export function readDesignOptionsRevision(
  specDir: string,
  intentId: string,
  digest: string,
): DesignOptionsDoc {
  const raw = JSON.parse(readFileSync(revisionPath(specDir, intentId, digest), "utf-8"));
  return DesignOptionsDocSchema.parse(raw);
}

export function readActiveDesignPointer(
  specDir: string,
  intentId: string,
): ActiveDesignPointer | null {
  const path = activePointerPath(specDir, intentId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as ActiveDesignPointer;
}

/**
 * R41: moving the pointer is the ENTIRE mechanism for "establishment does not carry
 * forward" -- this function does not read, touch, or reset attestation.yaml at all. A
 * decision/override recorded against the previous digest becomes stale purely because
 * gate/status code always compares against whatever active.json currently says (see
 * gate-check.ts's buildGateContext and commands/design.ts's status command).
 */
export function moveActiveDesignPointer(
  specDir: string,
  intentId: string,
  pointer: ActiveDesignPointer,
): void {
  const path = activePointerPath(specDir, intentId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pointer, null, 2)}\n`);
  renameSync(tmp, path);
}

export interface ActiveDesignOptions {
  pointer: ActiveDesignPointer;
  doc: DesignOptionsDoc;
}

export function readActiveDesignOptionsIfExists(
  specDir: string,
  intentId: string,
): ActiveDesignOptions | null {
  const pointer = readActiveDesignPointer(specDir, intentId);
  if (!pointer) return null;
  const doc = readDesignOptionsRevision(specDir, intentId, pointer.content_digest);
  return { pointer, doc };
}
