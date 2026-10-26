// The Codex CLI this plugin spawns, and whether it is on PATH. The seam
// lets a test say it is without having it (setCodexAvailability).

import { which } from "@specdriven/host";

/** The Codex CLI binary a pane session spawns. */
export const CODEX_BIN = "codex";

let probe: (() => boolean) | null = null;

/** Swap the PATH probe; null restores it. Returns the previous one. */
export function setCodexAvailability(fn: (() => boolean) | null): (() => boolean) | null {
  const previous = probe;
  probe = fn;
  return previous;
}

export function codexAvailable(): boolean {
  return probe ? probe() : which(CODEX_BIN) !== null;
}
