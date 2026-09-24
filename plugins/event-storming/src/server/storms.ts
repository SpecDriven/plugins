// The data repo's `storms/` folder: one `<slug>.storm.json` per Event
// Storming board, drawn on the tab's wall. Like a page, each board has an
// Automerge document behind it (doc.ts), so two people on one wall merge
// instead of conflicting, and the file on disk is the document's
// canonical JSON. The folder is made with the first board, not when the
// plugin goes on — a repo that never storms keeps no empty folder.
// Reading, writing, committing and the document store are the app's own,
// through `@specdriven/host`.

import { mkdir, readdir } from "node:fs/promises";
import {
  commitAndPush,
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
import { importStormDoc, isStormProjectionOf, projectStorm, reconcileStorm, type StormDoc } from "./doc";
import { exampleStorm } from "../storm/example";
import { importStorm, normalizeStormFile, parseStormFile, stormTextError } from "../storm/serialize";
import { emptyStormFile, type StickyKind, type StormFile } from "../storm/types";
import { STORMS_FOLDER, STORM_SUFFIX } from "../route";

const log = getLogger("event-storming");

export { STORMS_FOLDER };

export function isStormFile(fileName: string): boolean {
  return fileName.endsWith(STORM_SUFFIX);
}

/** What the sidebar lists for one board. */
export interface StormListing {
  /** Path relative to the data repo root, e.g. `storms/orders.storm.json`. */
  fileName: string;
  name: string;
  /** How many stickies of each kind — the sidebar's hint of the board's size. */
  counts: Partial<Record<StickyKind, number>>;
}

/** A board as the wall holds it: its listing, plus the file itself. */
export interface StormView extends StormListing {
  file: StormFile;
}

/** How a new board starts: empty, from the example, or from an import. */
export type StormSeed = { kind: "empty" } | { kind: "example" } | { kind: "import"; data: unknown };

/** Every board in the folder, nested ones included; unreadable files skipped. */
export async function listStorms(dataDir: string): Promise<StormListing[]> {
  const out: StormListing[] = [];
  for (const fileName of await stormFiles(dataDir, STORMS_FOLDER)) {
    const text = await readTextFile(`${dataDir}/${fileName}`);
    if (text === null || stormTextError(text) !== null) continue;
    out.push(listing(fileName, parseStormFile(text, fallbackName(fileName))));
  }
  return out;
}

export async function readStorm(dataDir: string, fileName: string): Promise<StormView | null> {
  const file = safe(fileName);
  const text = await readTextFile(`${dataDir}/${file}`);
  if (text === null) return null;
  const error = stormTextError(text);
  if (error !== null) throw new Error(`Board ${file} is unreadable: ${error}`);
  const parsed = parseStormFile(text, fallbackName(file));
  return { ...listing(file, parsed), file: parsed };
}

/**
 * Save a board as the wall holds it: through the document, so what lands on
 * disk is the document's projection — the reload cron commits and pushes
 * it, like a saved scenario. Whatever the client sent is normalized first.
 */
export async function saveStorm(dataDir: string, fileName: string, raw: unknown): Promise<StormView> {
  const file = safe(fileName);
  const wanted = normalizeStormFile(raw, fallbackName(file));
  const projection = await absorb(dataDir, file, wanted);
  await writeTextFile(`${dataDir}/${file}`, projection);
  const parsed = parseStormFile(projection, fallbackName(file));
  return { ...listing(file, parsed), file: parsed };
}

/**
 * Create a board: `storms/<slug>.storm.json`, empty or seeded, committed
 * and pushed like a new feature. A `/` in the name nests it.
 */
export async function createStorm(
  dataDir: string,
  name: string,
  seed: StormSeed = { kind: "empty" },
): Promise<string> {
  const segments = name.split("/").map((s) => s.trim());
  const boardName = segments.pop() ?? "";
  const stem = slugify(boardName);
  if (!boardName || !stem) throw new Error("Board name is required");
  const folder = [STORMS_FOLDER, ...segments.map(slugify).filter(Boolean)].join("/");
  const fileName = safe(`${folder}/${stem}${STORM_SUFFIX}`);
  if (await fileExists(`${dataDir}/${fileName}`)) {
    throw new Error(`Board already exists: ${fileName}`);
  }
  const file =
    seed.kind === "example"
      ? exampleStorm(boardName)
      : seed.kind === "import"
        ? importStorm(seed.data, boardName)
        : emptyStormFile(boardName);
  await mkdir(`${dataDir}/${folder}`, { recursive: true });
  const projection = await absorb(dataDir, fileName, file);
  await writeTextFile(`${dataDir}/${fileName}`, projection);
  await commitAndPush(dataDir, await stormPaths(dataDir, fileName), `Create Event Storming board: ${boardName}`);
  log.info("created a board", { "specdriven.file": fileName, "specdriven.seed": seed.kind });
  return fileName;
}

/**
 * Delete a board — the file and its document — committed and pushed like
 * a deleted feature. The client confirms: Undo is not possible past the push.
 */
export async function deleteStorm(dataDir: string, fileName: string): Promise<{ message: string }> {
  const file = safe(fileName);
  if (!(await fileExists(`${dataDir}/${file}`))) throw new Error(`Board not found: ${file}`);
  const paths = await stormPaths(dataDir, file);
  const sync = await removeAndPush(dataDir, paths, `Delete Event Storming board: ${file}`);
  await removeFileDoc(dataDir, file);
  return { message: sync.message };
}

/**
 * The folder's side of the sync tick's drift pass: a file that changed
 * without its document — an external edit, a teammate's push — is absorbed
 * (or first imported) and rewritten to the document's projection. A file
 * that is not a board (mid-edit, or not JSON) is left alone; a document
 * whose file is gone is dropped.
 */
export async function importStormDrift(dataDir: string): Promise<string> {
  return withSpan("sync.import_storm_drift", { "specdriven.dir": dataDir }, async (span) => {
    let imported = 0;
    let absorbed = 0;
    let skipped = 0;
    for (const fileName of await stormFiles(dataDir, STORMS_FOLDER)) {
      const text = await readTextFile(`${dataDir}/${fileName}`);
      if (text === null) continue;
      const error = stormTextError(text);
      if (error !== null) {
        skipped++;
        log.warn(`left ${fileName} alone: ${error}`);
        continue;
      }
      const loaded = await loadFileDoc<StormDoc>(dataDir, fileName);
      if (loaded === null) {
        const created = await createFileDoc(
          dataDir,
          fileName,
          importStormDoc(parseStormFile(text, fallbackName(fileName))),
        );
        const projection = projectStorm(created.doc);
        if (projection !== text) await writeTextFile(`${dataDir}/${fileName}`, projection);
        imported++;
        continue;
      }
      if (isStormProjectionOf(text, loaded.doc)) continue;
      const next = reconcileStorm(loaded.doc, parseStormFile(text, fallbackName(fileName)));
      await saveFileDoc(dataDir, fileName, next, loaded.heads);
      await writeTextFile(`${dataDir}/${fileName}`, projectStorm(next));
      absorbed++;
    }
    let removed = 0;
    for (const fileName of await listFileDocs(dataDir, STORMS_FOLDER, STORM_SUFFIX)) {
      if (!(await fileExists(`${dataDir}/${fileName}`))) {
        await removeFileDoc(dataDir, fileName);
        removed++;
      }
    }
    span.setAttributes({
      "sync.storms_imported": imported,
      "sync.storms_absorbed": absorbed,
      "sync.storms_skipped": skipped,
      "sync.storms_removed": removed,
    });
    const parts = [];
    if (imported > 0) parts.push(`imported ${imported} Event Storming board(s) into documents`);
    if (absorbed > 0) parts.push(`absorbed ${absorbed} externally edited board(s)`);
    if (skipped > 0) parts.push(`left ${skipped} unreadable board file(s) alone`);
    if (removed > 0) parts.push(`dropped ${removed} document(s) for deleted boards`);
    return parts.join("; ");
  });
}

/**
 * Feed a board into its document — reconciled as CRDT operations, or
 * imported whole for a board that has none yet — and return the projection
 * the file must now hold.
 */
async function absorb(dataDir: string, fileName: string, file: StormFile): Promise<string> {
  const loaded = await loadFileDoc<StormDoc>(dataDir, fileName);
  if (loaded === null) {
    const created = await createFileDoc(dataDir, fileName, importStormDoc(file));
    return projectStorm(created.doc);
  }
  const next = reconcileStorm(loaded.doc, file);
  await saveFileDoc(dataDir, fileName, next, loaded.heads);
  return projectStorm(next);
}

/** What a mutation commits for a board: the file and its document. */
async function stormPaths(dataDir: string, fileName: string): Promise<string[]> {
  return (await hasFileDoc(dataDir, fileName)) ? [fileName, fileDocDirRel(fileName)] : [fileName];
}

function listing(fileName: string, file: StormFile): StormListing {
  const counts: Partial<Record<StickyKind, number>> = {};
  for (const s of file.stickies) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  return { fileName, name: file.name || fallbackName(fileName), counts };
}

/** A display name from the file's stem, for a file whose name is empty. */
function fallbackName(fileName: string): string {
  return titleFromFileName(fileName.replace(/\.storm\.json$/, ""));
}

/** Board files under the folder, repo-relative and sorted. */
export async function stormFiles(dataDir: string, rel: string): Promise<string[]> {
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
    if (entry.isDirectory()) files.push(...(await stormFiles(dataDir, path)));
    else if (isStormFile(entry.name)) files.push(path);
  }
  return files.sort();
}

/** Segments that would escape or hide inside the data repo are rejected. */
function badSegment(segment: string): boolean {
  return !segment || segment.startsWith(".") || segment.includes("\\");
}

/** A board path: `storms/…/<name>.storm.json`, of safe segments. */
function safe(fileName: string): string {
  const segments = fileName.split("/");
  if (
    segments.length < 2 ||
    segments[0] !== STORMS_FOLDER ||
    segments.some(badSegment) ||
    !isStormFile(segments[segments.length - 1]!)
  ) {
    throw new Error(`Invalid board name: ${fileName}`);
  }
  return fileName;
}
