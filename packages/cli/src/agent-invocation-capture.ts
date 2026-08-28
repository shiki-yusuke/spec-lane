import type { AttributionCaptureStatus } from "@lane/schemas";

// cohort-3 measurement fix (2026-08-29) -- `lane work run`'s wrapper spawns the caller's
// exact claude/codex argv, and this is the one place that argv is ever inspected to learn
// what model/reasoning-effort the caller actually requested. Pure and synchronous (no
// spawning, no I/O) on purpose: called both by work.ts right before spawning, and directly
// by this module's own unit tests.
//
// Recognized "canonical" flag forms only -- see AttributionCaptureStatusSchema's doc
// comment in packages/schemas/src/attribution.ts for what each capture_status means and
// why a wrong guess is worse than a null:
//   - claude: `--model <v>` / `--effort <v>` (two tokens each).
//   - codex:  `--model <v>` (two tokens) / `-c model_reasoning_effort=<v>` (one token after
//     `-c`, value optionally wrapped in double quotes -- a shell can strip or preserve them
//     depending on how the caller quoted it, so both `-c model_reasoning_effort=high` and
//     `-c model_reasoning_effort="high"` are accepted).
// Never throws and never blocks the command: an unrecognized/non-canonical spelling (an
// alias like `-m`, or a combined `--model=<v>` token) is reported via capture_status
// instead -- lane wraps an arbitrary agent invocation, it does not get to reject it for
// spelling its own flags differently than this extractor expects.
//
// sol review (2026-08-29, must 4): only tokens *before* a literal `--` are ever scanned --
// matching wrapper-bind.ts's own `injectFlagBeforeDoubleDash` convention that a bare `--`
// ends flag parsing for the wrapped command's own CLI, so anything after it is a positional
// argument (e.g. a prompt string), never a flag this extractor should interpret.

interface FieldCapture {
  value: string | null;
  status: AttributionCaptureStatus;
}

/** Everything up to (not including) the first literal `--`, or the whole argv if there is
 * none -- see the module comment above for why. */
function flagPortion(argv: readonly string[]): readonly string[] {
  const dashIndex = argv.indexOf("--");
  return dashIndex === -1 ? argv : argv.slice(0, dashIndex);
}

/** A canonical two-token flag (`flag value`), e.g. `--model opus`. A value is only
 * accepted if the following token doesn't itself look like another flag (starts with
 * `-`) -- that case is treated as "the flag was given with no value" (ambiguous), not as
 * a value that happens to start with a dash. */
function extractCanonicalTwoTokenFlag(argv: readonly string[], flag: string): FieldCapture {
  const values: Array<string | undefined> = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const next = argv[i + 1];
    values.push(next !== undefined && !next.startsWith("-") ? next : undefined);
  }
  if (values.length === 0) return { value: null, status: "absent" };
  if (values.length > 1) return { value: null, status: "ambiguous" };
  const only = values[0];
  return only === undefined
    ? { value: null, status: "ambiguous" }
    : { value: only, status: "captured" };
}

/** Non-canonical spellings of a `--flag`/`--flag=<v>` style option: a short alias (e.g.
 * `-m`) or the combined single-token form (`--flag=<v>`). */
function hasNonCanonicalSpelling(
  argv: readonly string[],
  canonicalFlag: string,
  aliases: readonly string[],
): boolean {
  const combinedPrefix = `${canonicalFlag}=`;
  return argv.some((a) => a.startsWith(combinedPrefix) || aliases.includes(a));
}

/** Combines a canonical-flag result with whether a non-canonical spelling of the *same*
 * logical flag is also present in the same argv:
 *   - canonical ambiguous (duplicated / no value): stays ambiguous regardless -- already
 *     the worst outcome, a co-occurring alias changes nothing.
 *   - canonical captured + alias/combined form ALSO present (sol review must 4): the two
 *     spellings might agree or might conflict (whichever the real CLI honors -- last-wins,
 *     first-wins, or an outright rejection -- isn't something this extractor can know
 *     without replicating that CLI's own parser), so the canonical value is *not* asserted
 *     -- downgraded to ambiguous rather than risking misattribution.
 *   - canonical absent + alias/combined present: unsupported_syntax (a non-canonical
 *     spelling was used, and only that spelling).
 *   - canonical absent + no alias either: absent.
 */
function resolveWithNonCanonicalCheck(canonical: FieldCapture, hasAlias: boolean): FieldCapture {
  if (canonical.status === "ambiguous") return canonical;
  if (canonical.status === "captured") {
    return hasAlias ? { value: null, status: "ambiguous" } : canonical;
  }
  // canonical.status === "absent"
  return hasAlias ? { value: null, status: "unsupported_syntax" } : canonical;
}

function extractModelFlag(argv: readonly string[]): FieldCapture {
  const canonical = extractCanonicalTwoTokenFlag(argv, "--model");
  const hasAlias = hasNonCanonicalSpelling(argv, "--model", ["-m"]);
  return resolveWithNonCanonicalCheck(canonical, hasAlias);
}

function extractClaudeEffortFlag(argv: readonly string[]): FieldCapture {
  const canonical = extractCanonicalTwoTokenFlag(argv, "--effort");
  const hasAlias = hasNonCanonicalSpelling(argv, "--effort", ["-e"]);
  return resolveWithNonCanonicalCheck(canonical, hasAlias);
}

/** Codex's canonical effort form is `-c model_reasoning_effort=<v>` -- a single token
 * after `-c` holding `key=value`, value optionally double-quoted. A bare `--effort <v>`
 * (claude's own canonical spelling), `--effort=<v>`, or a malformed `-c
 * model_reasoning_effort` with no `=value` at all are all non-canonical for codex. */
function extractCodexEffortFlag(argv: readonly string[]): FieldCapture {
  const values: Array<string | undefined> = [];
  let sawNonCanonicalKeyNoValue = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-c") continue;
    const raw = argv[i + 1];
    if (raw === undefined) continue;
    const eqIdx = raw.indexOf("=");
    if (eqIdx === -1) {
      if (raw === "model_reasoning_effort") sawNonCanonicalKeyNoValue = true;
      continue;
    }
    const key = raw.slice(0, eqIdx);
    if (key !== "model_reasoning_effort") continue;
    const rawValue = raw.slice(eqIdx + 1);
    const unquoted =
      rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;
    values.push(unquoted.length > 0 ? unquoted : undefined);
  }
  const hasAlias =
    sawNonCanonicalKeyNoValue || argv.some((a) => a === "--effort" || a.startsWith("--effort="));

  let canonical: FieldCapture;
  if (values.length === 0) {
    canonical = { value: null, status: "absent" };
  } else if (values.length > 1) {
    canonical = { value: null, status: "ambiguous" };
  } else {
    const only = values[0];
    canonical =
      only === undefined
        ? { value: null, status: "ambiguous" }
        : { value: only, status: "captured" };
  }
  return resolveWithNonCanonicalCheck(canonical, hasAlias);
}

// sol review (2026-08-29, should 1): aggregate truth table (fixed here, exercised
// exhaustively by agent-invocation-capture.test.ts) --
//
//   model \ effort | captured        | absent  | unsupported_syntax | ambiguous
//   ----------------+-----------------+---------+---------------------+-----------
//   captured        | captured        | absent  | unsupported_syntax  | ambiguous
//   absent          | absent          | absent  | unsupported_syntax  | ambiguous
//   unsupported_syn | unsupported_syn | uns_syn | unsupported_syntax  | ambiguous
//   ambiguous       | ambiguous       | ambig.  | ambiguous           | ambiguous
//
// i.e. any ambiguous wins outright; else any unsupported_syntax wins; else "captured" only
// when BOTH fields captured; every other combination (including one captured + one absent)
// is "absent" -- capture_status is a record-level summary, not a per-field flag, and
// "captured" is reserved for the case both requested_model/requested_reasoning_effort are
// actually populated (see BindingRecordV2's own captured<=>both-non-null invariant in
// packages/schemas/src/attribution.ts).
function combineCaptureStatus(model: FieldCapture, effort: FieldCapture): AttributionCaptureStatus {
  if (model.status === "ambiguous" || effort.status === "ambiguous") return "ambiguous";
  if (model.status === "unsupported_syntax" || effort.status === "unsupported_syntax") {
    return "unsupported_syntax";
  }
  if (model.status === "captured" && effort.status === "captured") return "captured";
  return "absent";
}

export interface AgentInvocationCapture {
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  captureStatus: AttributionCaptureStatus;
  /** Non-null only when captureStatus is "ambiguous" -- callers should surface this to
   * stderr (never block on it: an ambiguous capture is a measurement gap, not a reason to
   * refuse running the wrapped agent). */
  warning: string | null;
}

/**
 * Extracts the requested model/reasoning-effort from the exact argv `lane work run` is
 * about to spawn. `argv` must be the wrapped command's own arguments (not including the
 * program name itself, e.g. `agentCmd.slice(1)`) -- lane's own injected flags
 * (`--session-id`, `--json`) are irrelevant to this extraction either way. Only the
 * portion of `argv` before a literal `--` is ever scanned (see flagPortion above).
 */
export function extractAgentInvocationCapture(
  agent: "claude" | "codex",
  argv: readonly string[],
): AgentInvocationCapture {
  const flags = flagPortion(argv);
  const model = extractModelFlag(flags);
  const effort =
    agent === "claude" ? extractClaudeEffortFlag(flags) : extractCodexEffortFlag(flags);
  const captureStatus = combineCaptureStatus(model, effort);
  const warning =
    captureStatus === "ambiguous"
      ? `AMBIGUOUS_MODEL_EFFORT_CAPTURE: could not reliably determine the requested model/reasoning-effort for this ${agent} invocation (a flag was duplicated, given with no value, or given in both a canonical and a non-canonical spelling at once) -- recording requested_model/requested_reasoning_effort as null rather than guessing`
      : null;
  return {
    requestedModel: model.status === "captured" ? model.value : null,
    requestedReasoningEffort: effort.status === "captured" ? effort.value : null,
    captureStatus,
    warning,
  };
}
