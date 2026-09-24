// The Event Storming plugin's browser half: the tab, its sidebar of boards
// and the wall, the `g w` shortcut, the palette's search and its "New
// board" command, the board a code gen session bundles, and the store's
// lifecycle. React and the app's building blocks are the page's own
// (`@specdriven/client`); React Flow, the icons and the wall's stylesheet
// ride in this bundle, the stylesheet added to the page while the plugin
// is on.

import { useSyncExternalStore, type ComponentProps } from "react";
import { StickyNote } from "lucide-react";
import {
  markText,
  PageSkeleton,
  type Context,
  type Plugin,
  type SearchResultItem,
  type TabPlugin,
} from "@specdriven/client";
import flowCss from "@xyflow/react/dist/base.css" with { type: "text" };
import stormCss from "./ui/storm.css" with { type: "text" };
import { newBoard, StormPane, StormsSidebar, Welcome } from "./ui/StormPane";
import { storms, stormsState, stormTitle, useStorms } from "./ui/store";
import { STORMS_FOLDER, parseStormsRoute, stormLink, stormsPath, type StormsRoute } from "./route";

/** Bumped on each reload tick so an open wall re-reads its file — while nothing on it is unsaved. */
let reloadKey = 0;
const reloadListeners = new Set<() => void>();
const subscribeReload = (l: () => void) => {
  reloadListeners.add(l);
  return () => {
    reloadListeners.delete(l);
  };
};
const useReloadKey = () => useSyncExternalStore(subscribeReload, () => reloadKey, () => 0);

/**
 * The open wall's parting save. A data folder switch awaits it (the
 * "data/leaving" event): it lands what the wall still holds in the folder
 * it was drawn in, then seals the pane.
 */
let flushOpen: () => Promise<void> = async () => {};
const bindSave = (handle: { flush: () => Promise<void> } | null) => {
  flushOpen = handle?.flush ?? (async () => {});
};

/** The first board the tab lists, or none. */
const first = (): string | null => stormsState().storms[0]?.fileName ?? null;

function Pane({ view, app, navigate }: ComponentProps<TabPlugin<StormsRoute>["Pane"]>) {
  const key = useReloadKey();
  const store = useStorms();
  const fileName = view.fileName ?? store.storms[0]?.fileName ?? null;
  if (!fileName) {
    if (!store.loaded) return <PageSkeleton cards={1} />;
    // No board yet: what Event Storming is, and the two ways to start.
    const start = async (example: boolean) => {
      const made = await newBoard(app.prompt, example ? { example: true } : {});
      if (made) navigate({ fileName: made }, { push: true });
    };
    return <Welcome onCreate={() => void start(false)} onExample={() => void start(true)} />;
  }
  return (
    // Keyed by the file, so switching boards starts the wall afresh.
    <StormPane
      key={fileName}
      fileName={fileName}
      repoCrumb={app.repoCrumb}
      reloadKey={key}
      prompt={app.prompt}
      confirm={app.confirm}
      onStartSession={app.startSession}
      onCopyLink={app.copyLink}
      copied={app.copied}
      onClosed={app.goHome}
      onSaveHandle={bindSave}
    />
  );
}

const tab: TabPlugin<StormsRoute> = {
  id: "event-storming",
  title: "Event Storming",
  icon: StickyNote,
  order: 45,
  shortcut: "g w",
  route: {
    match: parseStormsRoute,
    path: stormsPath,
    key: (view) => view.fileName ?? STORMS_FOLDER,
    title: (view) => (view.fileName ? stormTitle(view.fileName, stormsState()) : "Event Storming"),
    home: { fileName: null },
    // The bare folder opens the first board; with none, the tab opens on
    // its welcome, which offers to start one.
    resolve: (view) => (view.fileName ? view : { fileName: first() }),
  },
  Sidebar: ({ view, app, navigate }) => (
    <StormsSidebar
      active={view?.fileName ?? null}
      prompt={app.prompt}
      confirm={app.confirm}
      onNavigate={(fileName, opts) => navigate({ fileName }, opts)}
      onCopyLink={app.copyLink}
      onClosed={app.goHome}
    />
  ),
  Pane,
  palette: {
    group: "Event Storming",
    // One hit per board, by its name and what is written on its stickies
    // (src/server/search.ts, over the app's index).
    search: async (query, signal) => {
      const res = await fetch(`/api/search?scope=${STORMS_FOLDER}&q=${encodeURIComponent(query)}`, { signal });
      const data = (await res.json()) as { results?: SearchResultItem[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      return (data.results ?? []).map((r) => ({
        id: `storms:${r.fileName}`,
        label: r.featureName,
        sub: r.snippet ? markText(r.snippet, r.terms) : undefined,
        href: stormLink(r.fileName),
        view: { fileName: r.fileName },
      }));
    },
    commands: ({ prompt, navigate }) => [
      {
        id: "event-storming:new",
        group: "Actions",
        label: "New Event Storming board",
        text: "New Event Storming board",
        icon: <StickyNote size={14} aria-hidden="true" />,
        run: () => {
          void newBoard(prompt).then((made) => {
            if (made) navigate({ fileName: made }, { push: true });
          });
        },
      },
    ],
  },
  // The board open on the wall goes into a code gen session's prompt.
  session: (view) =>
    view.fileName
      ? {
          refs: [view.fileName],
          labels: [`the Event Storming board “${stormTitle(view.fileName, stormsState())}”`],
        }
      : null,
  recent: (view) => (view.fileName ? stormTitle(view.fileName, stormsState()) : null),
  subscribe: storms.subscribe,
};

/** The wall's stylesheet on the page, while the plugin is on. */
function addStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.plugin = "event-storming";
  style.textContent = `${flowCss}\n${stormCss}`;
  document.head.append(style);
  return () => style.remove();
}

const plugin: Plugin<Context> = {
  name: "event-storming",
  inject: ["tabs"],
  async apply(ctx) {
    if (typeof document !== "undefined") ctx.effect(addStyles);
    ctx.effect(() => ctx.need("tabs").add(tab as TabPlugin));
    // Switched off, or the data folder gone: forget everything.
    ctx.effect(() => () => {
      storms.reset();
      flushOpen = async () => {};
    });
    ctx.on("data/leaving", () => flushOpen());
    ctx.on("data/changed", async () => {
      storms.reset();
      await storms.load();
    });
    // The reload tick: the list, and the open wall.
    ctx.on("reload/tick", () => {
      void storms.load();
      reloadKey += 1;
      for (const l of reloadListeners) l();
    });
    // The boards are there before any deep link that names one resolves.
    await storms.load();
  },
};

export default plugin;
