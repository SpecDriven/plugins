// The Automerge system-of-record for an Event Model — the document behind
// each `models/<slug>.model.json`, kept in the app's own store through
// `@specdriven/host` (one per file, under `.specdriven/automerge/
// event-models/`). The file is the document's canonical JSON
// (src/model/serialize.ts), so two people on the same canvas merge at the
// CRDT level: a card moved here and a title edited there both land, because
// the model is kept as nested maps and lists rather than as one string.
// Lists of things with an id — slices, elements, fields, specifications —
// are reconciled by id, so concurrent additions to the same slice both
// survive; titles and descriptions are collaborative text.

import { A, newFileDoc } from "@specdriven/host";
import { serializeModelFile } from "../model/serialize";
import { MODEL_FORMAT, type EventModel, type Layout, type Links, type ModelFile } from "../model/types";

/** The document's schema version; the store keeps it beside the id. */
export const MODEL_SCHEMA_VERSION = 1;

/**
 * An Event Model's document: the model half keeps the published schema's
 * shape (src/model/types.ts) as nested maps and lists, so a title edited
 * here and a card moved there both land; titles and descriptions are
 * collaborative text.
 */
export type ModelDoc = {
  schemaVersion: number;
  /** Stable identity of the document, independent of its file path. */
  id: string;
  /** The model's name — the file's `name`, what the sidebar lists. */
  name: string;
  /** The published schema's half: the slices and everything in them. */
  model: EventModel;
  /** Where each card sits on the canvas. */
  layout: Layout;
  /** Which feature file holds each slice's scenarios. */
  links: Links;
  /** Name of the project member the model is assigned to; set whole. */
  assigned?: string;
};

/** A plain copy of an Automerge value — the doc's objects are frozen proxies. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The doc's view of the model file. */
export function docToModel(doc: A.Doc<ModelDoc>): ModelFile {
  return {
    format: MODEL_FORMAT,
    name: doc.name,
    ...(doc.assigned ? { assigned: doc.assigned } : {}),
    model: plain(doc.model),
    layout: plain(doc.layout),
    links: plain(doc.links),
  };
}

/** The JSON this document projects to. */
export function projectModel(doc: A.Doc<ModelDoc>): string {
  return serializeModelFile(docToModel(doc));
}

/** Whether `text` is what this document projects to. */
export function isModelProjectionOf(text: string, doc: A.Doc<ModelDoc>): boolean {
  return text === projectModel(doc);
}

/** Create a document from a parsed file (first import). */
export function importModelDoc(file: ModelFile): A.Doc<ModelDoc> {
  return newFileDoc<Omit<ModelDoc, "schemaVersion" | "id">>(MODEL_SCHEMA_VERSION, {
    name: file.name,
    model: plain(file.model),
    layout: plain(file.layout),
    links: plain(file.links),
    ...(file.assigned ? { assigned: file.assigned } : {}),
  });
}

type Path = (string | number)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether every item of a list has a string `id` — a list merged by id. */
function keyed(list: unknown[]): list is { id: string }[] {
  return list.length > 0 && list.every((item) => isRecord(item) && typeof item.id === "string");
}

/** The node at `path` inside the change proxy. */
function at(root: unknown, path: Path): unknown {
  let node = root;
  for (const key of path) node = (node as Record<string | number, unknown>)[key];
  return node;
}

/**
 * Drive the value at `path` toward `target`, as narrowly as the shapes
 * allow: keys of a map set or deleted one by one, a string as a text
 * splice, a keyed list in place item by item, and anything else replaced
 * whole. `current` is the doc's value there as loaded (not the proxy), so
 * the comparison never touches the proxy's accessors.
 */
function reconcileValue(root: unknown, path: Path, current: unknown, target: unknown): void {
  if (typeof target === "string" && typeof current === "string") {
    if (current !== target) A.updateText(root as A.Doc<unknown>, path, target);
    return;
  }
  if (Array.isArray(target) && Array.isArray(current)) {
    if (keyed(target) && (current.length === 0 || keyed(current))) {
      reconcileList(root, path, current as { id: string }[], target);
      return;
    }
    if (JSON.stringify(current) !== JSON.stringify(target)) set(root, path, target);
    return;
  }
  if (isRecord(target) && isRecord(current)) {
    for (const key of Object.keys(current)) {
      if (target[key] === undefined) delete (at(root, path) as Record<string, unknown>)[key];
    }
    for (const [key, value] of Object.entries(target)) {
      if (value === undefined) continue;
      if (current[key] === undefined) set(root, [...path, key], value);
      else reconcileValue(root, [...path, key], current[key], value);
    }
    return;
  }
  if (current !== target) set(root, path, target);
}

/** Assign a plain copy of `value` at `path`. */
function set(root: unknown, path: Path, value: unknown): void {
  const parent = at(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]!] = plain(value);
}

/**
 * A list of things with ids: items gone from the target are removed, items
 * new to it inserted where the target has them, items in both reconciled in
 * place — so an edit inside one element survives another element being
 * added beside it — and the order made to match the target's.
 */
function reconcileList(
  root: unknown,
  path: Path,
  current: { id: string }[],
  target: { id: string }[],
): void {
  const list = at(root, path) as unknown[];
  const wanted = new Set(target.map((item) => item.id));
  // Remove, from the end so indexes stay valid.
  const kept: { id: string }[] = [];
  for (let i = current.length - 1; i >= 0; i--) {
    if (!wanted.has(current[i]!.id)) list.splice(i, 1);
    else kept.unshift(current[i]!);
  }
  // Insert or update, walking the target in order; a kept item found out of
  // order is moved (removed and re-inserted) — its concurrent edits ride the
  // loser of that rare race, which the file's next drift pass repairs.
  const live = [...kept];
  target.forEach((item, index) => {
    const have = live.findIndex((k) => k.id === item.id);
    if (have === -1) {
      list.splice(index, 0, plain(item));
      live.splice(index, 0, item);
      return;
    }
    if (have !== index) {
      list.splice(have, 1);
      list.splice(index, 0, plain(item));
      live.splice(have, 1);
      live.splice(index, 0, item);
      return;
    }
    reconcileValue(root, [...path, index], live[index], item);
    live[index] = item;
  });
}

/**
 * Drive the document toward a parsed file: the name as a text splice, the
 * model, layout and links reconciled structurally, and the assignment set
 * whole — it is not text to merge, and concurrent changes to it resolve to
 * the same winner on every peer (reconcile.ts).
 */
export function reconcileModel(doc: A.Doc<ModelDoc>, target: ModelFile): A.Doc<ModelDoc> {
  const current = docToModel(doc);
  return A.change(doc, (d) => {
    if (d.name !== target.name) A.updateText(d, ["name"], target.name);
    reconcileValue(d, ["model"], current.model, target.model);
    reconcileValue(d, ["layout"], current.layout, target.layout);
    reconcileValue(d, ["links"], current.links, target.links);
    if ((current.assigned ?? "") !== (target.assigned ?? "")) {
      if (target.assigned) d.assigned = target.assigned;
      else delete d.assigned;
    }
  });
}
