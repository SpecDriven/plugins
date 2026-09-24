// The board file (src/storm/): canonical bytes, a forgiving reader, the
// imports it takes, the outline it reads out as — and every gesture on the
// wall as a pure edit of it (src/ui/mutations.ts).

import { expect, test } from "bun:test";
import { exampleStorm } from "../src/storm/example";
import { areaOf, stormOutline } from "../src/storm/outline";
import {
  importStorm,
  normalizeStormFile,
  parseStormFile,
  serializeStormFile,
  stormTextError,
} from "../src/storm/serialize";
import { emptyStormFile, STICKY, STICKY_KINDS, STORM_FORMAT, type StormFile } from "../src/storm/types";
import {
  addArea,
  addSticky,
  connect,
  duplicate,
  moveTo,
  removeIds,
  updateArea,
  updateSticky,
} from "../src/ui/mutations";

function board(): StormFile {
  return normalizeStormFile({
    name: "Orders",
    stickies: [
      { id: "place", kind: "command", text: "Place order", x: 0, y: 0 },
      { id: "placed", kind: "event", text: "Order placed", x: 160, y: 0 },
      { id: "paid", kind: "event", text: "Payment received", x: 320, y: 0, pivotal: true },
      { id: "shipped", kind: "event", text: "Order shipped", x: 640, y: 0 },
    ],
    areas: [
      { id: "sales", label: "Sales", x: -32, y: -32, width: 520, height: 240 },
      { id: "fulfil", label: "Fulfilment", x: 560, y: -32, width: 320, height: 240 },
    ],
    arrows: [{ id: "r1", from: "place", to: "placed" }],
  });
}

test("every sticky kind has its colour, size and meaning in the legend", () => {
  expect(STICKY_KINDS).toEqual(["event", "command", "actor", "policy", "aggregate", "readmodel", "external", "hotspot", "note"]);
  expect(STICKY.event.color).toBe("#ffa94d");
  expect(STICKY.command.color).toBe("#74c0fc");
  expect(STICKY.actor.height).toBeLessThan(STICKY.event.height);
  expect(STICKY.aggregate.width).toBeGreaterThan(STICKY.event.width);
  for (const kind of STICKY_KINDS) expect(STICKY[kind].meaning.length).toBeGreaterThan(10);
});

test("a board serializes to canonical JSON that reads back the same", () => {
  const text = serializeStormFile(board());
  expect(text.endsWith("}\n")).toBe(true);
  expect(text.indexOf('"format"')).toBeLessThan(text.indexOf('"name"'));
  expect(text).toContain(`"format": "${STORM_FORMAT}"`);
  // Within a sticky: identity, kind, text, then where it is.
  expect(text).toContain('"id": "place",\n      "kind": "command",\n      "text": "Place order",\n      "x": 0,');
  expect(parseStormFile(text)).toEqual(board());
  expect(serializeStormFile(parseStormFile(text))).toBe(text);
});

test("reading is forgiving: what a hand edit left is normalized to a board", () => {
  const file = normalizeStormFile(
    {
      stickies: [
        { id: "a", kind: "event", text: "A", x: 10.6, y: "no", pivotal: true },
        { id: "a", kind: "wat", text: 3 },
        { kind: "command", text: "No id", pivotal: true },
      ],
      areas: [{ id: "tiny", label: "Tiny", width: 5, height: 5 }],
      arrows: [
        { id: "ok", from: "a", to: "a" },
        { from: "a", to: "gone" },
      ],
      extra: true,
    },
    "Fallback",
  );
  expect(file.name).toBe("Fallback");
  expect(file.stickies[0]).toEqual({ id: "a", kind: "event", text: "A", x: 11, y: 0, pivotal: true });
  // A duplicate id is renamed, an unknown kind is a note, a missing id made up.
  expect(file.stickies[1]!.id).not.toBe("a");
  expect(file.stickies[1]!.kind).toBe("note");
  expect(file.stickies[1]!.text).toBe("");
  expect(file.stickies[2]!.id).toMatch(/^s-/);
  // Only an event can be pivotal.
  expect(file.stickies[2]!.pivotal).toBeUndefined();
  expect(file.areas[0]).toMatchObject({ width: 160, height: 120 });
  // An arrow to itself, or to a sticky that is not there, goes.
  expect(file.arrows).toEqual([]);
  expect("extra" in file).toBe(false);
});

test("a file that is not a board says why", () => {
  expect(stormTextError("{ nope")).toMatch(/^not JSON/);
  expect(stormTextError("[]")).toBe("not a JSON object");
  expect(stormTextError('{"format": "other/1"}')).toBe('unknown format "other/1"');
  expect(stormTextError(serializeStormFile(emptyStormFile("x")))).toBeNull();
});

test("an import takes this format or the Event Storm web app's list of nodes", () => {
  const own = importStorm(JSON.parse(serializeStormFile(board())), "Copy");
  expect(own.name).toBe("Copy");
  expect(own.stickies).toEqual(board().stickies);

  const eventstorm = importStorm(
    [
      { id: "1", name: "Customer", type: "actor", x: 0, y: 190, tilted: false },
      { id: "2", name: "Checkout Page", type: "view", x: 128, y: 112 },
      { id: "3", name: "Timeout", type: "process", x: 256, y: 112 },
      { id: "4", name: "Server down", type: "error", x: 384, y: 112 },
    ],
    "Shop",
  );
  expect(eventstorm.stickies.map((s) => [s.kind, s.text])).toEqual([
    ["actor", "Customer"],
    ["readmodel", "Checkout Page"],
    ["policy", "Timeout"],
    ["hotspot", "Server down"],
  ]);
  expect(() => importStorm({ slices: [] }, "x")).toThrow(/no stickies/);
});

test("the outline reads the timeline left to right, in phases cut at the pivotal events", () => {
  const outline = stormOutline(board());
  expect(outline).toBe(
    [
      "# Orders",
      "",
      "## Timeline",
      "",
      "### Phase 1",
      "",
      "- Order placed — in Sales",
      "  - after command “Place order”",
      "- Payment received (pivotal) — in Sales",
      "",
      "### Phase 2",
      "",
      "- Order shipped — in Fulfilment",
      "",
      "## Commands",
      "",
      "- Place order — in Sales",
      "",
      "## Areas",
      "",
      "- Sales (3 sticky notes)",
      "- Fulfilment (1 sticky note)",
      "",
    ].join("\n"),
  );
  expect(stormOutline(emptyStormFile("Empty"))).toContain("(no domain events yet)");
});

test("a sticky belongs to the smallest area holding its centre", () => {
  const file = board();
  file.areas.push({ id: "inner", label: "Payments", x: 300, y: -16, width: 180, height: 180 });
  expect(areaOf(file.stickies[2]!, file.areas)?.id).toBe("inner");
  expect(areaOf(file.stickies[0]!, file.areas)?.id).toBe("sales");
  expect(areaOf({ id: "far", kind: "note", text: "", x: 5000, y: 0 }, file.areas)).toBeNull();
});

test("the example board is a whole story: every kind of sticky, two areas, a pivotal event", () => {
  const file = exampleStorm("Online shop");
  expect(file.name).toBe("Online shop");
  const kinds = new Set(file.stickies.map((s) => s.kind));
  for (const kind of STICKY_KINDS.filter((k) => k !== "note")) expect(kinds.has(kind)).toBe(true);
  expect(file.stickies.filter((s) => s.pivotal).map((s) => s.text)).toEqual(["Payment received"]);
  expect(file.areas.map((a) => a.label)).toEqual(["Sales", "Fulfilment"]);
  expect(file.arrows.length).toBeGreaterThan(5);
  // Normalizing dropped nothing: every arrow's ends are there.
  expect(normalizeStormFile(file, "x").arrows).toEqual(file.arrows);
});

test("gestures are pure edits of the board", () => {
  const start = board();
  const added = addSticky(start, "hotspot", { x: 400, y: 400 }, "Why?");
  const sticky = added.file.stickies.find((s) => s.id === added.id)!;
  // Centred on the point, snapped to the grid.
  expect(sticky).toMatchObject({ kind: "hotspot", text: "Why?", x: 336, y: 336 });
  expect(start.stickies).toHaveLength(4);

  const area = addArea(start, { x: 0, y: 0 });
  expect(area.file.areas.at(-1)).toMatchObject({ id: area.id, width: 480, height: 360, x: -240, y: -176 });
  expect(updateArea(start, "sales", { width: 10 }).areas[0]!.width).toBe(160);

  // Turned into a command, an event stops being pivotal.
  const recoloured = updateSticky(start, "paid", { kind: "command" });
  expect(recoloured.stickies[2]).toEqual({ id: "paid", kind: "command", text: "Payment received", x: 320, y: 0 });

  const moved = moveTo(start, new Map([["placed", { x: 200.4, y: 16 }], ["sales", { x: 0, y: 0 }]]));
  expect(moved.stickies[1]).toMatchObject({ x: 200, y: 16 });
  expect(moved.areas[0]).toMatchObject({ x: 0, y: 0 });
  expect(moved.stickies[0]).toBe(start.stickies[0]!);

  expect(connect(start, "place", "placed")).toBeNull();
  expect(connect(start, "place", "place")).toBeNull();
  expect(connect(start, "placed", "paid")!.arrows).toHaveLength(2);

  // A sticky gone takes its arrows with it.
  const removed = removeIds(start, ["placed", "fulfil"]);
  expect(removed.stickies.map((s) => s.id)).toEqual(["place", "paid", "shipped"]);
  expect(removed.areas.map((a) => a.id)).toEqual(["sales"]);
  expect(removed.arrows).toEqual([]);

  const copied = duplicate(start, ["place", "placed"]);
  expect(copied.ids).toHaveLength(2);
  expect(copied.file.stickies).toHaveLength(6);
  const [a, b] = copied.ids;
  expect(copied.file.stickies.find((s) => s.id === a)).toMatchObject({ text: "Place order", x: 32, y: 32 });
  // The arrow between the copies is copied too.
  expect(copied.file.arrows.some((r) => r.from === a && r.to === b)).toBe(true);
});
