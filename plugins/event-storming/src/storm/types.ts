// An Event Storming board (Alberto Brandolini's workshop format,
// eventstorming.com): a wall of sticky notes, their colour saying what each
// one is, read left to right as time. The file is the board — the stickies
// where they were put, the areas drawn round them (bounded contexts,
// swimlanes, phases) and any arrows between them — so a board looks the
// same on every screen and a diff of it reads as the change made on it.

/** The file's format marker; a file without it is not a board. */
export const STORM_FORMAT = "specdriven-event-storm/1";

/** The sticky notes of the classic legend. */
export const STICKY_KINDS = [
  "event",
  "command",
  "actor",
  "policy",
  "aggregate",
  "readmodel",
  "external",
  "hotspot",
  "note",
] as const;

export type StickyKind = (typeof STICKY_KINDS)[number];

export interface StickyInfo {
  label: string;
  plural: string;
  /** The paper's colour — the same in both themes, as a sticky is. */
  color: string;
  /** The ink. */
  ink: string;
  width: number;
  height: number;
  /** What the legend says the colour means. */
  meaning: string;
  /** A name of the kind, as the new sticky's placeholder. */
  example: string;
}

/**
 * The legend (eventstorming.com's "The picture that explains everything"):
 * orange events on the timeline, blue commands that cause them, small
 * yellow actors who issue those, lilac policies that react to events, big
 * yellow aggregates that decide, green read models people look at, pink
 * external systems, and magenta hotspots where something is unclear or
 * contested. White notes are anything else worth writing down.
 */
export const STICKY: Record<StickyKind, StickyInfo> = {
  event: {
    label: "Domain event",
    plural: "Domain events",
    color: "#ffa94d",
    ink: "#3d2300",
    width: 128,
    height: 128,
    meaning: "Something that happened that the business cares about, in the past tense.",
    example: "Order placed",
  },
  command: {
    label: "Command",
    plural: "Commands",
    color: "#74c0fc",
    ink: "#0b2a44",
    width: 128,
    height: 128,
    meaning: "A decision or intention that causes an event, in the imperative.",
    example: "Place order",
  },
  actor: {
    label: "Actor",
    plural: "Actors",
    color: "#fff3bf",
    ink: "#3d3200",
    width: 96,
    height: 64,
    meaning: "The person or role who issues a command.",
    example: "Customer",
  },
  policy: {
    label: "Policy",
    plural: "Policies",
    color: "#d0bfff",
    ink: "#2b1a55",
    width: 128,
    height: 128,
    meaning: "A reaction: whenever an event happens, then a command — a rule, a process, an automation.",
    example: "Whenever payment fails, notify the customer",
  },
  aggregate: {
    label: "Aggregate",
    plural: "Aggregates",
    color: "#ffe066",
    ink: "#3d3200",
    width: 160,
    height: 160,
    meaning: "What takes a command and decides which events follow — the rules' keeper.",
    example: "Order",
  },
  readmodel: {
    label: "Read model",
    plural: "Read models",
    color: "#8ce99a",
    ink: "#0e3a17",
    width: 128,
    height: 128,
    meaning: "The information someone looks at to make a decision.",
    example: "Order summary",
  },
  external: {
    label: "External system",
    plural: "External systems",
    color: "#f783ac",
    ink: "#4a0a24",
    width: 176,
    height: 112,
    meaning: "A system outside the domain that events come from or commands go to.",
    example: "Payment provider",
  },
  hotspot: {
    label: "Hotspot",
    plural: "Hotspots",
    color: "#e64980",
    ink: "#ffffff",
    width: 128,
    height: 128,
    meaning: "A problem, question, risk or disagreement to come back to.",
    example: "What if the stock ran out?",
  },
  note: {
    label: "Note",
    plural: "Notes",
    color: "#f8f9fa",
    ink: "#212529",
    width: 128,
    height: 96,
    meaning: "Anything else worth writing down — an opportunity, a comment, a question for later.",
    example: "Ask finance",
  },
};

export function isStickyKind(value: unknown): value is StickyKind {
  return typeof value === "string" && (STICKY_KINDS as readonly string[]).includes(value);
}

/** One sticky note on the wall; `x`, `y` are its top-left corner. */
export interface Sticky {
  id: string;
  kind: StickyKind;
  text: string;
  x: number;
  y: number;
  /**
   * A pivotal event: one after which the story changes phase. The wall
   * draws it with the boundary line the workshop tapes through it.
   */
  pivotal?: boolean;
}

/** An area drawn round stickies: a bounded context, a swimlane, a phase. */
export interface Area {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An arrow from one sticky to another — the process level's reading order. */
export interface Arrow {
  id: string;
  from: string;
  to: string;
}

export interface StormFile {
  format: typeof STORM_FORMAT;
  name: string;
  stickies: Sticky[];
  areas: Area[];
  arrows: Arrow[];
}

export function emptyStormFile(name: string): StormFile {
  return { format: STORM_FORMAT, name, stickies: [], areas: [], arrows: [] };
}

/** The smallest an area can be drawn. */
export const MIN_AREA = { width: 160, height: 120 };
