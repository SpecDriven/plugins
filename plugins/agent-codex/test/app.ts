// The plugin inside the app it runs in: the app's API (which provides the
// data access and the agent registry the host half asks for) and its
// kernel, with this plugin mounted on it as the loader mounts an installed
// one — the same HostConfig, from this package's manifest.

import { resolve } from "node:path";
import "@specdriven/app/src/server/api";
import { host, hostConfigFor } from "@specdriven/app/src/plugins/host/loader";
import { parsePackageManifest } from "@specdriven/app/src/plugins/manifest";
import { version as appVersion } from "@specdriven/app/package.json";
import pkg from "../package.json";
import plugin from "../src/host";

/** Mount the plugin's host half; the disposer unmounts it, its provider and routes with it. */
export async function mountPlugin(): Promise<() => Promise<void>> {
  const manifest = parsePackageManifest(pkg, appVersion);
  const scope = host.plugin(plugin, hostConfigFor(manifest, resolve(import.meta.dir, "..")));
  await scope.ready;
  if (scope.error) throw scope.error;
  return () => scope.dispose();
}

/**
 * A settings profile under which the app mounts no coding agent of its own
 * for `data`: the test mounts this package's plugin directly, and the app's
 * built-in agent plugins (gone once the marketplace ones replace them)
 * would otherwise switch themselves on at the first `/api/state` and take
 * the provider over.
 */
export function quietProfile(data: string): Record<string, unknown> {
  return { plugins: { repos: { [data]: { enabled: [], autoEnabled: ["agent-claude", "agent-codex", "agent-pi"] } } } };
}
