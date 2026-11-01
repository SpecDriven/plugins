// A stand-in npm registry for src/binary.ts: a package tarball made with the
// system tar, the integrity npm would give it, and a fetch that serves it.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A gzipped npm-style tarball holding `package/<name>` and a package.json. */
export async function packageTarball(name: string, body: string): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await mkdtemp(join(tmpdir(), "specdriven-claude-tgz-"));
  try {
    await mkdir(join(dir, "package"));
    await writeFile(join(dir, "package", "package.json"), '{"name":"stand-in"}\n');
    await writeFile(join(dir, "package", name), body, { mode: 0o755 });
    const out = join(dir, "pkg.tgz");
    const tar = Bun.spawnSync(["tar", "-czf", out, "-C", dir, "package/package.json", `package/${name}`]);
    if (tar.exitCode !== 0) throw new Error(`tar: ${tar.stderr.toString()}`);
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const integrityOf = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** A fetch that answers every url with these bytes, and remembers the urls. */
export function servingFetch(bytes: Uint8Array<ArrayBuffer>, urls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
  }) as typeof fetch;
}
