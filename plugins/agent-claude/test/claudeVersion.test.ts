// The local Claude Code against the Agent SDK the plugin bundles
// (src/claudeVersion.ts): the SDK's Claude Code release is pinned with its
// binaries, `claude --version` is read and compared with it, the answer is
// kept a while, and Settings → Claude tells an older Claude Code to update.

import { afterEach, expect, test } from "bun:test";
import pkg from "../package.json";
import { BINARY_PINS } from "../src/binary";
import {
  SDK_CLAUDE_CODE_VERSION,
  VERSION_TTL_MS,
  claudeCodeVersion,
  compareVersions,
  forgetClaudeVersion,
  parseClaudeVersion,
  versionStatus,
  type VersionRunner,
} from "../src/claudeVersion";
import { setClaudeAvailability } from "../src/cli";
import { claudeCodeVersionAdvice } from "../src/ui/ClaudeSettings";

afterEach(() => {
  setClaudeAvailability(null);
  forgetClaudeVersion();
});

/** A runner that answers `--version` with this stdout, counting its calls. */
function answering(stdout: string, exitCode = 0): VersionRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { exitCode, stdout, stderr: "" };
  }) as VersionRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

test("the SDK's Claude Code release is pinned with its binaries", () => {
  expect(BINARY_PINS.version).toBe(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]);
  expect(SDK_CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("claude --version is read for its x.y.z", () => {
  expect(parseClaudeVersion("2.1.331 (Claude Code)\n")).toBe("2.1.331");
  expect(parseClaudeVersion("claude 10.0.2")).toBe("10.0.2");
  expect(parseClaudeVersion("no version here")).toBeNull();
});

test("versions compare by number, not by text", () => {
  expect(compareVersions("2.1.99", "2.1.331")).toBeLessThan(0);
  expect(compareVersions("2.2.0", "2.1.331")).toBeGreaterThan(0);
  expect(compareVersions("2.1.331", "2.1.331")).toBe(0);
  expect(versionStatus("2.1.300", "2.1.331")).toBe("older");
  expect(versionStatus("2.1.331", "2.1.331")).toBe("match");
  expect(versionStatus("2.1.400", "2.1.331")).toBe("newer");
  expect(versionStatus(null, "2.1.331")).toBe("unknown");
});

test("an older claude on PATH is reported as older", async () => {
  setClaudeAvailability(() => true);
  const runner = answering("2.1.1 (Claude Code)\n");
  const v = await claudeCodeVersion(runner);
  expect(v).toEqual({ version: "2.1.1", sdkVersion: SDK_CLAUDE_CODE_VERSION, status: "older", source: "path" });
  expect(runner.calls).toEqual([["claude", "--version"]]);
});

test("no Claude Code is missing, and nothing is run", async () => {
  setClaudeAvailability(() => false);
  const runner = answering("2.1.1");
  expect((await claudeCodeVersion(runner)).status).toBe("missing");
  expect(runner.calls).toEqual([]);
});

test("a Claude Code that fails or does not say is unknown, never an error", async () => {
  setClaudeAvailability(() => true);
  expect((await claudeCodeVersion(answering("", 1))).status).toBe("unknown");
  forgetClaudeVersion();
  const throwing: VersionRunner = async () => {
    throw new Error("spawn ENOENT");
  };
  expect((await claudeCodeVersion(throwing)).status).toBe("unknown");
});

test("the answer is kept a while, then asked again", async () => {
  setClaudeAvailability(() => true);
  const runner = answering(`${SDK_CLAUDE_CODE_VERSION} (Claude Code)`);
  const t0 = 1_000_000;
  expect((await claudeCodeVersion(runner, t0)).status).toBe("match");
  await claudeCodeVersion(runner, t0 + VERSION_TTL_MS - 1);
  expect(runner.calls.length).toBe(1);
  await claudeCodeVersion(runner, t0 + VERSION_TTL_MS);
  expect(runner.calls.length).toBe(2);
  forgetClaudeVersion();
  await claudeCodeVersion(runner, t0 + VERSION_TTL_MS + 1);
  expect(runner.calls.length).toBe(3);
});

test("Settings says to update only an older Claude Code", () => {
  const base = { sdkVersion: "2.1.331", source: "path" as const };
  expect(claudeCodeVersionAdvice({ ...base, version: "2.1.300", status: "older" })).toContain("claude update");
  expect(claudeCodeVersionAdvice({ ...base, version: "2.1.300", status: "older" })).toContain("2.1.331");
  expect(claudeCodeVersionAdvice({ ...base, version: "2.1.331", status: "match" })).toBeNull();
  expect(claudeCodeVersionAdvice({ ...base, version: "2.1.400", status: "newer" })).toBeNull();
  expect(claudeCodeVersionAdvice({ ...base, version: null, status: "unknown" })).toBeNull();
  expect(claudeCodeVersionAdvice(undefined)).toBeNull();
});
