// Every gesture on the wall as a pure edit of the board file: the wall
// derives its nodes and edges from the file again (flow.ts), autosaves it,
// and keeps the files it passed through for Undo — so nothing here touches
// React Flow, and every edit is testable on its own.

import { newId } from "../storm/serialize";
import { MIN_AREA, STICKY, type Area, type Sticky, type StickyKind, type StormFile } from "../storm/types";

/** The grid the wall snaps to. */
export const GRID = 16;

export const snap = (n: number) => Math.round(n / GRID) * GRID;

/** A new sticky centred on a point of the wall. */
export function addSticky(
  file: StormFile,
  kind: StickyKind,
  at: { x: number; y: number },
  text = "",
): { file: StormFile; id: string } {
  const { width, height } = STICKY[kind];
  const id = newId("s");
  const sticky: Sticky = { id, kind, text, x: snap(at.x - width / 2), y: snap(at.y - height / 2) };
  return { file: { ...file, stickies: [...file.stickies, sticky] }, id };
}

/** A new area centred on a point of the wall. */
export function addArea(file: StormFile, at: { x: number; y: number }, label = ""): { file: StormFile; id: string } {
  const width = MIN_AREA.width * 3;
  const height = MIN_AREA.height * 3;
  const id = newId("a");
  const area: Area = { id, label, x: snap(at.x - width / 2), y: snap(at.y - height / 2), width, height };
  return { file: { ...file, areas: [...file.areas, area] }, id };
}

export function updateSticky(file: StormFile, id: string, patch: Partial<Omit<Sticky, "id">>): StormFile {
  return {
    ...file,
    stickies: file.stickies.map((s) => {
      if (s.id !== id) return s;
      const next: Sticky = { ...s, ...patch };
      // Only an event can be pivotal; a sticky turned into anything else drops it.
      if (next.kind !== "event" || !next.pivotal) delete next.pivotal;
      return next;
    }),
  };
}

export function updateArea(file: StormFile, id: string, patch: Partial<Omit<Area, "id">>): StormFile {
  return {
    ...file,
    areas: file.areas.map((a) =>
      a.id === id
        ? {
            ...a,
            ...patch,
            width: Math.max(MIN_AREA.width, Math.round(patch.width ?? a.width)),
            height: Math.max(MIN_AREA.height, Math.round(patch.height ?? a.height)),
          }
        : a,
    ),
  };
}

/** Stickies and areas where a drag left them, by id. */
export function moveTo(file: StormFile, positions: Map<string, { x: number; y: number }>): StormFile {
  const moved = <T extends { id: string; x: number; y: number }>(item: T): T => {
    const at = positions.get(item.id);
    return at && (at.x !== item.x || at.y !== item.y) ? { ...item, x: Math.round(at.x), y: Math.round(at.y) } : item;
  };
  return { ...file, stickies: file.stickies.map(moved), areas: file.areas.map(moved) };
}

/** Everything named gone — stickies, areas, arrows — and the arrows of a gone sticky with it. */
export function removeIds(file: StormFile, ids: Iterable<string>): StormFile {
  const gone = new Set(ids);
  const stickies = file.stickies.filter((s) => !gone.has(s.id));
  const left = new Set(stickies.map((s) => s.id));
  return {
    ...file,
    stickies,
    areas: file.areas.filter((a) => !gone.has(a.id)),
    arrows: file.arrows.filter((a) => !gone.has(a.id) && left.has(a.from) && left.has(a.to)),
  };
}

/** An arrow from one sticky to another; null when there is one already, or it points at itself. */
export function connect(file: StormFile, from: string, to: string): StormFile | null {
  if (from === to || file.arrows.some((a) => a.from === from && a.to === to)) return null;
  const ids = new Set(file.stickies.map((s) => s.id));
  if (!ids.has(from) || !ids.has(to)) return null;
  return { ...file, arrows: [...file.arrows, { id: newId("r"), from, to }] };
}

/**
 * A copy of the stickies and areas named, a grid step down and right, with
 * the arrows between copied stickies copied too; the copies' ids come back
 * so the wall can select them.
 */
export function duplicate(file: StormFile, ids: Iterable<string>): { file: StormFile; ids: string[] } {
  const wanted = new Set(ids);
  const renamed = new Map<string, string>();
  const offset = GRID * 2;
  const stickies = file.stickies
    .filter((s) => wanted.has(s.id))
    .map((s) => {
      const id = newId("s");
      renamed.set(s.id, id);
      return { ...s, id, x: s.x + offset, y: s.y + offset };
    });
  const areas = file.areas
    .filter((a) => wanted.has(a.id))
    .map((a) => {
      const id = newId("a");
      renamed.set(a.id, id);
      return { ...a, id, x: a.x + offset, y: a.y + offset };
    });
  const arrows = file.arrows
    .filter((a) => renamed.has(a.from) && renamed.has(a.to))
    .map((a) => ({ id: newId("r"), from: renamed.get(a.from)!, to: renamed.get(a.to)! }));
  return {
    file: {
      ...file,
      stickies: [...file.stickies, ...stickies],
      areas: [...file.areas, ...areas],
      arrows: [...file.arrows, ...arrows],
    },
    ids: [...renamed.values()],
  };
}

export function setName(file: StormFile, name: string): StormFile {
  return { ...file, name };
}
