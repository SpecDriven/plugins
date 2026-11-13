// Check that a plugin's committed dist/ is what its src/ builds to now —
// the desktop app installs dist/ as it is, so a stale bundle ships old code.
//
//   bun scripts/check-dist.ts plugins/<name>
//
// Rebuilds the plugin with the app checkout's `plugin build` (../specdriven-app,
// or SPECDRIVEN_APP), then compares each bundle with the committed one
// (git's index) after dropping the lines that change without the plugin
// changing: the module path comments, which follow the folder the build ran
// from; the `var x = m.x;` shim lines, which list every export of the
// building app's SDK; and the debug id (scripts/normalize.ts). Source maps
// are not compared.

import { join, relative, resolve } from "node:path";
import { $ } from "bun";
import { normalize } from "./normalize";

const root = resolve(import.meta.dir, "..");
const app = resolve(process.env.SPECDRIVEN_APP ?? join(root, "..", "specdriven-app"));
const arg = process.argv[2];
if (!arg) throw new Error("usage: bun scripts/check-dist.ts plugins/<name>");
const dir = resolve(root, arg);

await $`bun ${join(app, "src/index.ts")} plugin build .`.cwd(dir);

const files = (await $`git ls-files -- dist`.cwd(dir).text()).split("\n").filter((f) => f.endsWith(".js"));
const built = [...new Bun.Glob("dist/*.js").scanSync(dir)];
const stale: string[] = [];
for (const f of new Set([...files, ...built])) {
  const path = relative(root, join(dir, f));
  const committed = files.includes(f) ? await $`git show :${path}`.cwd(root).text() : "";
  const now = (await Bun.file(join(dir, f)).exists()) ? await Bun.file(join(dir, f)).text() : "";
  if (normalize(committed) !== normalize(now)) stale.push(path);
}

if (stale.length) {
  console.error(`dist/ does not match src/ — run \`specdriven plugin build\` in ${arg} and commit dist/:`);
  for (const s of stale) console.error(`  - ${s}`);
  process.exit(1);
}
console.log(`${arg}: dist/ matches src/`);
