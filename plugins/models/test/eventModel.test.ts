// Event Modeling (roadmap/support-event-modeling.md): the model file's
// shape — canonical bytes, the published schema, and the grid the canvas
// draws it on.

import { describe, expect, test } from "bun:test";
import { autoLayout, sliceStart } from "../src/model/layout";
import {
  modelTextError,
  normalizeModelFile,
  parseModelFile,
  serializeExport,
  serializeModelFile,
} from "../src/model/serialize";
import {
  canConnect,
  emptyModelFile,
  inferSliceType,
  type Element,
  type EventModel,
  type Slice,
} from "../src/model/types";
import { isSchemaValid, schemaProblems } from "../src/model/validate";

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

/** A cart: a screen issues a command that yields an event a read model shows. */
function cart(): EventModel {
  return {
    slices: [
      slice("add-item", {
        screens: [
          element("cart-ui", "SCREEN", {
            dependencies: [
              { id: "add-item-cmd", type: "OUTBOUND", title: "AddItem", elementType: "COMMAND" },
            ],
          }),
        ],
        commands: [
          element("add-item-cmd", "COMMAND", {
            title: "AddItem",
            fields: [{ name: "sku", type: "String" }],
            dependencies: [
              { id: "cart-ui", type: "INBOUND", title: "cart-ui", elementType: "SCREEN" },
              { id: "item-added", type: "OUTBOUND", title: "ItemAdded", elementType: "EVENT" },
            ],
          }),
        ],
        events: [
          element("item-added", "EVENT", {
            title: "ItemAdded",
            dependencies: [
              { id: "add-item-cmd", type: "INBOUND", title: "AddItem", elementType: "COMMAND" },
            ],
          }),
        ],
      }),
      slice("show-cart", {
        sliceType: "STATE_VIEW",
        readmodels: [
          element("cart-items", "READMODEL", {
            dependencies: [
              { id: "item-added", type: "INBOUND", title: "ItemAdded", elementType: "EVENT" },
              { id: "cart-ui-2", type: "OUTBOUND", title: "CartUI", elementType: "SCREEN" },
            ],
          }),
        ],
        screens: [
          element("cart-ui-2", "SCREEN", {
            dependencies: [
              { id: "cart-items", type: "INBOUND", title: "cart-items", elementType: "READMODEL" },
            ],
          }),
        ],
        specifications: [
          {
            id: "spec-1",
            title: "shows the added item",
            linkedId: "cart-items",
            given: [{ id: "g1", title: "ItemAdded", type: "SPEC_EVENT", linkedId: "item-added" }],
            when: [],
            then: [{ id: "t1", title: "CartItems", type: "SPEC_READMODEL", linkedId: "cart-items" }],
          },
        ],
      }),
    ],
  };
}

describe("serialize", () => {
  test("the file's bytes are canonical: fixed key order, stable across re-reads", () => {
    const file = { ...emptyModelFile("Cart"), model: cart() };
    const text = serializeModelFile(file);
    expect(text.startsWith('{\n  "format": "specdriven-event-model/1",\n  "name": "Cart",\n')).toBe(
      true,
    );
    expect(text.endsWith("}\n")).toBe(true);
    // Keys given in another order land in the same place.
    const shuffled = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    const reordered = { model: shuffled.model, links: {}, layout: shuffled.layout, name: "Cart", format: file.format };
    expect(serializeModelFile(reordered as never)).toBe(text);
    expect(serializeModelFile(parseModelFile(text))).toBe(text);
    // An element reads id, title, type before its lists.
    expect(text).toMatch(/"id": "cart-ui",\n\s+"title": "cart-ui",\n\s+"type": "SCREEN"/);
  });

  test("a bare export reads as a model with no layout, and normalizing fills the lists", () => {
    const file = normalizeModelFile(
      { slices: [{ id: "s", title: "S", sliceType: "STATE_CHANGE", commands: [{ id: "c", title: "C" }] }] },
      "Imported",
    );
    expect(file.name).toBe("Imported");
    expect(file.model.slices[0]!.events).toEqual([]);
    expect(file.model.slices[0]!.commands[0]).toEqual({
      id: "c",
      title: "C",
      type: "COMMAND",
      fields: [],
      dependencies: [],
    });
    expect(file.layout.lanes.map((l) => l.kind)).toEqual([
      "SCREEN_AUTOMATION",
      "COMMAND_READMODEL",
      "EVENTS",
    ]);
  });

  test("placements of missing elements or wrong lanes are dropped", () => {
    const file = normalizeModelFile({
      model: cart(),
      layout: {
        lanes: [{ id: "ui", kind: "SCREEN_AUTOMATION", title: "UI" }],
        elements: { "cart-ui": { lane: "ui", column: 0 }, gone: { lane: "ui", column: 1 }, "item-added": { lane: "ui", column: 0 } },
        slices: { "add-item": { width: 2 }, nope: { width: 3 } },
      },
      links: { "show-cart": { feature: "specs/cart/show.feature.md" }, nope: { feature: "x" } },
    });
    expect(Object.keys(file.layout.elements)).toEqual(["cart-ui"]);
    expect(file.layout.slices).toEqual({ "add-item": { width: 2 } });
    expect(file.links).toEqual({ "show-cart": { feature: "specs/cart/show.feature.md" } });
    // The missing lane kinds were added back.
    expect(file.layout.lanes).toHaveLength(3);
  });

  test("modelTextError names what is wrong", () => {
    expect(modelTextError("{")).toMatch(/not valid JSON/);
    expect(modelTextError("[]")).toBe("not a JSON object");
    expect(modelTextError('{"name":"x"}')).toMatch(/no `model`/);
    expect(modelTextError('{"slices":[]}')).toBeNull();
    expect(() => parseModelFile("nope")).toThrow(/Invalid model file/);
  });
});

describe("validate", () => {
  test("a model and its export pass the published schema", () => {
    const model = cart();
    expect(schemaProblems(model)).toEqual([]);
    expect(isSchemaValid(JSON.parse(serializeExport(model)))).toBe(true);
    // The README's own example.
    expect(
      schemaProblems({
        slices: [
          {
            id: "submit-cart",
            title: "Submit Cart",
            status: "Created",
            context: "Shop",
            sliceType: "STATE_CHANGE",
            commands: [{ id: "submit-cart", title: "Submit Cart", type: "COMMAND", fields: [], dependencies: [] }],
            events: [{ id: "cart-submitted", title: "Cart Submitted", type: "EVENT", fields: [], dependencies: [] }],
            readmodels: [],
            screens: [],
            processors: [],
            tables: [],
            specifications: [],
          },
        ],
      }),
    ).toEqual([]);
  });

  test("a bad type, a missing list and an unknown key are reported with their path", () => {
    const model = cart();
    (model.slices[0]!.commands[0] as { type: string }).type = "VERB";
    const problems = schemaProblems(model);
    expect(problems.some((p) => p.path === "/slices/0/commands/0/type" && /allowed/.test(p.message))).toBe(true);
    const missing = { slices: [{ id: "s", title: "S", sliceType: "STATE_CHANGE" }] };
    expect(schemaProblems(missing).some((p) => /required property 'commands'/.test(p.message))).toBe(true);
    const extra = { slices: [], layout: {} };
    expect(schemaProblems(extra).some((p) => /additional properties \(layout\)/.test(p.message))).toBe(true);
    // The file as a whole is not the export: only its `model` half validates.
    expect(isSchemaValid({ ...emptyModelFile("x"), model: cart() })).toBe(false);
  });
});

describe("layout", () => {
  test("elements land in their type's lane, stacked in one column when they chain", () => {
    const file = { ...emptyModelFile("Cart"), model: cart() };
    const layout = autoLayout(file.model, file.layout);
    expect(layout.elements["cart-ui"]).toEqual({ lane: "ui", column: 0 });
    expect(layout.elements["add-item-cmd"]).toEqual({ lane: "cmd", column: 0 });
    expect(layout.elements["item-added"]).toEqual({ lane: "events", column: 0 });
    // The view slice: the read model in its band's first column, the screen above it.
    expect(layout.elements["cart-items"]).toEqual({ lane: "cmd", column: 0 });
    expect(layout.elements["cart-ui-2"]).toEqual({ lane: "ui", column: 0 });
    expect(layout.slices).toEqual({ "add-item": { width: 1 }, "show-cart": { width: 1 } });
    expect(sliceStart(file.model, layout, 1)).toBe(1);
  });

  test("two elements sharing a lane take separate columns; an automation's chain steps right", () => {
    const model: EventModel = {
      slices: [
        slice("auto", {
          sliceType: "AUTOMATION",
          events: [element("e1", "EVENT")],
          readmodels: [
            element("todo", "READMODEL", {
              dependencies: [
                { id: "e1", type: "INBOUND", title: "e1", elementType: "EVENT" },
                { id: "proc", type: "OUTBOUND", title: "proc", elementType: "AUTOMATION" },
              ],
            }),
          ],
          processors: [
            element("proc", "AUTOMATION", {
              dependencies: [
                { id: "todo", type: "INBOUND", title: "todo", elementType: "READMODEL" },
                { id: "c1", type: "OUTBOUND", title: "c1", elementType: "COMMAND" },
              ],
            }),
          ],
          commands: [
            element("c1", "COMMAND", {
              dependencies: [{ id: "proc", type: "INBOUND", title: "proc", elementType: "AUTOMATION" }],
            }),
          ],
        }),
      ],
    };
    const layout = autoLayout(model, emptyModelFile("x").layout);
    expect(layout.elements.e1!.column).toBe(0);
    expect(layout.elements.todo!.column).toBe(0);
    expect(layout.elements.proc!.column).toBe(0);
    // The command shares the read model's lane, so it steps right of it.
    expect(layout.elements.c1!.column).toBe(1);
    expect(layout.slices.auto).toEqual({ width: 2 });
  });

  test("existing placements stay unless asked to arrange everything", () => {
    const file = { ...emptyModelFile("Cart"), model: cart() };
    file.layout.elements["cart-ui"] = { lane: "ui", column: 3 };
    file.layout.elements.stale = { lane: "ui", column: 0 };
    const kept = autoLayout(file.model, file.layout);
    expect(kept.elements["cart-ui"]).toEqual({ lane: "ui", column: 3 });
    expect(kept.elements.stale).toBeUndefined();
    expect(kept.slices["add-item"]).toEqual({ width: 4 });
    const fresh = autoLayout(file.model, file.layout, true);
    expect(fresh.elements["cart-ui"]).toEqual({ lane: "ui", column: 0 });
  });

  test("an event with an aggregate goes to its stream's lane when there is one", () => {
    const file = { ...emptyModelFile("Cart"), model: cart() };
    file.model.slices[0]!.events[0]!.aggregate = "Cart";
    file.layout.lanes.push({ id: "cart-events", kind: "EVENTS", title: "Cart", aggregate: "Cart" });
    const layout = autoLayout(file.model, file.layout);
    expect(layout.elements["item-added"]!.lane).toBe("cart-events");
  });
});

describe("rules", () => {
  test("only the cheat sheet's arrows connect", () => {
    expect(canConnect("SCREEN", "COMMAND")).toBe(true);
    expect(canConnect("COMMAND", "EVENT")).toBe(true);
    expect(canConnect("EVENT", "READMODEL")).toBe(true);
    expect(canConnect("EVENT", "AUTOMATION")).toBe(true);
    expect(canConnect("READMODEL", "SCREEN")).toBe(true);
    expect(canConnect("READMODEL", "AUTOMATION")).toBe(true);
    expect(canConnect("AUTOMATION", "COMMAND")).toBe(true);
    expect(canConnect("EVENT", "COMMAND")).toBe(false);
    expect(canConnect("COMMAND", "READMODEL")).toBe(false);
    expect(canConnect("SCREEN", "EVENT")).toBe(false);
  });

  test("a slice's pattern follows its members", () => {
    const model = cart();
    expect(inferSliceType(model.slices[0]!)).toBe("STATE_CHANGE");
    expect(inferSliceType(model.slices[1]!)).toBe("STATE_VIEW");
    expect(inferSliceType(slice("empty"))).toBeNull();
    expect(inferSliceType(slice("auto", { processors: [element("p", "AUTOMATION")] }))).toBe("AUTOMATION");
  });
});
