// The tab's client store: the listing of the data repo's Event Storming
// boards, read from GET /api/storms and kept current by the mutations
// below and the app's reload tick. Module-level state read through
// useSyncExternalStore, like the app's own module stores, so the tab holds
// only which board is open — the wall itself (StormPane.tsx) holds the
// open board's file.

import { useSyncExternalStore } from "react";
import { toast } from "@specdriven/client";
import type { StormListing } from "../server/storms";

export interface StormsStore {
  storms: StormListing[];
  /** Whether GET /api/storms has answered since the last reset. */
  loaded: boolean;
  error: string | null;
}

export const EMPTY_STORMS: StormsStore = { storms: [], loaded: false, error: null };

let state: StormsStore = EMPTY_STORMS;
const listeners = new Set<() => void>();

function set(next: StormsStore): void {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useStorms(): StormsStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** The listing outside React — what a bare `/storms` resolves its first board from. */
export function stormsState(): StormsStore {
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

/** What a new board starts from, as POST /api/storms takes it. */
export type Seed = { example: true } | { import: unknown } | Record<string, never>;

export const storms = {
  subscribe,

  /** Read the listing; errors land in the store rather than a toast. */
  async load(): Promise<void> {
    try {
      const data = await call<{ storms: StormListing[] }>("/api/storms");
      set({ storms: data.storms, loaded: true, error: null });
    } catch (e) {
      set({ ...state, loaded: true, error: (e as Error).message });
    }
  },

  /** Forget everything — another data folder, or the plugin went off. */
  reset(): void {
    set(EMPTY_STORMS);
  },

  /** Create a board and return its file name; null (after a toast) when refused. */
  async create(name: string, seed: Seed = {}): Promise<string | null> {
    try {
      const data = await call<{ fileName: string }>("/api/storms", {
        method: "POST",
        body: JSON.stringify({ name, ...seed }),
      });
      await storms.load();
      return data.fileName;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  },

  /** Delete a board; the server's sync message, or null after a toast. */
  async remove(fileName: string): Promise<string | null> {
    try {
      const data = await call<{ message: string }>(`/api/storms/${encodeURIComponent(fileName)}`, {
        method: "DELETE",
      });
      await storms.load();
      return data.message;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  },
};

/** The listing's name for a board, for the window title and breadcrumbs. */
export function stormTitle(fileName: string, store: StormsStore): string {
  return store.storms.find((s) => s.fileName === fileName)?.name ?? stormStem(fileName);
}

/** `storms/shop/orders.storm.json` -> `orders`. */
export function stormStem(fileName: string): string {
  return fileName.split("/").pop()!.replace(/\.storm\.json$/, "");
}

/** The url of a board's download. */
export function stormExportUrl(fileName: string): string {
  return `/api/storms/${encodeURIComponent(fileName)}/export`;
}
