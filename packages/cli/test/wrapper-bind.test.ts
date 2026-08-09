import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WrapperBindConflictError,
  WrapperBindTimeoutError,
  WrapperUnsupportedCommandError,
  detectWrapperAgent,
  runWrapperBind,
} from "../src/wrapper-bind.js";

// M0 spec-lane 0.5.0 — exercises the wrapper-binding strategy against small fake
// claude/codex executables (execFile-compatible shell scripts) rather than the real
// binaries, matching the M0 spec's own e2e convention for the agent-cost boundary
// (§7: "モック実行ファイル（execFile 互換）で差し替え").

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "lane-wrapper-bind-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeFakeBinary(name: string, script: string): string {
  const path = join(workDir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

describe("detectWrapperAgent", () => {
  it("matches only the exact basename claude/codex", () => {
    expect(detectWrapperAgent("claude")).toBe("claude");
    expect(detectWrapperAgent("/usr/local/bin/claude")).toBe("claude");
    expect(detectWrapperAgent("codex")).toBe("codex");
    expect(detectWrapperAgent("claude-code")).toBeNull();
    expect(detectWrapperAgent("codex-cli")).toBeNull();
    expect(detectWrapperAgent("bash")).toBeNull();
  });
});

describe("runWrapperBind (claude: pre_assigned_session_id)", () => {
  it("injects --session-id and passes through the child's exit code", async () => {
    const bin = writeFakeBinary("claude", '#!/bin/sh\necho "args: $@"\nexit 0\n');
    const result = await runWrapperBind(bin, ["-p", "hello"], { cwd: workDir });
    expect(result.agent).toBe("claude");
    expect(result.bindingMethod).toBe("pre_assigned_session_id");
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(result.exitCode).resolves.toBe(0);
  });

  it("propagates a nonzero child exit code", async () => {
    const bin = writeFakeBinary("claude", "#!/bin/sh\nexit 7\n");
    const result = await runWrapperBind(bin, [], { cwd: workDir });
    await expect(result.exitCode).resolves.toBe(7);
  });

  it("rejects if the caller already passed --session-id", async () => {
    const bin = writeFakeBinary("claude", "#!/bin/sh\nexit 0\n");
    await expect(runWrapperBind(bin, ["--session-id", "manual"], { cwd: workDir })).rejects.toThrow(
      WrapperBindConflictError,
    );
  });

  it("rejects the --session-id=<value> single-token form too (gpt-5.4 review must4)", async () => {
    const bin = writeFakeBinary("claude", "#!/bin/sh\nexit 0\n");
    await expect(runWrapperBind(bin, ["--session-id=manual"], { cwd: workDir })).rejects.toThrow(
      WrapperBindConflictError,
    );
  });

  it("injects --session-id before a literal -- rather than after it (gpt-5.4 review must4)", async () => {
    const argsFile = join(workDir, "received-args.txt");
    // Writes the args it actually received to a file -- stdio is "inherit" for the
    // claude wrapper, so stdout itself isn't capturable from the test process.
    const bin = writeFakeBinary(
      "claude",
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argsFile}"\nexit 0\n`,
    );
    const result = await runWrapperBind(bin, ["-p", "--", "hello", "world"], { cwd: workDir });
    // claude's own bind resolves synchronously (no join step) -- the child process itself
    // (and its file write) only finishes some time after that, so it must be awaited
    // separately before reading the file it wrote.
    await result.exitCode;
    const received = readFileSync(argsFile, "utf-8").trim().split("\n");
    const dashDashIndex = received.indexOf("--");
    const sessionFlagIndex = received.indexOf("--session-id");
    expect(dashDashIndex).toBeGreaterThan(-1);
    expect(sessionFlagIndex).toBeGreaterThan(-1);
    // If injected after `--`, the flag would land in the wrapped command's positional
    // args instead of being recognized as an option by its own CLI parser.
    expect(sessionFlagIndex).toBeLessThan(dashDashIndex);
    expect(received[sessionFlagIndex + 1]).toBe(result.sessionId);
  });
});

describe("runWrapperBind (codex: self_reported_thread_id)", () => {
  it("parses the leading thread.started line and forwards the rest of stdout transparently", async () => {
    const bin = writeFakeBinary(
      "codex",
      [
        "#!/bin/sh",
        'echo \'{"type":"thread.started","thread_id":"th_abc123"}\'',
        'echo "some other output"',
        "exit 0",
      ].join("\n"),
    );
    const result = await runWrapperBind(bin, ["exec", "do the thing"], { cwd: workDir });
    expect(result.agent).toBe("codex");
    expect(result.bindingMethod).toBe("self_reported_thread_id");
    expect(result.sessionId).toBe("th_abc123");
    await expect(result.exitCode).resolves.toBe(0);
  });

  it("rejects (and kills the child) if no thread.started line arrives within the bind timeout", async () => {
    const bin = writeFakeBinary("codex", "#!/bin/sh\nsleep 5\n");
    await expect(
      runWrapperBind(bin, ["exec"], { cwd: workDir, bindTimeoutMs: 200 }),
    ).rejects.toThrow(WrapperBindTimeoutError);
  });

  it("rejects if the leading line is not a thread.started event, and kills the child (gpt-5.4 review must3)", async () => {
    const marker = join(workDir, "still-running-marker");
    // If the child were left running after the reject, this would eventually create the
    // marker file; asserting it never appears is how "the child was actually killed, not
    // just abandoned" gets verified without a fragile process-liveness check.
    const bin = writeFakeBinary(
      "codex",
      `#!/bin/sh\necho '{"type":"other"}'\nsleep 2 && touch "${marker}"\n`,
    );
    await expect(runWrapperBind(bin, ["exec"], { cwd: workDir })).rejects.toThrow(
      /not a thread\.started event/,
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects if the leading line is not valid JSON, and kills the child (gpt-5.4 review must3)", async () => {
    const marker = join(workDir, "still-running-marker-2");
    const bin = writeFakeBinary(
      "codex",
      `#!/bin/sh\necho 'not json'\nsleep 2 && touch "${marker}"\n`,
    );
    await expect(runWrapperBind(bin, ["exec"], { cwd: workDir })).rejects.toThrow(/not valid JSON/);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  });
});

describe("runWrapperBind (unsupported command)", () => {
  it("rejects with WrapperUnsupportedCommandError for anything other than claude/codex", async () => {
    await expect(runWrapperBind("bash", ["-c", "true"])).rejects.toThrow(
      WrapperUnsupportedCommandError,
    );
  });
});
