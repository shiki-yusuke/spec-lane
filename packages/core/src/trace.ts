import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent, TraceRef, TraceRelation } from "@lane/schemas";
import { TraceEventSchema } from "@lane/schemas";
import { canonicalizeJcs } from "./jcs.js";
import { resolveDataDir } from "./xdg.js";

// M0 spec-lane 0.5.0 — trace/v1 event_id identity recipe (docs/protocols/trace-v1.md
// section 3), ported byte-for-byte from ai-agent-skills-playbook's own
// contracts/trace/v1/verify-fixtures.mjs `computeBaseIdentity`/`computeIdentity`/
// `recomputeEventId` (see packages/core/test/differential/trace-fixtures.test.ts, which
// checks this against the vendored fixtures). Lives in core, not schemas, because it needs
// node:crypto (via jcs.ts's canonicalizeJcs+sha256) -- schemas has no dependencies at all
// (design.md §2.1's fixed direction), core -> schemas.

function refIdentity(ref: TraceRef): { logical_id: string; content_digest?: string } {
  return ref.content_digest !== undefined
    ? { logical_id: ref.logical_id, content_digest: ref.content_digest }
    : { logical_id: ref.logical_id };
}

/**
 * Relation-specific identity subset (trace-v1.md's identity table). Callers MUST have
 * already confirmed the relation's required identity fields are present (TraceEventSchema
 * enforces this at parse time for every relation this repo actually constructs) --
 * feeding an incomplete event here would silently hash `undefined`, exactly the bug the
 * protocol doc's "never feed undefined into the JCS canonicalizer" MUST exists to prevent.
 */
export function computeTraceEventBaseIdentity(
  event: Pick<
    TraceEvent,
    "relation" | "from_ref" | "to_ref" | "task_run_id" | "session_id" | "payload"
  >,
): Record<string, unknown> {
  switch (event.relation) {
    case "session_bound":
      return { task_run_id: event.task_run_id, session_id: event.session_id };
    case "task_run_started":
      return { task_run_id: event.task_run_id };
    case "usage_imported": {
      const window = (
        event.payload as { window?: { since?: unknown; until?: unknown } } | undefined
      )?.window;
      return {
        task_run_id: event.task_run_id,
        session_id: event.session_id,
        window: { since: window?.since, until: window?.until },
      };
    }
    case "attributed_to":
      return {
        from_ref: { logical_id: event.from_ref.logical_id },
        to_ref: { logical_id: event.to_ref.logical_id },
        task_run_id: event.task_run_id,
      };
    default:
      return {
        relation: event.relation,
        from_ref: refIdentity(event.from_ref),
        to_ref: refIdentity(event.to_ref),
      };
  }
}

export function computeTraceEventIdentity(
  event: Pick<
    TraceEvent,
    | "relation"
    | "from_ref"
    | "to_ref"
    | "task_run_id"
    | "session_id"
    | "payload"
    | "supersedes_event_id"
  >,
): Record<string, unknown> {
  const base = computeTraceEventBaseIdentity(event);
  if (event.supersedes_event_id !== undefined) {
    return { ...base, supersedes_event_id: event.supersedes_event_id };
  }
  return base;
}

/** "tr1_" + hex(sha256(JCS({schema: "trace/v1", relation, identity}))). */
export function computeTraceEventId(
  event: Pick<
    TraceEvent,
    | "relation"
    | "from_ref"
    | "to_ref"
    | "task_run_id"
    | "session_id"
    | "payload"
    | "supersedes_event_id"
  >,
): string {
  const identity = computeTraceEventIdentity(event);
  const canonical = canonicalizeJcs({ schema: "trace/v1", relation: event.relation, identity });
  return `tr1_${createHash("sha256").update(canonical, "utf-8").digest("hex")}`;
}

const MAX_TRACE_EVENT_BYTES = 16 * 1024;
const MAX_TRACE_EVENT_DEPTH = 8;

function maxJsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(maxJsonDepth));
}

/** trace-v1.md "Limits" — enforced independently of shape validation (layer 4). */
export function checkTraceEventLimits(event: unknown): string[] {
  const reasons: string[] = [];
  const byteLength = Buffer.byteLength(JSON.stringify(event), "utf-8");
  if (byteLength > MAX_TRACE_EVENT_BYTES) {
    reasons.push(`event_too_large: ${byteLength} bytes > ${MAX_TRACE_EVENT_BYTES}`);
  }
  const depth = maxJsonDepth(event);
  if (depth > MAX_TRACE_EVENT_DEPTH) {
    reasons.push(`event_too_deep: depth ${depth} > ${MAX_TRACE_EVENT_DEPTH}`);
  }
  return reasons;
}

export interface BuildTraceEventInput {
  relation: TraceRelation;
  fromRef: TraceRef;
  toRef: TraceRef;
  occurredAt: string;
  actor: TraceEvent["actor"];
  laneId?: string;
  taskRunId?: string;
  phaseRunId?: string;
  sessionId?: string;
  causationEventId?: string;
  payload?: Record<string, unknown>;
  supersedesEventId?: string;
}

/**
 * The one writer path: always computes event_id itself (never trusts a caller-supplied
 * value) and validates the result against TraceEventSchema before returning, so a
 * malformed event can never reach appendTraceEvent in the first place.
 */
export function buildTraceEvent(input: BuildTraceEventInput): TraceEvent {
  const draft = {
    schema_version: "trace/v1" as const,
    relation: input.relation,
    from_ref: input.fromRef,
    to_ref: input.toRef,
    task_run_id: input.taskRunId,
    session_id: input.sessionId,
    payload: input.payload,
    supersedes_event_id: input.supersedesEventId,
  };
  const eventId = computeTraceEventId(draft);
  return TraceEventSchema.parse({
    schema_version: "trace/v1",
    event_id: eventId,
    relation: input.relation,
    from_ref: input.fromRef,
    to_ref: input.toRef,
    occurred_at: input.occurredAt,
    actor: input.actor,
    ...(input.laneId !== undefined ? { lane_id: input.laneId } : {}),
    ...(input.taskRunId !== undefined ? { task_run_id: input.taskRunId } : {}),
    ...(input.phaseRunId !== undefined ? { phase_run_id: input.phaseRunId } : {}),
    ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
    ...(input.causationEventId !== undefined ? { causation_event_id: input.causationEventId } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.supersedesEventId !== undefined
      ? { supersedes_event_id: input.supersedesEventId }
      : {}),
  });
}

export function traceLedgerPath(): string {
  return join(resolveDataDir(), "trace", "events.jsonl");
}

/**
 * Appends one event as one JSONL line (0700 dir, atomic single write() -- POSIX append
 * mode with a payload well under PIPE_BUF is atomic for a single writer; this ledger is
 * not designed for concurrent multi-process writers). M0 spec §1 -- event_id is
 * deterministic, so a duplicate append (e.g. a retried command) is harmless: a reader
 * dedups by event_id, and this function deliberately does NOT scan the existing ledger
 * before appending (an O(n) read-before-every-write would not scale, and is unnecessary
 * when the identity itself already makes re-appends inert to any reader).
 */
export function appendTraceEvent(event: TraceEvent): void {
  const path = traceLedgerPath();
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort; non-POSIX filesystems may not support chmod
  }
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/** Reads every line of the trace ledger, parsed and schema-validated. Empty if none yet. */
export function readTraceEvents(): TraceEvent[] {
  const path = traceLedgerPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => TraceEventSchema.parse(JSON.parse(line)));
}
