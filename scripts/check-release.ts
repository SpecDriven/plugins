// Check that a plugin's newest release is the plugin as it is committed —
// an app that reads release folders installs the zip, so a zip cut from
// other code than the source beside it ships something nobody reviewed.
//
//   bun scripts/check-release.ts plugins/<name>
//
// The newest zip in release/ must hold the manifest package.json has now
// (its name, version and "specdriven" section) and the bundles dist/ has:
// byte for byte while dist/ is committed, which `scripts/release.ts` writes
// in the same run. Once a plugin no longer commits dist/, the zip is
// compared with a rebuild instead, the way check-dist.ts compares.
//
// So a change to a plugin's code needs a new version: check-dist.ts makes
// the change reach dist/, and a released zip never changes (check-index.ts),
// which leaves raising "version" and running scripts/release.ts.
//
// Reads the zip with the app's own reader (../specdriven-app, or
// SPECDRIVEN_APP). An app from before release folders has none, and
// installs dist/ as committed: there is nothing to check against it.

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { $ } from "bun";
import { normalize } from "./normalize";

const root = resolve(import.meta.dir, "..");
const app = resolve(process.env.SPECDRIVEN_APP ?? join(root, "..", "specdriven-app"));
const arg = process.argv[2];
if (!arg) throw new Error("usage: bun scripts/check-release.ts plugins/<name>");
const dir = resolve(root, arg);

const appVersion: string = (await Bun.file(join(app, "package.json")).json()).version;
const market = await import(join(app, "src/plugins/marketplace.ts"));
const zipModule = join(app, "src/plugins/host/zip.ts");
if (typeof market.parseReleases !== "function" || !existsSync(zipModule)) {
  console.log(`${arg}: release not checked — SpecDriven ${appVersion} does not read release folders`);
  process.exit(0);
}
const { unzip } = await import(zipModule);
const { RELEASE_DIR, RELEASES_FILE, parseReleases } = market;

const fail = (why: string): never => {
  console.error(`${arg}: ${why}`);
  process.exit(1);
};

const listFile = join(dir, RELEASE_DIR, RELEASES_FILE);
if (!existsSync(listFile)) fail(`no ${RELEASE_DIR}/${RELEASES_FILE} — run \`bun scripts/release.ts ${arg}\``);
const pkg = await Bun.file(join(dir, "package.json")).json();
const [newest] = parseReleases(await Bun.file(listFile).json(), pkg.specdriven?.id ?? pkg.name);
if (!newest) fail(`${RELEASE_DIR}/${RELEASES_FILE} lists no version — run \`bun scripts/release.ts ${arg}\``);

const entries: { path: string; data: Uint8Array }[] = unzip(
  new Uint8Array(await Bun.file(join(dir, RELEASE_DIR, newest.file)).arrayBuffer()),
);
const entry = (path: string) => entries.find((e) => e.path === path);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const again = `raise "version" in package.json and run \`bun scripts/release.ts ${arg}\``;

// The manifest the zip installs is the one in the tree.
const zipped = JSON.parse(text(entry("package.json")?.data ?? fail(`${newest.file} has no package.json`)));
for (const key of ["name", "version", "specdriven"] as const) {
  if (JSON.stringify(zipped[key]) !== JSON.stringify(pkg[key])) {
    fail(`package.json's "${key}" is not what ${newest.file} was released with — ${again}`);
  }
}

// The bundles the zip installs are the ones in the tree.
const committed = (await $`git ls-files -- dist`.cwd(dir).text()).split("\n").filter((f) => f.endsWith(".js"));
const zippedJs = entries.map((e) => e.path).filter((p) => p.startsWith("dist/") && p.endsWith(".js"));
const differing: string[] = [];
if (committed.length > 0) {
  for (const f of new Set([...committed, ...zippedJs])) {
    const inTree = committed.includes(f)
      ? Buffer.from(await $`git show :${relative(root, join(dir, f))}`.cwd(root).arrayBuffer())
      : null;
    const inZip = entry(f)?.data;
    if (!inTree || !inZip || !inTree.equals(Buffer.from(inZip))) differing.push(f);
  }
} else {
  await $`bun ${join(app, "src/index.ts")} plugin build .`.cwd(dir);
  const built = [...new Bun.Glob("dist/*.js").scanSync(dir)];
  for (const f of new Set([...built, ...zippedJs])) {
    const now = built.includes(f) ? await Bun.file(join(dir, f)).text() : "";
    const inZip = entry(f)?.data;
    if (!inZip || normalize(text(inZip)) !== normalize(now)) differing.push(f);
  }
}
if (differing.length) {
  fail(
    `${newest.file} does not hold the plugin as it is now (${differing.sort().join(", ")}): a released version is never rebuilt — ${again}`,
  );
}
console.log(`${arg}: ${newest.file} is the plugin at ${newest.version}`);
