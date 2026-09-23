// The model file as React Flow sees it (roadmap/support-event-modeling.md):
// a node per lane (a row), per slice (a band) and per element (a card), and
// an edge per arrow — derived afresh from the file after every change, so
// the file stays the one source of truth and a card always sits in its cell.

import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { ELEMENT_LISTS, type Element, type Lane, type ModelFile, type Slice } from "../model/types";
import { CARD_H, CARD_W, cardPosition, laneRow, sliceBand } from "./geometry";
import { arrows } from "./mutations";

export type ElementNodeData = { element: Element; sliceId: string; [key: string]: unknown };
export type LaneNodeData = { lane: Lane; index: number; [key: string]: unknown };
export type SliceNodeData = { slice: Slice; index: number; feature?: string; [key: string]: unknown };

export type ElementNode = Node<ElementNodeData, "element">;
export type LaneNode = Node<LaneNodeData, "lane">;
export type SliceNode = Node<SliceNodeData, "slice">;
export type CanvasNode = ElementNode | LaneNode | SliceNode;

/** What is selected on the canvas, as the inspector needs it. */
export type Selection =
  | { kind: "element"; id: string }
  | { kind: "slice"; id: string }
  | { kind: "lane"; id: string };

export const elementNodeId = (id: string) => `el:${id}`;
export const sliceNodeId = (id: string) => `slice:${id}`;
export const laneNodeId = (id: string) => `lane:${id}`;

/** The selection a node id stands for. */
export function selectionOf(nodeId: string): Selection | null {
  const at = nodeId.indexOf(":");
  if (at === -1) return null;
  const kind = nodeId.slice(0, at);
  const id = nodeId.slice(at + 1);
  if (kind === "el") return { kind: "element", id };
  if (kind === "slice") return { kind: "slice", id };
  if (kind === "lane") return { kind: "lane", id };
  return null;
}

export function nodeIdOf(selection: Selection): string {
  switch (selection.kind) {
    case "element":
      return elementNodeId(selection.id);
    case "slice":
      return sliceNodeId(selection.id);
    case "lane":
      return laneNodeId(selection.id);
  }
}

export function toFlow(file: ModelFile): { nodes: CanvasNode[]; edges: Edge[] } {
  const { model, layout } = file;
  const nodes: CanvasNode[] = [];
  layout.lanes.forEach((lane, index) => {
    const rect = laneRow(model, layout, index);
    nodes.push({
      id: laneNodeId(lane.id),
      type: "lane",
      position: { x: rect.x, y: rect.y },
      data: { lane, index },
      style: { width: rect.width, height: rect.height },
      draggable: false,
      connectable: false,
      deletable: false,
      zIndex: -2,
    });
  });
  const positions = new Map<string, { x: number; y: number }>();
  model.slices.forEach((slice, index) => {
    const rect = sliceBand(model, layout, index);
    nodes.push({
      id: sliceNodeId(slice.id),
      type: "slice",
      position: { x: rect.x, y: rect.y },
      data: { slice, index, feature: file.links[slice.id]?.feature },
      style: { width: rect.width, height: rect.height },
      draggable: false,
      connectable: false,
      deletable: false,
      zIndex: -1,
    });
    for (const list of ELEMENT_LISTS) {
      for (const element of slice[list]) {
        const position = cardPosition(model, layout, slice, element.id);
        positions.set(element.id, position);
        nodes.push({
          id: elementNodeId(element.id),
          type: "element",
          position,
          data: { element, sliceId: slice.id },
          style: { width: CARD_W, height: CARD_H },
          zIndex: 1,
        });
      }
    }
  });
  const edges: Edge[] = arrows(file).map(({ from, to }) => {
    const a = positions.get(from)!;
    const b = positions.get(to)!;
    // An arrow leaves the card on the side facing where it goes: down to
    // the card below, up to the one above, right along a lane.
    const [sourceHandle, targetHandle] =
      b.y > a.y + CARD_H / 2
        ? ["s-bottom", "t-top"]
        : b.y < a.y - CARD_H / 2
          ? ["s-top", "t-bottom"]
          : ["s-right", "t-left"];
    return {
      id: `${from}->${to}`,
      source: elementNodeId(from),
      target: elementNodeId(to),
      sourceHandle,
      targetHandle,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      className: "em-edge",
    };
  });
  return { nodes, edges };
}

/** The (from, to) element ids of an edge id. */
export function edgeEnds(edgeId: string): { from: string; to: string } | null {
  const at = edgeId.indexOf("->");
  if (at === -1) return null;
  return { from: edgeId.slice(0, at), to: edgeId.slice(at + 2) };
}
