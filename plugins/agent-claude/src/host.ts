// The Claude agent plugin's host half (specs/agents/claude.feature.md,
// specs/agents/agent-plugins.feature.md in the specs repo): the provider on
// the app's agent registry (src/provider.ts), and the routes for how Claude
// signs in — the mode, what Claude Code's own settings say of a proxy, the
// login driven from Settings, a check of the proxy, and the plugin's own
// settings — among them the model a new Claude starts on, from the models
// the signed-in account offers (src/accountModels.ts). The proxy token lives in the plugin's secret store and never
// leaves the host; the page learns only whether there is one. A local
// Claude only, so every route refuses in the hosted app and the demo.

import { homedir } from "node:os";
import { AgentError, HOSTED_REFUSAL, getLogger, isDemoMode, isHostedMode, json } from "@specdriven/host";
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
  onSignInChange,
  startLogin,
} from "./auth";
import type { EffectiveClaudeAuth, LoginStatus } from "./auth";
import { NO_ACCOUNT, accountModels, fetchAccountModels, forgetAccountModels } from "./accountModels";
import type { AccountProbe } from "./accountModels";
import { canFetchBinary } from "./binary";
import { claudeAvailable } from "./cli";
import { listedClaudeModels } from "./models";
import { createClaudeProvider } from "./provider";
import { ADOPTED_KEY, CLAUDE_LEGACY_KEYS, claudeSettingsOf, claudeSettingsPatch } from "./settings";
import type { ClaudeSettingsValues } from "./settings";

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

function claudeAuthView(auth: EffectiveClaudeAuth, login: LoginStatus, own: ClaudeSettingsValues) {
  return {
    mode: auth.mode,
    inferred: auth.inferred,
    cliAvailable: claudeAvailable(),
    /** No Claude Code yet, but the email sign-in can fetch this platform's. */
    canFetchClaude: canFetchBinary(),
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
    firstResponseSeconds: own.firstResponseSeconds,
    /** The model a new Claude starts on; null is Claude Code's own default. */
    defaultModel: own.defaultModel,
    /** The effort a new Claude starts at; null is Claude Code's own. */
    defaultEffort: own.defaultEffort,
    signIn: loginState(),
  };
}

const log = getLogger("agent-claude");

/** The refusal a sign-in route answers with, logged with what was asked. */
const claudeFailure = (what: string, e: unknown) => {
  const status = e instanceof ClaudeAuthError ? e.status : 502;
  log.warn(`${what} refused`, { status, error: (e as Error).message });
  return json({ error: (e as Error).message }, status);
};

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
      agents.register(
        createClaudeProvider({
          settings,
          token: () => storedToken(secrets),
          listedModels: async () => listedClaudeModels(await data.dir().catch(() => null)),
          accountModels: () => signedInAccountModels(),
          // The pane's model and effort picks become Settings → Claude's defaults.
          saveSettings: async (patch) => {
            const parsed = claudeSettingsPatch(patch);
            if ("error" in parsed) throw new AgentError(400, parsed.error);
            await config.settings.write(parsed.patch);
          },
        }),
      ),
    );

    // A new sign-in — the email one done, Claude Code fetched for it, a
    // sign-out, another mode, proxy or token — makes what the app holds of
    // the old one stale: the pane's "not set up", a live session's account
    // and credentials. The app re-reads the one and refreshes the other
    // (AgentSession.refresh); an app from before `changed` restarts instead.
    // The account's models go with the old sign-in too.
    const signInChanged = () => {
      forgetAccountModels();
      (agents as { changed?(id: string): void }).changed?.("claude");
    };
    ctx.effect(() => onSignInChange(signInChanged));

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

    /** The signed-in Claude account as a Claude Code started under it
        reports it, with the models it offers, for Settings → Claude's
        Default model and the pane's model menu; neither behind a proxy or
        with no one signed in. */
    const signedInAccount = async (): Promise<AccountProbe> => {
      const own = await settings();
      const cwd = await claudeCwd();
      const token = await storedToken(secrets);
      if ((await effectiveClaudeAuth(own, cwd, token)).mode !== "login") return NO_ACCOUNT;
      return accountModels(async () => ((await loginStatus()).loggedIn ? fetchAccountModels(own, cwd, token) : NO_ACCOUNT));
    };
    const signedInAccountModels = async () => (await signedInAccount()).models;

    const answer = async (): Promise<Response> => {
      const own = await settings();
      const auth = await effectiveClaudeAuth(own, await claudeCwd(), await storedToken(secrets));
      return json(claudeAuthView(auth, await loginStatus(), own));
    };

    const getAuth: Handler = () => answer();

    const postToken: Handler = async (req) => {
      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 1024) {
        return json({ error: "Paste the proxy's token" }, 400);
      }
      await secrets.save({ token: body.token.trim() });
      signInChanged();
      return answer();
    };

    const deleteToken: Handler = async () => {
      await secrets.clear();
      signInChanged();
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
      signInChanged();
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
        return claudeFailure("sign-in", e);
      }
    };

    const getLogin: Handler = async () => json({ signIn: loginState(), login: await loginStatus() });

    const deleteLogin: Handler = () => json({ signIn: cancelLogin() });

    const postLogout: Handler = async () => {
      try {
        await claudeLogout();
      } catch (e) {
        return claudeFailure("sign-out", e);
      }
      return answer();
    };

    // Settings → Claude's "Check sign-in": the CLI asked afresh who is
    // signed in and, with an account, a Claude Code started under it for
    // the models it offers — proof the sign-in works, never the cached
    // answer, and the list "Default model" shows from then on. A Claude
    // Code that cannot answer is reported, not an error: the sign-in may
    // still be fine.
    // What that Claude Code found is the proof: `account` is the account
    // it runs as (null when it was not started or did not say), "none"
    // when it found no account, token or key whatever the CLI said.
    const postLoginCheck: Handler = async () => {
      const login = await loginStatus();
      if (!login.loggedIn || login.method === "api_key") return json({ login, models: [], error: null, account: null });
      forgetAccountModels();
      try {
        const { account, models } = await signedInAccount();
        return json({ login, models, error: null, account });
      } catch (e) {
        return json({ login, models: [], error: (e as Error).message, account: null });
      }
    };

    // The models the Claude account offers, for Settings → Claude's
    // "Default model"; none behind a proxy or with no one signed in.
    const getModels: Handler = async () => {
      try {
        return json({ models: await signedInAccountModels() });
      } catch (e) {
        return json({ models: [], error: (e as Error).message }, 502);
      }
    };

    const getSettings: Handler = async () => json(await settings());

    const putSettings: Handler = async (req) => {
      const parsed = claudeSettingsPatch(await req.json().catch(() => null));
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await config.settings.write(parsed.patch);
      if ("claudeAuth" in parsed.patch || "claudeProxyUrl" in parsed.patch) signInChanged();
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
    add("POST", "/api/claude/login/check", postLoginCheck);
    add("GET", "/api/claude/models", getModels);
    add("GET", "/api/claude/settings", getSettings);
    add("PUT", "/api/claude/settings", putSettings);
  },
};

export default plugin;
