// Trying the API again when the user switches folders
// (specs/agents/agent-pane.feature.md S14 "Switching folders tries the
// agent's API again"): the app calls the provider's reconnect with the folder
// now open. A Claude whose API goes through a proxy checks that proxy —
// the same check as Settings' "Check connection" (src/auth.ts checkProxy),
// which wakes a proxy that went quiet — a few times, a moment apart, and
// says whether it answered. A Claude signed in to an account has nothing to
// try. An app from before the hook never calls it.

import { checkProxy, effectiveClaudeAuth, type ProxyCheck } from "./auth";
import type { ClaudeSettingsValues } from "./settings";

/** What a reconnect found, as the app's AgentReconnect has it. */
export interface ReconnectAnswer {
  ok: boolean;
  detail: string;
  url?: string;
}

export interface ReconnectDeps {
  settings: () => Promise<ClaudeSettingsValues>;
  /** The proxy token the plugin's secret store holds. */
  token: () => Promise<string | null>;
  /** Default: checkProxy. */
  check?: (url: string, token: string | null) => Promise<{ result: ProxyCheck; detail: string }>;
  /** Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** The proxy answered: what was learned of the old one (its models) goes. */
  answered?: () => void;
  /** Env for the proxy Claude Code's own settings name; default process.env. */
  env?: NodeJS.ProcessEnv;
}

/** How many times an unreachable proxy is tried, and the pause between. */
export const RECONNECT_TRIES = 3;
export const RECONNECT_PAUSE_MS = 1000;

/**
 * Check the proxy a Claude session started in `cwd` would use. Null with no
 * proxy (an account sign-in, or proxy mode with no url anywhere). A proxy
 * that refuses the token is an answer, not a reason to try again.
 */
export async function reconnectProxy(cwd: string, deps: ReconnectDeps): Promise<ReconnectAnswer | null> {
  const auth = await effectiveClaudeAuth(await deps.settings(), cwd, await deps.token(), deps.env ?? process.env);
  if (!auth.proxy) return null;
  const { url, token } = auth.proxy;
  const check = deps.check ?? ((u: string, t: string | null) => checkProxy(u, t));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = { result: "unreachable" as ProxyCheck, detail: "" };
  for (let attempt = 1; attempt <= RECONNECT_TRIES; attempt++) {
    last = await check(url, token);
    if (last.result !== "unreachable") break;
    if (attempt < RECONNECT_TRIES) await sleep(RECONNECT_PAUSE_MS);
  }
  if (last.result !== "unreachable") deps.answered?.();
  switch (last.result) {
    case "ok":
      return { ok: true, detail: `The API at ${url} answers`, url };
    case "unexpected":
      // It answered, just not the model list: turns can still go through.
      return { ok: true, detail: `The API at ${url} answers (${last.detail})`, url };
    case "unauthorized":
      return { ok: false, detail: `The API at ${url} answers but refuses the token — ${last.detail}. Check Settings → Claude.`, url };
    case "unreachable":
      return {
        ok: false,
        detail: `No answer from the API at ${url} after ${RECONNECT_TRIES} tries — is the proxy running? (${last.detail})`,
        url,
      };
  }
}

/** The provider with a reconnect hook, as withReportedModels adds its own. */
export function withReconnect<P extends object>(
  provider: P,
  deps: ReconnectDeps,
): P & { reconnect(ctx: { cwd: string }): Promise<ReconnectAnswer | null> } {
  return Object.assign(provider, {
    reconnect: ({ cwd }: { cwd: string }) => reconnectProxy(cwd, deps),
  });
}
