// The data repo's `models` folder (roadmap/support-event-modeling.md in
// specs-specdriven): one JSON file per Event Model, shown on the Models tab
// while the plugin is on, created when it is, kept in an Automerge document
// behind the file, and committed by the sync tick.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A, fileDocDirRel, loadFileDoc } from "@specdriven/host";
import { docToModel, importModelDoc, projectModel, reconcileModel, type ModelDoc } from "../src/server/doc";
import { serializeModelFile } from "../src/model/serialize";
import { emptyModelFile, type Element, type ModelFile, type Slice } from "../src/model/types";
import { setGitEngine } from "@specdriven/app/src/server/git";
import {
  MODELS_FOLDER,
  createModel,
  deleteModel,
  ensureModelsFolder,
  importModelDrift,
  importedFile,
  isModelsFolderPath,
  listModels,
  readModel,
  saveModel,
} from "../src/server/models";
import { syncDataDir } from "@specdriven/app/src/server/reload";
import { isSearchScope, resetSearchCache, searchScope } from "@specdriven/app/src/server/search";
import { parseRoute } from "@specdriven/app/src/frontend/route";
import { modelLink, modelsPath, parseModelsRoute } from "../src/route";
import { git, stopServers, twoClones } from "@specdriven/app/tests/helpers/fixtures";
import { mountModels } from "./app";

const searchModels = (dir: string, q: string) => searchScope(dir, MODELS_FOLDER, q);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-models-"));
  resetSearchCache();
});

afterEach(async () => {
  stopServers();
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return readdir(path).then(
    () => true,
    () => false,
  );
}

const element = (id: string, type: Element["type"], over: Partial<Element> = {}): Element => ({
  id,
  title: id,
  type,
  fields: [],
  dependencies: [],
  ...over,
});

const slice = (id: string, over: Partial<Slice> = {}): Slice => ({
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
  ...over,
});

function cartFile(): ModelFile {
  const file = emptyModelFile("Cart");
  file.model.slices.push(
    slice("add-item", {
      title: "Add item",
      screens: [element("cart-ui", "SCREEN", { title: "Cart UI" })],
      commands: [element("add-item-cmd", "COMMAND", { title: "AddItem" })],
      events: [element("item-added", "EVENT", { title: "ItemAdded" })],
    }),
  );
  return file;
}

test("ensureModelsFolder creates the folder once", async () => {
  expect(await ensureModelsFolder(root)).toBe(true);
  expect(await exists(join(root, MODELS_FOLDER))).toBe(true);
  expect(await ensureModelsFolder(root)).toBe(false);
});

// The folder's drift pass is the plugin's (src/host.ts): it runs while the
// plugin is mounted.
test("a sync tick creates the folder only while the plugin is on", async () => {
  const clones = await twoClones(root);
  await syncDataDir(clones.a);
  expect(await exists(join(clones.a, MODELS_FOLDER))).toBe(false);
  const unmount = await mountModels();
  try {
    await syncDataDir(clones.a);
  } finally {
    await unmount();
  }
  expect(await exists(join(clones.a, MODELS_FOLDER))).toBe(true);
});

test("model paths are the folder and what is under it", () => {
  expect(isModelsFolderPath("models")).toBe(true);
  expect(isModelsFolderPath("models/shop")).toBe(true);
  expect(isModelsFolderPath("modelsx")).toBe(false);
});

test("a model's url is its path under the folder", () => {
  expect(modelLink("models/cart.model.json")).toBe("/models/cart");
  expect(modelLink("models/shop/cart.model.json")).toBe("/models/shop/cart");
  // The plugin parses its own urls (src/route.ts); to the app's router they
  // are home until the mounted tab claims them.
  expect(parseModelsRoute("/models/cart")).toEqual({ fileName: "models/cart.model.json" });
  expect(parseModelsRoute("/models/shop/cart.model.json")).toEqual({
    fileName: "models/shop/cart.model.json",
  });
  // The bare folder names the Models tab, which opens on its first model.
  expect(parseModelsRoute("/models")).toEqual({ fileName: null });
  expect(parseModelsRoute("/modelsx")).toBeNull();
  expect(parseRoute("/models/cart")).toEqual({});
  expect(modelsPath({ fileName: "models/cart.model.json" })).toBe("/models/cart");
  expect(modelsPath({ fileName: null })).toBe("/models");
});

test("listModels names the models, nested ones included, skipping what is not one", async () => {
  await mkdir(join(root, MODELS_FOLDER, "shop"), { recursive: true });
  const cart = cartFile();
  cart.assigned = "Ada";
  await writeFile(join(root, MODELS_FOLDER, "cart.model.json"), serializeModelFile(cart));
  await writeFile(join(root, MODELS_FOLDER, "shop/no-name.model.json"), '{"slices": []}\n');
  await writeFile(join(root, MODELS_FOLDER, "broken.model.json"), "{ nope");
  await writeFile(join(root, MODELS_FOLDER, "notes.md"), "# Notes\n");
  expect(await listModels(root)).toEqual([
    { fileName: "models/cart.model.json", name: "Cart", assigned: "Ada", slices: 1, links: [] },
    { fileName: "models/shop/no-name.model.json", name: "No Name", slices: 0, links: [] },
  ]);
});

test("a model is created, read and saved through its document, committed and pushed", async () => {
  const clones = await twoClones(root);
  const fileName = await createModel(clones.a, "Shopping cart");
  expect(fileName).toBe("models/shopping-cart.model.json");
  const text = await Bun.file(join(clones.a, fileName)).text();
  expect(text).toBe(serializeModelFile(emptyModelFile("Shopping cart")));
  expect(text).toContain('"format": "specdriven-event-model/1"');
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(true);
  expect(await exists(join(clones.b, fileDocDirRel(fileName)))).toBe(true);

  const saved = await saveModel(clones.a, fileName, { ...cartFile(), name: "Shopping cart" });
  expect(saved.name).toBe("Shopping cart");
  expect(saved.slices).toBe(1);
  // The save completed the layout: every card has a place.
  expect(saved.file.layout.elements["cart-ui"]).toEqual({ lane: "ui", column: 0 });
  expect(saved.file.layout.slices["add-item"]).toEqual({ width: 1 });
  expect((await readModel(clones.a, fileName))?.file).toEqual(saved.file);
  const loaded = await loadFileDoc<ModelDoc>(clones.a, fileName);
  expect(loaded?.doc.model.slices[0]?.commands[0]?.title).toBe("AddItem");
  // The file is the document's projection, byte for byte.
  expect(await Bun.file(join(clones.a, fileName)).text()).toBe(projectModel(loaded!.doc));

  // A duplicate name is refused.
  await expect(createModel(clones.a, "Shopping cart")).rejects.toThrow("already exists");
});

test("a model is deleted with its document, committed and pushed", async () => {
  const clones = await twoClones(root);
  const fileName = await createModel(clones.a, "Cart");
  await deleteModel(clones.a, fileName);
  expect(await Bun.file(join(clones.a, fileName)).exists()).toBe(false);
  expect(await exists(join(clones.a, fileDocDirRel(fileName)))).toBe(false);
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(false);
  await expect(deleteModel(clones.a, fileName)).rejects.toThrow("not found");
});

test("an import must pass the published schema, and is laid out on arrival", async () => {
  const bare = {
    slices: [
      {
        id: "submit-cart",
        title: "Submit Cart",
        sliceType: "STATE_CHANGE",
        commands: [{ id: "submit", title: "Submit Cart", type: "COMMAND", fields: [], dependencies: [] }],
        events: [{ id: "submitted", title: "Cart Submitted", type: "EVENT", fields: [], dependencies: [] }],
        readmodels: [],
        screens: [],
        processors: [],
        tables: [],
        specifications: [],
      },
    ],
  };
  const file = importedFile("Imported cart", bare);
  expect(file.name).toBe("Imported cart");
  expect(file.layout.elements.submit).toEqual({ lane: "cmd", column: 0 });
  expect(file.layout.elements.submitted).toEqual({ lane: "events", column: 0 });
  expect(() => importedFile("x", { slices: [{ id: "s" }] })).toThrow(/Not a valid Event Model/);
  expect(() => importedFile("x", { slices: [{ ...bare.slices[0], extra: 1 }] })).toThrow(/extra/);

  const clones = await twoClones(root);
  const fileName = await createModel(clones.a, "Imported", bare);
  expect((await readModel(clones.a, fileName))?.file.model.slices[0]?.title).toBe("Submit Cart");
});

test("an externally edited model is absorbed into its document; a broken one is left alone", async () => {
  await mkdir(join(root, MODELS_FOLDER), { recursive: true });
  const fileName = "models/cart.model.json";
  await writeFile(join(root, fileName), serializeModelFile(cartFile()));
  expect(await importModelDrift(root)).toContain("imported 1");
  // The import completed the layout and rewrote the file to the projection.
  const first = await Bun.file(join(root, fileName)).text();
  expect(first).toContain('"cart-ui": {');
  expect(await importModelDrift(root)).toBe("");

  const edited = cartFile();
  edited.assigned = "Grace";
  edited.model.slices[0]!.commands[0]!.title = "AddItemToCart";
  edited.model.slices[0]!.commands[0]!.fields.push({ name: "sku", type: "String" });
  await writeFile(join(root, fileName), serializeModelFile(edited));
  expect(await importModelDrift(root)).toContain("absorbed 1");
  const loaded = await loadFileDoc<ModelDoc>(root, fileName);
  expect(loaded?.doc.assigned).toBe("Grace");
  expect(loaded?.doc.model.slices[0]?.commands[0]?.title).toBe("AddItemToCart");
  expect(loaded?.doc.model.slices[0]?.commands[0]?.fields).toEqual([{ name: "sku", type: "String" }]);

  await writeFile(join(root, fileName), "{ half-typed");
  expect(await importModelDrift(root)).toContain("left 1");
  expect(await Bun.file(join(root, fileName)).text()).toBe("{ half-typed");

  await rm(join(root, fileName));
  expect(await importModelDrift(root)).toContain("dropped 1");
  expect(await loadFileDoc<ModelDoc>(root, fileName)).toBeNull();
});

test("two peers' edits to different parts of one model both survive", () => {
  const base = importModelDoc(cartFile());
  // Peer A renames the command; peer B adds an event and moves the screen.
  const a = reconcileModel(A.clone(base), (() => {
    const f = docToModel(base);
    f.model.slices[0]!.commands[0]!.title = "AddItemToCart";
    return f;
  })());
  const b = reconcileModel(A.clone(base), (() => {
    const f = docToModel(base);
    f.model.slices[0]!.events.push(element("item-rejected", "EVENT", { title: "ItemRejected" }));
    f.layout.elements["cart-ui"] = { lane: "ui", column: 2 };
    return f;
  })());
  const both = A.merge(a, b);
  const merged = docToModel(both);
  expect(merged.model.slices[0]!.commands[0]!.title).toBe("AddItemToCart");
  expect(merged.model.slices[0]!.events.map((e) => e.id)).toEqual(["item-added", "item-rejected"]);
  expect(merged.layout.elements["cart-ui"]).toEqual({ lane: "ui", column: 2 });
  // And the merged document still projects to canonical bytes.
  expect(projectModel(both)).toBe(serializeModelFile(merged));
});

test("reconciling removes, reorders and rewrites what the target says", () => {
  const base = importModelDoc(cartFile());
  const target = docToModel(base);
  target.model.slices.push(slice("show-cart", { sliceType: "STATE_VIEW" }));
  target.model.slices.reverse();
  target.model.slices[1]!.screens = [];
  target.links["show-cart"] = { feature: "specs/cart/show.feature.md" };
  delete target.layout.elements["cart-ui"];
  const next = docToModel(reconcileModel(base, target));
  expect(next).toEqual(target);
  // The same target again is a no-op.
  const again = reconcileModel(importModelDoc(target), target);
  expect(docToModel(again)).toEqual(target);
});

test("a model path outside the folder is refused", async () => {
  await expect(readModel(root, "../secrets.model.json")).rejects.toThrow("Invalid model name");
  await expect(readModel(root, "models/notes.md")).rejects.toThrow("Invalid model name");
});

test("the Models tab searches the models by name, slice, element and specification", async () => {
  const unmount = await mountModels();
  try {
    await searchesModels();
  } finally {
    await unmount();
  }
});

async function searchesModels() {
  await mkdir(join(root, MODELS_FOLDER), { recursive: true });
  const cart = cartFile();
  cart.model.slices[0]!.specifications.push({
    id: "spec",
    title: "duplicate sku increments quantity",
    linkedId: "add-item-cmd",
    given: [],
    when: [],
    then: [],
  });
  await writeFile(join(root, MODELS_FOLDER, "cart.model.json"), serializeModelFile(cart));
  await writeFile(join(root, MODELS_FOLDER, "billing.model.json"), serializeModelFile(emptyModelFile("Billing")));
  const byElement = await searchModels(root, "ItemAdded");
  expect(byElement.map((r) => r.fileName)).toEqual(["models/cart.model.json"]);
  expect(byElement[0]!.kind).toBe("model");
  expect(byElement[0]!.featureName).toBe("Cart");
  expect((await searchModels(root, "quantity"))[0]?.snippet).toContain("increments quantity");
  expect((await searchModels(root, "billing")).map((r) => r.featureName)).toEqual(["Billing"]);
}

// The palette on the Models tab asks the app's search route with
// `scope=models`: the scope is there while the plugin is mounted.
test("the models search scope comes and goes with the plugin", async () => {
  expect(isSearchScope("models")).toBe(false);
  const unmount = await mountModels();
  try {
    expect(isSearchScope("models")).toBe(true);
    expect(isSearchScope("modelsx")).toBe(false);
  } finally {
    await unmount();
  }
  expect(isSearchScope("models")).toBe(false);
});
