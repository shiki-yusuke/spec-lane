import { describe, expect, it } from "vitest";
import { extractAgentInvocationCapture } from "../src/agent-invocation-capture.js";

// cohort-3 measurement fix (2026-08-29) -- unit coverage for the argv -> requested
// model/reasoning-effort extraction, independent of `lane work run` itself (see
// work.test.ts for the end-to-end coverage of how this plugs into session_bound's
// payload and the derived v2 binding-record).

describe("extractAgentInvocationCapture (claude)", () => {
  it("captures both --model and --effort in canonical two-token form", () => {
    const result = extractAgentInvocationCapture("claude", [
      "-p",
      "hi",
      "--model",
      "claude-sonnet-5",
      "--effort",
      "high",
    ]);
    expect(result).toMatchObject({
      requestedModel: "claude-sonnet-5",
      requestedReasoningEffort: "high",
      captureStatus: "captured",
      warning: null,
    });
  });

  it("is absent when neither flag is given", () => {
    const result = extractAgentInvocationCapture("claude", ["-p", "hi"]);
    expect(result).toMatchObject({
      requestedModel: null,
      requestedReasoningEffort: null,
      captureStatus: "absent",
      warning: null,
    });
  });

  it("is absent for model, captured for effort, when only --effort is given (overall absent, not captured)", () => {
    const result = extractAgentInvocationCapture("claude", ["--effort", "high"]);
    expect(result.requestedModel).toBeNull();
    expect(result.requestedReasoningEffort).toBe("high");
    expect(result.captureStatus).toBe("absent");
  });

  it("is ambiguous (not a guess) when --model is duplicated", () => {
    const result = extractAgentInvocationCapture("claude", [
      "--model",
      "opus",
      "--model",
      "sonnet",
    ]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
    expect(result.warning).toMatch(/AMBIGUOUS_MODEL_EFFORT_CAPTURE/);
  });

  it("is ambiguous when --model is given with no following value (next token is another flag)", () => {
    const result = extractAgentInvocationCapture("claude", ["--model", "--effort", "high"]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
  });

  it("is ambiguous when --model is the last token with no value at all", () => {
    const result = extractAgentInvocationCapture("claude", ["--model"]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
  });

  it("is unsupported_syntax for the combined --model=<v> form", () => {
    const result = extractAgentInvocationCapture("claude", ["--model=opus"]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("unsupported_syntax");
  });

  it("is unsupported_syntax for the -m alias", () => {
    const result = extractAgentInvocationCapture("claude", ["-m", "opus"]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("unsupported_syntax");
  });

  it("is unsupported_syntax for the -e effort alias", () => {
    const result = extractAgentInvocationCapture("claude", ["-e", "high"]);
    expect(result.requestedReasoningEffort).toBeNull();
    expect(result.captureStatus).toBe("unsupported_syntax");
  });

  it("does not confuse the command's own positional args for flag values", () => {
    const result = extractAgentInvocationCapture("claude", ["-p", "explain --model to me"]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("absent");
  });
});

describe("extractAgentInvocationCapture (codex)", () => {
  it("captures --model and -c model_reasoning_effort=<v> with an unquoted value", () => {
    const result = extractAgentInvocationCapture("codex", [
      "exec",
      "--model",
      "gpt-5.6-terra",
      "-c",
      "model_reasoning_effort=high",
    ]);
    expect(result).toMatchObject({
      requestedModel: "gpt-5.6-terra",
      requestedReasoningEffort: "high",
      captureStatus: "captured",
    });
  });

  it("captures -c model_reasoning_effort=<v> with a double-quoted value (quotes stripped)", () => {
    const result = extractAgentInvocationCapture("codex", [
      "exec",
      "-c",
      'model_reasoning_effort="high"',
    ]);
    expect(result.requestedReasoningEffort).toBe("high");
  });

  it("is absent when neither flag is given", () => {
    const result = extractAgentInvocationCapture("codex", ["exec"]);
    expect(result).toMatchObject({
      requestedModel: null,
      requestedReasoningEffort: null,
      captureStatus: "absent",
    });
  });

  it("is ambiguous when -c model_reasoning_effort= is duplicated with different values", () => {
    const result = extractAgentInvocationCapture("codex", [
      "-c",
      "model_reasoning_effort=high",
      "-c",
      "model_reasoning_effort=low",
    ]);
    expect(result.requestedReasoningEffort).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
  });

  it("is ambiguous when -c model_reasoning_effort= has an empty value", () => {
    const result = extractAgentInvocationCapture("codex", ["-c", "model_reasoning_effort="]);
    expect(result.requestedReasoningEffort).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
  });

  it("is unsupported_syntax for -c model_reasoning_effort with no =value at all", () => {
    const result = extractAgentInvocationCapture("codex", ["-c", "model_reasoning_effort"]);
    expect(result.requestedReasoningEffort).toBeNull();
    expect(result.captureStatus).toBe("unsupported_syntax");
  });

  it("is unsupported_syntax for claude's --effort spelling passed to codex", () => {
    const result = extractAgentInvocationCapture("codex", ["--effort", "high"]);
    expect(result.requestedReasoningEffort).toBeNull();
    expect(result.captureStatus).toBe("unsupported_syntax");
  });

  it("never throws and never signals rejection for a completely unrecognized invocation shape", () => {
    expect(() =>
      extractAgentInvocationCapture("codex", ["--totally-unknown-flag", "value"]),
    ).not.toThrow();
  });
});

// sol review (2026-08-29, must 4): a canonical flag and a non-canonical spelling of the
// *same* logical flag both present in the same argv must never let the canonical value
// win by default -- which one the real CLI actually honors isn't knowable here.
describe("extractAgentInvocationCapture (mixed canonical + non-canonical spellings, must 4)", () => {
  it("claude: --model AND -m both present is ambiguous, not the canonical value", () => {
    const result = extractAgentInvocationCapture("claude", ["--model", "opus", "-m", "sonnet"]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
  });

  it("claude: --model AND --model=<v> both present is ambiguous", () => {
    const result = extractAgentInvocationCapture("claude", ["--model", "opus", "--model=sonnet"]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
  });

  it("claude: --effort AND -e both present is ambiguous", () => {
    const result = extractAgentInvocationCapture("claude", ["--effort", "high", "-e", "low"]);
    expect(result.requestedReasoningEffort).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
  });

  it("codex: -c model_reasoning_effort=<v> AND --effort both present is ambiguous", () => {
    const result = extractAgentInvocationCapture("codex", [
      "-c",
      "model_reasoning_effort=high",
      "--effort",
      "low",
    ]);
    expect(result.requestedReasoningEffort).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
  });

  it("codex: --model AND -m both present is ambiguous", () => {
    const result = extractAgentInvocationCapture("codex", ["--model", "gpt-5.6-terra", "-m", "x"]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("ambiguous");
  });
});

// sol review (2026-08-29, must 4): matches wrapper-bind.ts's own convention that a literal
// `--` ends flag parsing for the wrapped command -- anything after it is a positional
// argument (e.g. a prompt) and must never be scanned for flags.
describe("extractAgentInvocationCapture (literal -- terminates flag scanning, must 4)", () => {
  it("claude: --model after a literal -- is a positional arg, not a flag (absent)", () => {
    const result = extractAgentInvocationCapture("claude", ["-p", "--", "--model", "opus"]);
    expect(result.requestedModel).toBeNull();
    expect(result.captureStatus).toBe("absent");
  });

  it("claude: a real --model before -- is still captured, ignoring what follows --", () => {
    const result = extractAgentInvocationCapture("claude", [
      "--model",
      "opus",
      "--effort",
      "high",
      "--",
      "--model",
      "sonnet",
      "-e",
      "low",
    ]);
    expect(result).toMatchObject({
      requestedModel: "opus",
      requestedReasoningEffort: "high",
      captureStatus: "captured",
    });
  });

  it("codex: -c model_reasoning_effort=<v> after -- is ignored (absent)", () => {
    const result = extractAgentInvocationCapture("codex", [
      "exec",
      "--",
      "-c",
      "model_reasoning_effort=high",
    ]);
    expect(result.requestedReasoningEffort).toBeNull();
    expect(result.captureStatus).toBe("absent");
  });
});

// sol review (2026-08-29, should 1): the aggregate capture_status truth table fixed in
// agent-invocation-capture.ts's combineCaptureStatus doc comment, exercised exhaustively.
// Exploits the fact that each per-field status can be produced independently for model vs.
// effort by choosing an appropriate claude argv for every one of the 16 combinations.
describe("extractAgentInvocationCapture (aggregate capture_status truth table, should 1)", () => {
  function argvFor(
    flag: "--model" | "--effort",
    status: "captured" | "absent" | "unsupported_syntax" | "ambiguous",
  ): string[] {
    if (status === "captured") return [flag, "opus"];
    if (status === "absent") return [];
    if (status === "unsupported_syntax") return [`${flag}=opus`];
    return [flag, "opus", flag, "sonnet"]; // ambiguous: duplicated canonical flag
  }

  const STATUSES = ["captured", "absent", "unsupported_syntax", "ambiguous"] as const;
  const EXPECTED: Record<(typeof STATUSES)[number], Record<(typeof STATUSES)[number], string>> = {
    captured: {
      captured: "captured",
      absent: "absent",
      unsupported_syntax: "unsupported_syntax",
      ambiguous: "ambiguous",
    },
    absent: {
      captured: "absent",
      absent: "absent",
      unsupported_syntax: "unsupported_syntax",
      ambiguous: "ambiguous",
    },
    unsupported_syntax: {
      captured: "unsupported_syntax",
      absent: "unsupported_syntax",
      unsupported_syntax: "unsupported_syntax",
      ambiguous: "ambiguous",
    },
    ambiguous: {
      captured: "ambiguous",
      absent: "ambiguous",
      unsupported_syntax: "ambiguous",
      ambiguous: "ambiguous",
    },
  };

  for (const modelStatus of STATUSES) {
    for (const effortStatus of STATUSES) {
      it(`model=${modelStatus} x effort=${effortStatus} -> ${EXPECTED[modelStatus][effortStatus]}`, () => {
        const argv = [...argvFor("--model", modelStatus), ...argvFor("--effort", effortStatus)];
        const result = extractAgentInvocationCapture("claude", argv);
        expect(result.captureStatus).toBe(EXPECTED[modelStatus][effortStatus]);
      });
    }
  }
});
