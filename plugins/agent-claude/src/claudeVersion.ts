// The local Claude Code against the Agent SDK the plugin bundles. Each SDK
// release is "at parity with" one Claude Code release (its package.json's
// claudeCodeVersion, pinned in binaries.json by scripts/pin-binaries.ts),
// and drives the `claude` it spawns with that release's options and
// messages. A `claude` on PATH older than that may not know them, so the
// plugin asks it for its version when it is activated and whenever
// Settings → Claude reads how Claude signs in, and Settings says to update
// it. The binary the plugin fetches is the SDK's own, so it always matches.

import { execFile } from "node:child_process";
import { getLogger } from "@specdriven/host";
import type { RunResult } from "@specdriven/host";
import { BINARY_PINS, installedBinary } from "./binary";
import { claudeExecutable } from "./cli";

/** The Claude Code release the bundled Agent SDK is at parity with. */
export const SDK_CLAUDE_CODE_VERSION: string = BINARY_PINS.claudeCodeVersion;

/** How long one `claude --version` answer stands: a `claude update` in a
    terminal shows up within it. */
export const VERSION_TTL_MS = 5 * 60_000;

const VERSION_TIMEOUT_MS = 10_000;

export type VersionRunner = (cmd: string, args: string[]) => Promise<RunResult>;

/** `claude --version`, stopped after VERSION_TIMEOUT_MS. Node's execFile
    rather than the app's run, which takes no time limit in the oldest app
    the plugin runs in. A spawn failure resolves as exit 1. */
const runVersion: VersionRunner = (cmd, args) =>
  new Promise((done) => {
    execFile(cmd, args, { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      done({ exitCode, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface ClaudeCodeVersion {
  /** The local Claude Code's version; null when there is none or it did not say. */
  version: string | null;
  /** The Claude Code release the bundled Agent SDK is at parity with. */
  sdkVersion: string;
  /**
   * match / newer: fine. older: the local Claude Code is behind the SDK —
   * update it. missing: no Claude Code yet. unknown: it did not say.
   */
  status: "match" | "older" | "newer" | "missing" | "unknown";
  /** Which Claude Code answered: the `claude` on PATH or the binary the plugin fetched. */
  source: "path" | "fetched" | null;
}

/** The first x.y.z in `claude --version`'s answer ("2.1.331 (Claude Code)"). */
export function parseClaudeVersion(stdout: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1] ?? null;
}

/** Numeric x.y.z order: negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function versionStatus(local: string | null, sdk: string = SDK_CLAUDE_CODE_VERSION): ClaudeCodeVersion["status"] {
  if (!local) return "unknown";
  const d = compareVersions(local, sdk);
  return d < 0 ? "older" : d > 0 ? "newer" : "match";
}

const log = getLogger("agent-claude");

let cached: { executable: string; at: number; answer: ClaudeCodeVersion } | null = null;

/** Drop the kept answer: the next check asks Claude Code again. */
export function forgetClaudeVersion(): void {
  cached = null;
}

/**
 * The local Claude Code's version against the SDK's, asked of the Claude
 * Code the plugin would run (src/cli.ts) and kept a while per executable.
 * Never throws: a Claude Code that cannot answer is "unknown".
 */
export async function claudeCodeVersion(runner: VersionRunner = runVersion, now: number = Date.now()): Promise<ClaudeCodeVersion> {
  const executable = claudeExecutable();
  if (!executable) return { version: null, sdkVersion: SDK_CLAUDE_CODE_VERSION, status: "missing", source: null };
  if (cached && cached.executable === executable && now - cached.at < VERSION_TTL_MS) return cached.answer;
  const source = executable === installedBinary() ? "fetched" : "path";
  let version: string | null = null;
  try {
    const result = await runner(executable, ["--version"]);
    version = result.exitCode === 0 ? parseClaudeVersion(result.stdout) : null;
    if (!version) log.warn("claude --version gave no version", { executable, exit: result.exitCode, stderr: result.stderr.trim().slice(-300) });
  } catch (e) {
    log.warn("claude --version failed", { executable, error: (e as Error).message });
  }
  const answer: ClaudeCodeVersion = { version, sdkVersion: SDK_CLAUDE_CODE_VERSION, status: versionStatus(version), source };
  cached = { executable, at: now, answer };
  return answer;
}
