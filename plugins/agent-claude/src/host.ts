// The Claude agent plugin's host half (specs/agents/claude.feature.md,
// specs/agents/agent-plugins.feature.md in the specs repo): the provider on
// the app's agent registry (src/provider.ts), and the routes for how Claude
// signs in — the mode, what Claude Code's own settings say of a proxy, the
// login driven from Settings, a check of the proxy, and the plugin's own
// settings. The proxy token lives in the plugin's secret store and never
// leaves the host; the page learns only whether there is one. A local
// Claude only, so every route refuses in the hosted app and the demo.

import { homedir } from "node:os";
import { HOSTED_REFUSAL, isDemoMode, isHostedMode, json } from "@specdriven/host";
import type { Context, Handler, HostConfig, Plugin, SecretStore } from "@specdriven/host";
import {
  ClaudeAuthError,
  cancelLogin,
  checkProxy,
  detectClaudeProxy,
  effectiveClaudeAuth,
  loginState,
  loginStatus,
  logout as claudeLogout,
  startLogin,
} from "./auth";
import type { EffectiveClaudeAuth, LoginStatus } from "./auth";
import { claudeAvailable } from "./cli";
import { createClaudeProvider } from "./provider";
import { ADOPTED_KEY, CLAUDE_LEGACY_KEYS, claudeSettingsOf, claudeSettingsPatch } from "./settings";

export const DEMO_REFUSAL = "Claude sign-in is disabled in demo mode";

/** The secret store the proxy token lives in (HostConfig.secrets). */
export const TOKEN_STORE = "token";

/** Refused where there is no local Claude; otherwise the handler. */
const guarded =
  (handler: Handler): Handler =>
  (req, params) => {
    if (isHostedMode()) return json({ error: HOSTED_REFUSAL }, 403);
    if (isDemoMode()) return json({ error: DEMO_REFUSAL }, 403);
    return handler(req, params);
  };

/** A settings file's path with the home folder as ~, for the page. */
function tilde(path: string | null): string | null {
  const home = homedir();
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function claudeAuthView(auth: EffectiveClaudeAuth, login: LoginStatus, firstResponseSeconds: number) {
  return {
    mode: auth.mode,
    inferred: auth.inferred,
    cliAvailable: claudeAvailable(),
    login,
    proxy: {
      /** The url in effect: the stored one, else the detected one. */
      url: auth.storedUrl ?? auth.detected.url,
      storedUrl: auth.storedUrl,
      storedToken: auth.storedToken,
      hasToken: auth.storedToken || auth.detected.token !== null,
      detected: {
        url: auth.detected.url,
        urlSource: tilde(auth.detected.urlSource),
        hasToken: auth.detected.token !== null,
        tokenSource: tilde(auth.detected.tokenSource),
      },
    },
    /** The pane's first-response wait behind the proxy; 0 is no limit. */
    firstResponseSeconds,
    signIn: loginState(),
  };
}

const claudeFailure = (e: unknown) =>
  e instanceof ClaudeAuthError ? json({ error: e.message }, e.status) : json({ error: (e as Error).message }, 502);

/** The token the store holds, or null. */
async function storedToken(secrets: SecretStore): Promise<string | null> {
  return (await secrets.load())?.token ?? null;
}

const plugin: Plugin<Context, HostConfig> = {
  name: "agent-claude",
  inject: ["routes", "agents", "data"],
  async apply(ctx, config) {
    const agents = ctx.need("agents");
    const routes = ctx.need("routes");
    const data = ctx.need("data");
    const secrets = config.secrets(TOKEN_STORE);
    const settings = async () => claudeSettingsOf(await config.settings.read());

    ctx.effect(() =>
      agents.register(createClaudeProvider({ settings, token: () => storedToken(secrets) })),
    );

    // The values that lived at the top of settings.json while Claude was
    // built in come into the plugin's section once.
    try {
      await config.settings.adopt(CLAUDE_LEGACY_KEYS);
      if ((await config.settings.read())[ADOPTED_KEY] !== true) await config.settings.write({ [ADOPTED_KEY]: true });
    } catch (e) {
      console.error(`[agent-claude] adopting settings: ${(e as Error).message}`);
    }

    /** Where Claude Code's project settings would be read from: the open
        data folder, else the process's folder. */
    const claudeCwd = async (): Promise<string> => {
      try {
        return (await data.dir()) ?? process.cwd();
      } catch {
        return process.cwd();
      }
    };

    const answer = async (): Promise<Response> => {
      const own = await settings();
      const auth = await effectiveClaudeAuth(own, await claudeCwd(), await storedToken(secrets));
      return json(claudeAuthView(auth, await loginStatus(), own.firstResponseSeconds));
    };

    const getAuth: Handler = () => answer();

    const postToken: Handler = async (req) => {
      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 1024) {
        return json({ error: "Paste the proxy's token" }, 400);
      }
      await secrets.save({ token: body.token.trim() });
      return answer();
    };

    const deleteToken: Handler = async () => {
      await secrets.clear();
      return answer();
    };

    // "Use detected": the url and token Claude Code's settings or the
    // environment carry become the plugin's own, copied host-side so the
    // token never passes through the page.
    const postProxyDetect: Handler = async () => {
      const detected = await detectClaudeProxy(await claudeCwd());
      if (!detected.url) return json({ error: "No proxy found in Claude Code's settings or the environment" }, 404);
      await config.settings.write({ claudeProxyUrl: detected.url });
      if (detected.token) await secrets.save({ token: detected.token });
      return answer();
    };

    const postProxyCheck: Handler = async (req) => {
      const body = (await req.json().catch(() => ({}))) as { url?: unknown };
      const auth = await effectiveClaudeAuth(await settings(), await claudeCwd(), await storedToken(secrets));
      const typed = typeof body.url === "string" ? claudeSettingsPatch({ claudeProxyUrl: body.url }) : null;
      const url =
        (typed && "patch" in typed ? (typed.patch.claudeProxyUrl as string | null) : null) ||
        auth.storedUrl ||
        auth.detected.url;
      if (!url) return json({ error: "Enter the proxy's url first" }, 400);
      const token = (await storedToken(secrets)) ?? auth.detected.token;
      return json({ url, ...(await checkProxy(url, token)) });
    };

    const postLogin: Handler = async (req) => {
      const body = (await req.json().catch(() => ({}))) as { email?: unknown };
      try {
        return json({ signIn: await startLogin(typeof body.email === "string" ? body.email : "") });
      } catch (e) {
        return claudeFailure(e);
      }
    };

    const getLogin: Handler = async () => json({ signIn: loginState(), login: await loginStatus() });

    const deleteLogin: Handler = () => json({ signIn: cancelLogin() });

    const postLogout: Handler = async () => {
      try {
        await claudeLogout();
      } catch (e) {
        return claudeFailure(e);
      }
      return answer();
    };

    const getSettings: Handler = async () => json(await settings());

    const putSettings: Handler = async (req) => {
      const parsed = claudeSettingsPatch(await req.json().catch(() => null));
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await config.settings.write(parsed.patch);
      return json(await settings());
    };

    const add = (method: string, pattern: string, handler: Handler) =>
      ctx.effect(() => routes.add(method, pattern, guarded(handler)));
    add("GET", "/api/claude/auth", getAuth);
    add("POST", "/api/claude/token", postToken);
    add("DELETE", "/api/claude/token", deleteToken);
    add("POST", "/api/claude/proxy/detect", postProxyDetect);
    add("POST", "/api/claude/proxy/check", postProxyCheck);
    add("POST", "/api/claude/login", postLogin);
    add("GET", "/api/claude/login", getLogin);
    add("DELETE", "/api/claude/login", deleteLogin);
    add("POST", "/api/claude/logout", postLogout);
    add("GET", "/api/claude/settings", getSettings);
    add("PUT", "/api/claude/settings", putSettings);
  },
};

export default plugin;
