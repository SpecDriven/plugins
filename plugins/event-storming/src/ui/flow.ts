// The board file as React Flow nodes and edges: the areas underneath, the
// stickies on top — pivotal events a layer below the rest, so the boundary
// line they draw runs behind the stickies it crosses — and the arrows
// between them. Pure: the wall derives these again from the file after
// every edit (StormPane.tsx), keeping only which ones are selected.

import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { STICKY, type Area, type Sticky, type StickyKind, type StormFile } from "../storm/types";

export type StickyNode = Node<{ sticky: Sticky }, "sticky">;
export type AreaNode = Node<{ area: Area }, "area">;
export type WallNode = StickyNode | AreaNode;

export function toFlow(file: StormFile, hidden: ReadonlySet<StickyKind>): { nodes: WallNode[]; edges: Edge[] } {
  const areas: AreaNode[] = file.areas.map((area) => ({
    id: area.id,
    type: "area",
    position: { x: area.x, y: area.y },
    width: area.width,
    height: area.height,
    zIndex: 0,
    dragHandle: ".storm-area-label",
    className: "storm-area-node",
    data: { area },
  }));
  const stickies: StickyNode[] = file.stickies.map((sticky) => ({
    id: sticky.id,
    type: "sticky",
    position: { x: sticky.x, y: sticky.y },
    width: STICKY[sticky.kind].width,
    height: STICKY[sticky.kind].height,
    zIndex: sticky.pivotal ? 1 : 2,
    hidden: hidden.has(sticky.kind),
    data: { sticky },
  }));
  const kinds = new Map(file.stickies.map((s) => [s.id, s.kind]));
  const edges: Edge[] = file.arrows.map((arrow) => ({
    id: arrow.id,
    source: arrow.from,
    target: arrow.to,
    zIndex: 3,
    hidden: hidden.has(kinds.get(arrow.from)!) || hidden.has(kinds.get(arrow.to)!),
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    className: "storm-arrow",
  }));
  return { nodes: [...areas, ...stickies], edges };
}

/** Where the stickies are: their bounds on the wall, or null for an empty wall. */
export function stickyBounds(file: StormFile): { x: number; y: number; right: number; bottom: number } | null {
  if (file.stickies.length === 0) return null;
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const s of file.stickies) {
    const { width, height } = STICKY[s.kind];
    x = Math.min(x, s.x);
    y = Math.min(y, s.y);
    right = Math.max(right, s.x + width);
    bottom = Math.max(bottom, s.y + height);
  }
  return { x, y, right, bottom };
}
