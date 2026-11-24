// The Models tab's client store (roadmap/support-event-modeling.md): the
// listing of the data repo's Event Models, read from GET /api/models and
// kept current by the mutations below and the app's reload tick. Module-
// level state read through useSyncExternalStore, like the app's own module
// stores, so the tab holds only which model is open — the canvas itself
// (ModelsPane.tsx) holds the open model's file.

import { useSyncExternalStore } from "react";
import type { ModelListing } from "../server/models";
import { toast } from "@specdriven/client";

export interface ModelsStore {
  models: ModelListing[];
  /** Whether GET /api/models has answered since the last reset. */
  loaded: boolean;
  error: string | null;
}

export const EMPTY_MODELS: ModelsStore = { models: [], loaded: false, error: null };

let state: ModelsStore = EMPTY_MODELS;
const listeners = new Set<() => void>();

function set(next: ModelsStore): void {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useModels(): ModelsStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** The listing outside React — what a bare `/models` resolves its first
    model from, in the same tick `load()` filled the store. */
export function modelsState(): ModelsStore {
  return state;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const models = {
  subscribe,

  /** Read the listing; errors land in the store rather than a toast. */
  async load(): Promise<void> {
    try {
      const data = await call<{ models: ModelListing[] }>("/api/models");
      set({ models: data.models, loaded: true, error: null });
    } catch (e) {
      set({ ...state, loaded: true, error: (e as Error).message });
    }
  },

  /** Forget everything — another data folder, or the switch went off. */
  reset(): void {
    set(EMPTY_MODELS);
  },

  /**
   * Create a model — empty, or from an import's JSON — and return its file
   * name; null (after a toast) when the server refused.
   */
  async create(name: string, model?: unknown): Promise<string | null> {
    try {
      const data = await call<{ fileName: string }>("/api/models", {
        method: "POST",
        body: JSON.stringify(model === undefined ? { name } : { name, model }),
      });
      await models.load();
      return data.fileName;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  },

  /** Delete a model; the server's sync message, or null after a toast. */
  async remove(fileName: string): Promise<string | null> {
    try {
      const data = await call<{ message: string }>(`/api/models/${encodeURIComponent(fileName)}`, {
        method: "DELETE",
      });
      await models.load();
      return data.message;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  },
};

/** The listing's name for a model, for the window title and breadcrumbs. */
export function modelTitle(fileName: string, store: ModelsStore): string {
  return store.models.find((m) => m.fileName === fileName)?.name ?? modelStem(fileName);
}

/** `models/shop/cart.model.json` -> `cart`. */
export function modelStem(fileName: string): string {
  return fileName.split("/").pop()!.replace(/\.model\.json$/, "");
}

/** The url of a model's export — the schema's half, as a download. */
export function modelExportUrl(fileName: string): string {
  return `/api/models/${encodeURIComponent(fileName)}/export`;
}
