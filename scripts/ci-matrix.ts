// The CI matrix: every plugin this index lists from this repository,
// checked against three app refs —
//
//   floor    v<minAppVersion>, the oldest app the plugin says it runs in
//   release  the newest app release, what most users have
//   main     the app's main, so a change there that breaks a plugin shows
//            up before it ships
//
//   bun scripts/ci-matrix.ts
//
// Prints `{"include":[{plugin, dir, kind, appRef}, …]}`, and writes it as
// `matrix=` (and the release tag as `release=`) to $GITHUB_OUTPUT when that
// is set.

import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const APP_REPO = "https://github.com/SpecDriven/specdriven-app";
const root = resolve(import.meta.dir, "..");

const versionParts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
function compareVersions(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const tags = (await $`git ls-remote --tags --refs ${APP_REPO}`.text())
  .split("\n")
  .map((line) => line.split("refs/tags/")[1])
  .filter((t): t is string => !!t && /^v\d+\.\d+\.\d+$/.test(t));
const release = tags.sort(compareVersions).at(-1);
if (!release) throw new Error(`no release tags at ${APP_REPO}`);

const index = await Bun.file(join(root, "marketplace.json")).json();
const include: { plugin: string; dir: string; kind: string; appRef: string }[] = [];
for (const row of index.plugins as { name: string; source: string }[]) {
  if (!row.source.startsWith("./")) continue; // a git source is tested in its own repository
  const dir = row.source.slice(2);
  const pkg = await Bun.file(join(root, dir, "package.json")).json();
  const min: string | undefined = pkg.specdriven?.minAppVersion;
  const floor = min ? `v${min}` : undefined;
  if (floor && !tags.includes(floor)) {
    throw new Error(`${row.name} needs SpecDriven ${min}, which is not a release (newest is ${release})`);
  }
  if (floor && floor !== release) include.push({ plugin: row.name, dir, kind: "floor", appRef: floor });
  include.push({ plugin: row.name, dir, kind: "release", appRef: release });
  include.push({ plugin: row.name, dir, kind: "main", appRef: "main" });
}

const matrix = JSON.stringify({ include });
console.log(matrix);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\nrelease=${release}\n`);
