// The Claude Code this plugin spawns: the `claude` on PATH, else the binary
// it fetched for this platform (src/binary.ts). The seam lets a test say
// there is one without having it (setClaudeAvailability).

import { which } from "@specdriven/host";
import { installedBinary } from "./binary";

/** The Claude CLI binary the session shells out to. */
export const CLAUDE_BIN = "claude";

let probe: (() => boolean) | null = null;

/** Swap the lookup for a yes/no (yes runs `claude`); null restores it. Returns the previous one. */
export function setClaudeAvailability(fn: (() => boolean) | null): (() => boolean) | null {
  const previous = probe;
  probe = fn;
  return previous;
}

/** The Claude Code to run, or null when there is none yet. */
export function claudeExecutable(): string | null {
  if (probe) return probe() ? CLAUDE_BIN : null;
  return which(CLAUDE_BIN) ?? installedBinary();
}

export function claudeAvailable(): boolean {
  return claudeExecutable() !== null;
}
