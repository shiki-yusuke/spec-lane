import type { EngineRef } from "@lane/schemas";
import { formatDesignMessage } from "./design-messages.js";

// I-2026-08-18-design-critic-injection R43/R44/R44a — lane-owned format allow/deny check,
// layered on top of a schema-valid EngineRef (design-options.ts). Deliberately NOT part of
// that schema (see design-options.ts's own header comment): the upstream contract places no
// such constraint on human_ref/session_ref, so folding this in there would break the
// accept/reject conformance-parity test against the vendored upstream schema.
//
// R44a is the load-bearing scope limit: this is a FORMAT check, not identity detection. An
// opaque string that happens to be, say, someone's internal employee id passes -- this
// module cannot and does not try to decide whether an arbitrary string denotes a natural
// person (that would require an identity model this lane does not have and is explicitly a
// non-goal). It only rejects values *shaped* like the closed set of formats below, mirroring
// this project's existing personal-dimension enforcement style (a closed, machine-checkable
// list rather than semantic judgment) -- see core/goodhart.ts's PERSONAL_DIMENSION_KEYS for
// the sibling convention (closed key-name list there; closed format list here, because
// human_ref/session_ref are free-text values, not dictionary keys).

// Address-shaped formats forbidden in engine_ref.human_ref (R43): this project's other
// personal-dimension enforcement (core/goodhart.ts) works on key *names*; human_ref is a
// value, so the equivalent control here is a closed set of value *shapes* that are
// themselves commonly an address/handle for a specific person.
const PROHIBITED_HUMAN_REF_FORMATS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "email_address", re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  { id: "slack_user_id", re: /^[UW][A-Z0-9]{8,}$/ },
  { id: "e164_phone_number", re: /^\+[1-9]\d{7,14}$/ },
  { id: "at_handle", re: /^@[A-Za-z0-9_-]{2,}$/ },
];

// Credential-shaped formats forbidden in engine_ref.session_ref (R44): a session_ref is
// supposed to be an opaque run/session label, never a bearer credential -- these are the
// shapes of live secrets that would leak into a committed artifact if accepted.
const PROHIBITED_SESSION_REF_FORMATS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "jwt_like", re: /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ },
  { id: "aws_access_key_id", re: /^AKIA[0-9A-Z]{16}$/ },
  { id: "bearer_authorization_header", re: /^Bearer\s+\S+$/i },
  { id: "generic_api_key_like", re: /^(sk|pk|ghp|xox[abp])-?[A-Za-z0-9_-]{16,}$/ },
];

export interface EngineRefFormatViolation {
  path: string;
  message: string;
}

/**
 * Checks the format-only denylist (R43/R44) against one EngineRef. Returns [] when clean.
 * `path` names which record this EngineRef came from (e.g. "artifact_shapers[0].engine_ref"
 * or "critic_reviews[2].critic") so a caller can report exactly where the violation is,
 * matching R26's "never a bare verdict" for every other design-critic check.
 */
export function checkEngineRefFormats(
  engineRef: EngineRef,
  path: string,
): EngineRefFormatViolation[] {
  const violations: EngineRefFormatViolation[] = [];
  if (engineRef.human_ref !== undefined) {
    const match = PROHIBITED_HUMAN_REF_FORMATS.find((f) =>
      f.re.test(engineRef.human_ref as string),
    );
    if (match) {
      violations.push({
        path: `${path}.human_ref`,
        message: formatDesignMessage("engine_ref_prohibited_human_format", {
          matchedFormat: match.id,
        }),
      });
    }
  }
  if (engineRef.session_ref !== undefined) {
    const match = PROHIBITED_SESSION_REF_FORMATS.find((f) =>
      f.re.test(engineRef.session_ref as string),
    );
    if (match) {
      violations.push({
        path: `${path}.session_ref`,
        message: formatDesignMessage("engine_ref_prohibited_session_format", {
          matchedFormat: match.id,
        }),
      });
    }
  }
  return violations;
}
