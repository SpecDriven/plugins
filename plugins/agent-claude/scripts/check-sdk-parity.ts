// Checks that the Agent SDK the plugin bundles and the Claude Code it is
// built for agree everywhere they are written down:
//
//   - package.json pins @anthropic-ai/claude-agent-sdk to an exact version
//   - the installed SDK (node_modules) is that version
//   - src/binaries.json pins the binaries for it, and names the Claude Code
//     release the SDK's own package.json calls its claudeCodeVersion
//   - the SDK's GitHub release notes say "Updated to parity with Claude Code
//     v<that release>" (a release whose notes name no parity is a warning,
//     not a failure)
//
//   bun scripts/check-sdk-parity.ts [--notes-since <old SDK version>] [--notes-file <path>]
//
// With --notes-since, also writes the release notes of every SDK release
// after that version up to the pinned one, newest first, as Markdown (to
// --notes-file, or stdout) — the body of the update pull request
// (.github/workflows/agent-sdk-update.yml). With GITHUB_OUTPUT set, writes
// `sdk=` and `claude_code=` to it. GH_TOKEN or GITHUB_TOKEN, when set, is
// sent to the GitHub API to lift its rate limit.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { SDK_PACKAGE } from "../src/binary";

const SDK_REPO = "anthropics/claude-agent-sdk-typescript";
const dir = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const errors: string[] = [];
const warnings: string[] = [];

const pkg = (await Bun.file(join(dir, "package.json")).json()) as { dependencies: Record<string, string> };
const pinned = pkg.dependencies[SDK_PACKAGE];
if (!pinned || !/^\d+\.\d+\.\d+$/.test(pinned)) {
  console.error(`package.json must pin ${SDK_PACKAGE} to an exact version, not "${pinned}"`);
  process.exit(1);
}

const installedFile = Bun.file(join(dir, "node_modules", SDK_PACKAGE, "package.json"));
const installed = (await installedFile.exists())
  ? ((await installedFile.json()) as { version: string; claudeCodeVersion?: string })
  : null;
if (!installed) errors.push(`${SDK_PACKAGE} is not installed: run bun install`);
else if (installed.version !== pinned) errors.push(`installed ${SDK_PACKAGE} is ${installed.version}, package.json pins ${pinned}: run bun install`);
const claudeCode = installed?.claudeCodeVersion ?? null;
if (installed && !claudeCode) errors.push(`${SDK_PACKAGE}@${installed.version} names no claudeCodeVersion`);

const pins = (await Bun.file(join(dir, "src", "binaries.json")).json()) as { version: string; claudeCodeVersion?: string };
if (pins.version !== pinned) errors.push(`src/binaries.json pins binaries for ${pins.version}, not ${pinned}: run bun scripts/pin-binaries.ts`);
if (claudeCode && pins.claudeCodeVersion !== claudeCode) {
  errors.push(`src/binaries.json says Claude Code ${pins.claudeCodeVersion}, the SDK says ${claudeCode}: run bun scripts/pin-binaries.ts`);
}

interface Release {
  tag_name: string;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "agent-claude-sdk-check" };
if (token) headers.authorization = `Bearer ${token}`;

async function github<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The Claude Code version a release's notes say the SDK is at parity with. */
function parityOf(body: string | null): string | null {
  return /parity with Claude Code v?(\d+\.\d+\.\d+)/i.exec(body ?? "")?.[1] ?? null;
}

let parity: string | null = null;
try {
  const release = await github<Release>(`repos/${SDK_REPO}/releases/tags/v${pinned}`);
  parity = parityOf(release.body);
  if (!parity) warnings.push(`the v${pinned} release notes name no Claude Code parity (${release.html_url})`);
  else if (claudeCode && parity !== claudeCode) {
    errors.push(`the v${pinned} release notes say parity with Claude Code ${parity}, the SDK's package.json says ${claudeCode}`);
  }
} catch (e) {
  errors.push(`could not read the v${pinned} release notes: ${(e as Error).message}`);
}

const versionParts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
function compareVersions(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const since = option("--notes-since");
if (since) {
  const releases: Release[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await github<Release[]>(`repos/${SDK_REPO}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100 || batch.some((r) => compareVersions(r.tag_name, since) <= 0)) break;
  }
  const between = releases
    .filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
    .filter((r) => compareVersions(r.tag_name, since) > 0 && compareVersions(r.tag_name, pinned) <= 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const notes = between
    .map((r) => {
      const changes = (r.body ?? "").split(/^## Update\b/m)[0]!.replace(/^## What's changed\s*/m, "").trim();
      return `### [${r.tag_name}](${r.html_url})\n\n${changes || "_No notes._"}`;
    })
    .join("\n\n");
  const file = option("--notes-file");
  if (file) await Bun.write(file, `${notes}\n`);
  else console.log(notes);
}

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log(`${SDK_PACKAGE} ${pinned} is at parity with Claude Code ${claudeCode}${parity ? " (release notes agree)" : ""}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sdk=${pinned}\nclaude_code=${claudeCode}\n`);
