// The plugin inside the app it runs in: the app's API (which provides the
// data access the host half asks for) and its kernel, with the Event
// Storming plugin mounted on it as the loader would mount an installed one.

import "@specdriven/app/src/server/api";
import { host } from "@specdriven/app/src/plugins/host/loader";
import storming from "../src/host";

/** Mount the plugin's host half; the disposer unmounts it, its routes and hooks with it. */
export async function mountStorming(): Promise<() => Promise<void>> {
  const scope = host.plugin(storming);
  await scope.ready;
  return () => scope.dispose();
}
