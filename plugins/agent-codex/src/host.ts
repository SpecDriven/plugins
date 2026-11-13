// The Codex agent plugin's host half (specs/agents/codex.feature.md in the
// specs repo): the provider on the app's agent registry (src/provider.ts),
// and the routes for how Codex signs in — the mode, what Codex's own config
// says of an API, the ChatGPT login driven from Settings, a check of the
// API, the models the sign-in offers, and the plugin's own settings. The
// API key lives in the plugin's secret store and never leaves the host;
// the page learns only whether there is one. A local Codex only, so every
// route refuses in the hosted app and the demo. Switching the plugin off
// takes its sessions down with it.

import { homedir } from "node:os";
import { AgentError, HOSTED_REFUSAL, getLogger, isDemoMode, isHostedMode, json } from "@specdriven/host";
import type { Context, Handler, HostConfig, Plugin, SecretStore } from "@specdriven/host";
import {
  CodexAuthError,
  SENDABLE_KEY,
  accountEmail,
  cancelLogin,
  checkApi,
  detectCodexApi,
  effectiveCodexAuth,
  launchFor,
  loginState,
  loginStatus,
  logout as codexLogout,
  onSignInChange,
  startLogin,
} from "./auth";
import type { EffectiveCodexAuth, LoginStatus } from "./auth";
import { codexAvailable } from "./cli";
import { fetchAccountModels, fetchApiModels, forgetModels, listedCodexModels, offeredModels as keptModels } from "./models";
import type { CodexModel } from "./models";
import { createCodexProvider, describeSignIn } from "./provider";
import { codexSettingsOf, codexSettingsPatch } from "./settings";
import type { CodexSettingsValues } from "./settings";

export const DEMO_REFUSAL = "Codex sign-in is disabled in demo mode";

/** How long `codex login status` and the account's email stand. */
const SIGN_IN_TTL_MS = 30_000;

/** The secret store the API key lives in (HostConfig.secrets). */
export const KEY_STORE = "key";

/** Refused where there is no local Codex; otherwise the handler. */
const guarded =
  (handler: Handler): Handler =>
  (req, params) => {
    if (isHostedMode()) return json({ error: HOSTED_REFUSAL }, 403);
    if (isDemoMode()) return json({ error: DEMO_REFUSAL }, 403);
    return handler(req, params);
  };

/** A config file's path with the home folder as ~, for the page. */
function tilde(path: string | null): string | null {
  const home = homedir();
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function codexAuthView(auth: EffectiveCodexAuth, login: LoginStatus, own: CodexSettingsValues) {
  return {
    mode: auth.mode,
    inferred: auth.inferred,
    cliAvailable: codexAvailable(),
    login,
    api: {
      /** The address in effect: the stored one, else the detected one,
          else OpenAI's own once there is a key. */
      url: auth.url,
      storedUrl: auth.storedUrl,
      storedKey: auth.storedKey,
      hasKey: auth.storedKey || auth.detected.key !== null,
      detected: {
        url: auth.detected.url,
        urlSource: tilde(auth.detected.urlSource),
        hasKey: auth.detected.key !== null,
        keySource: tilde(auth.detected.keySource),
        /** Codex's own config requires API keys: a Codex started outside
            the app signs a ChatGPT account out. */
        requiresApiKey: auth.detected.requiresApiKey,
      },
    },
    /** The model a new Codex starts on; null is Codex's own default. */
    defaultModel: own.defaultModel,
    signIn: loginState(),
  };
}

const log = getLogger("agent-codex");

/** The refusal a sign-in route answers with, logged with what was asked. */
const codexFailure = (what: string, e: unknown) => {
  const status = e instanceof CodexAuthError ? e.status : 502;
  log.warn(`${what} refused`, { status, error: (e as Error).message });
  return json({ error: (e as Error).message }, status);
};

/** The key the store holds, or null. */
async function storedKey(secrets: SecretStore): Promise<string | null> {
  return (await secrets.load())?.key ?? null;
}

const plugin: Plugin<Context, HostConfig> = {
  name: "agent-codex",
  inject: ["routes", "agents", "data"],
  async apply(ctx, config) {
    const agents = ctx.need("agents");
    const routes = ctx.need("routes");
    const data = ctx.need("data");
    const secrets = config.secrets(KEY_STORE);
    const settings = async () => codexSettingsOf(await config.settings.read());
    const effective = async () => effectiveCodexAuth(await settings(), await storedKey(secrets));

    // Who is signed in to ChatGPT, as the account sign-in starts Codex:
    // `codex login status`, then the account's email of a Codex started for
    // nothing else. Kept a while — every model menu that mounts asks — and
    // dropped with the sign-in. A session's start does not wait for the
    // email (`wait` false): it is only the chip's tooltip.
    let signedIn: LoginStatus | null = null;
    let signedInAt = -Infinity;
    let signInAge = 0;
    const chatgptLogin = async (fresh = false, wait = true): Promise<LoginStatus> => {
      if (!fresh && signedIn && Date.now() - signedInAt < SIGN_IN_TTL_MS) return signedIn;
      const age = signInAge;
      const status = await loginStatus();
      signedIn = status;
      signedInAt = Date.now();
      if (!status.loggedIn || status.email) return status;
      const asking = accountEmail()
        .catch(() => null)
        .then((email) => {
          const named = { ...status, email };
          if (age === signInAge) signedIn = named;
          return named;
        });
      return wait ? asking : status;
    };

    /** The models the sign-in offers, for every model menu: the API's own
        list while Codex goes to an API, Codex's list for the ChatGPT
        account while it signs in with one — kept a while, forgotten with
        the sign-in. */
    const offeredModels = async (): Promise<CodexModel[]> => {
      const auth = await effective();
      if (auth.mode === "login") {
        if (!(await chatgptLogin()).loggedIn) return [];
        return keptModels(() => fetchAccountModels(), "login");
      }
      if (!auth.api) return [];
      const { url, key } = auth.api;
      // Kept for this address and key only: an answer asked for under
      // another sign-in is never offered.
      return keptModels(() => fetchApiModels(url, key), `api\n${url}\n${key ?? ""}`);
    };

    /** describeSignIn for what Settings chose: the API's address, or the
        ChatGPT account `codex login status` reports. */
    const currentSignIn = async () => {
      const auth = await effective();
      if (auth.mode === "api") return describeSignIn({ mode: "api", apiUrl: auth.api?.url ?? null, login: null });
      return describeSignIn({ mode: "login", apiUrl: null, login: await chatgptLogin(false, false) });
    };

    ctx.effect(() =>
      agents.register(
        createCodexProvider({
          settings,
          // The sign-in, read afresh for every Codex the app starts. The
          // ChatGPT login is asked of the CLI each time: it is only ever
          // required of a Codex that has one (src/auth.ts).
          launch: async () => launchFor(await effective(), (await loginStatus()).loggedIn),
          signIn: currentSignIn,
          listedModels: async () => listedCodexModels(await data.dir().catch(() => null)),
          offeredModels,
          // The pane's model pick becomes Settings → Codex's default.
          saveSettings: async (patch) => {
            const parsed = codexSettingsPatch(patch);
            if ("error" in parsed) throw new AgentError(400, parsed.error);
            await config.settings.write(parsed.patch);
          },
        }),
      ),
    );

    // A new sign-in — the ChatGPT one done, a sign-out, another mode,
    // address or key — makes what the app holds of the old one stale: the
    // pane's chip and model menu. The app re-reads them (an app from before
    // `changed` does on its next load).
    const signInChanged = () => {
      forgetModels();
      signedIn = null;
      signedInAt = -Infinity;
      signInAge += 1;
      (agents as { changed?(id: string): void }).changed?.("codex");
    };
    ctx.effect(() => onSignInChange(signInChanged));

    const answer = async (fresh = false): Promise<Response> =>
      json(codexAuthView(await effective(), await chatgptLogin(fresh), await settings()));

    const getAuth: Handler = () => answer();

    const postKey: Handler = async (req) => {
      const body = (await req.json().catch(() => ({}))) as { key?: unknown };
      if (typeof body.key !== "string" || !body.key.trim() || body.key.length > 1024) {
        return json({ error: "Paste the API key" }, 400);
      }
      if (!SENDABLE_KEY.test(body.key.trim())) {
        return json({ error: "A key is letters, digits and punctuation, with no spaces or line breaks" }, 400);
      }
      await secrets.save({ key: body.key.trim() });
      signInChanged();
      return answer();
    };

    const deleteKey: Handler = async () => {
      await secrets.clear();
      signInChanged();
      return answer();
    };

    // "Use detected": the address and key Codex's own config carries become
    // the plugin's own, copied host-side so the key never passes through
    // the page.
    const postApiDetect: Handler = async () => {
      const detected = await detectCodexApi();
      if (!detected.url && !detected.key) return json({ error: "No API found in Codex's own config" }, 404);
      if (detected.url) await config.settings.write({ codexApiUrl: detected.url });
      if (detected.key) await secrets.save({ key: detected.key });
      signInChanged();
      return answer();
    };

    const postApiCheck: Handler = async (req) => {
      const body = (await req.json().catch(() => ({}))) as { url?: unknown };
      const auth = await effective();
      const typed = typeof body.url === "string" ? codexSettingsPatch({ codexApiUrl: body.url }) : null;
      const url = (typed && "patch" in typed ? (typed.patch.codexApiUrl as string | null) : null) || auth.url;
      if (!url) return json({ error: "Enter the API's address first" }, 400);
      const key = (await storedKey(secrets)) ?? auth.detected.key;
      // The API may list other models now: the next menu asks it again.
      forgetModels();
      return json({ url, ...(await checkApi(url, key)) });
    };

    const postLogin: Handler = async () => {
      try {
        return json({ signIn: await startLogin() });
      } catch (e) {
        return codexFailure("sign-in", e);
      }
    };

    const getLogin: Handler = async () => json({ signIn: loginState(), login: await chatgptLogin(true) });

    const deleteLogin: Handler = () => json({ signIn: cancelLogin() });

    const postLogout: Handler = async () => {
      try {
        await codexLogout();
      } catch (e) {
        return codexFailure("sign-out", e);
      }
      return answer(true);
    };

    // Settings → Codex's "Check sign-in": the CLI asked afresh who is
    // signed in and, with an account, a Codex started under it for the
    // models it lists — never the kept answer. A Codex that cannot list
    // them is reported, not an error: the sign-in may still be fine.
    const postLoginCheck: Handler = async () => {
      forgetModels();
      const login = await chatgptLogin(true);
      if (!login.loggedIn) return json({ login, models: [], error: null });
      try {
        return json({ login, models: await offeredModels(), error: null });
      } catch (e) {
        return json({ login, models: [], error: (e as Error).message });
      }
    };

    // The models the sign-in offers, for Settings → Codex's "Default
    // model": the API's, or the ChatGPT account's; none with no one signed
    // in, or an API that lists none.
    const getModels: Handler = async () => {
      try {
        return json({ models: await offeredModels() });
      } catch (e) {
        return json({ models: [], error: (e as Error).message }, 502);
      }
    };

    const getSettings: Handler = async () => json(await settings());

    const putSettings: Handler = async (req) => {
      const parsed = codexSettingsPatch(await req.json().catch(() => null));
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      await config.settings.write(parsed.patch);
      if ("codexAuth" in parsed.patch || "codexApiUrl" in parsed.patch) signInChanged();
      return json(await settings());
    };

    const add = (method: string, pattern: string, handler: Handler) =>
      ctx.effect(() => routes.add(method, pattern, guarded(handler)));
    add("GET", "/api/codex/auth", getAuth);
    add("POST", "/api/codex/key", postKey);
    add("DELETE", "/api/codex/key", deleteKey);
    add("POST", "/api/codex/api/detect", postApiDetect);
    add("POST", "/api/codex/api/check", postApiCheck);
    add("POST", "/api/codex/login", postLogin);
    add("GET", "/api/codex/login", getLogin);
    add("DELETE", "/api/codex/login", deleteLogin);
    add("POST", "/api/codex/logout", postLogout);
    add("POST", "/api/codex/login/check", postLoginCheck);
    add("GET", "/api/codex/models", getModels);
    add("GET", "/api/codex/settings", getSettings);
    add("PUT", "/api/codex/settings", putSettings);
  },
};

export default plugin;
