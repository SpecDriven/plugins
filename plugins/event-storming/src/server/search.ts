// The tab's search (the app's `GET /api/search?scope=storms`, through the
// `search` service): one hit per board, by its name and, as text, what is
// written on its stickies and areas. The app keeps the index and ranks it.

import type { SearchSource } from "@specdriven/host";
import { titleFromFileName } from "@specdriven/host";
import { parseStormFile, stormTextError } from "../storm/serialize";
import { STORMS_FOLDER, stormFiles } from "./storms";

export const stormSearch: SearchSource = {
  kind: "storm",
  files: (dataDir) => stormFiles(dataDir, STORMS_FOLDER),
  document(fileName, content) {
    if (stormTextError(content) !== null) return null;
    const file = parseStormFile(content);
    const name = file.name || titleFromFileName(fileName.replace(/\.storm\.json$/, ""));
    const words = [...file.stickies.map((s) => s.text), ...file.areas.map((a) => a.label)];
    return { name, text: words.filter((w) => w.trim()).join(" · ") };
  },
};
