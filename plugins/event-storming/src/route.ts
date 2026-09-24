// The Event Storming boards' urls, owned by the plugin rather than by the
// app (its src/frontend/route.ts):
//
//   /storms                                         the tab, on its first board
//   /storms/<board>                                 a board's wall
//
// <board> is the file's path under the folder, without `.storm.json`; a
// hand-typed link may carry the suffix already.

/** The boards' folder in the data repo, shared with the host half. */
export const STORMS_FOLDER = "storms";

export const STORM_SUFFIX = ".storm.json";

/**
 * The tab's one view: a board, by its repo-relative file name — or, with
 * none named, the tab itself, which opens on the first board it lists.
 */
export interface StormsRoute {
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

/** The view a url names, or null when the url is not the tab's. */
export function parseStormsRoute(pathname: string): StormsRoute | null {
  const segs = pathname.split("/").filter(Boolean).map(decode);
  if (segs[0] !== STORMS_FOLDER) return null;
  if (!segs[1]) return { fileName: null };
  const path = segs.slice(1).join("/").replace(/\.storm\.json$/, "");
  return { fileName: `${STORMS_FOLDER}/${path}${STORM_SUFFIX}` };
}

/** `storms/shop/orders.storm.json` -> `/storms/shop/orders`. */
export function stormLink(fileName: string): string {
  const stem = fileName.slice(STORMS_FOLDER.length + 1).replace(/\.storm\.json$/, "");
  return `/${STORMS_FOLDER}/${stem.split("/").map(encodeURIComponent).join("/")}`;
}

/** The url of a view — the inverse of parseStormsRoute. */
export function stormsPath(view: StormsRoute): string {
  return view.fileName ? stormLink(view.fileName) : `/${STORMS_FOLDER}`;
}
