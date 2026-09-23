// The data repo's `models/` folder (roadmap/support-event-modeling.md in
// specs-specdriven): one `<slug>.model.json` per Event Model, drawn and
// edited on the Models tab's canvas. It is opt-in — shown while the plugin
// is on, created when it goes on — and like a page each model has an
// Automerge document behind it (doc.ts), so two people on one canvas merge
// instead of conflicting, and the file on disk is the document's canonical
// JSON. The file is the interchange format: its `model` half is the
// published Event Modeling schema, so it can leave for, and arrive from,
// the tools that speak it. Reading, writing, committing and the document
// store are the app's own, through `@specdriven/host`.

import { mkdir, readdir, stat } from "node:fs/promises";
import {
  commitAndPush,
  createFeature,
  createFileDoc,
  fileDocDirRel,
  fileExists,
  getLogger,
  hasFileDoc,
  listFileDocs,
  loadFileDoc,
  readTextFile,
  removeAndPush,
  removeFileDoc,
  saveFileDoc,
  slugify,
  titleFromFileName,
  withSpan,
  writeTextFile,
} from "@specdriven/host";
import { importModelDoc, isModelProjectionOf, projectModel, reconcileModel, type ModelDoc } from "./doc";
import { featureFromSlice } from "../model/feature";
import { autoLayout } from "../model/layout";
import {
  modelTextError,
  normalizeModelFile,
  parseModelFile,
  serializeModelFile,
} from "../model/serialize";
import { emptyModelFile, type EventModel, type ModelFile } from "../model/types";
import { schemaProblems } from "../model/validate";
import { MODELS_FOLDER } from "../route";

const log = getLogger("models");

export { MODELS_FOLDER };
const MODEL_SUFFIX = ".model.json";
const LABEL = "model";

/** True for the models folder itself and anything beneath it. */
export function isModelsFolderPath(path: string): boolean {
  return path === MODELS_FOLDER || path.startsWith(`${MODELS_FOLDER}/`);
}

export function isModelFile(fileName: string): boolean {
  return fileName.endsWith(MODEL_SUFFIX);
}

/** A slice and the feature file holding its scenarios — the bridge, from the model's side. */
export interface SliceLink {
  sliceId: string;
  /** The slice's title, for a crumb that names it. */
  slice: string;
  /** The feature's repo-relative file name. */
  feature: string;
}

/** What the sidebar lists for one model. */
export interface ModelListing {
  /** Path relative to the data repo root, e.g. `models/cart.model.json`. */
  fileName: string;
  name: string;
  assigned?: string;
  /** How many slices the model has — the sidebar's hint of its size. */
  slices: number;
  /**
   * Every slice linked to a feature file, in model order — how a feature's
   * page finds the model it belongs to and offers the way back.
   */
  links: SliceLink[];
}

/** A model as the canvas holds it: its listing, plus the file itself. */
export interface ModelView extends ModelListing {
  file: ModelFile;
}

/**
 * With the setting on, the folder exists — created here when it does not.
 * Returns whether this call created it.
 */
export async function ensureModelsFolder(dataDir: string): Promise<boolean> {
  const path = `${dataDir}/${MODELS_FOLDER}`;
  if (await isDirectory(path)) return false;
  await mkdir(path, { recursive: true });
  log.info("created the models folder", { "specdriven.dir": dataDir });
  return true;
}

/** Every model in the folder, nested ones included; unreadable files skipped. */
export async function listModels(dataDir: string): Promise<ModelListing[]> {
  const out: ModelListing[] = [];
  for (const fileName of await modelFiles(dataDir, MODELS_FOLDER)) {
    const text = await readTextFile(`${dataDir}/${fileName}`);
    if (text === null || modelTextError(text) !== null) continue;
    out.push(listing(fileName, parseModelFile(text, fallbackName(fileName))));
  }
  return out;
}

export async function readModel(dataDir: string, fileName: string): Promise<ModelView | null> {
  const file = safe(fileName);
  const text = await readTextFile(`${dataDir}/${file}`);
  if (text === null) return null;
  const error = modelTextError(text);
  if (error !== null) throw new Error(`${capitalize(LABEL)} ${file} is unreadable: ${error}`);
  const parsed = parseModelFile(text, fallbackName(file));
  return { ...listing(file, parsed), file: parsed };
}

/**
 * Save a model as the canvas holds it: through the document, so what lands
 * on disk is the document's projection — the reload cron commits and
 * pushes it, like a saved scenario. Whatever the client sent is normalized
 * first: only the schema's keys survive, and the layout is completed for
 * anything the client left unplaced.
 */
export async function saveModel(
  dataDir: string,
  fileName: string,
  raw: unknown,
): Promise<ModelView> {
  const file = safe(fileName);
  const wanted = normalizeModelFile(raw, fallbackName(file));
  wanted.layout = autoLayout(wanted.model, wanted.layout);
  const projection = await absorb(dataDir, file, wanted);
  await writeTextFile(`${dataDir}/${file}`, projection);
  const parsed = parseModelFile(projection, fallbackName(file));
  return { ...listing(file, parsed), file: parsed };
}

/**
 * Create a model: `models/<slug>.model.json` holding an empty model with
 * the default lanes — or, for an import, the model given, laid out — and
 * commit and push it like a new feature. A `/` in the name nests it.
 */
export async function createModel(
  dataDir: string,
  name: string,
  imported?: unknown,
): Promise<string> {
  const segments = name.split("/").map((s) => s.trim());
  const modelName = segments.pop() ?? "";
  if (!modelName) throw new Error(`${capitalize(LABEL)} name is required`);
  const stem = slugify(modelName);
  if (!stem) throw new Error(`${capitalize(LABEL)} name is required`);
  const folder = [MODELS_FOLDER, ...segments.map(slugify).filter(Boolean)].join("/");
  const fileName = safe(`${folder}/${stem}${MODEL_SUFFIX}`);
  if (await fileExists(`${dataDir}/${fileName}`)) {
    throw new Error(`${capitalize(LABEL)} already exists: ${fileName}`);
  }
  let file: ModelFile;
  if (imported === undefined) {
    file = emptyModelFile(modelName);
  } else {
    file = importedFile(modelName, imported);
  }
  await mkdir(`${dataDir}/${folder}`, { recursive: true });
  const projection = await absorb(dataDir, fileName, file);
  await writeTextFile(`${dataDir}/${fileName}`, projection);
  await commitAndPush(dataDir, await modelPaths(dataDir, fileName), `Create model: ${modelName}`);
  return fileName;
}

/**
 * A model arriving from outside — an export of another tool, or of this
 * one — checked against the published schema before it becomes a file, and
 * laid out from scratch when it brings no layout of its own.
 */
export function importedFile(name: string, raw: unknown): ModelFile {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bare = !("model" in record);
  const model: unknown = bare ? record : record.model;
  // Checked as it arrived, not as normalizing would repair it: a tool's
  // export is complete, and a hand-made file that is not should say so.
  const problems = schemaProblems(model);
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).map((p) => `${p.path}: ${p.message}`);
    const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : "";
    throw new Error(`Not a valid Event Model: ${shown.join("; ")}${more}`);
  }
  const file = normalizeModelFile(raw, name);
  file.name = name;
  file.layout = autoLayout(file.model, file.layout);
  return file;
}

/**
 * Scaffold a slice's feature file (src/model/feature.ts): one
 * scenario per Given / When / Then, created and committed like any new
 * feature, and linked from the slice — so the band shows "spec" and the
 * feature's page shows the model. `name` is the feature's, with a `/` for
 * a folder; the slice's title when not given. A slice already linked keeps
 * its feature: the canvas offers to open it instead.
 */
export async function generateSliceFeature(
  dataDir: string,
  fileName: string,
  sliceId: string,
  name?: string,
): Promise<{ fileName: string; scenarios: number; model: ModelView }> {
  const file = safe(fileName);
  const view = await readModel(dataDir, file);
  if (view === null) throw new Error(`${capitalize(LABEL)} not found: ${file}`);
  const slice = view.file.model.slices.find((s) => s.id === sliceId);
  if (!slice) throw new Error(`Slice not found: ${sliceId}`);
  const linked = view.file.links[sliceId]?.feature;
  if (linked) throw new Error(`The slice already has a feature file: ${linked}`);
  const wanted = (name ?? "").trim() || slice.title.trim() || "Slice";
  const heading = wanted.split("/").pop()!.trim();
  const generated = featureFromSlice(view.file, file, sliceId, heading)!;
  const featureFile = await createFeature(dataDir, wanted, generated.text);
  const next: ModelFile = { ...view.file, links: { ...view.file.links, [sliceId]: { feature: featureFile } } };
  const model = await saveModel(dataDir, file, next);
  log.info("scaffolded a feature from a slice", {
    "specdriven.file": file,
    "specdriven.feature": featureFile,
  });
  return { fileName: featureFile, scenarios: slice.specifications.length, model };
}

/** The schema's half of a model, as other tools take it. */
export async function exportModel(dataDir: string, fileName: string): Promise<EventModel | null> {
  const view = await readModel(dataDir, fileName);
  return view === null ? null : view.file.model;
}

/**
 * Delete a model — the file and its document — committed and pushed like a
 * deleted feature. The client confirms: Undo is not possible past the push.
 */
export async function deleteModel(dataDir: string, fileName: string): Promise<{ message: string }> {
  const file = safe(fileName);
  if (!(await fileExists(`${dataDir}/${file}`))) {
    throw new Error(`${capitalize(LABEL)} not found: ${file}`);
  }
  const paths = await modelPaths(dataDir, file);
  const sync = await removeAndPush(dataDir, paths, `Delete model: ${file}`);
  await removeFileDoc(dataDir, file);
  return { message: sync.message };
}

/**
 * The models folder's side of the sync tick's drift pass (pages.ts
 * importPageDrift): a file that changed without its document — an external
 * edit, a teammate's push, a model that predates its document — is absorbed
 * (or first imported), and rewritten to the document's projection. A file
 * that is not a model (mid-edit, or not JSON) is left alone; a document
 * whose file is gone is dropped.
 */
export async function importModelDrift(dataDir: string): Promise<string> {
  return withSpan("sync.import_model_drift", { "specdriven.dir": dataDir }, async (span) => {
    let imported = 0;
    let absorbed = 0;
    let skipped = 0;
    for (const fileName of await modelFiles(dataDir, MODELS_FOLDER)) {
      const text = await readTextFile(`${dataDir}/${fileName}`);
      if (text === null) continue;
      const error = modelTextError(text);
      if (error !== null) {
        skipped++;
        log.warn(`left ${fileName} alone: ${error}`);
        continue;
      }
      const loaded = await loadFileDoc<ModelDoc>(dataDir, fileName);
      if (loaded === null) {
        const file = parseModelFile(text, fallbackName(fileName));
        file.layout = autoLayout(file.model, file.layout);
        const created = await createFileDoc(dataDir, fileName, importModelDoc(file));
        const projection = projectModel(created.doc);
        if (projection !== text) await writeTextFile(`${dataDir}/${fileName}`, projection);
        imported++;
        continue;
      }
      if (isModelProjectionOf(text, loaded.doc)) continue;
      const file = parseModelFile(text, fallbackName(fileName));
      file.layout = autoLayout(file.model, file.layout);
      const next = reconcileModel(loaded.doc, file);
      await saveFileDoc(dataDir, fileName, next, loaded.heads);
      await writeTextFile(`${dataDir}/${fileName}`, projectModel(next));
      absorbed++;
    }
    let removed = 0;
    for (const fileName of await listFileDocs(dataDir, MODELS_FOLDER, MODEL_SUFFIX)) {
      if (!(await fileExists(`${dataDir}/${fileName}`))) {
        await removeFileDoc(dataDir, fileName);
        removed++;
      }
    }
    span.setAttributes({
      "sync.models_imported": imported,
      "sync.models_absorbed": absorbed,
      "sync.models_skipped": skipped,
      "sync.models_removed": removed,
    });
    const parts = [];
    if (imported > 0) parts.push(`imported ${imported} model(s) into documents`);
    if (absorbed > 0) parts.push(`absorbed ${absorbed} externally edited model(s)`);
    if (skipped > 0) parts.push(`left ${skipped} unreadable model file(s) alone`);
    if (removed > 0) parts.push(`dropped ${removed} document(s) for deleted models`);
    return parts.join("; ");
  });
}

/**
 * Feed a model into its document — reconciled as CRDT operations, or
 * imported whole for a model that has none yet — and return the projection
 * the file must now hold.
 */
async function absorb(dataDir: string, fileName: string, file: ModelFile): Promise<string> {
  const loaded = await loadFileDoc<ModelDoc>(dataDir, fileName);
  if (loaded === null) {
    const created = await createFileDoc(dataDir, fileName, importModelDoc(file));
    return projectModel(created.doc);
  }
  const next = reconcileModel(loaded.doc, file);
  await saveFileDoc(dataDir, fileName, next, loaded.heads);
  return projectModel(next);
}

/** What a mutation commits for a model: the file and its document. */
async function modelPaths(dataDir: string, fileName: string): Promise<string[]> {
  return (await hasFileDoc(dataDir, fileName))
    ? [fileName, fileDocDirRel(fileName)]
    : [fileName];
}

function listing(fileName: string, file: ModelFile): ModelListing {
  return {
    fileName,
    name: file.name || fallbackName(fileName),
    ...(file.assigned ? { assigned: file.assigned } : {}),
    slices: file.model.slices.length,
    links: sliceLinks(file),
  };
}

/** The slices linked to a feature file, in model order. */
export function sliceLinks(file: ModelFile): SliceLink[] {
  const out: SliceLink[] = [];
  for (const slice of file.model.slices) {
    const feature = file.links[slice.id]?.feature;
    if (feature) out.push({ sliceId: slice.id, slice: slice.title, feature });
  }
  return out;
}

/** A display name from the file's stem, for a file whose name is empty. */
function fallbackName(fileName: string): string {
  return titleFromFileName(fileName.replace(/\.model\.json$/, ""));
}

/** Model files under the folder, repo-relative and sorted. */
export async function modelFiles(dataDir: string, rel: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(`${dataDir}/${rel}`, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await modelFiles(dataDir, path)));
    else if (isModelFile(entry.name)) files.push(path);
  }
  return files.sort();
}

/** Segments that would escape or hide inside the data repo are rejected. */
function badSegment(segment: string): boolean {
  return !segment || segment.startsWith(".") || segment.includes("\\");
}

/** A model path: `models/…/<name>.model.json`, of safe segments. */
function safe(fileName: string): string {
  const segments = fileName.split("/");
  if (
    segments.length < 2 ||
    segments[0] !== MODELS_FOLDER ||
    segments.some(badSegment) ||
    !isModelFile(segments[segments.length - 1]!)
  ) {
    throw new Error(`Invalid ${LABEL} name: ${fileName}`);
  }
  return fileName;
}

function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** The bytes a fresh, empty model file holds — for tests and the demo. */
export function emptyModelText(name: string): string {
  return serializeModelFile(emptyModelFile(name));
}
