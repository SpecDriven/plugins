// The Event Models plugin's browser half (roadmap/support-event-modeling.md
// in specs-specdriven): the Models tab, its sidebar and canvas, the `g m`
// shortcut, the palette's search, the crumb a feature page carries back to
// a model whose slice links it, the model a code gen session bundles, and
// the store's lifecycle. React and the app's building blocks are the page's
// own (`@specdriven/client`); React Flow, the icons and the canvas's
// stylesheet ride in this bundle, the stylesheet added to the page while
// the plugin is on.

import { useSyncExternalStore, type ComponentProps } from "react";
import { Workflow } from "lucide-react";
import {
  markText,
  PageSkeleton,
  type Context,
  type Plugin,
  type SearchResultItem,
  type TabPlugin,
} from "@specdriven/client";
import flowCss from "@xyflow/react/dist/base.css" with { type: "text" };
import modelsCss from "./ui/models.css" with { type: "text" };
import { ModelsPane, ModelsSidebar } from "./ui/ModelsPane";
import { models, modelsState, modelTitle } from "./ui/models";
import { MODELS_FOLDER, modelLink, modelsPath, parseModelsRoute, type ModelsRoute } from "./route";

/**
 * Bumped on each reload tick so an open canvas re-reads its file — which it
 * does only while nothing on it is unsaved (ModelsPane.tsx).
 */
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
 * The open canvas's parting save. A data folder switch awaits it (the
 * "data/leaving" event): it lands what the canvas still holds in the folder
 * it was drawn in, then seals the pane so no later save of its — the unmount
 * one above all — reaches the new folder.
 */
let flushOpen: () => Promise<void> = async () => {};
const bindSave = (handle: { flush: () => Promise<void> } | null) => {
  flushOpen = handle?.flush ?? (async () => {});
};

/** The first model the tab lists, or none. */
const first = (): ModelsRoute | null => {
  const listed = modelsState().models[0];
  return listed ? { fileName: listed.fileName } : null;
};

function Pane({ view, app }: ComponentProps<TabPlugin<ModelsRoute>["Pane"]>) {
  const key = useReloadKey();
  const fileName = view.fileName ?? first()?.fileName;
  if (!fileName) return modelsState().loaded ? null : <PageSkeleton cards={1} />;
  return (
    // Keyed by the file, so switching models starts the canvas afresh.
    <ModelsPane
        key={fileName}
        fileName={fileName}
        features={app.features}
        members={app.members}
        assignments={app.assignments}
        repoCrumb={app.repoCrumb}
        reloadKey={key}
        prompt={app.prompt}
        confirm={app.confirm}
        onOpenFeature={app.openFeature}
        onFeatureCreated={app.featureCreated}
        onStartSession={app.startSession}
        onCopyLink={app.copyLink}
        copied={app.copied}
        onClosed={app.goHome}
        onSaveHandle={bindSave}
      />
  );
}

const tab: TabPlugin<ModelsRoute> = {
  id: "models",
  title: "Models",
  icon: Workflow,
  order: 40,
  shortcut: "g m",
  route: {
    match: parseModelsRoute,
    path: modelsPath,
    key: (view) => view.fileName ?? MODELS_FOLDER,
    title: (view) => (view.fileName ? modelTitle(view.fileName, modelsState()) : "Models"),
    home: { fileName: null },
    // The bare folder opens the first model; an empty folder has nothing to
    // open, so its link goes home and the rail has no Models icon.
    resolve: (view) => (view.fileName ? view : first()),
  },
  Sidebar: ({ view, app, navigate }) => (
    <ModelsSidebar
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
    group: "Models",
    // The Models tab searches the models: one hit per model, by its name and
    // what is on its canvas (src/server/search.ts, over the app's index).
    search: async (query, signal) => {
      const res = await fetch(
        `/api/search?scope=${MODELS_FOLDER}&q=${encodeURIComponent(query)}`,
        { signal },
      );
      const data = (await res.json()) as { results?: SearchResultItem[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      return (data.results ?? []).map((r) => ({
        id: `models:${r.fileName}`,
        label: r.featureName,
        sub: r.snippet ? markText(r.snippet, r.terms) : undefined,
        href: modelLink(r.fileName),
        view: { fileName: r.fileName },
      }));
    },
  },
  // The way back to the model: a feature holding a slice's scenarios carries
  // a crumb naming the Event Model — and the slice, in the tooltip — that
  // opens its canvas. One per model linking the feature.
  featureCrumbs: (fileName) =>
    modelsState().models.flatMap((model) => {
      const links = model.links.filter((l) => l.feature === fileName);
      if (links.length === 0) return [];
      const slices = links.map((l) => `“${l.slice || "Untitled slice"}”`).join(", ");
      return [
        {
          label: (
            <span className="crumb-model">
              <Workflow size={12} aria-hidden="true" />
              {model.name}
            </span>
          ),
          title: `Open the Event Model “${model.name}” — slice ${slices}`,
          view: { fileName: model.fileName },
        },
      ];
    }),
  // The model open on the canvas goes into a code gen session's prompt after
  // the specs, and the specs its slices link come along whole. A model alone
  // is a session too (the app's src/server/api.ts resolveSessionRequest).
  session: (view) =>
    view.fileName
      ? {
          refs: [view.fileName],
          labels: [`the model “${modelTitle(view.fileName, modelsState())}”`],
        }
      : null,
  subscribe: models.subscribe,
};

/** The canvas's stylesheet on the page, while the plugin is on. */
function addStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.plugin = "models";
  style.textContent = `${flowCss}\n${modelsCss}`;
  document.head.append(style);
  return () => style.remove();
}

const plugin: Plugin<Context> = {
  name: "models",
  inject: ["tabs"],
  async apply(ctx) {
    if (typeof document !== "undefined") ctx.effect(addStyles);
    ctx.effect(() => ctx.need("tabs").add(tab as TabPlugin));
    // Switched off, or the data folder gone: forget everything.
    ctx.effect(() => () => {
      models.reset();
      flushOpen = async () => {};
    });
    ctx.on("data/leaving", () => flushOpen());
    ctx.on("data/changed", async () => {
      models.reset();
      await models.load();
    });
    // The reload tick: the list, and the open canvas.
    ctx.on("reload/tick", () => {
      void models.load();
      reloadKey += 1;
      for (const l of reloadListeners) l();
    });
    // The models are there before any deep link that names one resolves.
    await models.load();
  },
};

export default plugin;
