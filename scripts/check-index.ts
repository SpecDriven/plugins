// Check marketplace.json against the plugins it lists, with the app's own
// parsers, so a row the app would refuse — or one that claims a version,
// api or id its package.json does not — never reaches `main`, which every
// released app reads as its default index.
//
//   bun scripts/check-index.ts
//
// The app checkout defaults to ../specdriven-app beside this repository
// (the same place the plugins' tsconfig paths point); SPECDRIVEN_APP
// names another.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const app = resolve(process.env.SPECDRIVEN_APP ?? join(root, "..", "specdriven-app"));

const { parseMarketplaceIndex, indexRowRefusal, subdirectorySource } = await import(
  join(app, "src/plugins/marketplace.ts")
);
const { parsePackageManifest } = await import(join(app, "src/plugins/manifest.ts"));
const appVersion: string = (await Bun.file(join(app, "package.json")).json()).version;

const problems: string[] = [];
const index = parseMarketplaceIndex(await Bun.file(join(root, "marketplace.json")).json());
const listed = new Set<string>();

for (const row of index.plugins) {
  const fail = (why: string) => problems.push(`${row.name}: ${why}`);
  const refusal = indexRowRefusal(row);
  if (refusal) fail(refusal);
  const sub = subdirectorySource(row.source);
  if (sub === null) continue; // a git source lives elsewhere; its own repo checks it
  listed.add(sub);
  const dir = join(root, sub);
  const pkgFile = join(dir, "package.json");
  if (!existsSync(pkgFile)) {
    fail(`${row.source} has no package.json`);
    continue;
  }
  const pkg = await Bun.file(pkgFile).json();
  let manifest;
  try {
    // Parsed as the app at this version would: a minAppVersion newer than
    // the app checked against fails here, so a row never needs an app that
    // is not out yet.
    manifest = parsePackageManifest(pkg, appVersion);
  } catch (err) {
    fail(`package.json: ${(err as Error).message}`);
    continue;
  }
  if (manifest.id !== row.name) fail(`the index names "${row.name}" but the manifest's id is "${manifest.id}"`);
  if (row.version !== undefined && row.version !== manifest.version) {
    fail(`the index claims version ${row.version} but package.json says ${manifest.version ?? "none"}`);
  }
  const api = pkg.specdriven?.api === undefined ? undefined : String(pkg.specdriven.api);
  if (row.api !== undefined && row.api !== api) fail(`the index claims api ${row.api} but the manifest says ${api}`);
  // The desktop app loads dist/ only, so each half the manifest names must be there.
  for (const half of [manifest.host, manifest.client]) {
    if (half && !existsSync(join(dir, half))) fail(`${half} is missing; run \`specdriven plugin build\``);
  }
}

const folders = readdirSync(join(root, "plugins")).filter((d) => statSync(join(root, "plugins", d)).isDirectory());
for (const d of folders) {
  if (!listed.has(`plugins/${d}`)) problems.push(`plugins/${d} is not listed in marketplace.json`);
}

if (problems.length) {
  console.error(`marketplace.json, checked against SpecDriven ${appVersion}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`marketplace.json: ${index.plugins.length} plugins OK against SpecDriven ${appVersion}`);
