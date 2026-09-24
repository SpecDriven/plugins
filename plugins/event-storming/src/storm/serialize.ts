// The bytes of a `storms/<slug>.storm.json` file: canonical JSON, so the
// file is a deterministic projection of its document (server/doc.ts) and a
// diff reads as the change made on the wall — keys in a fixed order,
// coordinates rounded to whole pixels, two-space indent, one trailing
// newline. Reading is forgiving: whatever a hand edit or another tool left
// is normalized to a board rather than refused, as long as it is JSON.

import {
  MIN_AREA,
  STORM_FORMAT,
  isStickyKind,
  type Area,
  type Arrow,
  type Sticky,
  type StickyKind,
  type StormFile,
} from "./types";

const KEY_ORDER = [
  "format",
  "name",
  "id",
  "kind",
  "label",
  "text",
  "pivotal",
  "x",
  "y",
  "width",
  "height",
  "from",
  "to",
  "stickies",
  "areas",
  "arrows",
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
function canonical(value: unknown): unknown {
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

export function serializeStormFile(file: StormFile): string {
  return `${JSON.stringify(canonical(normalizeStormFile(file, file.name)), null, 2)}\n`;
}

/** Why `text` is not a board file, or null when it is one. */
export function stormTextError(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `not JSON (${(e as Error).message})`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "not a JSON object";
  }
  const format = (parsed as { format?: unknown }).format;
  if (format !== undefined && format !== STORM_FORMAT) return `unknown format ${JSON.stringify(format)}`;
  return null;
}

/** A board from the text of its file; check stormTextError first. */
export function parseStormFile(text: string, fallbackName = ""): StormFile {
  return normalizeStormFile(JSON.parse(text), fallbackName);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

/** A fresh id for a thing on the wall. */
export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Only the format's keys survive, with their types: an unknown kind is a
 * note, a missing id is made up, a duplicate id renamed, an area never
 * smaller than MIN_AREA, and an arrow whose end is gone dropped.
 */
export function normalizeStormFile(raw: unknown, fallbackName = ""): StormFile {
  const r = record(raw);
  const seen = new Set<string>();
  const unique = (id: unknown, prefix: string): string => {
    let out = typeof id === "string" && id.trim() ? id.trim() : newId(prefix);
    while (seen.has(out)) out = newId(prefix);
    seen.add(out);
    return out;
  };
  const stickies: Sticky[] = list(r.stickies).map((s) => ({
    id: unique(s.id, "s"),
    kind: isStickyKind(s.kind) ? s.kind : "note",
    text: str(s.text),
    x: num(s.x),
    y: num(s.y),
    ...(s.pivotal === true && s.kind === "event" ? { pivotal: true } : {}),
  }));
  const areas: Area[] = list(r.areas).map((a) => ({
    id: unique(a.id, "a"),
    label: str(a.label),
    x: num(a.x),
    y: num(a.y),
    width: Math.max(MIN_AREA.width, num(a.width, MIN_AREA.width * 2)),
    height: Math.max(MIN_AREA.height, num(a.height, MIN_AREA.height * 2)),
  }));
  const ids = new Set(stickies.map((s) => s.id));
  const pairs = new Set<string>();
  const arrows: Arrow[] = [];
  for (const a of list(r.arrows)) {
    const from = str(a.from);
    const to = str(a.to);
    if (!ids.has(from) || !ids.has(to) || from === to || pairs.has(`${from}>${to}`)) continue;
    pairs.add(`${from}>${to}`);
    arrows.push({ id: unique(a.id, "r"), from, to });
  }
  return {
    format: STORM_FORMAT,
    name: str(r.name) || fallbackName,
    stickies,
    areas,
    arrows,
  };
}

/** vanillajonathan.github.io/eventstorm's kinds, as this board's. */
const EVENTSTORM_KINDS: Record<string, StickyKind> = {
  actor: "actor",
  aggregate: "aggregate",
  process: "policy",
  command: "command",
  error: "hotspot",
  event: "event",
  external: "external",
  view: "readmodel",
};

/**
 * A board from what an import brought: this format, or the plain list of
 * nodes `{ name, type, x, y }` the Event Storm web app saves.
 */
export function importStorm(raw: unknown, name: string): StormFile {
  if (Array.isArray(raw)) {
    const stickies = raw.map(record).map((n) => ({
      id: str(n.id),
      kind: EVENTSTORM_KINDS[str(n.type)] ?? "note",
      text: str(n.name),
      x: num(n.x),
      y: num(n.y),
    }));
    return normalizeStormFile({ name, stickies }, name);
  }
  const r = record(raw);
  if (!Array.isArray(r.stickies)) throw new Error("Not an Event Storming board: it has no stickies");
  const file = normalizeStormFile(raw, name);
  file.name = name;
  return file;
}
