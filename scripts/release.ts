// Release the version a plugin's package.json names: build it, add its zip
// and its row to the plugin's release folder, and put the version on the
// plugin's row in marketplace.json.
//
//   bun scripts/release.ts plugins/<name> [--notes <text>] [--keep <n>]
//
// The work is the app's own `specdriven plugin release` (../specdriven-app,
// or SPECDRIVEN_APP), which rebuilds dist/, writes
// release/<id>-<version>.zip — package.json, dist/ without its source maps,
// the README — and lists it in release/releases.json with its checksum,
// keeping the newest ten versions. A version that is in the folder already
// is refused: a release is never written again, so raise "version" first.
//
// Commit dist/, release/ and marketplace.json together. Merging them to
// `main` is what publishes the version.

import { join, relative, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const app = resolve(process.env.SPECDRIVEN_APP ?? join(root, "..", "specdriven-app"));
const [arg, ...options] = process.argv.slice(2);
if (!arg || arg.startsWith("--")) {
  console.error("usage: bun scripts/release.ts plugins/<name> [--notes <text>] [--keep <n>]");
  process.exit(2);
}
const dir = resolve(root, arg);
const source = `./${relative(root, dir).split("\\").join("/")}`;

const indexFile = join(root, "marketplace.json");
const index = await Bun.file(indexFile).json();
const row = (index.plugins as { name: string; source: string; version?: string }[]).find(
  (p) => p.source.replace(/\/+$/, "") === source,
);
if (!row) {
  console.error(`${source} is not listed in marketplace.json: add its row first.`);
  process.exit(1);
}

const released = await $`bun ${join(app, "src/index.ts")} plugin release ${dir} ${options}`.nothrow();
if (released.exitCode !== 0) process.exit(released.exitCode);

const version: string = (await Bun.file(join(dir, "package.json")).json()).version;
if (row.version !== version) {
  row.version = version;
  await Bun.write(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`marketplace.json: ${row.name} is at ${version}`);
}
console.log(`Commit ${arg}/dist, ${arg}/release and marketplace.json together.`);
