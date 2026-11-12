// The models the pane's menu offers for OpenCode (specs/agents/opencode
// .feature.md, and agent-plugins.feature.md "Each agent offers the models
// the data repo lists", in the specs repo). OpenCode reaches every model of
// every provider it holds credentials for — hundreds of them — so the menu
// is never the whole catalog:
//
//   - the data repo's `.specdriven/opencode-models.json` (a JSON list the
//     app's Settings edits), when it lists any, in its order;
//   - else the plugin's default, then the models OpenCode itself used
//     last (its own "Recent" list), that it still offers;
//   - else the first of what `opencode models` lists.
//
// The full list (`opencode models`, one `provider/model` per line) is also
// what reportedModels() reports, so the app can warn of a listed model
// OpenCode does not offer.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeModel, run } from "@specdriven/host";
import type { AgentModelOption } from "@specdriven/host";
import { opencodePath } from "./cli";

/** OpenCode's file of models, in the data repo. */
export const OPENCODE_MODELS_FILE = ".specdriven/opencode-models.json";

/** The most models the menu offers without a data-repo list. */
export const MENU_SIZE = 20;

/** How long one `opencode models` answer stands. */
const CATALOG_TTL_MS = 60_000;

export type ModelLister = () => Promise<string[]>;

/** `opencode models`: one model per line; [] when it fails. */
const listWithCli: ModelLister = async () => {
  const res = await run(opencodePath(), ["models"], { cwd: homedir() });
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[^\s/]+\/\S+$/.test(line));
};

let lister: ModelLister | null = null;
let cached: { at: number; models: string[] } | null = null;

/** Swap how the catalog is read (tests); null restores `opencode models`. Clears the cache. */
export function setModelLister(fn: ModelLister | null): ModelLister | null {
  const previous = lister;
  lister = fn;
  cached = null;
  return previous;
}

/** Every model OpenCode offers now, `provider/model`; cached for a minute. */
export async function opencodeModels(): Promise<string[]> {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
  const models = await (lister ?? listWithCli)().catch(() => [] as string[]);
  // An empty answer (OpenCode not signed in anywhere, or failing) is not kept.
  if (models.length > 0) cached = { at: Date.now(), models };
  return models;
}

/** OpenCode's own state folder: $XDG_STATE_HOME/opencode, else ~/.local/state/opencode. */
export function opencodeStateDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "opencode");
}

/** The models OpenCode's TUI lists as recent (its state's model.json), newest first. */
export async function recentModels(stateDir = opencodeStateDir()): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(stateDir, "model.json"), "utf8"));
  } catch {
    return [];
  }
  const recent = (parsed as { recent?: unknown } | null)?.recent;
  if (!Array.isArray(recent)) return [];
  const out: string[] = [];
  for (const entry of recent) {
    const e = entry as { providerID?: unknown; modelID?: unknown } | null;
    if (typeof e?.providerID === "string" && typeof e.modelID === "string") out.push(`${e.providerID}/${e.modelID}`);
  }
  return out;
}

/** The data repo's list for OpenCode, in order; none without a data repo, a file or a list. */
export async function listedModels(dataDir: string | null): Promise<string[]> {
  if (!dataDir) return [];
  let list: unknown;
  try {
    list = JSON.parse(await readFile(join(dataDir, OPENCODE_MODELS_FILE), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.map(normalizeModel).filter((m): m is string => m !== null);
}

function row(value: string): AgentModelOption {
  return { value, displayName: value };
}

/**
 * The menu: the data repo's list when it has one (kept whole — a name
 * listed on purpose is not dropped); else the default and OpenCode's recent
 * models that the catalog still holds, up to MENU_SIZE; with no recent
 * ones, the catalog's first fill it.
 */
export function modelMenu(input: {
  catalog: readonly string[];
  listed: readonly string[];
  recent: readonly string[];
  defaultModel: string | null;
}): AgentModelOption[] {
  if (input.listed.length > 0) return [...new Set(input.listed)].map(row);
  const known = new Set(input.catalog);
  const picks: string[] = [];
  const add = (m: string | null) => {
    if (m && !picks.includes(m) && (known.size === 0 || known.has(m))) picks.push(m);
  };
  add(input.defaultModel);
  for (const m of input.recent) add(m);
  // No recent models (a fresh OpenCode): the catalog's first fill the menu.
  if (picks.length <= (input.defaultModel ? 1 : 0)) for (const m of input.catalog) add(m);
  return picks.slice(0, MENU_SIZE).map(row);
}
