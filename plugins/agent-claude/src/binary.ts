// Claude Code without the `claude` command (specs/agents/claude.feature.md
// "Sign in to Claude without Claude Code installed", in the specs repo): the
// Agent SDK publishes Claude Code's native binary as one npm package per
// platform, which the SDK finds next to itself only when npm installed them.
// A marketplace install copies the plugin's folder — dist/, no node_modules
// — and the host bundle carries nothing native (bunfig.toml), so the first
// email sign-in fetches this platform's package from the npm registry,
// checks it against the integrity pinned in binaries.json (scripts/
// pin-binaries.ts), and keeps the binary under
// ~/.specdriven/claude-code/<version>/<platform>/. A `claude` on PATH still
// comes first (src/cli.ts).
//
// Node APIs only — this module also runs under Electron.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import pins from "./binaries.json";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** The SDK's per-platform packages: `${SDK_PACKAGE}-<platform>`. */
export const BINARY_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "win32-x64",
  "win32-arm64",
] as const;

export const REGISTRY = "https://registry.npmjs.org";

/** The SDK version the pins are for, and each platform's npm integrity. */
export const BINARY_PINS: { version: string; packages: Record<string, string> } = pins;

/** A Linux whose libc is musl, the way the SDK tells (no glibc in the report). */
function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

/** This machine's package suffix, as the SDK names it; null where none is published. */
export function binaryPlatform(platform: string = process.platform, arch: string = process.arch, musl = isMusl()): string | null {
  const key = platform === "linux" && musl ? `linux-${arch}-musl` : `${platform}-${arch}`;
  return (BINARY_PLATFORMS as readonly string[]).includes(key) ? key : null;
}

/** Where a platform's binary is kept; null where there is none to fetch. */
export function binaryPath(platform: string | null = binaryPlatform()): string | null {
  if (!platform || !BINARY_PINS.packages[platform]) return null;
  const home = process.env.SPECDRIVEN_HOME || join(homedir(), ".specdriven");
  return join(home, "claude-code", BINARY_PINS.version, platform, platform.startsWith("win32") ? "claude.exe" : "claude");
}

/** The fetched binary, when it is there. */
export function installedBinary(): string | null {
  const path = binaryPath();
  return path && existsSync(path) ? path : null;
}

/** Whether this machine has a binary to fetch. */
export function canFetchBinary(): boolean {
  return binaryPath() !== null;
}

/** A download under way, for the Settings page. */
export interface BinaryDownload {
  receivedBytes: number;
  /** The registry's content-length; null when it sent none. */
  totalBytes: number | null;
}

let pending: Promise<string> | null = null;
let progress: BinaryDownload | null = null;

/** The download under way, or null. */
export function binaryDownload(): BinaryDownload | null {
  return progress ? { ...progress } : null;
}

export interface FetchBinaryDeps {
  fetch?: typeof fetch;
  /** Default: this machine's (binaryPlatform). */
  platform?: string | null;
}

/** Fetch, check and keep this platform's binary; one download at a time. */
export function fetchBinary(deps: FetchBinaryDeps = {}): Promise<string> {
  pending ??= download(deps).finally(() => {
    pending = null;
    progress = null;
  });
  return pending;
}

async function download(deps: FetchBinaryDeps): Promise<string> {
  const platform = deps.platform === undefined ? binaryPlatform() : deps.platform;
  const target = binaryPath(platform);
  const integrity = platform ? BINARY_PINS.packages[platform] : undefined;
  if (!platform || !target || !integrity) {
    throw new Error(`Claude Code is not published for ${process.platform}-${process.arch} — install the claude command instead`);
  }
  if (existsSync(target)) return target;
  const name = `${SDK_PACKAGE}-${platform}`;
  const url = `${REGISTRY}/${name}/-/${name.split("/")[1]}-${BINARY_PINS.version}.tgz`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url);
  } catch (e) {
    throw new Error(`Could not download Claude Code: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) throw new Error(`Could not download Claude Code: HTTP ${res.status}`);
  progress = { receivedBytes: 0, totalBytes: Number(res.headers.get("content-length")) || null };
  const hash = createHash("sha512");
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    chunks.push(value);
    progress.receivedBytes += value.byteLength;
  }
  if (`sha512-${hash.digest("base64")}` !== integrity) {
    throw new Error("The downloaded Claude Code does not match its pinned checksum, so it was not installed");
  }
  const file = tarEntry(gunzipSync(Buffer.concat(chunks)), `package/${basename(target)}`);
  if (!file) throw new Error(`The Claude Code package for ${platform} has no ${basename(target)}`);
  await mkdir(dirname(target), { recursive: true });
  // Written aside and moved in, so a half-written file is never the binary.
  const partial = `${target}.${process.pid}.partial`;
  try {
    await writeFile(partial, file, { mode: 0o755 });
    await rename(partial, target);
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  }
  return target;
}

/** One regular file's bytes out of a tar archive (ustar, GNU or pax names), or null. */
export function tarEntry(tar: Uint8Array, wanted: string): Uint8Array | null {
  const text = (from: number, length: number): string => {
    let end = from;
    while (end < from + length && tar[end] !== 0) end++;
    return Buffer.from(tar.subarray(from, end)).toString("utf8");
  };
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(tar[offset + 156] || 48);
    const prefix = text(offset + 257, 6) === "ustar" ? text(offset + 345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${text(offset, 100)}` : text(offset, 100));
    longName = null;
    const start = offset + 512;
    if (type === "L") longName = text(start, size);
    else if (type === "x") longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text(start, size))?.[1] ?? null;
    else if (type === "0" && name === wanted) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}
