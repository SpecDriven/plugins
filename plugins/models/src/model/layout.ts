// Where the cards go: the grid an Event Model is drawn on. Slices stand side
// by side in model order, each a band as many columns wide as its layout
// entry says; inside a band an element has a lane and a column. Nothing here
// is in pixels — the canvas (src/ui/geometry.ts) turns the
// grid into coordinates, so a file diff never shows a card nudged by 3px.

import {
  ELEMENT_LISTS,
  laneKindOf,
  type Element,
  type EventModel,
  type Lane,
  type Layout,
  type Slice,
} from "./types";

/** The lane an element goes in by default: its type's kind, or for an event
    with an aggregate the stream's own lane when there is one. */
export function defaultLane(layout: Layout, element: Element): Lane {
  const kind = laneKindOf(element.type);
  if (element.type === "EVENT" && element.aggregate) {
    const stream = layout.lanes.find(
      (lane) => lane.kind === "EVENTS" && lane.aggregate === element.aggregate,
    );
    if (stream) return stream;
  }
  const plain = layout.lanes.find((lane) => lane.kind === kind && !lane.aggregate);
  return plain ?? layout.lanes.find((lane) => lane.kind === kind) ?? layout.lanes[0]!;
}

/** The band width of a slice: its layout entry, or one column. */
export function sliceWidth(layout: Layout, slice: Slice): number {
  return Math.max(1, layout.slices[slice.id]?.width ?? 1);
}

/** The column the band of slice `index` starts at, counted over the model. */
export function sliceStart(model: EventModel, layout: Layout, index: number): number {
  let start = 0;
  for (let i = 0; i < index && i < model.slices.length; i++) {
    start += sliceWidth(layout, model.slices[i]!);
  }
  return start;
}

/**
 * A slice's elements in the order its arrows flow: what feeds an element
 * comes before it. Arrows from other slices and cycles count for nothing;
 * ties keep list order (screens, automations, commands, read models, events).
 */
function flowOrder(slice: Slice): Element[] {
  const members = new Map<string, Element>();
  for (const list of ELEMENT_LISTS) for (const e of slice[list]) members.set(e.id, e);
  const out: Element[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (element: Element): void => {
    if (done.has(element.id) || visiting.has(element.id)) return;
    visiting.add(element.id);
    for (const dep of element.dependencies) {
      if (dep.type !== "INBOUND") continue;
      const source = members.get(dep.id);
      if (source) visit(source);
    }
    visiting.delete(element.id);
    done.add(element.id);
    out.push(element);
  };
  for (const element of members.values()) visit(element);
  return out;
}

/**
 * Lay out what has no place yet, leaving placed elements where they are:
 * every element gets a lane and a column of its slice, and every slice a
 * band wide enough for its columns. An element sits in the column of what
 * feeds it — a screen, its command and the event below each other, the way
 * the cheat sheet draws a slice — and steps right when that cell is taken,
 * which is how an automation's command lands beside its read model. `all`
 * throws the existing placement away first — the toolbar's "Arrange".
 */
export function autoLayout(model: EventModel, layout: Layout, all = false): Layout {
  const next: Layout = {
    lanes: layout.lanes.map((lane) => ({ ...lane })),
    slices: {},
    elements: all ? {} : { ...layout.elements },
  };
  const ids = new Set<string>();
  for (const slice of model.slices) {
    const ordered = flowOrder(slice);
    for (const element of ordered) ids.add(element.id);
    /** Which (lane, column) cells the slice already fills. */
    const taken = new Set<string>();
    const cellOf = (lane: string, column: number) => `${lane}:${column}`;
    for (const element of ordered) {
      const placed = next.elements[element.id];
      if (placed) taken.add(cellOf(placed.lane, placed.column));
    }
    for (const element of ordered) {
      if (next.elements[element.id]) continue;
      const lane = defaultLane(next, element).id;
      let column = 0;
      for (const dep of element.dependencies) {
        if (dep.type !== "INBOUND") continue;
        const source = next.elements[dep.id];
        if (source && ordered.some((e) => e.id === dep.id)) {
          column = Math.max(column, source.column);
        }
      }
      while (taken.has(cellOf(lane, column))) column++;
      taken.add(cellOf(lane, column));
      next.elements[element.id] = { lane, column };
    }
    let width = all ? 1 : (layout.slices[slice.id]?.width ?? 1);
    for (const element of ordered) {
      width = Math.max(width, next.elements[element.id]!.column + 1);
    }
    next.slices[slice.id] = { width };
  }
  // A placement whose element is gone is noise in the file.
  for (const id of Object.keys(next.elements)) {
    if (!ids.has(id)) delete next.elements[id];
  }
  return next;
}
