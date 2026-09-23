// The bytes of a `models/<slug>.model.json` file: canonical JSON, so the
// file is a deterministic projection of its document (automerge/model.ts)
// and a diff of it in a pull request reads as the change that was made —
// keys in a fixed order, two-space indent, one trailing newline.

import {
  DEFAULT_LANES,
  ELEMENT_LISTS,
  MODEL_FORMAT,
  laneKindOf,
  type Element,
  type EventModel,
  type LaneKind,
  type Layout,
  type Links,
  type ModelFile,
  type Slice,
} from "./types";

/**
 * Keys written first, in this order; anything else follows alphabetically.
 * Identity and naming lead so a reader knows what an object is before its
 * details, and the file's own halves come in the order they are read.
 */
const KEY_ORDER = [
  "format",
  "name",
  "assigned",
  "id",
  "title",
  "type",
  "sliceType",
  "status",
  "index",
  "context",
  "model",
  "layout",
  "links",
  "slices",
  "lanes",
  "elements",
  "screens",
  "processors",
  "commands",
  "readmodels",
  "events",
  "tables",
  "specifications",
  "given",
  "when",
  "then",
  "fields",
  "dependencies",
];

const RANK = new Map(KEY_ORDER.map((key, i) => [key, i]));

function compareKeys(a: string, b: string): number {
  const ra = RANK.get(a);
  const rb = RANK.get(b);
  if (ra !== undefined && rb !== undefined) return ra - rb;
  if (ra !== undefined) return -1;
  if (rb !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A plain copy of `value` with every object's keys in canonical order. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort(compareKeys)) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/** The file's bytes for a model. */
export function serializeModelFile(file: ModelFile): string {
  return `${JSON.stringify(canonical(file), null, 2)}\n`;
}

/** The bytes of an export: the schema's half alone, ready for other tools. */
export function serializeExport(model: EventModel): string {
  return `${JSON.stringify(canonical(model), null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

/**
 * An element as the schema shapes it, with the required lists present. Only
 * the keys the schema knows survive, so a file hand-edited with a typo'd key
 * cannot smuggle it into an export.
 */
function normalizeElement(raw: unknown, type: Element["type"]): Element | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.title !== "string") return null;
  const element: Element = {
    id: raw.id,
    title: raw.title,
    type,
    fields: Array.isArray(raw.fields) ? (raw.fields as Element["fields"]) : [],
    dependencies: Array.isArray(raw.dependencies)
      ? (raw.dependencies as Element["dependencies"])
      : [],
  };
  const optional = [
    "description",
    "groupId",
    "domain",
    "modelContext",
    "context",
    "slice",
    "aggregate",
    "apiEndpoint",
    "service",
    "createsAggregate",
    "sketched",
    "prototype",
    "listElement",
  ] as const;
  for (const key of optional) {
    if (raw[key] !== undefined) (element as Record<string, unknown>)[key] = raw[key];
  }
  for (const key of ["tags", "aggregateDependencies", "triggers"] as const) {
    const list = strings(raw[key]);
    if (list) element[key] = list;
  }
  return element;
}

const LIST_TYPE = {
  screens: "SCREEN",
  processors: "AUTOMATION",
  commands: "COMMAND",
  readmodels: "READMODEL",
  events: "EVENT",
} as const;

function normalizeSlice(raw: unknown): Slice | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const slice: Slice = {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "",
    sliceType:
      raw.sliceType === "STATE_VIEW" || raw.sliceType === "AUTOMATION"
        ? raw.sliceType
        : "STATE_CHANGE",
    screens: [],
    processors: [],
    commands: [],
    readmodels: [],
    events: [],
    tables: Array.isArray(raw.tables) ? (raw.tables as Slice["tables"]) : [],
    specifications: Array.isArray(raw.specifications)
      ? (raw.specifications as Slice["specifications"])
      : [],
  };
  for (const list of ELEMENT_LISTS) {
    const items = Array.isArray(raw[list]) ? raw[list] : [];
    slice[list] = (items as unknown[])
      .map((item) => normalizeElement(item, LIST_TYPE[list]))
      .filter((e): e is Element => e !== null);
  }
  if (raw.status === "Created" || raw.status === "InProgress" || raw.status === "Done") {
    slice.status = raw.status;
  }
  if (typeof raw.index === "number") slice.index = raw.index;
  if (typeof raw.context === "string") slice.context = raw.context;
  if (Array.isArray(raw.screenImages)) slice.screenImages = raw.screenImages as Slice["screenImages"];
  if (Array.isArray(raw.actors)) slice.actors = raw.actors as Slice["actors"];
  const aggregates = strings(raw.aggregates);
  if (aggregates) slice.aggregates = aggregates;
  return slice;
}

/** The schema's half of a file — or of an import — with every list present. */
export function normalizeModel(raw: unknown): EventModel {
  const slices = isRecord(raw) && Array.isArray(raw.slices) ? raw.slices : [];
  return {
    slices: slices.map(normalizeSlice).filter((s): s is Slice => s !== null),
  };
}

function normalizeLayout(raw: unknown, model: EventModel): Layout {
  const layout: Layout = {
    lanes: DEFAULT_LANES.map((lane) => ({ ...lane })),
    slices: {},
    elements: {},
  };
  if (!isRecord(raw)) return layout;
  if (Array.isArray(raw.lanes)) {
    const lanes = raw.lanes.filter(
      (lane): lane is Layout["lanes"][number] =>
        isRecord(lane) &&
        typeof lane.id === "string" &&
        typeof lane.title === "string" &&
        (lane.kind === "SCREEN_AUTOMATION" ||
          lane.kind === "COMMAND_READMODEL" ||
          lane.kind === "EVENTS"),
    );
    if (lanes.length > 0) {
      layout.lanes = lanes.map((lane) => ({
        id: lane.id,
        kind: lane.kind,
        title: lane.title,
        ...(typeof lane.aggregate === "string" ? { aggregate: lane.aggregate } : {}),
      }));
    }
  }
  // Every lane kind must be there for placement to have somewhere to go.
  for (const lane of DEFAULT_LANES) {
    if (!layout.lanes.some((l) => l.kind === lane.kind)) layout.lanes.push({ ...lane });
  }
  const sliceIds = new Set(model.slices.map((s) => s.id));
  if (isRecord(raw.slices)) {
    for (const [id, span] of Object.entries(raw.slices)) {
      if (!sliceIds.has(id) || !isRecord(span) || typeof span.width !== "number") continue;
      layout.slices[id] = { width: Math.max(1, Math.floor(span.width)) };
    }
  }
  const laneIds = new Set(layout.lanes.map((l) => l.id));
  if (isRecord(raw.elements)) {
    for (const [id, place] of Object.entries(raw.elements)) {
      if (
        !isRecord(place) ||
        typeof place.lane !== "string" ||
        typeof place.column !== "number" ||
        !laneIds.has(place.lane)
      ) {
        continue;
      }
      layout.elements[id] = { lane: place.lane, column: Math.max(0, Math.floor(place.column)) };
    }
  }
  return layout;
}

function normalizeLinks(raw: unknown, model: EventModel): Links {
  const links: Links = {};
  if (!isRecord(raw)) return links;
  const sliceIds = new Set(model.slices.map((s) => s.id));
  for (const [id, link] of Object.entries(raw)) {
    if (!sliceIds.has(id) || !isRecord(link)) continue;
    links[id] = typeof link.feature === "string" ? { feature: link.feature } : {};
  }
  return links;
}

/**
 * A file's contents as a ModelFile, whatever an older version or a hand
 * edit left in it: missing lists come back empty, placements of lanes or
 * elements that are gone are dropped, and unknown keys do not survive.
 * A bare export (just `slices`) reads as a model with no layout — the
 * canvas lays it out on first open.
 */
export function normalizeModelFile(raw: unknown, fallbackName = ""): ModelFile {
  const record = isRecord(raw) ? raw : {};
  const bare = !("model" in record) && "slices" in record;
  const model = normalizeModel(bare ? record : record.model);
  const file: ModelFile = {
    format: MODEL_FORMAT,
    name: typeof record.name === "string" ? record.name : fallbackName,
    model,
    layout: normalizeLayout(record.layout, model),
    links: normalizeLinks(record.links, model),
  };
  if (typeof record.assigned === "string" && record.assigned) file.assigned = record.assigned;
  // A placement of an element that is gone, or in a lane of the wrong
  // kind, is no placement.
  const lanes = new Map(file.layout.lanes.map((lane) => [lane.id, lane]));
  const kinds = new Map<string, LaneKind>();
  for (const slice of model.slices) {
    for (const list of ELEMENT_LISTS) {
      for (const element of slice[list]) kinds.set(element.id, laneKindOf(element.type));
    }
  }
  for (const [id, place] of Object.entries(file.layout.elements)) {
    const kind = kinds.get(id);
    if (kind === undefined || lanes.get(place.lane)?.kind !== kind) {
      delete file.layout.elements[id];
    }
  }
  return file;
}

/** Why `text` is not a model file, or null when it is one. */
export function modelTextError(text: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return `not valid JSON: ${(e as Error).message}`;
  }
  if (!isRecord(raw)) return "not a JSON object";
  if (!("model" in raw) && !("slices" in raw)) return "no `model` (or `slices`) key";
  return null;
}

/** A file's contents parsed and normalized; throws on text that is no model. */
export function parseModelFile(text: string, fallbackName = ""): ModelFile {
  const error = modelTextError(text);
  if (error !== null) throw new Error(`Invalid model file: ${error}`);
  return normalizeModelFile(JSON.parse(text), fallbackName);
}
