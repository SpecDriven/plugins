// The OpenCode CLI this plugin spawns, and whether it is on PATH. The seam
// lets a test say it is without having it (setOpencodeAvailability).

import { which } from "@specdriven/host";

/** The OpenCode CLI binary a pane session spawns. */
export const OPENCODE_BIN = "opencode";

let probe: (() => boolean) | null = null;

/** Swap the PATH probe; null restores it. Returns the previous one. */
export function setOpencodeAvailability(fn: (() => boolean) | null): (() => boolean) | null {
  const previous = probe;
  probe = fn;
  return previous;
}

export function opencodeAvailable(): boolean {
  return probe ? probe() : which(OPENCODE_BIN) !== null;
}

/** The path to spawn: the one on PATH, else the bare name (the spawn fails with ENOENT). */
export function opencodePath(): string {
  return which(OPENCODE_BIN) ?? OPENCODE_BIN;
}
