// roadmap/support-event-modeling.md: the canvas's pure half — cells to
// pixels and back, and the gestures as functions on the model file.

import { describe, expect, test } from "bun:test";
import { emptyModelFile } from "../src/model/types";
import {
  CARD_H,
  CARD_W,
  COL_W,
  LANE_H,
  LANE_HEADER_W,
  SLICE_HEADER_H,
  cardPosition,
  dropTarget,
  laneRow,
  sliceBand,
  totalColumns,
} from "../src/ui/geometry";
import {
  addElement,
  addLane,
  addSlice,
  addSpecification,
  arrows,
  canDraw,
  connect,
  disconnect,
  mintId,
  moveElement,
  moveSlice,
  removeElement,
  removeLane,
  removeSlice,
  setSliceWidth,
  updateElement,
} from "../src/ui/mutations";

function cart() {
  let file = emptyModelFile("Cart");
  const s1 = addSlice(file, "Add item");
  file = s1.file;
  const ui = addElement(file, s1.id, "SCREEN", "Cart UI");
  file = ui.file;
  const cmd = addElement(file, s1.id, "COMMAND", "Add item");
  file = cmd.file;
  const evt = addElement(file, s1.id, "EVENT", "Item added");
  file = evt.file;
  file = connect(file, ui.id, cmd.id)!;
  file = connect(file, cmd.id, evt.id)!;
  return { file, slice: s1.id, ui: ui.id, cmd: cmd.id, evt: evt.id };
}

describe("mutations", () => {
  test("ids come from titles and never collide", () => {
    const { file, slice, cmd } = cart();
    expect(slice).toBe("add-item");
    // The command's slug was taken by the slice, so it got a counter.
    expect(cmd).toBe("add-item-2");
    expect(mintId(file, "Add item", "COMMAND")).toBe("add-item-3");
    expect(mintId(file, "???", "COMMAND")).toBe("command");
  });

  test("a new card lands in its type's lane at the band's first free column", () => {
    const { file, slice, ui, cmd, evt } = cart();
    expect(file.layout.elements[ui]).toEqual({ lane: "ui", column: 0 });
    expect(file.layout.elements[cmd]).toEqual({ lane: "cmd", column: 0 });
    expect(file.layout.elements[evt]).toEqual({ lane: "events", column: 0 });
    const more = addElement(file, slice, "COMMAND", "Remove item");
    expect(more.file.layout.elements[more.id]).toEqual({ lane: "cmd", column: 1 });
    expect(more.file.layout.slices[slice]).toEqual({ width: 2 });
    // The slice's pattern follows its members.
    expect(file.model.slices[0]!.sliceType).toBe("STATE_CHANGE");
    expect(file.model.slices[0]!.commands[0]!.slice).toBe(slice);
  });

  test("arrows follow the cheat sheet and are written at both ends", () => {
    const { file, ui, cmd, evt } = cart();
    expect(arrows(file)).toEqual([
      { from: ui, to: cmd },
      { from: cmd, to: evt },
    ]);
    expect(file.model.slices[0]!.screens[0]!.dependencies).toEqual([
      { id: cmd, type: "OUTBOUND", title: "Add item", elementType: "COMMAND" },
    ]);
    expect(file.model.slices[0]!.commands[0]!.dependencies).toEqual([
      { id: ui, type: "INBOUND", title: "Cart UI", elementType: "SCREEN" },
      { id: evt, type: "OUTBOUND", title: "Item added", elementType: "EVENT" },
    ]);
    // An event never feeds a command; a drawn arrow is not drawn twice.
    expect(canDraw(file, evt, cmd)).toBe(false);
    expect(connect(file, evt, cmd)).toBeNull();
    expect(canDraw(file, ui, cmd)).toBe(false);
    const erased = disconnect(file, ui, cmd);
    expect(arrows(erased)).toEqual([{ from: cmd, to: evt }]);
    expect(erased.model.slices[0]!.commands[0]!.dependencies).toHaveLength(1);
  });

  test("renaming a card renames it on the arrows too", () => {
    const { file, cmd, ui } = cart();
    const renamed = updateElement(file, cmd, { title: "Add to cart", description: "why" });
    expect(renamed.model.slices[0]!.commands[0]!.title).toBe("Add to cart");
    expect(renamed.model.slices[0]!.commands[0]!.description).toBe("why");
    expect(renamed.model.slices[0]!.screens[0]!.dependencies[0]!.title).toBe("Add to cart");
    expect(updateElement(renamed, cmd, { description: "" }).model.slices[0]!.commands[0]!.description).toBeUndefined();
    expect(updateElement(file, ui, { title: "x" }).model.slices[0]!.commands[0]!.dependencies[0]!.title).toBe("x");
  });

  test("moving a card snaps it to a cell, changes its slice, and refuses a taken cell", () => {
    const { file, slice, ui, cmd, evt } = cart();
    const s2 = addSlice(file, "Show cart");
    let next = s2.file;
    // Into the other band: the event changes slice and both patterns follow.
    next = moveElement(next, evt, { sliceId: s2.id, lane: "events", column: 0 })!;
    expect(next.model.slices[0]!.events).toEqual([]);
    expect(next.model.slices[1]!.events[0]!.id).toBe(evt);
    expect(next.model.slices[1]!.events[0]!.slice).toBe(s2.id);
    expect(next.model.slices[1]!.sliceType).toBe("STATE_VIEW");
    // The arrow across the bands survives.
    expect(arrows(next)).toContainEqual({ from: cmd, to: evt });
    // Within the band, to the next column: the band widens.
    next = moveElement(next, cmd, { sliceId: slice, lane: "cmd", column: 2 })!;
    expect(next.layout.elements[cmd]).toEqual({ lane: "cmd", column: 2 });
    expect(next.layout.slices[slice]).toEqual({ width: 3 });
    // A lane of the wrong kind, or a taken cell, is refused.
    expect(moveElement(next, ui, { sliceId: slice, lane: "cmd", column: 0 })).toBeNull();
    const twin = addElement(next, slice, "SCREEN", "Other UI");
    expect(moveElement(twin.file, twin.id, { sliceId: slice, lane: "ui", column: 0 })).toBeNull();
    // Narrowing a band stops at what its cards need.
    expect(setSliceWidth(next, slice, 1).layout.slices[slice]).toEqual({ width: 3 });
  });

  test("removing a card takes its arrows; removing a slice takes its cards and arrows into them", () => {
    const { file, slice, cmd, evt } = cart();
    const gone = removeElement(file, cmd);
    expect(arrows(gone)).toEqual([]);
    expect(gone.layout.elements[cmd]).toBeUndefined();
    expect(gone.model.slices[0]!.events[0]!.dependencies).toEqual([]);
    const s2 = addSlice(file, "Show cart");
    let two = s2.file;
    const rm = addElement(two, s2.id, "READMODEL", "Cart items");
    two = connect(rm.file, evt, rm.id)!;
    const cut = removeSlice(two, slice);
    expect(cut.model.slices.map((s) => s.id)).toEqual([s2.id]);
    expect(cut.model.slices[0]!.readmodels[0]!.dependencies).toEqual([]);
    expect(Object.keys(cut.layout.elements)).toEqual([rm.id]);
  });

  test("slices reorder, lanes come and go", () => {
    const { file } = cart();
    let next = addSlice(file, "Show cart").file;
    next = moveSlice(next, "show-cart", 0);
    expect(next.model.slices.map((s) => s.id)).toEqual(["show-cart", "add-item"]);
    next = addLane(next, "EVENTS", "Inventory", "Inventory");
    expect(next.layout.lanes.map((l) => l.id)).toEqual(["ui", "cmd", "events", "inventory"]);
    // A card moved to the stream lane takes the stream's aggregate.
    next = moveElement(next, "item-added", { sliceId: "add-item", lane: "inventory", column: 0 })!;
    expect(next.model.slices[1]!.events[0]!.aggregate).toBe("Inventory");
    // Removing the lane sends its cards to the remaining lane of that kind;
    // the last lane of a kind cannot go.
    const fewer = removeLane(next, "inventory")!;
    expect(fewer.layout.elements["item-added"]!.lane).toBe("events");
    expect(removeLane(fewer, "events")).toBeNull();
    expect(removeLane(fewer, "ui")).toBeNull();
  });

  test("a specification is a Given / When / Then of its slice", () => {
    const { file, slice } = cart();
    const spec = addSpecification(file, slice, "adds the item");
    expect(spec.file.model.slices[0]!.specifications[0]).toEqual({
      id: "adds-the-item",
      title: "adds the item",
      given: [],
      when: [],
      then: [],
      linkedId: slice,
    });
  });
});

describe("geometry", () => {
  test("bands stand side by side and lanes span the canvas", () => {
    const { file } = cart();
    const wide = setSliceWidth(addSlice(file, "Show cart").file, "add-item", 2);
    expect(totalColumns(wide.model, wide.layout)).toBe(3);
    expect(sliceBand(wide.model, wide.layout, 0)).toEqual({
      x: LANE_HEADER_W,
      y: 0,
      width: 2 * COL_W,
      height: SLICE_HEADER_H + 3 * LANE_H,
    });
    expect(sliceBand(wide.model, wide.layout, 1).x).toBe(LANE_HEADER_W + 2 * COL_W);
    expect(laneRow(wide.model, wide.layout, 2)).toEqual({
      x: 0,
      y: SLICE_HEADER_H + 2 * LANE_H,
      width: LANE_HEADER_W + 4 * COL_W,
      height: LANE_H,
    });
  });

  test("a card's pixels come from its cell, and a drop finds the cell again", () => {
    const { file, cmd } = cart();
    const two = setSliceWidth(addSlice(file, "Show cart").file, "add-item", 2);
    const slice = two.model.slices[0]!;
    const at = cardPosition(two.model, two.layout, slice, cmd);
    expect(at).toEqual({
      x: LANE_HEADER_W + (COL_W - CARD_W) / 2,
      y: SLICE_HEADER_H + LANE_H + (LANE_H - CARD_H) / 2,
    });
    expect(dropTarget(two.model, two.layout, at.x, at.y)).toEqual({
      sliceId: "add-item",
      lane: "cmd",
      column: 0,
    });
    // One column right, still in the first band; two right, in the second.
    expect(dropTarget(two.model, two.layout, at.x + COL_W, at.y)).toEqual({
      sliceId: "add-item",
      lane: "cmd",
      column: 1,
    });
    expect(dropTarget(two.model, two.layout, at.x + 2 * COL_W, at.y)).toEqual({
      sliceId: "show-cart",
      lane: "cmd",
      column: 0,
    });
    // Past the last band: the last slice's next column. Off the top: the first lane.
    expect(dropTarget(two.model, two.layout, at.x + 5 * COL_W, -500)).toEqual({
      sliceId: "show-cart",
      lane: "ui",
      column: 3,
    });
    expect(dropTarget(emptyModelFile("x").model, emptyModelFile("x").layout, 0, 0)).toBeNull();
  });
});
