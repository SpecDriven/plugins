// The specs-folder migration's side (src/server/relink.ts): features moved
// under `specs/` keep the slices that link them, and the plugin is told of
// the moves through the app's `sync.moved` hook while it is mounted.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sync } from "@specdriven/app/src/plugins/host/loader";
import { parseModelFile, serializeModelFile } from "../src/model/serialize";
import { emptyModelFile } from "../src/model/types";
import { mountModels } from "./app";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-models-relink-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a moved feature's slice links follow it; the folder is reserved while mounted", async () => {
  const file = emptyModelFile("Cart");
  for (const id of ["a", "b", "c"]) {
    file.model.slices.push({
      id,
      title: id,
      sliceType: "STATE_CHANGE",
      screens: [],
      processors: [],
      commands: [],
      readmodels: [],
      events: [],
      tables: [],
      specifications: [],
    });
  }
  file.links = { a: { feature: "cart.feature.md" }, b: { feature: "specs/kept.feature.md" }, c: {} };
  await mkdir(join(root, "models"), { recursive: true });
  await writeFile(join(root, "models/cart.model.json"), serializeModelFile(file));
  await writeFile(join(root, "models/broken.model.json"), "{ nope");

  expect(sync.reserved()).not.toContain("models");
  const unmount = await mountModels();
  try {
    expect(sync.reserved()).toContain("models");
    await sync.runMoved(root, new Map([["cart.feature.md", "specs/cart.feature.md"]]));
  } finally {
    await unmount();
  }
  const after = parseModelFile(await Bun.file(join(root, "models/cart.model.json")).text());
  expect(after.links).toEqual({
    a: { feature: "specs/cart.feature.md" },
    b: { feature: "specs/kept.feature.md" },
    c: {},
  });
  expect(await Bun.file(join(root, "models/broken.model.json")).text()).toBe("{ nope");
  expect(sync.reserved()).not.toContain("models");
});
