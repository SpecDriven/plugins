// The Event Models' urls (roadmap/support-event-modeling.md), owned by the
// plugin rather than by the app (its src/frontend/route.ts):
//
//   /models                                         the tab, on its first model
//   /models/<model>                                 an Event Model's canvas
//
// <model> is the file's path under the folder, without `.model.json`; a
// hand-typed link may carry the suffix already.

/** The Event Models' folder, shared with the host half (src/server/models.ts). */
export const MODELS_FOLDER = "models";

/**
 * The module's one view: a model's canvas, by its repo-relative file name —
 * or, with none named, the tab itself, which opens on the first model it
 * lists (specs/app/tasks.feature.md "A bare folder url opens that tab").
 */
export interface ModelsRoute {
  fileName: string | null;
}

/** Decode a path segment; a malformed escape is kept as-is rather than thrown. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The view a url names, or null when the url is not the module's. */
export function parseModelsRoute(pathname: string): ModelsRoute | null {
  const segs = pathname.split("/").filter(Boolean).map(decode);
  if (segs[0] !== MODELS_FOLDER) return null;
  if (!segs[1]) return { fileName: null };
  const path = segs.slice(1).join("/").replace(/\.model\.json$/, "");
  return { fileName: `${MODELS_FOLDER}/${path}.model.json` };
}

/** `models/shop/cart.model.json` -> `/models/shop/cart`. */
export function modelLink(fileName: string): string {
  const stem = fileName.slice(MODELS_FOLDER.length + 1).replace(/\.model\.json$/, "");
  return `/${MODELS_FOLDER}/${stem.split("/").map(encodeURIComponent).join("/")}`;
}

/** The url of a view — the inverse of parseModelsRoute. */
export function modelsPath(view: ModelsRoute): string {
  return view.fileName ? modelLink(view.fileName) : `/${MODELS_FOLDER}`;
}
