// The plugin's browser half (src/client.tsx) on the app's client kernel:
// the Models tab opens its first model, goes home while the folder is
// empty, carries a crumb from a feature page back to the model, and names
// the open model for a code gen session.

import { afterEach, expect, test } from "bun:test";
import { client, matchPluginRoute, tabs } from "@specdriven/app/src/plugins/client/loader";
import { tabReachable } from "@specdriven/app/src/plugins/client/tabs";
import models from "../src/client";
import type { ModelsRoute } from "../src/route";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the Models tab opens its first model, and a feature page crumbs back to it", async () => {
  // The listing is the one fetch the plugin makes on mount; answered here.
  let listed: unknown[] = [];
  globalThis.fetch = (async () => Response.json({ models: listed })) as unknown as typeof fetch;
  const scope = client.plugin(models);
  await scope.ready;
  try {
    const tab = tabs.get("models")!;
    expect(tab).toBeDefined();
    // An empty folder: the bare url resolves to nothing, so it goes home and
    // the tab has no rail icon or chord.
    expect(tabReachable(tab)).toBe(false);
    const bare = matchPluginRoute("/models")!;
    expect(bare.view).toEqual({ fileName: null });
    expect(tab.route.resolve!(bare.view)).toBeNull();

    listed = [
      {
        fileName: "models/cart.model.json",
        name: "Cart",
        links: [{ slice: "Add item", feature: "specs/cart.feature.md" }],
      },
    ];
    await client.serial("data/changed");
    expect(tabReachable(tab)).toBe(true);
    expect(tab.route.resolve!(bare.view)).toEqual({ fileName: "models/cart.model.json" });
    expect(tab.route.title({ fileName: "models/cart.model.json" })).toBe("Cart");

    const crumbs = tab.featureCrumbs!("specs/cart.feature.md");
    expect(crumbs.map((c) => [c.title, tab.route.path(c.view as ModelsRoute)])).toEqual([
      ["Open the Event Model “Cart” — slice “Add item”", "/models/cart"],
    ]);
    expect(tab.featureCrumbs!("specs/other.feature.md")).toEqual([]);
    expect(tab.session!({ fileName: "models/cart.model.json" })).toEqual({
      refs: ["models/cart.model.json"],
      labels: ["the model “Cart”"],
    });
  } finally {
    await scope.dispose();
  }
  expect(tabs.get("models")).toBeUndefined();
});
