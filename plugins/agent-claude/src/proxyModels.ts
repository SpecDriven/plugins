// The models an API proxy offers (specs/agents/claude.feature.md "Choose the
// model Claude starts on", in the specs repo): GET /v1/models on the proxy,
// with the token the way Claude Code sends it — the one request "Check
// proxy" already makes (src/auth.ts checkProxy), its answer read this time.
// Settings → Claude's "Default model" and every model menu offer them while
// Claude goes through a proxy, the way the account's models serve a sign-in.

import type { AccountModel } from "./accountModels";
import { SENDABLE_TOKEN, UNSENDABLE_TOKEN, withoutToken } from "./auth";
import { normalizeDefaultModel } from "./settings";

/** How long the proxy gets to answer one page. */
export const PROXY_MODELS_TIMEOUT_MS = 10_000;

/** The most models read from a proxy: a menu, not a catalog. */
const MAX_PROXY_MODELS = 200;

/** One page of GET /v1/models, as the API shapes it. */
interface ModelsPage {
  data?: unknown;
  has_more?: unknown;
  last_id?: unknown;
}

/** The API's model objects as menu rows, dropping what is no model id and repeats. */
export function proxyModelsOf(rows: unknown, into: AccountModel[] = []): AccountModel[] {
  if (!Array.isArray(rows)) return into;
  for (const row of rows as Record<string, unknown>[]) {
    const value = normalizeDefaultModel(row?.id);
    if (!value || into.some((m) => m.value === value)) continue;
    const name = typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : value;
    into.push({ value, displayName: name, description: name !== value ? name : "" });
    if (into.length === MAX_PROXY_MODELS) break;
  }
  return into;
}

/**
 * Every model the proxy lists, page by page. A proxy that refuses the token
 * or answers oddly throws with why; one that answers with no list lists
 * none, which leaves the menus Claude Code's aliases.
 */
export async function fetchProxyModels(
  url: string,
  token: string | null,
  fetchFn: typeof fetch = fetch,
  timeoutMs = PROXY_MODELS_TIMEOUT_MS,
): Promise<AccountModel[]> {
  if (token && !SENDABLE_TOKEN.test(token)) throw new Error(UNSENDABLE_TOKEN);
  const base = url.endsWith("/") ? url : `${url}/`;
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers["x-api-key"] = token;
  }
  const models: AccountModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const target = new URL("v1/models", base);
    target.searchParams.set("limit", "100");
    if (after) target.searchParams.set("after_id", after);
    const res = await fetchFn(target, { headers, signal: AbortSignal.timeout(timeoutMs) }).catch((e: Error) => {
      throw new Error(withoutToken(e.message, token));
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(token ? `The proxy refused the token (HTTP ${res.status})` : `The proxy wants a token (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`The proxy answered HTTP ${res.status} to /v1/models`);
    const body = (await res.json().catch(() => null)) as ModelsPage | null;
    proxyModelsOf(body?.data, models);
    const last = typeof body?.last_id === "string" ? body.last_id : null;
    if (body?.has_more !== true || !last || models.length >= MAX_PROXY_MODELS) break;
    after = last;
  }
  return models;
}
