// Claude Code without the `claude` command (specs/agents/claude.feature.md
// "Sign in to Claude without Claude Code installed"): the pins match the SDK
// the plugin depends on, the package for this machine is named the way the
// SDK names it, a download is kept only when it matches its pin, and the
// binary comes out of the tarball into ~/.specdriven/claude-code.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import {
  BINARY_PINS,
  BINARY_PLATFORMS,
  SDK_PACKAGE,
  binaryDownload,
  binaryPath,
  binaryPlatform,
  fetchBinary,
  installedBinary,
  tarEntry,
} from "../src/binary";
import { claudeExecutable } from "../src/cli";
import { integrityOf, packageTarball, servingFetch } from "./registry";

const realHome = process.env.SPECDRIVEN_HOME;
const realPath = process.env.PATH;
let home: string;
let savedPins: Record<string, string>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-claude-binary-"));
  process.env.SPECDRIVEN_HOME = home;
  savedPins = { ...BINARY_PINS.packages };
});

afterEach(async () => {
  for (const key of Object.keys(BINARY_PINS.packages)) delete BINARY_PINS.packages[key];
  Object.assign(BINARY_PINS.packages, savedPins);
  process.env.SPECDRIVEN_HOME = realHome;
  process.env.PATH = realPath;
  await rm(home, { recursive: true, force: true });
});

test("the pins are for the SDK version package.json depends on, one per platform", () => {
  expect(BINARY_PINS.version).toBe(pkg.dependencies[SDK_PACKAGE]);
  expect(Object.keys(BINARY_PINS.packages).sort()).toEqual([...BINARY_PLATFORMS].sort());
  for (const integrity of Object.values(BINARY_PINS.packages)) expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
});

test("the package for a machine is named the way the SDK names it", () => {
  expect(binaryPlatform("darwin", "arm64", false)).toBe("darwin-arm64");
  expect(binaryPlatform("linux", "x64", false)).toBe("linux-x64");
  expect(binaryPlatform("linux", "arm64", true)).toBe("linux-arm64-musl");
  expect(binaryPlatform("win32", "x64", false)).toBe("win32-x64");
  expect(binaryPlatform("freebsd", "x64", false)).toBeNull();
  expect(binaryPlatform("linux", "ia32", false)).toBeNull();
  expect(binaryPath("win32-arm64")).toBe(join(home, "claude-code", BINARY_PINS.version, "win32-arm64", "claude.exe"));
  expect(binaryPath("linux-x64")).toBe(join(home, "claude-code", BINARY_PINS.version, "linux-x64", "claude"));
  expect(binaryPath(null)).toBeNull();
});

test("tarEntry finds a file by its ustar name, and nothing else", async () => {
  const tgz = await packageTarball("claude", "#!/bin/sh\necho hi\n");
  const tar = Bun.gunzipSync(tgz);
  expect(new TextDecoder().decode(tarEntry(tar, "package/claude")!)).toBe("#!/bin/sh\necho hi\n");
  expect(tarEntry(tar, "package/claude.exe")).toBeNull();
  expect(tarEntry(new Uint8Array(1024), "package/claude")).toBeNull();
});

test("a download that matches its pin is kept as the Claude Code to run, executable", async () => {
  const platform = binaryPlatform()!;
  const name = platform.startsWith("win32") ? "claude.exe" : "claude";
  const tgz = await packageTarball(name, "#!/bin/sh\necho stand-in\n");
  BINARY_PINS.packages[platform] = integrityOf(tgz);
  process.env.PATH = home; // no `claude` to find
  expect(installedBinary()).toBeNull();
  expect(claudeExecutable()).toBeNull();

  const urls: string[] = [];
  const pending = fetchBinary({ fetch: servingFetch(tgz, urls) });
  // One download at a time: a second ask joins the first.
  expect(fetchBinary({ fetch: servingFetch(tgz, urls) })).toBe(pending);
  const path = await pending;
  expect(urls).toEqual([
    `https://registry.npmjs.org/${SDK_PACKAGE}-${platform}/-/claude-agent-sdk-${platform}-${BINARY_PINS.version}.tgz`,
  ]);
  expect(path).toBe(binaryPath()!);
  expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho stand-in\n");
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o111).toBe(0o111);
  expect(installedBinary()).toBe(path);
  expect(claudeExecutable()).toBe(path);
  expect(binaryDownload()).toBeNull();
  // Kept: asking again fetches nothing.
  expect(await fetchBinary({ fetch: servingFetch(tgz, urls) })).toBe(path);
  expect(urls).toHaveLength(1);
});

test("a download that does not match its pin is refused and leaves nothing behind", async () => {
  const platform = binaryPlatform()!;
  const tgz = await packageTarball("claude", "#!/bin/sh\necho tampered\n");
  await expect(fetchBinary({ fetch: servingFetch(tgz) })).rejects.toThrow("does not match its pinned checksum");
  expect(existsSync(binaryPath(platform)!)).toBe(false);
  expect(installedBinary()).toBeNull();

  const failing = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
  await expect(fetchBinary({ fetch: failing })).rejects.toThrow("HTTP 404");
  await expect(fetchBinary({ fetch: servingFetch(tgz), platform: null })).rejects.toThrow("not published");
});
