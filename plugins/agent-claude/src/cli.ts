// The Claude CLI this plugin spawns, and whether it is on PATH. The seam
// lets a test say it is without having it (setClaudeAvailability).

import { which } from "@specdriven/host";

/** The Claude CLI binary the session shells out to. */
export const CLAUDE_BIN = "claude";

let probe: (() => boolean) | null = null;

/** Swap the PATH probe; null restores it. Returns the previous one. */
export function setClaudeAvailability(fn: (() => boolean) | null): (() => boolean) | null {
  const previous = probe;
  probe = fn;
  return previous;
}

export function claudeAvailable(): boolean {
  return probe ? probe() : which(CLAUDE_BIN) !== null;
}
