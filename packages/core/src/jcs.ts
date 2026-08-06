import { createHash } from "node:crypto";

// design.md §4.5 / agent-metrics:v1 protocol doc section 5 — RFC 8785 JSON Canonicalization
// Scheme, minimal subset ported byte-for-byte from ai-agent-skills-playbook's
// contracts/agent-metrics/v1/verify-fixtures.mjs (`canonicalize`), so an emitter and that
// contract's own conformance checker derive identical bytes from the same identity object.
// Sufficient only for this protocol's upsert-identity object: nested plain objects/arrays
// of strings and non-negative integers, no floats, no non-ASCII keys. Key ordering uses
// JS's default string comparison (UTF-16 code unit order), which is exactly what RFC 8785
// requires — do not "improve" this into a general JCS implementation without re-checking
// that requirement.
export function canonicalizeJcs(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJcs).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJcs(record[k])}`).join(",")}}`;
}

export interface UpsertIdentity {
  schema: string;
  repository: unknown;
  subject: unknown;
}

/**
 * am1_<hex sha256> over the RFC 8785 JCS canonicalization of {schema, repository, subject}
 * only — protocol doc section 5. Deliberately excludes generated_at/change/emitter.version/
 * token-and-cost values so a re-measurement, a price-catalog update, or the PR's head
 * moving to a new commit are all corrections to the *same* subject and resolve to the same
 * key, not a new row.
 */
export function computeAgentMetricsUpsertKey(identity: UpsertIdentity): string {
  const canonical = canonicalizeJcs({
    schema: identity.schema,
    repository: identity.repository,
    subject: identity.subject,
  });
  return `am1_${createHash("sha256").update(canonical, "utf-8").digest("hex")}`;
}
