// roadmap/support-event-modeling.md in specs-specdriven, the bridge to the specs: a slice
// scaffolds its feature file — one scenario per Given / When / Then, the
// examples as tables — and is linked to it; the listing carries the links
// so a feature finds its model; and a code gen session bundles the model's
// JSON after the specs.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionPrompt } from "@specdriven/app/src/server/agent";
import { handleApi, matchApi, reloader } from "@specdriven/app/src/server/api";
import { featureFromSlice } from "../src/model/feature";
import {
  emptyModelFile,
  type Element,
  type ModelFile,
  type Slice,
  type Specification,
} from "../src/model/types";
import { parseFeature } from "@specdriven/app/src/server/parser";
import { readFeature } from "@specdriven/app/src/server/features";
import { setGitEngine } from "@specdriven/app/src/server/git";
import { createModel, generateSliceFeature, listModels, readModel, saveModel } from "../src/server/models";
import { modelInput, modelSection, sessionModels } from "../src/server/session";
import { writeState } from "@specdriven/app/src/server/state";
import { stopServers } from "@specdriven/app/tests/helpers/fixtures";
import { mountModels } from "./app";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-slice-feature-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-slice-feature-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  reloader.stop();
  stopServers();
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

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

const spec = (id: string, title: string, over: Partial<Specification> = {}): Specification => ({
  id,
  title,
  given: [],
  when: [],
  then: [],
  linkedId: "add-item",
  ...over,
});

/** A cart with one slice whose examples exercise every kind of step. */
function cartFile(): ModelFile {
  const file = emptyModelFile("Shopping cart");
  file.model.slices.push(
    slice("add-item", {
      title: "Add item to cart",
      screens: [element("cart-ui", "SCREEN", { title: "Cart screen" })],
      commands: [
        element("add-item-cmd", "COMMAND", {
          title: "AddItem",
          fields: [
            { name: "sku", type: "String", example: "A-1" },
            { name: "qty", type: "Int", example: "2" },
            { name: "note", type: "String" },
          ],
        }),
      ],
      events: [element("item-added", "EVENT", { title: "ItemAdded" })],
      readmodels: [element("cart-view", "READMODEL", { title: "Cart contents" })],
      specifications: [
        spec("s1", "adds the item", {
          given: [{ id: "g1", title: "", type: "SPEC_READMODEL", linkedId: "cart-view", expectEmptyList: true }],
          when: [{ id: "w1", title: "", type: "SPEC_COMMAND", linkedId: "add-item-cmd" }],
          then: [
            {
              id: "t1",
              title: "ItemAdded",
              type: "SPEC_EVENT",
              linkedId: "item-added",
              examples: [
                { sku: "A-1", qty: 2 },
                { sku: "B|2", qty: 1, gift: true },
              ],
            },
          ],
        }),
        spec("s2", "adds the item", {
          when: [{ id: "w2", title: "AddItem", type: "SPEC_COMMAND" }],
          then: [
            { id: "t2", title: "Out of stock", type: "SPEC_ERROR" },
            { id: "t3", title: "", type: "SPEC_EVENT" },
          ],
        }),
        spec("s3", "  "),
      ],
    }),
    slice("checkout", { title: "Checkout" }),
  );
  return file;
}

describe("featureFromSlice", () => {
  test("one scenario per specification, steps as bullets, examples as tables", () => {
    const generated = featureFromSlice(cartFile(), "models/cart.model.json", "add-item")!;
    expect(generated.name).toBe("Add item to cart");
    expect(generated.text).toBe(
      [
        "# Add item to cart",
        "",
        "Scenarios of the slice “Add item to cart” in the Event Model “Shopping cart” (models/cart.model.json).",
        "",
        "## adds the item @v1 [proposed]",
        "",
        "- **Given** Cart contents is empty",
        "- **When** AddItem",
        "- **Then** ItemAdded",
        "",
        "Examples for AddItem:",
        "",
        "| sku | qty |",
        "| --- | --- |",
        "| A-1 | 2   |",
        "",
        "Examples for ItemAdded:",
        "",
        "| sku  | qty | gift |",
        "| ---- | --- | ---- |",
        "| A-1  | 2   |      |",
        "| B\\|2 | 1   | true |",
        "",
        "## adds the item (2) @v1 [proposed]",
        "",
        "- **When** AddItem",
        "- **Then** the error “Out of stock”",
        "",
        "## Example 3 @v1 [proposed]",
        "",
      ].join("\n"),
    );
    // What it wrote is a feature file the parser reads back whole.
    const parsed = parseFeature(generated.text);
    expect(parsed.name).toBe("Add item to cart");
    expect(parsed.description).toContain("models/cart.model.json");
    expect(parsed.scenarios.map((s) => [s.name, s.status])).toEqual([
      ["adds the item", "proposed"],
      ["adds the item (2)", "proposed"],
      ["Example 3", "proposed"],
    ]);
  });

  test("the heading can be given; an unknown slice is null; an untitled one is numbered", () => {
    const file = cartFile();
    expect(featureFromSlice(file, "models/cart.model.json", "add-item", "Cart items")!.text).toStartWith(
      "# Cart items\n\nScenarios of the slice “Add item to cart”",
    );
    expect(featureFromSlice(file, "models/cart.model.json", "nope")).toBeNull();
    file.model.slices[1]!.title = "";
    expect(featureFromSlice(file, "models/cart.model.json", "checkout")!.text).toBe(
      "# Slice 2\n\nScenarios of the slice “Slice 2” in the Event Model “Shopping cart” (models/cart.model.json).\n",
    );
  });
});

describe("generateSliceFeature", () => {
  test("creates the feature, links the slice to it, and refuses a second time", async () => {
    const modelFile = await createModel(root, "Shopping cart");
    await saveModel(root, modelFile, cartFile());
    const made = await generateSliceFeature(root, modelFile, "add-item");
    expect(made.fileName).toBe("specs/add-item-to-cart.feature.md");
    expect(made.scenarios).toBe(3);
    expect(made.model.file.links["add-item"]).toEqual({ feature: "specs/add-item-to-cart.feature.md" });
    const text = (await readFeature(root, made.fileName))!;
    expect(text).toStartWith("# Add item to cart\n\nScenarios of the slice “Add item to cart”");
    expect(text).toContain("## adds the item @v1 [proposed]");
    // The link is in the model's file and its listing.
    expect((await readModel(root, modelFile))!.file.links["add-item"]?.feature).toBe(made.fileName);
    expect((await listModels(root))[0]!.links).toEqual([
      { sliceId: "add-item", slice: "Add item to cart", feature: "specs/add-item-to-cart.feature.md" },
    ]);
    await expect(generateSliceFeature(root, modelFile, "add-item")).rejects.toThrow(
      "already has a feature file: specs/add-item-to-cart.feature.md",
    );
  });

  test("a name places the feature in a folder and is its heading; an unknown slice is refused", async () => {
    const modelFile = await createModel(root, "Shopping cart");
    await saveModel(root, modelFile, cartFile());
    const made = await generateSliceFeature(root, modelFile, "checkout", "billing/Check out");
    expect(made.fileName).toBe("specs/billing/check-out.feature.md");
    expect(made.scenarios).toBe(0);
    expect(await readFeature(root, made.fileName)).toBe(
      "# Check out\n\nScenarios of the slice “Checkout” in the Event Model “Shopping cart” (models/cart.model.json).\n".replace(
        "models/cart.model.json",
        modelFile,
      ),
    );
    await expect(generateSliceFeature(root, modelFile, "nope")).rejects.toThrow("Slice not found");
    await expect(generateSliceFeature(root, "models/none.model.json", "checkout")).rejects.toThrow(
      "not found",
    );
  });
});

describe("a session bundles the model", () => {
  test("sessionModels: the ones named, and the ones whose slices link a spec", async () => {
    const modelFile = await createModel(root, "Shopping cart");
    await saveModel(root, modelFile, cartFile());
    await generateSliceFeature(root, modelFile, "add-item");
    // Named: its JSON, and its linked spec for the session to take on.
    const named = await sessionModels(root, [modelFile], []);
    expect(named.models.map((m) => m.fileName)).toEqual([modelFile]);
    expect(named.features).toEqual(["specs/add-item-to-cart.feature.md"]);
    expect(named.models[0]!.slices).toEqual([
      { title: "Add item to cart", feature: "specs/add-item-to-cart.feature.md" },
      { title: "Checkout" },
    ]);
    expect(JSON.parse(named.models[0]!.json).slices).toHaveLength(2);
    // A selected spec brings the model whose slice links it.
    const linked = await sessionModels(root, [], ["specs/add-item-to-cart.feature.md"]);
    expect(linked.models.map((m) => m.fileName)).toEqual([modelFile]);
    expect(linked.features).toEqual([]);
    expect((await sessionModels(root, [], ["specs/other.feature.md"])).models).toEqual([]);
    await expect(sessionModels(root, ["models/none.model.json"], [])).rejects.toThrow("model not found");
  });

  test("buildSessionPrompt: the model's map and JSON after the specs", () => {
    const view = { fileName: "models/cart.model.json", name: "Shopping cart", slices: 2, links: [], file: cartFile() };
    const model = modelInput(view);
    const specs = [{ fileName: "specs/add-item-to-cart.feature.md", content: "# Add item to cart\n" }];
    const prompt = buildSessionPrompt("s", specs, undefined, [modelSection(model, true)]);
    expect(prompt).toContain("Implement the following specification.");
    expect(prompt.indexOf("## Spec: specs/add-item-to-cart.feature.md")).toBeLessThan(
      prompt.indexOf("## Event Model: models/cart.model.json"),
    );
    expect(prompt).toContain('The Event Model "Shopping cart" the specifications above belong to');
    expect(prompt).toContain("- Add item to cart — no specification yet");
    expect(prompt).toContain("- Checkout — no specification yet");
    expect(prompt).toContain("```json\n{\n  \"slices\": [");
    expect(prompt).toEndWith("```\n");
    // A model alone is a session too.
    const alone = buildSessionPrompt("s", [], undefined, [modelSection(model, false)]);
    expect(alone).toContain("Implement the following Event Model.");
    expect(alone).toContain('The Event Model "Shopping cart": a timeline');
    expect(alone).not.toContain("## Spec:");
    // Without models the prompt is what it was.
    expect(buildSessionPrompt("s", specs)).toBe(buildSessionPrompt("s", specs, undefined, []));
  });

  test("the prompt route bundles the open model and the model behind a selected spec", async () => {
    const data = join(root, "data");
    await writeState({ dataRepo: data }, root);
    const unmount = await mountModels();
    const modelFile = await createModel(data, "Shopping cart");
    await saveModel(data, modelFile, cartFile());
    await generateSliceFeature(data, modelFile, "add-item");
    const api = (body: unknown) =>
      handleApi(
        new Request("http://localhost/api/agent/session/prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ) as Promise<Response>;
    // From the model: its linked spec comes along, whole.
    const fromModel = await api({ name: "s", attachments: { models: [modelFile] } });
    expect(fromModel.status).toBe(200);
    const one = (await fromModel.json()).prompt as string;
    expect(one).toContain("## Spec: specs/add-item-to-cart.feature.md");
    expect(one).toContain("## Event Model: models/shopping-cart.model.json");
    expect(one).toContain("- Add item to cart → specs/add-item-to-cart.feature.md");
    // From the spec: the model whose slice links it comes along.
    const fromSpec = await api({ name: "s", files: [{ fileName: "specs/add-item-to-cart.feature.md" }] });
    expect(fromSpec.status).toBe(200);
    expect((await fromSpec.json()).prompt).toContain("## Event Model: models/shopping-cart.model.json");
    // Neither: refused as before; a malformed list, or a model that is not there, too.
    expect((await api({ name: "s" })).status).toBe(400);
    expect((await api({ name: "s", attachments: { models: "x" } })).status).toBe(400);
    const missing = await api({ name: "s", attachments: { models: ["models/none.model.json"] } });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("model not found: models/none.model.json");
    // Unmounted, the app has nothing that takes a model.
    await unmount();
    const off = await api({ name: "s", attachments: { models: [modelFile] } });
    expect((await off.json()).error).toBe("nothing takes attachments for models");
    const plain = await api({ name: "s", files: [{ fileName: "specs/add-item-to-cart.feature.md" }] });
    expect((await plain.json()).prompt).not.toContain("## Event Model:");
  });

  // The route is the plugin's (src/host.ts): there while it is mounted.
  test("the slice feature route exists", async () => {
    const unmount = await mountModels();
    try {
      expect(matchApi("POST", "/api/models/models%2Fcart.model.json/slices/add-item/feature")).not.toBeNull();
    } finally {
      await unmount();
    }
    expect(matchApi("GET", "/api/models/models%2Fcart.model.json/slices/add-item/feature")).toBeNull();
  });
});
