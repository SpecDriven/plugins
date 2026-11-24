// What the canvas does to a model (roadmap/support-event-modeling.md), as
// pure functions from one ModelFile to the next: add and move cards, draw
// and erase arrows, edit what the inspector shows. Every gesture on the
// canvas is one of these, applied to the file the pane holds and autosaved
// — so the file, not React Flow's node list, is the state.

import { autoLayout } from "../model/layout";
import {
  ELEMENT_LISTS,
  SLICE_LIST,
  canConnect,
  findElement,
  inferSliceType,
  laneKindOf,
  type Element,
  type ElementType,
  type Field,
  type Lane,
  type LaneKind,
  type ModelFile,
  type Slice,
  type Specification,
} from "../model/types";
import { slugify } from "@specdriven/client";

/** A deep copy, so a mutation never touches the file React holds. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every id in use — elements, slices, lanes, specifications. */
function idsOf(file: ModelFile): Set<string> {
  const ids = new Set<string>();
  for (const slice of file.model.slices) {
    ids.add(slice.id);
    for (const list of ELEMENT_LISTS) for (const e of slice[list]) ids.add(e.id);
    for (const spec of slice.specifications) ids.add(spec.id);
  }
  for (const lane of file.layout.lanes) ids.add(lane.id);
  return ids;
}

/**
 * An id from a title — `add-item` for "Add item" — readable in the file and
 * in a diff; a taken one gets a counter. A title with nothing to slug falls
 * back to the kind.
 */
export function mintId(file: ModelFile, title: string, kind: string): string {
  const ids = idsOf(file);
  const base = slugify(title) || kind.toLowerCase();
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const TYPE_LABEL: Record<ElementType, string> = {
  SCREEN: "Screen",
  COMMAND: "Command",
  EVENT: "Event",
  READMODEL: "Read model",
  AUTOMATION: "Automation",
};

export function typeLabel(type: ElementType): string {
  return TYPE_LABEL[type];
}

function sliceOf(file: ModelFile, sliceId: string): Slice {
  const slice = file.model.slices.find((s) => s.id === sliceId);
  if (!slice) throw new Error(`No slice ${sliceId}`);
  return slice;
}

/** A slice's pattern kept in step with what it holds. */
function retype(slice: Slice): void {
  const inferred = inferSliceType(slice);
  if (inferred) slice.sliceType = inferred;
}

/** A new slice after the others — or at `index` — one column wide. */
export function addSlice(file: ModelFile, title: string, index?: number): { file: ModelFile; id: string } {
  const next = clone(file);
  const id = mintId(next, title, "slice");
  const slice: Slice = {
    id,
    title,
    sliceType: "STATE_CHANGE",
    screens: [],
    processors: [],
    commands: [],
    readmodels: [],
    events: [],
    tables: [],
    specifications: [],
  };
  next.model.slices.splice(index ?? next.model.slices.length, 0, slice);
  next.layout.slices[id] = { width: 1 };
  return { file: next, id };
}

export function updateSlice(
  file: ModelFile,
  sliceId: string,
  patch: Partial<Pick<Slice, "title" | "sliceType" | "status" | "context">>,
): ModelFile {
  const next = clone(file);
  const slice = sliceOf(next, sliceId);
  if (patch.title !== undefined) slice.title = patch.title;
  if (patch.sliceType !== undefined) slice.sliceType = patch.sliceType;
  if (patch.status !== undefined) {
    if (patch.status) slice.status = patch.status;
    else delete slice.status;
  }
  if (patch.context !== undefined) {
    if (patch.context) slice.context = patch.context;
    else delete slice.context;
  }
  return next;
}

/** Remove a slice and everything in it; arrows into it from elsewhere go too. */
export function removeSlice(file: ModelFile, sliceId: string): ModelFile {
  const next = clone(file);
  const slice = sliceOf(next, sliceId);
  const gone = new Set<string>();
  for (const list of ELEMENT_LISTS) for (const e of slice[list]) gone.add(e.id);
  next.model.slices = next.model.slices.filter((s) => s.id !== sliceId);
  for (const other of next.model.slices) {
    for (const list of ELEMENT_LISTS) {
      for (const e of other[list]) {
        e.dependencies = e.dependencies.filter((d) => !gone.has(d.id));
      }
    }
  }
  for (const id of gone) delete next.layout.elements[id];
  delete next.layout.slices[sliceId];
  delete next.links[sliceId];
  return next;
}

/** Move a slice to `index` among the others — the bands swap places. */
export function moveSlice(file: ModelFile, sliceId: string, index: number): ModelFile {
  const next = clone(file);
  const from = next.model.slices.findIndex((s) => s.id === sliceId);
  if (from === -1) return file;
  const [slice] = next.model.slices.splice(from, 1);
  const to = Math.max(0, Math.min(next.model.slices.length, index));
  next.model.slices.splice(to, 0, slice!);
  return next;
}

/** Widen or narrow a band; never below what its cards need. */
export function setSliceWidth(file: ModelFile, sliceId: string, width: number): ModelFile {
  const next = clone(file);
  const slice = sliceOf(next, sliceId);
  let needed = 1;
  for (const list of ELEMENT_LISTS) {
    for (const e of slice[list]) {
      needed = Math.max(needed, (next.layout.elements[e.id]?.column ?? 0) + 1);
    }
  }
  next.layout.slices[sliceId] = { width: Math.max(needed, Math.floor(width)) };
  return next;
}

export function setSliceLink(file: ModelFile, sliceId: string, feature: string | null): ModelFile {
  const next = clone(file);
  if (feature) next.links[sliceId] = { feature };
  else delete next.links[sliceId];
  return next;
}

/**
 * A new card in a slice: placed in the lane its type belongs in — the one
 * given, when it is of that kind — at the band's first free column, or the
 * column given.
 */
export function addElement(
  file: ModelFile,
  sliceId: string,
  type: ElementType,
  title: string,
  place?: { lane?: string; column?: number },
): { file: ModelFile; id: string } {
  const next = clone(file);
  const slice = sliceOf(next, sliceId);
  const id = mintId(next, title, type);
  const element: Element = { id, title, type, fields: [], dependencies: [], slice: slice.id };
  slice[SLICE_LIST[type]].push(element);
  retype(slice);
  const lanes = next.layout.lanes;
  const wanted = lanes.find((l) => l.id === place?.lane && l.kind === laneKindOf(type));
  const lane =
    wanted ?? lanes.find((l) => l.kind === laneKindOf(type) && !l.aggregate) ?? lanes.find((l) => l.kind === laneKindOf(type));
  if (!lane) return { file: next, id };
  const taken = new Set<number>();
  for (const list of ELEMENT_LISTS) {
    for (const e of slice[list]) {
      const p = next.layout.elements[e.id];
      if (p && p.lane === lane.id) taken.add(p.column);
    }
  }
  let column = place?.column ?? 0;
  if (place?.column === undefined) while (taken.has(column)) column++;
  next.layout.elements[id] = { lane: lane.id, column };
  const width = next.layout.slices[slice.id]?.width ?? 1;
  next.layout.slices[slice.id] = { width: Math.max(width, column + 1) };
  return { file: next, id };
}

/**
 * Drop a card in a cell: another column of its band, another lane of the
 * right kind (an events lane per stream), or another slice's band — in
 * which case the element changes slice, and the pattern of both slices
 * follows. A cell already holding a card is refused, so nothing hides
 * under anything.
 */
export function moveElement(
  file: ModelFile,
  elementId: string,
  target: { sliceId: string; lane: string; column: number },
): ModelFile | null {
  const next = clone(file);
  const found = findElement(next.model, elementId);
  if (!found) return null;
  const { slice: from, element } = found;
  const lane = next.layout.lanes.find((l) => l.id === target.lane);
  if (!lane || lane.kind !== laneKindOf(element.type)) return null;
  const to = sliceOf(next, target.sliceId);
  for (const list of ELEMENT_LISTS) {
    for (const e of to[list]) {
      if (e.id === elementId) continue;
      const p = next.layout.elements[e.id];
      if (p && p.lane === target.lane && p.column === target.column) return null;
    }
  }
  if (from.id !== to.id) {
    const list = SLICE_LIST[element.type];
    from[list] = from[list].filter((e) => e.id !== elementId);
    to[list].push(element);
    element.slice = to.id;
    retype(from);
    retype(to);
  }
  if (element.type === "EVENT") {
    if (lane.aggregate) element.aggregate = lane.aggregate;
  }
  next.layout.elements[elementId] = { lane: target.lane, column: target.column };
  const width = next.layout.slices[to.id]?.width ?? 1;
  next.layout.slices[to.id] = { width: Math.max(width, target.column + 1) };
  return next;
}

/** Remove a card and every arrow touching it. */
export function removeElement(file: ModelFile, elementId: string): ModelFile {
  const next = clone(file);
  for (const slice of next.model.slices) {
    for (const list of ELEMENT_LISTS) {
      slice[list] = slice[list].filter((e) => e.id !== elementId);
      for (const e of slice[list]) {
        e.dependencies = e.dependencies.filter((d) => d.id !== elementId);
      }
    }
    retype(slice);
    for (const spec of slice.specifications) {
      for (const key of ["given", "when", "then"] as const) {
        for (const step of spec[key]) if (step.linkedId === elementId) delete step.linkedId;
      }
    }
  }
  delete next.layout.elements[elementId];
  return next;
}

export function updateElement(
  file: ModelFile,
  elementId: string,
  patch: Partial<Pick<Element, "title" | "description" | "aggregate" | "context" | "fields">> & {
    /** Back to this system: the context key goes. */
    clearContext?: boolean;
  },
): ModelFile {
  const next = clone(file);
  const found = findElement(next.model, elementId);
  if (!found) return file;
  const { element } = found;
  if (patch.title !== undefined) {
    element.title = patch.title;
    // The arrows' labels name the element too.
    for (const slice of next.model.slices) {
      for (const list of ELEMENT_LISTS) {
        for (const e of slice[list]) {
          for (const d of e.dependencies) if (d.id === elementId) d.title = patch.title;
        }
      }
    }
  }
  for (const key of ["description", "aggregate", "context"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value) (element as Record<string, unknown>)[key] = value;
    else delete element[key];
  }
  if (patch.clearContext) delete element.context;
  if (patch.fields !== undefined) element.fields = clone(patch.fields);
  return next;
}

/** Whether an arrow from one element to the other is allowed and not there yet. */
export function canDraw(file: ModelFile, fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  const from = findElement(file.model, fromId);
  const to = findElement(file.model, toId);
  if (!from || !to) return false;
  if (!canConnect(from.element.type, to.element.type)) return false;
  return !from.element.dependencies.some((d) => d.type === "OUTBOUND" && d.id === toId);
}

/** Draw an arrow: an OUTBOUND dependency on the source, an INBOUND one on the target. */
export function connect(file: ModelFile, fromId: string, toId: string): ModelFile | null {
  if (!canDraw(file, fromId, toId)) return null;
  const next = clone(file);
  const from = findElement(next.model, fromId)!;
  const to = findElement(next.model, toId)!;
  from.element.dependencies.push({
    id: toId,
    type: "OUTBOUND",
    title: to.element.title,
    elementType: to.element.type,
  });
  to.element.dependencies.push({
    id: fromId,
    type: "INBOUND",
    title: from.element.title,
    elementType: from.element.type,
  });
  return next;
}

/** Erase an arrow, at both its ends. */
export function disconnect(file: ModelFile, fromId: string, toId: string): ModelFile {
  const next = clone(file);
  const from = findElement(next.model, fromId);
  const to = findElement(next.model, toId);
  if (from) {
    from.element.dependencies = from.element.dependencies.filter(
      (d) => !(d.type === "OUTBOUND" && d.id === toId),
    );
  }
  if (to) {
    to.element.dependencies = to.element.dependencies.filter(
      (d) => !(d.type === "INBOUND" && d.id === fromId),
    );
  }
  return next;
}

/** Every arrow of the model, as (from, to) pairs, from the OUTBOUND ends. */
export function arrows(file: ModelFile): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const slice of file.model.slices) {
    for (const list of ELEMENT_LISTS) {
      for (const e of slice[list]) {
        for (const d of e.dependencies) {
          const pair = d.type === "OUTBOUND" ? `${e.id}->${d.id}` : `${d.id}->${e.id}`;
          if (seen.has(pair)) continue;
          seen.add(pair);
          const [from, to] = pair.split("->") as [string, string];
          if (findElement(file.model, from) && findElement(file.model, to)) out.push({ from, to });
        }
      }
    }
  }
  return out;
}

/** A new lane: another events stream, or another row of one of the kinds. */
export function addLane(file: ModelFile, kind: LaneKind, title: string, aggregate?: string): ModelFile {
  const next = clone(file);
  const id = mintId(next, title, "lane");
  const lane: Lane = { id, kind, title, ...(aggregate ? { aggregate } : {}) };
  // Lanes keep their kinds together: the new one goes after the last of its kind.
  let at = next.layout.lanes.length;
  for (let i = next.layout.lanes.length - 1; i >= 0; i--) {
    if (next.layout.lanes[i]!.kind === kind) {
      at = i + 1;
      break;
    }
  }
  next.layout.lanes.splice(at, 0, lane);
  return next;
}

export function updateLane(
  file: ModelFile,
  laneId: string,
  patch: Partial<Pick<Lane, "title" | "aggregate">>,
): ModelFile {
  const next = clone(file);
  const lane = next.layout.lanes.find((l) => l.id === laneId);
  if (!lane) return file;
  if (patch.title !== undefined) lane.title = patch.title;
  if (patch.aggregate !== undefined) {
    if (patch.aggregate) lane.aggregate = patch.aggregate;
    else delete lane.aggregate;
  }
  return next;
}

/** Remove a lane; its cards move to the remaining lane of that kind. Refused for the last of a kind. */
export function removeLane(file: ModelFile, laneId: string): ModelFile | null {
  const next = clone(file);
  const lane = next.layout.lanes.find((l) => l.id === laneId);
  if (!lane) return file;
  const fallback = next.layout.lanes.find((l) => l.kind === lane.kind && l.id !== laneId);
  if (!fallback) return null;
  next.layout.lanes = next.layout.lanes.filter((l) => l.id !== laneId);
  for (const place of Object.values(next.layout.elements)) {
    if (place.lane === laneId) place.lane = fallback.id;
  }
  return autoLayoutFile(next);
}

/** The layout completed for every card that has none — after a lane change, say. */
export function autoLayoutFile(file: ModelFile, all = false): ModelFile {
  const next = clone(file);
  next.layout = autoLayout(next.model, next.layout, all);
  return next;
}

/** A new Given / When / Then on a slice. */
export function addSpecification(file: ModelFile, sliceId: string, title: string): { file: ModelFile; id: string } {
  const next = clone(file);
  const slice = sliceOf(next, sliceId);
  const id = mintId(next, title, "spec");
  const spec: Specification = { id, title, given: [], when: [], then: [], linkedId: sliceId };
  slice.specifications.push(spec);
  return { file: next, id };
}

export function updateSpecification(
  file: ModelFile,
  sliceId: string,
  spec: Specification,
): ModelFile {
  const next = clone(file);
  const slice = sliceOf(next, sliceId);
  const at = slice.specifications.findIndex((s) => s.id === spec.id);
  if (at === -1) return file;
  slice.specifications[at] = clone(spec);
  return next;
}

export function removeSpecification(file: ModelFile, sliceId: string, specId: string): ModelFile {
  const next = clone(file);
  const slice = sliceOf(next, sliceId);
  slice.specifications = slice.specifications.filter((s) => s.id !== specId);
  return next;
}

/** An empty field of a card. */
export function newField(name = ""): Field {
  return { name, type: "String" };
}

export function setName(file: ModelFile, name: string): ModelFile {
  return { ...clone(file), name };
}

export function setAssigned(file: ModelFile, assigned: string | null): ModelFile {
  const next = clone(file);
  if (assigned) next.assigned = assigned;
  else delete next.assigned;
  return next;
}
