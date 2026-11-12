// The OpenCode CLI this plugin spawns, and where it is. OpenCode's own
// installer puts it in ~/.opencode/bin and adds that to the shell's PATH —
// which a desktop app started from the Dock never reads — so the plugin
// looks there too when PATH has none. The seam lets a test say it is
// available without having it (setOpencodeAvailability).

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "@specdriven/host";

/** The OpenCode CLI binary a pane session spawns. */
export const OPENCODE_BIN = "opencode";

/** Where OpenCode's installer puts the binary. */
export function installerPath(home: string = homedir()): string {
  return join(home, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : OPENCODE_BIN);
}

/** The CLI on PATH, else the installer's copy under `home`, else null. */
export function findOpencode(home: string = homedir()): string | null {
  const onPath = which(OPENCODE_BIN);
  if (onPath) return onPath;
  const installed = installerPath(home);
  try {
    accessSync(installed, constants.X_OK);
    return installed;
  } catch {
    return null;
  }
}

let probe: (() => boolean) | null = null;

/** Swap the availability probe; null restores it. Returns the previous one. */
export function setOpencodeAvailability(fn: (() => boolean) | null): (() => boolean) | null {
  const previous = probe;
  probe = fn;
  return previous;
}

export function opencodeAvailable(): boolean {
  return probe ? probe() : findOpencode() !== null;
}

/** The path to spawn: where the CLI is, else the bare name (the spawn fails with ENOENT). */
export function opencodePath(): string {
  return findOpencode() ?? OPENCODE_BIN;
}
