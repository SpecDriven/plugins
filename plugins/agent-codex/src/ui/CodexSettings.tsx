import { useEffect, useState } from "react";
import { modelLabel, narrowModels, type CodexModel } from "../modelMenu";
import { OPENAI_API_URL, type CodexAuthMode } from "../settings";

// Settings → Codex (specs/agents/codex.feature.md "Choose how Codex signs
// in", "API settings are filled in from Codex's own config", "Sign in to
// Codex with a ChatGPT account", "Codex lists the models its sign-in
// offers"): how every Codex the app starts signs in — the ChatGPT account
// the Codex CLI is signed in to, or the API with a key kept on this device
// — and the model it starts on. The host half (src/auth.ts, src/host.ts)
// never sends a key back; the page learns only whether there is one. What
// the section changes goes through the plugin's own route
// (PUT /api/codex/settings), into its section of the settings file.

export interface CodexSignIn {
  inProgress: boolean;
  url: string | null;
  done: boolean;
  error: string | null;
}

export interface CodexAuthInfo {
  mode: CodexAuthMode;
  /** No stored choice: the server inferred this one. */
  inferred: boolean;
  cliAvailable: boolean;
  /** Whether a ChatGPT account is signed in, and which. */
  login: { loggedIn: boolean; method: string; email: string | null };
  api: {
    url: string | null;
    storedUrl: string | null;
    storedKey: boolean;
    hasKey: boolean;
    detected: {
      url: string | null;
      urlSource: string | null;
      hasKey: boolean;
      keySource: string | null;
      requiresApiKey: boolean;
    };
  };
  /** The model a new Codex starts on; null is Codex's own default. */
  defaultModel: string | null;
  signIn: CodexSignIn | null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? "Something went wrong" };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Could not reach the app" };
  }
}

/** The plugin's own settings, patched through its route. */
async function patchCodexSettings(patch: {
  codexAuth?: CodexAuthMode | null;
  codexApiUrl?: string | null;
  defaultModel?: string | null;
}): Promise<string | null> {
  const result = await call("PUT", "/api/codex/settings", patch);
  return result.ok ? null : result.error;
}

export async function fetchCodexAuth(): Promise<CodexAuthInfo | null> {
  const result = await call<CodexAuthInfo>("GET", "/api/codex/auth");
  return result.ok ? result.data : null;
}

/** The models the sign-in offers; null when it lists none or could not say. */
export async function fetchOfferedModels(): Promise<CodexModel[] | null> {
  const result = await call<{ models: CodexModel[] }>("GET", "/api/codex/models");
  return result.ok && result.data.models.length > 0 ? result.data.models : null;
}

const MODE_HINT: Record<CodexAuthMode, string> = {
  login:
    "Sessions use the ChatGPT account the Codex CLI is signed in to. An API address or key in Codex's own config is set aside for them.",
  api: "Sessions send their API calls to the address below, with its key. That overrides whatever Codex's own config says.",
};

/**
 * The models the data repo lists for Codex (the "Codex models" list the app
 * adds to this section), from the state payload; null from an app that
 * keeps no lists.
 */
export function codexModelsOf(settings: Record<string, unknown>): string[] | null {
  const all = settings.agentModels;
  if (!all || typeof all !== "object" || Array.isArray(all)) return null;
  const list = (all as Record<string, unknown>).codex;
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : [];
}

/** The section's body: the mode, then the account or the API, then the model. */
export function CodexSettings({ models = null }: { models?: string[] | null } = {}) {
  const [info, setInfo] = useState<CodexAuthInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offered, setOffered] = useState<CodexModel[] | null>(null);

  // The models the sign-in offers — the API's own list (GET
  // <address>/models), or the ChatGPT account's — asked afresh whenever the
  // account or the API changes, and again once a sign-in or a check of the
  // API is done.
  const signInKey =
    info?.mode === "login"
      ? info.login.loggedIn
        ? `login ${info.login.email ?? ""}`
        : null
      : info?.mode === "api" && info.api.url
        ? `api ${info.api.url} ${info.api.hasKey} ${info.api.storedKey}`
        : null;
  const [modelsAsk, setModelsAsk] = useState(0);
  const reloadModels = () => setModelsAsk((n) => n + 1);
  useEffect(() => {
    setOffered(null);
    if (signInKey === null) return;
    let live = true;
    void fetchOfferedModels().then((list) => {
      if (live) setOffered(list);
    });
    return () => {
      live = false;
    };
  }, [signInKey, modelsAsk]);

  const refresh = async () => {
    const next = await fetchCodexAuth();
    setFailed(next === null);
    if (next) setInfo(next);
  };
  useEffect(() => {
    void refresh();
  }, []);

  if (failed && !info) return <p className="hint">Could not read how Codex signs in.</p>;
  if (!info) return <p className="hint">Checking how Codex signs in…</p>;

  const pickMode = async (mode: CodexAuthMode) => {
    setInfo({ ...info, mode, inferred: false });
    setError(await patchCodexSettings({ codexAuth: mode }));
    await refresh();
  };

  return (
    <div className="codex-settings">
      <label className="settings-row">
        <span className="settings-row-label">
          Sign in with
          <span className="settings-row-hint">
            {info.inferred ? "Chosen for you from Codex's own config — pick one to keep it. " : ""}
            {MODE_HINT[info.mode]}
          </span>
        </span>
        <select aria-label="Codex sign-in" value={info.mode} onChange={(e) => void pickMode(e.target.value as CodexAuthMode)}>
          <option value="login">ChatGPT account</option>
          <option value="api">API</option>
        </select>
      </label>
      {info.mode === "login" ? (
        <CodexAccount info={info} onChange={setInfo} refresh={refresh} reloadModels={reloadModels} onModels={setOffered} />
      ) : (
        <CodexApi info={info} refresh={refresh} onError={setError} reloadModels={reloadModels} />
      )}
      <DefaultModel
        info={info}
        models={models}
        offered={signInKey === null ? null : offered}
        offeredBy={info.mode === "api" ? "the API lists" : "your ChatGPT account offers"}
        refresh={refresh}
        onError={setError}
      />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * The model a new Codex starts on ("Codex lists the models its sign-in
 * offers"): a dropdown of what the sign-in offers — the API's own model
 * list, or the ChatGPT account's — narrowed to the names the data repo
 * lists for Codex when it lists any. With nothing listed, Codex's own
 * default stays a choice. A default the menu does not hold stays on offer,
 * so opening the menu never changes it. With no list from the sign-in, a
 * field for a model id.
 */
export function DefaultModel({
  info,
  models,
  offered = null,
  offeredBy = "the API lists",
  refresh,
  onError,
}: {
  info: CodexAuthInfo;
  /** The names the data repo lists for Codex, which narrow the menu; null
      from an app that keeps no lists. */
  models: string[] | null;
  /** The models the sign-in offers; null when not signed in or not known. */
  offered?: CodexModel[] | null;
  /** Who offers them, for the hint. */
  offeredBy?: string;
  refresh: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const [draft, setDraft] = useState(info.defaultModel ?? "");
  useEffect(() => setDraft(info.defaultModel ?? ""), [info.defaultModel]);
  const commit = async (value = draft) => {
    const model = value.trim();
    setDraft(model);
    if (model === (info.defaultModel ?? "")) return;
    const failed = await patchCodexSettings({ defaultModel: model || null });
    onError(failed);
    if (failed) setDraft(info.defaultModel ?? "");
    await refresh();
  };
  const listed = models ?? [];
  const narrowed = listed.length > 0;
  if ((offered && offered.length > 0) || narrowed) {
    const menu = narrowModels(offered ?? [], listed);
    // With a list in the data repo, a default it does not hold is not
    // used: the list's first is. With none, an empty default is Codex's own.
    const shown = narrowed ? (draft && listed.includes(draft) ? draft : menu[0]!.value) : draft;
    const options = !shown || menu.some((m) => m.value === shown) ? menu : [...menu, { value: shown, displayName: shown, description: "" }];
    return (
      <label className="settings-row">
        <span className="settings-row-label">
          Default model
          <span className="settings-row-hint">
            The model the coding agent pane and the app's other Codex calls start on, from the models{" "}
            {offered && offered.length > 0 ? offeredBy : "listed below"}
            {narrowed && offered && offered.length > 0 ? ", narrowed to the Codex models listed below" : ""}. Applies to
            sessions started after the change.
          </span>
        </span>
        <select aria-label="Default Codex model" value={shown} onChange={(e) => void commit(e.target.value)}>
          {!narrowed && <option value="">Codex's default</option>}
          {options.map((m) => (
            <option key={m.value} value={m.value} title={m.description || undefined}>
              {modelLabel(m)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="settings-row">
      <span className="settings-row-label">
        Default model
        <span className="settings-row-hint">
          The model the coding agent pane and the app's other Codex calls start on — a model id. Empty uses Codex's own
          default. Once {info.mode === "api" ? "the API answers with its model list" : "a ChatGPT account is signed in"}, this
          becomes a menu of those models. Applies to sessions started after the change.
        </span>
      </span>
      <input
        aria-label="Default Codex model"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder="Codex's default"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

/** What "Check sign-in" found, in a sentence. */
export function signInCheckText(login: CodexAuthInfo["login"], models: CodexModel[], error: string | null): string {
  if (!login.loggedIn) return "Not signed in — the Codex CLI has no ChatGPT account. Sign in below.";
  const who = login.email ? `Signed in as ${login.email}` : "Signed in to a ChatGPT account";
  if (error) return `${who}, but Codex could not list the account's models: ${error}`;
  if (models.length === 0) return `${who}, but Codex listed no models for the account.`;
  return `${who} — Codex started under the account and lists ${models.length} model${models.length === 1 ? "" : "s"}.`;
}

/**
 * The ChatGPT account: who is signed in, or plainly that nobody is; the
 * browser sign-in; "Check sign-in", which asks the CLI afresh and has a
 * Codex started under the account list its models; sign out. Codex keeps
 * one sign-in, so the section says when signing in would replace an API key
 * of Codex's own, and when Codex's own config would sign the account out.
 */
export function CodexAccount({
  info,
  onChange,
  refresh,
  reloadModels,
  onModels,
}: {
  info: CodexAuthInfo;
  onChange: (info: CodexAuthInfo) => void;
  refresh: () => Promise<void>;
  /** Have "Default model" ask for the account's models again. */
  reloadModels: () => void;
  /** The account's models as "Check sign-in" just listed them; null for none. */
  onModels: (models: CodexModel[] | null) => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = info.signIn;
  const inProgress = signIn?.inProgress ?? false;
  const signedIn = info.login.loggedIn;
  const { detected, storedKey } = info.api;

  // While the browser sign-in is under way, ask the server every couple of
  // seconds whether it came back; once it has, the account's models are
  // asked for again.
  useEffect(() => {
    if (!inProgress) return;
    let live = true;
    const tick = async () => {
      const result = await call<{ signIn: CodexSignIn | null; login: CodexAuthInfo["login"] }>("GET", "/api/codex/login");
      if (!live || !result.ok) return;
      const next = result.data.signIn;
      if (next?.inProgress) {
        onChange({ ...info, signIn: next, login: result.data.login });
      } else {
        await refresh();
        if (next?.done) reloadModels();
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [inProgress]);

  const start = async () => {
    setBusy(true);
    setStatus(null);
    setCheck(null);
    const result = await call<{ signIn: CodexSignIn }>("POST", "/api/codex/login");
    setBusy(false);
    if (!result.ok) return setStatus(result.error);
    onChange({ ...info, signIn: result.data.signIn });
  };
  const cancel = async () => {
    await call("DELETE", "/api/codex/login");
    await refresh();
  };
  const signOut = async () => {
    setBusy(true);
    setStatus(null);
    setCheck(null);
    const result = await call("POST", "/api/codex/logout");
    setBusy(false);
    if (!result.ok) return setStatus(result.error);
    await refresh();
    setCheck("Signed out.");
  };
  const checkSignIn = async () => {
    setBusy(true);
    setStatus(null);
    setCheck("Checking — asking the Codex CLI, then starting a Codex under the account…");
    const result = await call<{ login: CodexAuthInfo["login"]; models: CodexModel[]; error: string | null }>(
      "POST",
      "/api/codex/login/check",
    );
    setBusy(false);
    if (!result.ok) {
      setCheck(null);
      return setStatus(result.error);
    }
    const { login, models, error } = result.data;
    onChange({ ...info, login });
    onModels(models.length > 0 ? models : null);
    setCheck(signInCheckText(login, models, error));
  };

  const who = !signedIn ? (
    <>
      <strong>Not signed in.</strong> Sign in with your ChatGPT account through the browser.
    </>
  ) : info.login.email ? (
    <>
      Signed in as <strong>{info.login.email}</strong>.
    </>
  ) : (
    <>Signed in to a ChatGPT account.</>
  );
  // Codex's own API key sits where the account would go.
  const replacesKey = !signedIn && detected.hasKey && detected.keySource !== "environment";

  return (
    <div className="settings-row auth-section">
      <span className="auth-title">ChatGPT account</span>
      {!info.cliAvailable ? (
        <p className="hint">The Codex CLI is not installed — install the codex command (npm i -g @openai/codex), then come back here.</p>
      ) : (
        <p className="hint" role="status">
          {who}
        </p>
      )}
      {info.cliAvailable && replacesKey && (
        <p className="hint">
          Codex keeps one sign-in: signing in replaces the API key in {detected.keySource}.
          {storedKey ? " The app has its own copy for the API." : " To keep it for the API, switch to API and choose “Use detected” first."}
        </p>
      )}
      {info.cliAvailable && detected.requiresApiKey && (
        <p className="hint">
          Codex's own config requires API keys (<code>forced_login_method = "api"</code>): the app's sessions set that aside,
          but a Codex started outside the app signs the ChatGPT account out again.
        </p>
      )}
      {!info.cliAvailable ? null : inProgress ? (
        <>
          <p className="hint" role="status">
            Finish signing in in the browser window Codex opened. This page updates by itself once Codex has the account;
            nothing is pasted here.
          </p>
          <div className="auth-row">
            <button className="secondary" onClick={() => void cancel()}>
              Cancel
            </button>
          </div>
        </>
      ) : signedIn ? (
        <div className="auth-row">
          <button className="secondary" disabled={busy} onClick={() => void checkSignIn()}>
            Check sign-in
          </button>
          <button className="secondary" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="auth-row">
          <button className="secondary" disabled={busy} onClick={() => void start()}>
            Sign in
          </button>
          <button className="secondary" disabled={busy} onClick={() => void checkSignIn()}>
            Check sign-in
          </button>
        </div>
      )}
      {check && !inProgress && (
        <p className="hint" role="status">
          {check}
        </p>
      )}
      {signIn?.error && !inProgress && <p className="error">{signIn.error}</p>}
      {status && <p className="error">{status}</p>}
    </div>
  );
}

/** What "Check connection" found, as the page says it. */
export function apiCheckText(result: string, detail: string): string {
  const lead = result === "ok" ? "OK" : result === "unauthorized" ? "Wrong key" : result === "unreachable" ? "Unreachable" : "Odd answer";
  return `${lead} — ${detail}`;
}

/** The API: its address and key, what Codex's own config carries, a check. */
export function CodexApi({
  info,
  refresh,
  onError,
  reloadModels,
}: {
  info: CodexAuthInfo;
  refresh: () => Promise<void>;
  onError: (error: string | null) => void;
  /** Have "Default model" ask the API for its models again. */
  reloadModels?: () => void;
}) {
  const { api } = info;
  const [urlDraft, setUrlDraft] = useState(api.storedUrl ?? "");
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setUrlDraft(api.storedUrl ?? ""), [api.storedUrl]);

  const commitUrl = async () => {
    const url = urlDraft.trim();
    if (url === (api.storedUrl ?? "")) return;
    setStatus(null);
    onError(await patchCodexSettings({ codexApiUrl: url || null }));
    await refresh();
  };
  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setStatus(null);
    const result = await call("POST", "/api/codex/key", { key: key.trim() });
    setBusy(false);
    if (!result.ok) return setStatus(result.error);
    setKey("");
    await refresh();
  };
  const removeKey = async () => {
    setStatus(null);
    const result = await call("DELETE", "/api/codex/key");
    if (!result.ok) return setStatus(result.error);
    await refresh();
  };
  const useDetected = async () => {
    setBusy(true);
    setStatus(null);
    const result = await call("POST", "/api/codex/api/detect");
    setBusy(false);
    if (!result.ok) return setStatus(result.error);
    await refresh();
  };
  const runCheck = async () => {
    setBusy(true);
    setCheck("Checking…");
    const result = await call<{ url: string; result: string; detail: string }>("POST", "/api/codex/api/check", {
      url: urlDraft.trim() || undefined,
    });
    setBusy(false);
    setCheck(result.ok ? apiCheckText(result.data.result, result.data.detail) : result.error);
    // An API that answers lists its models: the menu follows.
    if (result.ok && result.data.result === "ok") reloadModels?.();
  };

  const detected = api.detected;
  const canUseDetected =
    (detected.url !== null && detected.url !== api.storedUrl) || (detected.hasKey && !api.storedKey);
  const effectiveUrl = urlDraft.trim() || api.url;

  return (
    <div className="settings-row auth-section">
      <span className="auth-title">API</span>
      <div className="paste-token">
        <div className="auth-row">
          <input
            aria-label="Codex API address"
            className="paste-token-host"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => void commitUrl()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder={detected.url ?? OPENAI_API_URL}
          />
          <button className="secondary" disabled={busy || !effectiveUrl} onClick={() => void runCheck()}>
            Check connection
          </button>
        </div>
        {(detected.url || detected.hasKey) && (
          <span className="settings-row-hint">
            {detected.url ? (
              <>
                Detected in {detected.urlSource}: <code>{detected.url}</code>
                {detected.hasKey ? " with a key" : ", no key"}.
              </>
            ) : (
              <>Detected an API key in {detected.keySource}.</>
            )}
            {canUseDetected && (
              <>
                {" "}
                <button className="link" disabled={busy} onClick={() => void useDetected()}>
                  Use detected
                </button>
              </>
            )}
          </span>
        )}
        {!api.storedUrl && !detected.url && (
          <span className="settings-row-hint">
            No address is set anywhere: with a key, Codex calls OpenAI's API (<code>{OPENAI_API_URL}</code>). Enter another
            address to send its API calls there.
          </span>
        )}
        <div className="auth-row">
          <input
            aria-label="Codex API key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveKey();
            }}
            placeholder={api.storedKey ? "Replace the key" : "API key"}
          />
          <button className="secondary" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
            Save key
          </button>
        </div>
        <span className="hint">
          {api.storedKey ? (
            <>
              A key is kept on this device, never shown.{" "}
              <button className="link" onClick={() => void removeKey()}>
                Remove
              </button>
            </>
          ) : detected.hasKey ? (
            <>Using the key from {detected.keySource} — not copied here until you save one or use the detected settings.</>
          ) : (
            <>No key: the API is called without one.</>
          )}
        </span>
        {check && <p className="hint">{check}</p>}
        {status && <p className="error">{status}</p>}
      </div>
    </div>
  );
}
