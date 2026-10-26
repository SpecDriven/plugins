// The Pi CLI this plugin spawns, and whether it is on PATH. The seam lets a
// test say it is without having it (setPiAvailability).

import { which } from "@specdriven/host";

/** The Pi CLI binary a pane session spawns. */
export const PI_BIN = "pi";

let probe: (() => boolean) | null = null;

/** Swap the PATH probe; null restores it. Returns the previous one. */
export function setPiAvailability(fn: (() => boolean) | null): (() => boolean) | null {
  const previous = probe;
  probe = fn;
  return previous;
}

export function piAvailable(): boolean {
  return probe ? probe() : which(PI_BIN) !== null;
}
