// Event Modeling (roadmap/support-event-modeling.md): the model behind a
// `models/<slug>.model.json` file. The `model` half mirrors Martin Dilger's
// Event Modeling Specification JSON Schema (eventmodeling.schema.json beside
// this file, vendored from github.com/dilgerma/event-modeling-spec) key for
// key, so an export of it validates against the published schema and opens
// in the tools that speak it. The schema forbids unknown keys at every
// level, so what SpecDriven adds — where each element sits on the canvas,
// and which feature file a slice's Given/When/Then lives in — sits beside it
// under `layout` and `links`, never inside it.

/** What an element is — the five card colours of an Event Model. */
export type ElementType = "COMMAND" | "EVENT" | "READMODEL" | "SCREEN" | "AUTOMATION";

export const ELEMENT_TYPES: readonly ElementType[] = [
  "SCREEN",
  "COMMAND",
  "EVENT",
  "READMODEL",
  "AUTOMATION",
];

/** The pattern a slice is: state change, state view, or automation. */
export type SliceType = "STATE_CHANGE" | "STATE_VIEW" | "AUTOMATION";

export const SLICE_TYPES: readonly SliceType[] = ["STATE_CHANGE", "STATE_VIEW", "AUTOMATION"];

export type SliceStatus = "Created" | "InProgress" | "Done";

export const SLICE_STATUSES: readonly SliceStatus[] = ["Created", "InProgress", "Done"];

export type FieldType =
  | "String"
  | "Boolean"
  | "Double"
  | "Decimal"
  | "Long"
  | "Custom"
  | "Date"
  | "DateTime"
  | "UUID"
  | "Int";

export const FIELD_TYPES: readonly FieldType[] = [
  "String",
  "Boolean",
  "Double",
  "Decimal",
  "Long",
  "Custom",
  "Date",
  "DateTime",
  "UUID",
  "Int",
];

export type Cardinality = "List" | "Single";

/** Which way a dependency points, seen from the element that carries it. */
export type DependencyType = "INBOUND" | "OUTBOUND";

export type SpecStepType = "SPEC_EVENT" | "SPEC_COMMAND" | "SPEC_READMODEL" | "SPEC_ERROR";

/** A typed attribute of a command, event, read model or table. */
export type Field = {
  name: string;
  type: FieldType;
  example?: string | Record<string, unknown>;
  subfields?: Field[];
  mapping?: string;
  optional?: boolean;
  technicalAttribute?: boolean;
  generated?: boolean;
  idAttribute?: boolean;
  pii?: boolean;
  schema?: string;
  cardinality?: Cardinality;
};

/**
 * One end of an arrow. An arrow from A to B is an OUTBOUND dependency on A
 * naming B and an INBOUND one on B naming A — both are written, so either
 * element tells the whole story on its own.
 */
export type Dependency = {
  /** The element at the other end. */
  id: string;
  type: DependencyType;
  title: string;
  elementType: ElementType;
};

/** A card on the canvas: a screen, command, event, read model or automation. */
export type Element = {
  id: string;
  title: string;
  type: ElementType;
  fields: Field[];
  dependencies: Dependency[];
  description?: string;
  groupId?: string;
  tags?: string[];
  domain?: string;
  modelContext?: string;
  /** Whether the element belongs to this system or to one it talks to. */
  context?: "INTERNAL" | "EXTERNAL";
  /** The slice the element belongs to — the one whose list it sits in. */
  slice?: string;
  aggregate?: string;
  aggregateDependencies?: string[];
  apiEndpoint?: string;
  service?: string | null;
  createsAggregate?: boolean;
  triggers?: string[];
  sketched?: boolean;
  prototype?: Record<string, unknown>;
  listElement?: boolean;
};

/** One row of a Given / When / Then: an event, command, read model or error. */
export type SpecificationStep = {
  id: string;
  title: string;
  type: SpecStepType;
  tags?: string[];
  examples?: Record<string, unknown>[];
  index?: number;
  specRow?: number;
  fields?: Field[];
  /** The element this step stands for, when it stands for one. */
  linkedId?: string;
  expectEmptyList?: boolean;
};

/** A Given / When / Then example of a slice — what a scenario is to a feature. */
export type Specification = {
  id: string;
  title: string;
  given: SpecificationStep[];
  when: SpecificationStep[];
  then: SpecificationStep[];
  linkedId: string;
  vertical?: boolean;
  sliceName?: string;
  comments?: { description: string }[];
};

export type Actor = { name: string; authRequired: boolean };

export type Table = { id: string; title: string; fields: Field[] };

export type ScreenImage = { id: string; title: string; url?: string };

/**
 * A vertical slice: the smallest piece of the model that can be handed to
 * someone to build. Its elements live in the typed lists below; the canvas
 * shows them as one band across the swimlanes.
 */
export type Slice = {
  id: string;
  title: string;
  sliceType: SliceType;
  commands: Element[];
  events: Element[];
  readmodels: Element[];
  screens: Element[];
  processors: Element[];
  tables: Table[];
  specifications: Specification[];
  status?: SliceStatus;
  index?: number;
  context?: string;
  screenImages?: ScreenImage[];
  actors?: Actor[];
  aggregates?: string[];
};

/** The whole model, as the published schema shapes it. */
export type EventModel = { slices: Slice[] };

/** The list of a slice that holds elements of one type. */
export const SLICE_LIST: Record<ElementType, keyof Pick<Slice, "commands" | "events" | "readmodels" | "screens" | "processors">> = {
  COMMAND: "commands",
  EVENT: "events",
  READMODEL: "readmodels",
  SCREEN: "screens",
  AUTOMATION: "processors",
};

export const ELEMENT_LISTS = ["screens", "processors", "commands", "readmodels", "events"] as const;

// ---- SpecDriven's half: the canvas and the bridge to the specs ----

/**
 * What a swimlane holds. The canvas is the classic three rows — screens and
 * automations on top, commands and read models in the middle, events at the
 * bottom — and grows an events lane per stream when the model needs one.
 */
export type LaneKind = "SCREEN_AUTOMATION" | "COMMAND_READMODEL" | "EVENTS";

export type Lane = {
  id: string;
  kind: LaneKind;
  title: string;
  /** An events lane for one stream: the aggregate its events belong to. */
  aggregate?: string;
};

/**
 * Where an element sits: which lane, and which column of its slice's band,
 * counted from the band's left edge. Slices stand side by side in model
 * order, each as wide as `layout.slices` says, so the grid needs no pixels
 * — the canvas derives them, and a diff of the file stays small.
 */
export type Placement = { lane: string; column: number };

export type Layout = {
  lanes: Lane[];
  /** How many columns each slice's band spans; a slice not listed spans one. */
  slices: { [sliceId: string]: { width: number } };
  elements: { [elementId: string]: Placement };
};

/** What ties a slice to the specs: the feature file holding its scenarios. */
export type Links = { [sliceId: string]: { feature?: string } };

export const MODEL_FORMAT = "specdriven-event-model/1";

/** A `models/<slug>.model.json` file, whole. */
export type ModelFile = {
  format: typeof MODEL_FORMAT;
  name: string;
  assigned?: string;
  model: EventModel;
  layout: Layout;
  links: Links;
};

export const DEFAULT_LANES: Lane[] = [
  { id: "ui", kind: "SCREEN_AUTOMATION", title: "Screens / Automations" },
  { id: "cmd", kind: "COMMAND_READMODEL", title: "Commands / Read models" },
  { id: "events", kind: "EVENTS", title: "Events" },
];

/** The lane kind an element type belongs in. */
export function laneKindOf(type: ElementType): LaneKind {
  switch (type) {
    case "SCREEN":
    case "AUTOMATION":
      return "SCREEN_AUTOMATION";
    case "COMMAND":
    case "READMODEL":
      return "COMMAND_READMODEL";
    case "EVENT":
      return "EVENTS";
  }
}

/** An empty model with the three default lanes. */
export function emptyModelFile(name: string): ModelFile {
  return {
    format: MODEL_FORMAT,
    name,
    model: { slices: [] },
    layout: { lanes: DEFAULT_LANES.map((lane) => ({ ...lane })), slices: {}, elements: {} },
    links: {},
  };
}

/** Every element of the model, in slice order then list order. */
export function allElements(model: EventModel): { slice: Slice; element: Element }[] {
  const out: { slice: Slice; element: Element }[] = [];
  for (const slice of model.slices) {
    for (const list of ELEMENT_LISTS) {
      for (const element of slice[list]) out.push({ slice, element });
    }
  }
  return out;
}

/** The slice and element an id names, or null. */
export function findElement(
  model: EventModel,
  id: string,
): { slice: Slice; element: Element } | null {
  for (const slice of model.slices) {
    for (const list of ELEMENT_LISTS) {
      const element = slice[list].find((e) => e.id === id);
      if (element) return { slice, element };
    }
  }
  return null;
}

/**
 * Which connections an Event Model allows (eventmodeling.org cheat sheet):
 * a screen or an automation issues a command; a command yields events; events
 * feed read models; a read model feeds a screen or an automation; and an
 * event of another system feeds an automation directly (translation).
 */
export function canConnect(from: ElementType, to: ElementType): boolean {
  switch (from) {
    case "SCREEN":
      return to === "COMMAND";
    case "AUTOMATION":
      return to === "COMMAND";
    case "COMMAND":
      return to === "EVENT";
    case "EVENT":
      return to === "READMODEL" || to === "AUTOMATION";
    case "READMODEL":
      return to === "SCREEN" || to === "AUTOMATION";
  }
}

/** The pattern a slice's members make it, or null for an empty one. */
export function inferSliceType(slice: Slice): SliceType | null {
  if (slice.processors.length > 0) return "AUTOMATION";
  if (slice.commands.length > 0) return "STATE_CHANGE";
  if (slice.readmodels.length > 0 || slice.screens.length > 0 || slice.events.length > 0) {
    return "STATE_VIEW";
  }
  return null;
}
