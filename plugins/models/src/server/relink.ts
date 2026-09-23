// The specs-folder migration's side (the app's src/server/migrate.ts,
// through `sync.moved`): a repo written before the spec tree had its own
// folder has its features moved under `specs/`, and every Event Model
// slice that names one of them is pointed at its new path — or the slice
// would lose the spec it generated. The rewritten files ride the sync
// tick's next commit.

import { getLogger, readTextFile, writeTextFile } from "@specdriven/host";
import { parseModelFile, serializeModelFile } from "../model/serialize";
import type { ModelFile } from "../model/types";
import { MODELS_FOLDER, modelFiles } from "./models";

const log = getLogger("models");

/** Rewrite the feature paths the models' slices point at; returns the files changed. */
export async function relinkModels(dataDir: string, moved: ReadonlyMap<string, string>): Promise<string[]> {
  const changed: string[] = [];
  for (const fileName of await modelFiles(dataDir, MODELS_FOLDER)) {
    const text = await readTextFile(`${dataDir}/${fileName}`);
    if (text === null) continue;
    let model: ModelFile;
    try {
      model = parseModelFile(text);
    } catch {
      // A model we cannot parse is left exactly as it is: the migration must
      // not turn a corrupt file into a differently corrupt one.
      log.warn(`skipped unparseable model during migration: ${fileName}`);
      continue;
    }
    let touched = false;
    const links: ModelFile["links"] = {};
    for (const [sliceId, link] of Object.entries(model.links ?? {})) {
      // A slice with no feature yet, or one naming a spec that did not move,
      // is copied across untouched.
      const to = link.feature === undefined ? undefined : moved.get(link.feature);
      if (to === undefined) {
        links[sliceId] = link;
        continue;
      }
      links[sliceId] = { ...link, feature: to };
      touched = true;
    }
    if (!touched) continue;
    // Written through the model serializer, so the file keeps its canonical
    // key order rather than whatever a hand-rolled stringify would emit.
    await writeTextFile(`${dataDir}/${fileName}`, serializeModelFile({ ...model, links }));
    changed.push(fileName);
  }
  return changed;
}
