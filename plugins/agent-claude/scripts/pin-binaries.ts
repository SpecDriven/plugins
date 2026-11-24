// Pins the Claude Code binaries the plugin may fetch (src/binary.ts): for
// the Agent SDK version package.json names, the npm registry's integrity of
// each per-platform package, and the Claude Code version that SDK is at
// parity with (its package.json's claudeCodeVersion — what the local
// `claude` is checked against, src/claudeVersion.ts), written to
// src/binaries.json. Run it after
// bumping @anthropic-ai/claude-agent-sdk — test/binary.test.ts fails until
// the pins match the dependency.
//
//   bun scripts/pin-binaries.ts

import { join } from "node:path";
import { BINARY_PLATFORMS, SDK_PACKAGE } from "../src/binary";

const dir = join(import.meta.dir, "..");
const pkg = (await Bun.file(join(dir, "package.json")).json()) as { dependencies: Record<string, string> };
const version = pkg.dependencies[SDK_PACKAGE];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${SDK_PACKAGE} must be pinned to an exact version, not "${version}"`);

const sdkRes = await fetch(`https://registry.npmjs.org/${SDK_PACKAGE}/${version}`);
if (!sdkRes.ok) throw new Error(`${SDK_PACKAGE}@${version}: HTTP ${sdkRes.status}`);
const claudeCodeVersion = ((await sdkRes.json()) as { claudeCodeVersion?: string }).claudeCodeVersion;
if (!claudeCodeVersion || !/^\d+\.\d+\.\d+$/.test(claudeCodeVersion)) {
  throw new Error(`${SDK_PACKAGE}@${version} names no claudeCodeVersion ("${claudeCodeVersion}")`);
}
console.log(`Claude Code: ${claudeCodeVersion}`);

const packages: Record<string, string> = {};
for (const platform of BINARY_PLATFORMS) {
  const name = `${SDK_PACKAGE}-${platform}`;
  const res = await fetch(`https://registry.npmjs.org/${name}/${version}`);
  if (!res.ok) throw new Error(`${name}@${version}: HTTP ${res.status}`);
  const meta = (await res.json()) as { dist?: { integrity?: string } };
  const integrity = meta.dist?.integrity;
  if (!integrity?.startsWith("sha512-")) throw new Error(`${name}@${version} has no sha512 integrity`);
  packages[platform] = integrity;
  console.log(`${platform}: ${integrity.slice(0, 24)}…`);
}

await Bun.write(join(dir, "src", "binaries.json"), JSON.stringify({ version, claudeCodeVersion, packages }, null, 2) + "\n");
console.log(`Pinned ${BINARY_PLATFORMS.length} binaries for ${version} (Claude Code ${claudeCodeVersion})`);
