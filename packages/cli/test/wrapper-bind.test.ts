import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("rejects if the leading line is not a thread.started event", async () => {
    const bin = writeFakeBinary("codex", '#!/bin/sh\necho \'{"type":"other"}\'\nexit 0\n');
    await expect(runWrapperBind(bin, ["exec"], { cwd: workDir })).rejects.toThrow(
      /not a thread\.started event/,
    );
  });
});

describe("runWrapperBind (unsupported command)", () => {
  it("rejects with WrapperUnsupportedCommandError for anything other than claude/codex", async () => {
    await expect(runWrapperBind("bash", ["-c", "true"])).rejects.toThrow(
      WrapperUnsupportedCommandError,
    );
  });
});
