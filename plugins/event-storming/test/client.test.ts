// The plugin's browser half (src/client.tsx) on the app's client kernel:
// the tab opens its first board, or its welcome while there is none, names
// the open board for a code gen session, and offers a "New board" command.

import { afterEach, expect, test } from "bun:test";
import { client, matchPluginRoute, tabs } from "@specdriven/app/src/plugins/client/loader";
import { tabReachable } from "@specdriven/app/src/plugins/client/tabs";
import storming from "../src/client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the tab opens its first board, its welcome while there is none", async () => {
  // The listing is the one fetch the plugin makes on mount; answered here.
  let listed: unknown[] = [];
  globalThis.fetch = (async () => Response.json({ storms: listed })) as unknown as typeof fetch;
  const scope = client.plugin(storming);
  await scope.ready;
  try {
    const tab = tabs.get("event-storming")!;
    expect(tab).toBeDefined();
    expect(tab.shortcut).toBe("g w");
    // No boards: the tab is still there, on its welcome.
    expect(tabReachable(tab)).toBe(true);
    const bare = matchPluginRoute("/storms")!;
    expect(bare.view).toEqual({ fileName: null });
    expect(tab.route.resolve!(bare.view)).toEqual({ fileName: null });

    listed = [{ fileName: "storms/orders.storm.json", name: "Orders", counts: { event: 3 } }];
    await client.serial("data/changed");
    expect(tab.route.resolve!(bare.view)).toEqual({ fileName: "storms/orders.storm.json" });
    expect(tab.route.title({ fileName: "storms/orders.storm.json" })).toBe("Orders");
    expect(tab.route.title({ fileName: null })).toBe("Event Storming");
    expect(tab.session!({ fileName: "storms/orders.storm.json" })).toEqual({
      refs: ["storms/orders.storm.json"],
      labels: ["the Event Storming board “Orders”"],
    });
    expect(tab.session!({ fileName: null })).toBeNull();
    expect(tab.recent!({ fileName: "storms/orders.storm.json" })).toBe("Orders");
    const commands = tab.palette!.commands!({
      prompt: async () => null,
      promptWithChoice: async () => null,
      confirm: async () => false,
      navigate: () => {},
    });
    expect(commands.map((c) => c.text)).toEqual(["New Event Storming board"]);
  } finally {
    await scope.dispose();
  }
  expect(tabs.get("event-storming")).toBeUndefined();
});
