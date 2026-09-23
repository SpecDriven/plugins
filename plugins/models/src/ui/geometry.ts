// The canvas's coordinates (roadmap/support-event-modeling.md): the grid a
// model is laid out on (src/model/layout.ts) turned into pixels,
// and back. Slices are bands standing side by side, lanes are rows, and a
// card sits in one cell of the band it belongs to. The file never holds a
// pixel — a card dropped anywhere snaps to the cell under it.

import { sliceStart, sliceWidth } from "../model/layout";
import type { EventModel, Layout, Slice } from "../model/types";

/** The lane titles' gutter on the left. */
export const LANE_HEADER_W = 170;
/** The slice titles' strip along the top. */
export const SLICE_HEADER_H = 40;
export const COL_W = 230;
export const LANE_H = 140;
export const CARD_W = 180;
export const CARD_H = 88;
/** Spare columns to the right of the last band — room to drop a card past it. */
export const SPARE_COLS = 1;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The columns the model spans, all bands together. */
export function totalColumns(model: EventModel, layout: Layout): number {
  return sliceStart(model, layout, model.slices.length);
}

/** The band of the slice at `index`. */
export function sliceBand(model: EventModel, layout: Layout, index: number): Rect {
  const slice = model.slices[index]!;
  return {
    x: LANE_HEADER_W + sliceStart(model, layout, index) * COL_W,
    y: 0,
    width: sliceWidth(layout, slice) * COL_W,
    height: SLICE_HEADER_H + layout.lanes.length * LANE_H,
  };
}

/** The row of the lane at `index`, as wide as the whole canvas. */
export function laneRow(model: EventModel, layout: Layout, index: number): Rect {
  return {
    x: 0,
    y: SLICE_HEADER_H + index * LANE_H,
    width: LANE_HEADER_W + (totalColumns(model, layout) + SPARE_COLS) * COL_W,
    height: LANE_H,
  };
}

/** The top-left corner of the card of an element placed in `slice`. */
export function cardPosition(
  model: EventModel,
  layout: Layout,
  slice: Slice,
  elementId: string,
): { x: number; y: number } {
  const place = layout.elements[elementId];
  const index = model.slices.indexOf(slice);
  const start = sliceStart(model, layout, Math.max(0, index));
  const laneIndex = Math.max(
    0,
    layout.lanes.findIndex((lane) => lane.id === place?.lane),
  );
  const column = place?.column ?? 0;
  return {
    x: LANE_HEADER_W + (start + column) * COL_W + (COL_W - CARD_W) / 2,
    y: SLICE_HEADER_H + laneIndex * LANE_H + (LANE_H - CARD_H) / 2,
  };
}

/** Where a card dropped with its top-left at (x, y) belongs. */
export interface DropTarget {
  sliceId: string;
  lane: string;
  column: number;
}

/**
 * The cell under a card's centre: which band, which column of it, which
 * lane. Past the last band the card lands in the last slice's next column
 * (the band grows); off the top or bottom it keeps to the nearest lane.
 * Null with no slices — there is no band to land in.
 */
export function dropTarget(
  model: EventModel,
  layout: Layout,
  x: number,
  y: number,
): DropTarget | null {
  if (model.slices.length === 0 || layout.lanes.length === 0) return null;
  const cx = x + CARD_W / 2;
  const cy = y + CARD_H / 2;
  const col = Math.max(0, Math.floor((cx - LANE_HEADER_W) / COL_W));
  const laneIndex = Math.min(
    layout.lanes.length - 1,
    Math.max(0, Math.floor((cy - SLICE_HEADER_H) / LANE_H)),
  );
  const lane = layout.lanes[laneIndex]!.id;
  for (let i = 0; i < model.slices.length; i++) {
    const start = sliceStart(model, layout, i);
    const width = sliceWidth(layout, model.slices[i]!);
    if (col < start + width) {
      return { sliceId: model.slices[i]!.id, lane, column: Math.max(0, col - start) };
    }
  }
  const last = model.slices[model.slices.length - 1]!;
  const start = sliceStart(model, layout, model.slices.length - 1);
  return { sliceId: last.id, lane, column: col - start };
}
