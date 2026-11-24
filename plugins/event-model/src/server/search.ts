// The Models tab's search (the app's `GET /api/search?scope=models`,
// through the `search` service): one hit per model, by its name, and as
// text the titles of its slices, elements and specifications — what
// someone remembers of a model. The app keeps the index and ranks it.

import type { SearchSource } from "@specdriven/host";
import { titleFromFileName } from "@specdriven/host";
import { modelTextError, parseModelFile } from "../model/serialize";
import { allElements } from "../model/types";
import { MODELS_FOLDER, modelFiles } from "./models";

export const modelSearch: SearchSource = {
  kind: "model",
  files: (dataDir) => modelFiles(dataDir, MODELS_FOLDER),
  document(fileName, content) {
    if (modelTextError(content) !== null) return null;
    const file = parseModelFile(content);
    const name = file.name || titleFromFileName(fileName.replace(/\.model\.json$/, ""));
    const words: string[] = [];
    for (const slice of file.model.slices) {
      words.push(slice.title);
      for (const spec of slice.specifications) words.push(spec.title);
    }
    for (const { element } of allElements(file.model)) {
      words.push(element.title);
      if (element.description) words.push(element.description);
    }
    return { name, text: words.join(" · ") };
  },
};
