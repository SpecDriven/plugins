// Check marketplace.json against the plugins it lists, with the app's own
// parsers, so a row the app would refuse — or one that claims a version,
// api or id its package.json does not — never reaches `main`, which every
// released app reads as its default index.
//
// Each plugin's release folder is checked the same way, since an app that
// reads them installs from its zips: releases.json parses, every zip it
// lists is there with the checksum and size it claims and holds the plugin
// and version its row says, nothing else is in the folder, the newest
// version is the one package.json names, and a zip that `main` already has
// is unchanged — a release is never written again.
//
//   bun scripts/check-index.ts
//
// The app checkout defaults to ../specdriven-app beside this repository
// (the same place the plugins' tsconfig paths point); SPECDRIVEN_APP
// names another. An app from before release folders installs dist/ as
// committed and has no reader for them: against it they are not checked.
// RELEASE_BASE names the ref released zips are compared with, `origin/main`
// unless it says otherwise.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const app = resolve(process.env.SPECDRIVEN_APP ?? join(root, "..", "specdriven-app"));

const market = await import(join(app, "src/plugins/marketplace.ts"));
const { parseMarketplaceIndex, indexRowRefusal, subdirectorySource } = market;
const { parsePackageManifest } = await import(join(app, "src/plugins/manifest.ts"));
const appVersion: string = (await Bun.file(join(app, "package.json")).json()).version;

// What an app that reads release folders brings: their parser and a zip reader.
const zipModule = join(app, "src/plugins/host/zip.ts");
const releases =
  typeof market.parseReleases === "function" && existsSync(zipModule)
    ? { ...(market as ReleaseApi), unzip: (await import(zipModule)).unzip as Unzip }
    : null;
type Unzip = (bytes: Uint8Array) => { path: string; data: Uint8Array }[];
interface Release {
  version: string;
  file: string;
  sha256: string;
  size?: number;
  api?: string;
  minAppVersion?: string;
}
interface ReleaseApi {
  RELEASE_DIR: string;
  RELEASES_FILE: string;
  parseReleases(raw: unknown, plugin?: string): Release[];
  compareVersions(a: string, b: string): number;
}

// The ref a released zip must not differ from, when this checkout has it.
const base = process.env.RELEASE_BASE ?? "origin/main";
const hasBase = (await $`git rev-parse --verify --quiet ${`${base}^{commit}`}`.cwd(root).nothrow().quiet()).exitCode === 0;
const onBase = async (path: string): Promise<string | null> => {
  const res = await $`git rev-parse --verify --quiet ${`${base}:${path}`}`.cwd(root).nothrow().quiet();
  return res.exitCode === 0 ? res.text().trim() : null;
};

const problems: string[] = [];
const index = parseMarketplaceIndex(await Bun.file(join(root, "marketplace.json")).json());
const listed = new Set<string>();
let zips = 0;

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
  // An app from before release folders loads dist/ only, so each half the
  // manifest names must be there while dist/ is committed.
  for (const half of [manifest.host, manifest.client]) {
    if (half && !existsSync(join(dir, half))) fail(`${half} is missing; run \`specdriven plugin build\``);
  }
  if (releases) zips += await checkReleases(sub, dir, row.name, manifest.version, fail);
}

/** A plugin's release folder; answers how many zips it checked. */
async function checkReleases(
  sub: string,
  dir: string,
  name: string,
  version: string | undefined,
  fail: (why: string) => void,
): Promise<number> {
  const { RELEASE_DIR, RELEASES_FILE, parseReleases, compareVersions, unzip } = releases!;
  const releaseDir = join(dir, RELEASE_DIR);
  const listFile = join(releaseDir, RELEASES_FILE);
  const cut = `run \`bun scripts/release.ts ${sub}\``;
  if (!existsSync(listFile)) {
    fail(`no ${RELEASE_DIR}/${RELEASES_FILE}: the plugin has no released version — ${cut}`);
    return 0;
  }
  let list: Release[];
  try {
    list = parseReleases(await Bun.file(listFile).json(), name);
  } catch (err) {
    fail(`${RELEASE_DIR}/${RELEASES_FILE}: ${(err as Error).message}`);
    return 0;
  }
  if (list.length === 0) fail(`${RELEASE_DIR}/${RELEASES_FILE} lists no version — ${cut}`);
  // Newest first: the first is the version an app installs.
  const newest = list[0];
  if (newest && version && compareVersions(newest.version, version) !== 0) {
    fail(`package.json is at ${version} but the newest release is ${newest.version} — ${cut}`);
  }

  for (const release of list) {
    const file = join(releaseDir, release.file);
    const at = `${release.file}`;
    if (!existsSync(file)) {
      fail(`${at} is listed for ${release.version} but is not in ${RELEASE_DIR}/`);
      continue;
    }
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const sum = createHash("sha256").update(bytes).digest("hex");
    if (sum !== release.sha256) fail(`${at} does not match its checksum in ${RELEASES_FILE} (it is ${sum})`);
    if (release.size !== undefined && release.size !== bytes.length) {
      fail(`${at} is ${bytes.length} bytes, not the ${release.size} ${RELEASES_FILE} says`);
    }
    // A zip `main` already offers is the one users may have installed.
    const published = hasBase ? await onBase(relative(root, file)) : null;
    if (published && published !== (await $`git hash-object ${file}`.cwd(root).text()).trim()) {
      fail(`${at} is on ${base} already and has changed: a release is never written again — raise "version" and ${cut}`);
    }
    let entries: { path: string; data: Uint8Array }[];
    try {
      entries = unzip(bytes);
    } catch (err) {
      fail(`${at}: ${(err as Error).message}`);
      continue;
    }
    const pkgEntry = entries.find((e) => e.path === "package.json");
    if (!pkgEntry) {
      fail(`${at} has no package.json`);
      continue;
    }
    let zipped: { name?: string; version?: string; specdriven?: Record<string, unknown> };
    try {
      zipped = JSON.parse(new TextDecoder().decode(pkgEntry.data));
    } catch {
      fail(`${at}: its package.json does not parse`);
      continue;
    }
    const section = zipped.specdriven ?? {};
    const id = typeof section.id === "string" ? section.id : zipped.name;
    if (id !== name) fail(`${at} holds the plugin "${id}", not "${name}"`);
    if (zipped.version !== release.version) fail(`${at} holds version ${zipped.version}, not ${release.version}`);
    const zipApi = section.api === undefined ? undefined : String(section.api);
    if (release.api !== undefined && release.api !== zipApi) {
      fail(`${RELEASES_FILE} says ${release.version} speaks api ${release.api}; its manifest says ${zipApi}`);
    }
    // The list is what an app reads to pick a version it can run: it must
    // say what the manifest in the zip will say once unpacked.
    const zipFloor = typeof section.minAppVersion === "string" ? section.minAppVersion : undefined;
    if (release.minAppVersion !== zipFloor) {
      fail(
        `${RELEASES_FILE} says ${release.version} needs SpecDriven ${release.minAppVersion ?? "any"}; its manifest says ${zipFloor ?? "any"}`,
      );
    }
    for (const half of [section.host, section.client]) {
      if (typeof half === "string" && !entries.some((e) => e.path === half.replace(/^\.\//, ""))) {
        fail(`${at} does not hold ${half}, which its manifest names`);
      }
    }
  }
  for (const found of readdirSync(releaseDir)) {
    if (found !== RELEASES_FILE && !list.some((r) => r.file === found)) {
      fail(`${RELEASE_DIR}/${found} is not listed in ${RELEASES_FILE}`);
    }
  }
  return list.length;
}

// A marketplace just initialized from the app has no plugins/ folder with
// anything in it yet — git keeps no empty folders.
const pluginsDir = join(root, "plugins");
const folders = existsSync(pluginsDir)
  ? readdirSync(pluginsDir).filter((d) => statSync(join(pluginsDir, d)).isDirectory())
  : [];
for (const d of folders) {
  if (!listed.has(`plugins/${d}`)) problems.push(`plugins/${d} is not listed in marketplace.json`);
}

if (problems.length) {
  console.error(`marketplace.json, checked against SpecDriven ${appVersion}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`marketplace.json: ${index.plugins.length} plugins OK against SpecDriven ${appVersion}`);
console.log(
  releases
    ? `release folders: ${zips} released versions OK${hasBase ? `, none changed since ${base}` : ` (not compared with ${base}: no such ref here)`}`
    : `release folders: not checked — SpecDriven ${appVersion} does not read them`,
);
