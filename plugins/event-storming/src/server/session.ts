// What a code gen session bundles from an Event Storming board (the app's
// src/server/agent.ts buildSessionPrompt, through the `sessions` service):
// the board open on the tab when the session started, read out as its
// timeline (src/storm/outline.ts) and then as its JSON, so an agent sees
// the story the specs tell and the words the domain uses for it.

import type { SessionSection } from "@specdriven/host";
import { stormOutline } from "../storm/outline";
import { serializeStormFile } from "../storm/serialize";
import { readStorm, type StormView } from "./storms";

/** The boards a session asked for, by file name; one not there is an error. */
export async function sessionStorms(dataDir: string, wanted: string[]): Promise<StormView[]> {
  const views: StormView[] = [];
  for (const fileName of new Set(wanted)) {
    const view = await readStorm(dataDir, fileName);
    if (view === null) throw new Error(`Event Storming board not found: ${fileName}`);
    views.push(view);
  }
  return views;
}

export function stormSection(view: StormView, withSpecs: boolean): SessionSection {
  const lines = [
    `The Event Storming board "${view.name}"${withSpecs ? " the specifications above belong to" : ""}: ` +
      "a workshop's wall of sticky notes read left to right as time — domain events (orange), the " +
      "commands (blue) and actors (small yellow) behind them, policies (lilac), aggregates (big " +
      "yellow), read models (green), external systems (pink) and hotspots (magenta) — with the areas " +
      "drawn round them. Its outline:",
    "",
    ...stormOutline(view.file).trimEnd().split("\n"),
    "",
    "The board as JSON:",
    "",
    "```json",
    serializeStormFile(view.file).trimEnd(),
    "```",
  ];
  return {
    heading: `Event Storming board: ${view.fileName}`,
    noun: { one: "Event Storming board", many: "Event Storming boards" },
    lines,
  };
}
