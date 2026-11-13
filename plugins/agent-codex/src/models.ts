// The models Codex's sign-in offers (specs/agents/codex.feature.md "Codex
// lists the models its sign-in offers", in the specs repo). With the API,
// the API's own list: GET <address>/models with the key — the request
// "Check connection" makes (src/auth.ts checkApi), its answer read this
// time. With a ChatGPT account, Codex's own list for it (`model/list`,
// asked of a `codex app-server` started under the account for nothing
// else). The data repo's `.specdriven/codex-models.json` (Settings →
// Codex's "Codex models", the app's) narrows either to the names it lists
// (src/modelMenu.ts).
// An answer is kept a while, per sign-in, and forgotten when it changes.
//
// Node APIs only — this module also runs under Electron.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ACCOUNT_ARGS, SENDABLE_KEY, UNSENDABLE_KEY, modelsUrl, withoutKey } from "./auth";
import { CODEX_CLIENT_INFO, CodexClient } from "./codexChat";
import type { CodexModel } from "./modelMenu";
import { normalizeModel } from "./settings";

export type { CodexModel } from "./modelMenu";

/** How long the API gets to answer. */
export const API_MODELS_TIMEOUT_MS = 10_000;

/** The most models read from an API: a menu, not a catalog. */
const MAX_MODELS = 200;

/** The API's model objects (`{ id }`) as menu rows, dropping what is no
    model id and repeats. */
export function apiModelsOf(rows: unknown): CodexModel[] {
  const models: CodexModel[] = [];
  if (!Array.isArray(rows)) return models;
  for (const row of rows as Record<string, unknown>[]) {
    const value = normalizeModel(row?.id);
    if (!value || models.some((m) => m.value === value)) continue;
    const name = typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : value;
    models.push({ value, displayName: name, description: "" });
    if (models.length === MAX_MODELS) break;
  }
  return models;
}

/**
 * Every model the API lists: GET <address>/models, with the key as a
 * bearer token. An API that refuses the key or answers oddly throws with
 * why — never quoting the key; one that answers with no list lists none.
 */
export async function fetchApiModels(
  url: string,
  key: string | null,
  fetchFn: typeof fetch = fetch,
  timeoutMs = API_MODELS_TIMEOUT_MS,
): Promise<CodexModel[]> {
  if (key && !SENDABLE_KEY.test(key)) throw new Error(UNSENDABLE_KEY);
  const res = await fetchFn(modelsUrl(url), {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e: Error) => {
    throw new Error(e.name === "TimeoutError" ? "The API did not list its models in time" : withoutKey(e.message, key));
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(key ? `The API refused the key (HTTP ${res.status})` : `The API wants a key (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`The API answered HTTP ${res.status} to /models`);
  const body = (await res.json().catch(() => null)) as { data?: unknown } | unknown[] | null;
  return apiModelsOf(Array.isArray(body) ? body : body?.data);
}

/** Codex's own model rows (`model/list`) as menu rows, the hidden ones left out. */
export function accountModelsOf(rows: unknown): CodexModel[] {
  const models: CodexModel[] = [];
  if (!Array.isArray(rows)) return models;
  for (const row of rows as Record<string, unknown>[]) {
    const value = normalizeModel(row?.model ?? row?.id);
    if (!value || row.hidden === true || models.some((m) => m.value === value)) continue;
    models.push({
      value,
      displayName: typeof row.displayName === "string" && row.displayName ? row.displayName : value,
      description: typeof row.description === "string" ? row.description : "",
    });
  }
  return models;
}

/** How long a Codex started to list its models gets to answer. */
const ACCOUNT_MODELS_TIMEOUT_MS = 15_000;

/** The models Codex lists for the signed-in ChatGPT account: `model/list`
    of a `codex app-server` started under the account sign-in. */
export async function fetchAccountModels(cwd: string = process.cwd()): Promise<CodexModel[]> {
  return new Promise<CodexModel[]>((resolve, reject) => {
    let settled = false;
    const done = (models: CodexModel[] | null, error?: string) => {
      if (settled) return;
      settled = true;
      client.close();
      if (models) resolve(models);
      else reject(new Error(error ?? "Codex did not list its models"));
    };
    const client = new CodexClient({
      cwd,
      extraArgs: [...ACCOUNT_ARGS],
      onNotification: () => {},
      onServerRequest: (id) => client.respondError(id, "not supported"),
      onStderr: () => {},
      onExit: (_code, error) => done(null, error ? `Could not start Codex: ${error.message}` : "Codex exited before listing its models"),
    });
    void (async () => {
      const init = await client.request(
        "initialize",
        { clientInfo: CODEX_CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } },
        ACCOUNT_MODELS_TIMEOUT_MS,
      );
      if (!init.ok) return done(null, init.error);
      const listed = await client.request("model/list", {}, ACCOUNT_MODELS_TIMEOUT_MS);
      if (!listed.ok) return done(null, listed.error);
      done(accountModelsOf(listed.result.data));
    })();
  });
}

// --- One answer per sign-in ---------------------------------------------------

/** How long an answer is kept before it is asked for again. */
export const MODELS_TTL_MS = 10 * 60_000;

let cached: { key: string; models: CodexModel[]; at: number } | null = null;
let pending: { key: string; asking: Promise<CodexModel[]> } | null = null;

/**
 * The sign-in's models, asked for at most once per sign-in and TTL; a
 * failed ask is not kept, so the next one tries again. `key` names the
 * sign-in the answer is for — the account, or an API and its key: an
 * answer kept or being asked for under another is never given.
 */
export async function offeredModels(ask: () => Promise<CodexModel[]>, key: string, now = Date.now()): Promise<CodexModel[]> {
  if (cached && cached.key === key && now - cached.at < MODELS_TTL_MS) return cached.models;
  if (pending?.key !== key) {
    const mine: { key: string; asking: Promise<CodexModel[]> } = { key, asking: Promise.resolve([]) };
    mine.asking = ask()
      .then((models) => {
        if (pending === mine) cached = { key, models, at: Date.now() };
        return models;
      })
      .finally(() => {
        if (pending === mine) pending = null;
      });
    pending = mine;
  }
  return pending.asking;
}

/** Forget the answer: the sign-in changed, so its models may have. */
export function forgetModels(): void {
  cached = null;
  pending = null;
}

// --- The data repo's list -----------------------------------------------------

/** Codex's file of models, in the data repo. */
export const CODEX_MODELS_FILE = ".specdriven/codex-models.json";

/** The app's old file of every agent's models, in the data repo. */
export const AGENT_MODELS_FILE = ".specdriven/agent-models.json";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Codex's list, in order; none without a data repo, a file or a list. */
export async function listedCodexModels(dataDir: string | null): Promise<string[]> {
  if (!dataDir) return [];
  let list: unknown;
  try {
    list = await readJson(join(dataDir, CODEX_MODELS_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return [];
    try {
      list = ((await readJson(join(dataDir, AGENT_MODELS_FILE))) as { codex?: unknown } | null)?.codex;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map(normalizeModel).filter((m): m is string => m !== null);
}
