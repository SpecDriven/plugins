import { useEffect, useState } from "react";
import { DEFAULT_AGENT_FIRST_RESPONSE_SECONDS, type ClaudeAuthMode } from "../settings";

// Settings → Claude (specs/agents/claude.feature.md "Choose how Claude signs
// in", "API proxy settings are filled in from Claude Code's settings", "Sign
// in to Claude with an email"): how every Claude the app starts signs in —
// the Claude account the CLI is signed in to, or an API proxy with a token
// kept on this device. The host half (src/auth.ts, src/host.ts) never sends
// a token back; the page learns only whether there is one. What
// the section changes goes through the plugin's own route
// (PUT /api/claude/settings), into its section of the settings file.

export interface ClaudeSignIn {
  inProgress: boolean;
  email: string;
  url: string | null;
  done: boolean;
  error: string | null;
}

export interface ClaudeAuthInfo {
  mode: ClaudeAuthMode;
  /** No stored choice: the server inferred this one. */
  inferred: boolean;
  cliAvailable: boolean;
  login: { loggedIn: boolean; method: string; email: string | null };
  proxy: {
    url: string | null;
    storedUrl: string | null;
    storedToken: boolean;
    hasToken: boolean;
    detected: { url: string | null; urlSource: string | null; hasToken: boolean; tokenSource: string | null };
  };
  /** The pane's first-response wait behind the proxy; 0 is no limit. */
  firstResponseSeconds: number;
  signIn: ClaudeSignIn | null;
}

/** The plugin's own settings, patched through its route. */
async function patchClaudeSettings(patch: {
  claudeAuth?: ClaudeAuthMode | null;
  claudeProxyUrl?: string | null;
  firstResponseSeconds?: number;
}): Promise<string | null> {
  const result = await call("PUT", "/api/claude/settings", patch);
  return result.ok ? null : result.error;
}

export async function fetchClaudeAuth(): Promise<ClaudeAuthInfo | null> {
  try {
    const res = await fetch("/api/claude/auth");
    if (!res.ok) return null;
    return (await res.json()) as ClaudeAuthInfo;
  } catch {
    return null;
  }
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

const MODE_HINT: Record<ClaudeAuthMode, string> = {
  login:
    "Sessions use the Claude account the Claude CLI is signed in to. A proxy or API key in Claude Code's own settings is set aside for them.",
  proxy:
    "Sessions send their API calls to the proxy below, with its token. That overrides whatever Claude Code's own settings say.",
};

/** The section's body: the mode, then the account or the proxy with its timeout. */
export function ClaudeSettings() {
  const [info, setInfo] = useState<ClaudeAuthInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const next = await fetchClaudeAuth();
    setFailed(next === null);
    if (next) setInfo(next);
  };
  useEffect(() => {
    void refresh();
  }, []);

  if (failed && !info) return <p className="hint">Could not read how Claude signs in.</p>;
  if (!info) return <p className="hint">Checking how Claude signs in…</p>;

  const pickMode = async (mode: ClaudeAuthMode) => {
    setInfo({ ...info, mode, inferred: false });
    setError(await patchClaudeSettings({ claudeAuth: mode }));
    await refresh();
  };

  return (
    <div className="claude-settings">
      <label className="settings-row">
        <span className="settings-row-label">
          Sign in with
          <span className="settings-row-hint">
            {info.inferred ? "Chosen for you from Claude Code's settings — pick one to keep it. " : ""}
            {MODE_HINT[info.mode]}
          </span>
        </span>
        <select value={info.mode} onChange={(e) => void pickMode(e.target.value as ClaudeAuthMode)}>
          <option value="login">Claude account (email login)</option>
          <option value="proxy">API proxy</option>
        </select>
      </label>
      {info.mode === "login" ? (
        <ClaudeAccount info={info} onChange={setInfo} refresh={refresh} />
      ) : (
        <ClaudeProxy info={info} refresh={refresh} onError={setError} />
      )}
      {info.mode === "proxy" && <ProxyTimeout info={info} refresh={refresh} onError={setError} />}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * The pane's first-response wait (specs/agents/agent-pane.feature.md "A
 * Claude turn fails fast when the API proxy does not answer"): only a
 * Claude whose API goes through a proxy is held to it.
 */
function ProxyTimeout({
  info,
  refresh,
  onError,
}: {
  info: ClaudeAuthInfo;
  refresh: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const [draft, setDraft] = useState(String(info.firstResponseSeconds));
  useEffect(() => setDraft(String(info.firstResponseSeconds)), [info.firstResponseSeconds]);
  const commit = async () => {
    const n = Number(draft);
    const seconds = Number.isFinite(n) && n >= 0 ? Math.floor(n) : info.firstResponseSeconds;
    setDraft(String(seconds));
    if (seconds === info.firstResponseSeconds) return;
    onError(await patchClaudeSettings({ firstResponseSeconds: seconds }));
    await refresh();
  };
  return (
    <label className="settings-row">
      <span className="settings-row-label">
        Proxy timeout (seconds)
        <span className="settings-row-hint">
          A turn in the coding agent pane that gets no response from the API through the proxy
          in this time is stopped with an error, instead of retrying for minutes while the proxy
          is down. 0 waits as long as Claude Code retries; the default is{" "}
          {DEFAULT_AGENT_FIRST_RESPONSE_SECONDS}. Applies to sessions started after the change.
        </span>
      </span>
      <input
        type="number"
        min={0}
        aria-label="Proxy timeout in seconds"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}

/** The Claude account: who is signed in, the email sign-in, sign out. */
function ClaudeAccount({
  info,
  onChange,
  refresh,
}: {
  info: ClaudeAuthInfo;
  onChange: (info: ClaudeAuthInfo) => void;
  refresh: () => Promise<void>;
}) {
  const [email, setEmail] = useState(info.login.email ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = info.signIn;
  const inProgress = signIn?.inProgress ?? false;

  // While the browser sign-in is under way, ask the server every couple of
  // seconds whether it came back.
  useEffect(() => {
    if (!inProgress) return;
    let live = true;
    const tick = async () => {
      const result = await call<{ signIn: ClaudeSignIn | null; login: ClaudeAuthInfo["login"] }>("GET", "/api/claude/login");
      if (!live || !result.ok) return;
      if (result.data.signIn?.inProgress) onChange({ ...info, signIn: result.data.signIn, login: result.data.login });
      else await refresh();
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
    const result = await call<{ signIn: ClaudeSignIn }>("POST", "/api/claude/login", { email: email.trim() });
    setBusy(false);
    if (!result.ok) return setStatus(result.error);
    onChange({ ...info, signIn: result.data.signIn });
    if (result.data.signIn.url) window.open(result.data.signIn.url, "_blank", "noopener");
  };
  const cancel = async () => {
    await call("DELETE", "/api/claude/login");
    await refresh();
  };
  const signOut = async () => {
    setBusy(true);
    setStatus(null);
    const result = await call("POST", "/api/claude/logout");
    setBusy(false);
    if (!result.ok) return setStatus(result.error);
    await refresh();
  };

  const who = info.login.loggedIn
    ? info.login.method === "api_key"
      ? "Signed in with an API key, not a Claude account — sessions in this mode set it aside, so sign in below."
      : info.login.email
        ? "Signed in"
        : "Signed in to a Claude account"
    : "Not signed in";

  return (
    <div className="settings-row auth-section">
      <span className="auth-title">Claude account</span>
      {!info.cliAvailable ? (
        <p className="hint">The Claude CLI is not on PATH — install Claude Code first, then come back here.</p>
      ) : (
        <p className="hint">
          {who}
          {info.login.loggedIn && info.login.email && info.login.method !== "api_key" ? (
            <>
              {" "}
              as <strong>{info.login.email}</strong>
            </>
          ) : null}
          {info.login.loggedIn && info.login.method !== "api_key" ? "." : info.login.loggedIn ? "" : " — enter the email of your Claude account to sign in through the browser."}
        </p>
      )}
      {inProgress ? (
        <>
          <p className="hint">
            Finish signing in in your browser
            {signIn?.url ? (
              <>
                {" "}
                —{" "}
                <a href={signIn.url} target="_blank" rel="noopener noreferrer">
                  open the sign-in page
                </a>{" "}
                if it did not open by itself
              </>
            ) : null}
            .
          </p>
          <div className="auth-row">
            <button className="secondary" onClick={() => void cancel()}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        info.cliAvailable && (
          <div className="auth-row">
            <input
              aria-label="Claude account email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void start();
              }}
              placeholder="you@example.com"
            />
            <button className="secondary" disabled={busy || !email.trim()} onClick={() => void start()}>
              {info.login.loggedIn && info.login.method !== "api_key" ? "Switch account…" : "Sign in…"}
            </button>
            {info.login.loggedIn && info.login.method !== "api_key" && (
              <button className="secondary" disabled={busy} onClick={() => void signOut()}>
                Sign out
              </button>
            )}
          </div>
        )
      )}
      {signIn?.error && !inProgress && <p className="error">{signIn.error}</p>}
      {status && <p className="error">{status}</p>}
    </div>
  );
}

/** The API proxy: its url and token, what Claude Code's settings carry, a check. */
function ClaudeProxy({
  info,
  refresh,
  onError,
}: {
  info: ClaudeAuthInfo;
  refresh: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const { proxy } = info;
  const [urlDraft, setUrlDraft] = useState(proxy.storedUrl ?? "");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setUrlDraft(proxy.storedUrl ?? ""), [proxy.storedUrl]);

  const commitUrl = async () => {
    const url = urlDraft.trim();
    if (url === (proxy.storedUrl ?? "")) return;
    setStatus(null);
    onError(await patchClaudeSettings({ claudeProxyUrl: url || null }));
    await refresh();
  };
  const saveToken = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setStatus(null);
    const result = await call("POST", "/api/claude/token", { token: token.trim() });
    setBusy(false);
    if (!result.ok) return setStatus(result.error);
    setToken("");
    await refresh();
  };
  const removeToken = async () => {
    setStatus(null);
    const result = await call("DELETE", "/api/claude/token");
    if (!result.ok) return setStatus(result.error);
    await refresh();
  };
  const useDetected = async () => {
    setBusy(true);
    setStatus(null);
    const result = await call("POST", "/api/claude/proxy/detect");
    setBusy(false);
    if (!result.ok) return setStatus(result.error);
    await refresh();
  };
  const runCheck = async () => {
    setBusy(true);
    setCheck("Checking…");
    const result = await call<{ url: string; result: string; detail: string }>("POST", "/api/claude/proxy/check", {
      url: urlDraft.trim() || undefined,
    });
    setBusy(false);
    setCheck(result.ok ? `${result.data.result === "ok" ? "OK" : result.data.result === "unauthorized" ? "Wrong token" : result.data.result === "unreachable" ? "Unreachable" : "Odd answer"} — ${result.data.detail}` : result.error);
  };

  const detected = proxy.detected;
  const canUseDetected =
    detected.url !== null && (detected.url !== proxy.storedUrl || (detected.hasToken && !proxy.storedToken));
  const effectiveUrl = urlDraft.trim() || proxy.url;

  return (
    <div className="settings-row auth-section">
      <span className="auth-title">API proxy</span>
      <div className="paste-token">
        <div className="auth-row">
          <input
            aria-label="Claude API proxy url"
            className="paste-token-host"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => void commitUrl()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder={detected.url ?? "http://localhost:6655/anthropic/"}
          />
          <button className="secondary" disabled={busy || !effectiveUrl} onClick={() => void runCheck()}>
            Check connection
          </button>
        </div>
        {detected.url && (
          <span className="settings-row-hint">
            Detected in {detected.urlSource}: <code>{detected.url}</code>
            {detected.hasToken ? " with a token" : ", no token"}.
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
        {!proxy.storedUrl && !detected.url && (
          <span className="settings-row-hint">
            No proxy is set up anywhere yet — enter the address Claude Code should send its API calls to.
          </span>
        )}
        <div className="auth-row">
          <input
            aria-label="Claude API proxy token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveToken();
            }}
            placeholder={proxy.storedToken ? "Replace the token" : "Proxy token"}
          />
          <button className="secondary" disabled={busy || !token.trim()} onClick={() => void saveToken()}>
            Save token
          </button>
        </div>
        <span className="hint">
          {proxy.storedToken ? (
            <>
              A token is kept on this device, never shown.{" "}
              <button className="link" onClick={() => void removeToken()}>
                Remove
              </button>
            </>
          ) : detected.hasToken ? (
            <>Using the token from {detected.tokenSource} — not copied here until you save one or use the detected settings.</>
          ) : (
            <>No token: the proxy is called without one.</>
          )}
        </span>
        {check && <p className="hint">{check}</p>}
        {status && <p className="error">{status}</p>}
      </div>
    </div>
  );
}
