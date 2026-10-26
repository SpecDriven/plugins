// specdriven-shim:@specdriven/client
var m = globalThis.__specdriven?.modules?.["@specdriven/client"];
if (!m)
  throw new Error("SpecDriven did not publish @specdriven/client for plugins");
var client_default = m.default ?? m;
var Breadcrumbs = m.Breadcrumbs;
var CORE_SETTINGS_ORDER = m.CORE_SETTINGS_ORDER;
var Menu = m.Menu;
var PageSkeleton = m.PageSkeleton;
var SaveIndicator = m.SaveIndicator;
var Tooltip = m.Tooltip;
var createPromiseQueue = m.createPromiseQueue;
var featurePath = m.featurePath;
var markText = m.markText;
var slugify = m.slugify;
var toast = m.toast;

// specdriven-shim:react
var m2 = globalThis.__specdriven?.modules?.["react"];
if (!m2)
  throw new Error("SpecDriven did not publish react for plugins");
var react_default = m2.default ?? m2;
var Activity = m2.Activity;
var Children = m2.Children;
var Component = m2.Component;
var Fragment = m2.Fragment;
var Profiler = m2.Profiler;
var PureComponent = m2.PureComponent;
var StrictMode = m2.StrictMode;
var Suspense = m2.Suspense;
var ViewTransition = m2.ViewTransition;
var act = m2.act;
var addTransitionType = m2.addTransitionType;
var cache = m2.cache;
var cacheSignal = m2.cacheSignal;
var captureOwnerStack = m2.captureOwnerStack;
var cloneElement = m2.cloneElement;
var createContext = m2.createContext;
var createElement = m2.createElement;
var createRef = m2.createRef;
var forwardRef = m2.forwardRef;
var isValidElement = m2.isValidElement;
var lazy = m2.lazy;
var memo = m2.memo;
var startTransition = m2.startTransition;
var unstable_useCacheRefresh = m2.unstable_useCacheRefresh;
var use = m2.use;
var useActionState = m2.useActionState;
var useCallback = m2.useCallback;
var useContext = m2.useContext;
var useDebugValue = m2.useDebugValue;
var useDeferredValue = m2.useDeferredValue;
var useEffect = m2.useEffect;
var useEffectEvent = m2.useEffectEvent;
var useId = m2.useId;
var useImperativeHandle = m2.useImperativeHandle;
var useInsertionEffect = m2.useInsertionEffect;
var useLayoutEffect = m2.useLayoutEffect;
var useMemo = m2.useMemo;
var useOptimistic = m2.useOptimistic;
var useReducer = m2.useReducer;
var useRef = m2.useRef;
var useState = m2.useState;
var useSyncExternalStore = m2.useSyncExternalStore;
var useTransition = m2.useTransition;
var version = m2.version;

// ../../../../plugins/plugins/agent-claude/src/settings.ts
var DEFAULT_AGENT_FIRST_RESPONSE_SECONDS = 15;

// specdriven-shim:react/jsx-runtime
var m3 = globalThis.__specdriven?.modules?.["react/jsx-runtime"];
if (!m3)
  throw new Error("SpecDriven did not publish react/jsx-runtime for plugins");
var jsx_runtime_default = m3.default ?? m3;
var Fragment2 = m3.Fragment;
var jsx = m3.jsx;
var jsxs = m3.jsxs;

// ../../../../plugins/plugins/agent-claude/src/ui/ClaudeSettings.tsx
async function patchClaudeSettings(patch) {
  const result = await call("PUT", "/api/claude/settings", patch);
  return result.ok ? null : result.error;
}
async function fetchClaudeAuth() {
  try {
    const res = await fetch("/api/claude/auth");
    if (!res.ok)
      return null;
    return await res.json();
  } catch {
    return null;
  }
}
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok)
      return { ok: false, error: data.error ?? "Something went wrong" };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Could not reach the app" };
  }
}
var MODE_HINT = {
  login: "Sessions use the Claude account the Claude CLI is signed in to. A proxy or API key in Claude Code's own settings is set aside for them.",
  proxy: "Sessions send their API calls to the proxy below, with its token. That overrides whatever Claude Code's own settings say."
};
function ClaudeSettings() {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState(null);
  const refresh = async () => {
    const next = await fetchClaudeAuth();
    setFailed(next === null);
    if (next)
      setInfo(next);
  };
  useEffect(() => {
    refresh();
  }, []);
  if (failed && !info)
    return /* @__PURE__ */ jsx("p", {
      className: "hint",
      children: "Could not read how Claude signs in."
    });
  if (!info)
    return /* @__PURE__ */ jsx("p", {
      className: "hint",
      children: "Checking how Claude signs in…"
    });
  const pickMode = async (mode) => {
    setInfo({ ...info, mode, inferred: false });
    setError(await patchClaudeSettings({ claudeAuth: mode }));
    await refresh();
  };
  return /* @__PURE__ */ jsxs("div", {
    className: "claude-settings",
    children: [
      /* @__PURE__ */ jsxs("label", {
        className: "settings-row",
        children: [
          /* @__PURE__ */ jsxs("span", {
            className: "settings-row-label",
            children: [
              "Sign in with",
              /* @__PURE__ */ jsxs("span", {
                className: "settings-row-hint",
                children: [
                  info.inferred ? "Chosen for you from Claude Code's settings — pick one to keep it. " : "",
                  MODE_HINT[info.mode]
                ]
              })
            ]
          }),
          /* @__PURE__ */ jsxs("select", {
            value: info.mode,
            onChange: (e) => void pickMode(e.target.value),
            children: [
              /* @__PURE__ */ jsx("option", {
                value: "login",
                children: "Claude account (email login)"
              }),
              /* @__PURE__ */ jsx("option", {
                value: "proxy",
                children: "API proxy"
              })
            ]
          })
        ]
      }),
      info.mode === "login" ? /* @__PURE__ */ jsx(ClaudeAccount, {
        info,
        onChange: setInfo,
        refresh
      }) : /* @__PURE__ */ jsx(ClaudeProxy, {
        info,
        refresh,
        onError: setError
      }),
      info.mode === "proxy" && /* @__PURE__ */ jsx(ProxyTimeout, {
        info,
        refresh,
        onError: setError
      }),
      error && /* @__PURE__ */ jsx("p", {
        className: "error",
        children: error
      })
    ]
  });
}
function ProxyTimeout({
  info,
  refresh,
  onError
}) {
  const [draft, setDraft] = useState(String(info.firstResponseSeconds));
  useEffect(() => setDraft(String(info.firstResponseSeconds)), [info.firstResponseSeconds]);
  const commit = async () => {
    const n = Number(draft);
    const seconds = Number.isFinite(n) && n >= 0 ? Math.floor(n) : info.firstResponseSeconds;
    setDraft(String(seconds));
    if (seconds === info.firstResponseSeconds)
      return;
    onError(await patchClaudeSettings({ firstResponseSeconds: seconds }));
    await refresh();
  };
  return /* @__PURE__ */ jsxs("label", {
    className: "settings-row",
    children: [
      /* @__PURE__ */ jsxs("span", {
        className: "settings-row-label",
        children: [
          "Proxy timeout (seconds)",
          /* @__PURE__ */ jsxs("span", {
            className: "settings-row-hint",
            children: [
              "A turn in the coding agent pane that gets no response from the API through the proxy in this time is stopped with an error, instead of retrying for minutes while the proxy is down. 0 waits as long as Claude Code retries; the default is",
              " ",
              DEFAULT_AGENT_FIRST_RESPONSE_SECONDS,
              ". Applies to sessions started after the change."
            ]
          })
        ]
      }),
      /* @__PURE__ */ jsx("input", {
        type: "number",
        min: 0,
        "aria-label": "Proxy timeout in seconds",
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => void commit(),
        onKeyDown: (e) => {
          if (e.key === "Enter")
            e.currentTarget.blur();
        }
      })
    ]
  });
}
function ClaudeAccount({
  info,
  onChange,
  refresh
}) {
  const [email, setEmail] = useState(info.login.email ?? "");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const signIn = info.signIn;
  const inProgress = signIn?.inProgress ?? false;
  useEffect(() => {
    if (!inProgress)
      return;
    let live = true;
    const tick = async () => {
      const result = await call("GET", "/api/claude/login");
      if (!live || !result.ok)
        return;
      if (result.data.signIn?.inProgress)
        onChange({ ...info, signIn: result.data.signIn, login: result.data.login });
      else
        await refresh();
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
    const result = await call("POST", "/api/claude/login", { email: email.trim() });
    setBusy(false);
    if (!result.ok)
      return setStatus(result.error);
    onChange({ ...info, signIn: result.data.signIn });
    if (result.data.signIn.url)
      window.open(result.data.signIn.url, "_blank", "noopener");
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
    if (!result.ok)
      return setStatus(result.error);
    await refresh();
  };
  const who = info.login.loggedIn ? info.login.method === "api_key" ? "Signed in with an API key, not a Claude account — sessions in this mode set it aside, so sign in below." : info.login.email ? "Signed in" : "Signed in to a Claude account" : "Not signed in";
  return /* @__PURE__ */ jsxs("div", {
    className: "settings-row auth-section",
    children: [
      /* @__PURE__ */ jsx("span", {
        className: "auth-title",
        children: "Claude account"
      }),
      !info.cliAvailable ? /* @__PURE__ */ jsx("p", {
        className: "hint",
        children: "The Claude CLI is not on PATH — install Claude Code first, then come back here."
      }) : /* @__PURE__ */ jsxs("p", {
        className: "hint",
        children: [
          who,
          info.login.loggedIn && info.login.email && info.login.method !== "api_key" ? /* @__PURE__ */ jsxs(Fragment2, {
            children: [
              " ",
              "as ",
              /* @__PURE__ */ jsx("strong", {
                children: info.login.email
              })
            ]
          }) : null,
          info.login.loggedIn && info.login.method !== "api_key" ? "." : info.login.loggedIn ? "" : " — enter the email of your Claude account to sign in through the browser."
        ]
      }),
      inProgress ? /* @__PURE__ */ jsxs(Fragment2, {
        children: [
          /* @__PURE__ */ jsxs("p", {
            className: "hint",
            children: [
              "Finish signing in in your browser",
              signIn?.url ? /* @__PURE__ */ jsxs(Fragment2, {
                children: [
                  " ",
                  "—",
                  " ",
                  /* @__PURE__ */ jsx("a", {
                    href: signIn.url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    children: "open the sign-in page"
                  }),
                  " ",
                  "if it did not open by itself"
                ]
              }) : null,
              "."
            ]
          }),
          /* @__PURE__ */ jsx("div", {
            className: "auth-row",
            children: /* @__PURE__ */ jsx("button", {
              className: "secondary",
              onClick: () => void cancel(),
              children: "Cancel"
            })
          })
        ]
      }) : info.cliAvailable && /* @__PURE__ */ jsxs("div", {
        className: "auth-row",
        children: [
          /* @__PURE__ */ jsx("input", {
            "aria-label": "Claude account email",
            type: "email",
            autoComplete: "email",
            value: email,
            onChange: (e) => setEmail(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter")
                start();
            },
            placeholder: "you@example.com"
          }),
          /* @__PURE__ */ jsx("button", {
            className: "secondary",
            disabled: busy || !email.trim(),
            onClick: () => void start(),
            children: info.login.loggedIn && info.login.method !== "api_key" ? "Switch account…" : "Sign in…"
          }),
          info.login.loggedIn && info.login.method !== "api_key" && /* @__PURE__ */ jsx("button", {
            className: "secondary",
            disabled: busy,
            onClick: () => void signOut(),
            children: "Sign out"
          })
        ]
      }),
      signIn?.error && !inProgress && /* @__PURE__ */ jsx("p", {
        className: "error",
        children: signIn.error
      }),
      status && /* @__PURE__ */ jsx("p", {
        className: "error",
        children: status
      })
    ]
  });
}
function ClaudeProxy({
  info,
  refresh,
  onError
}) {
  const { proxy } = info;
  const [urlDraft, setUrlDraft] = useState(proxy.storedUrl ?? "");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setUrlDraft(proxy.storedUrl ?? ""), [proxy.storedUrl]);
  const commitUrl = async () => {
    const url = urlDraft.trim();
    if (url === (proxy.storedUrl ?? ""))
      return;
    setStatus(null);
    onError(await patchClaudeSettings({ claudeProxyUrl: url || null }));
    await refresh();
  };
  const saveToken = async () => {
    if (!token.trim())
      return;
    setBusy(true);
    setStatus(null);
    const result = await call("POST", "/api/claude/token", { token: token.trim() });
    setBusy(false);
    if (!result.ok)
      return setStatus(result.error);
    setToken("");
    await refresh();
  };
  const removeToken = async () => {
    setStatus(null);
    const result = await call("DELETE", "/api/claude/token");
    if (!result.ok)
      return setStatus(result.error);
    await refresh();
  };
  const useDetected = async () => {
    setBusy(true);
    setStatus(null);
    const result = await call("POST", "/api/claude/proxy/detect");
    setBusy(false);
    if (!result.ok)
      return setStatus(result.error);
    await refresh();
  };
  const runCheck = async () => {
    setBusy(true);
    setCheck("Checking…");
    const result = await call("POST", "/api/claude/proxy/check", {
      url: urlDraft.trim() || undefined
    });
    setBusy(false);
    setCheck(result.ok ? `${result.data.result === "ok" ? "OK" : result.data.result === "unauthorized" ? "Wrong token" : result.data.result === "unreachable" ? "Unreachable" : "Odd answer"} — ${result.data.detail}` : result.error);
  };
  const detected = proxy.detected;
  const canUseDetected = detected.url !== null && (detected.url !== proxy.storedUrl || detected.hasToken && !proxy.storedToken);
  const effectiveUrl = urlDraft.trim() || proxy.url;
  return /* @__PURE__ */ jsxs("div", {
    className: "settings-row auth-section",
    children: [
      /* @__PURE__ */ jsx("span", {
        className: "auth-title",
        children: "API proxy"
      }),
      /* @__PURE__ */ jsxs("div", {
        className: "paste-token",
        children: [
          /* @__PURE__ */ jsxs("div", {
            className: "auth-row",
            children: [
              /* @__PURE__ */ jsx("input", {
                "aria-label": "Claude API proxy url",
                className: "paste-token-host",
                value: urlDraft,
                onChange: (e) => setUrlDraft(e.target.value),
                onBlur: () => void commitUrl(),
                onKeyDown: (e) => {
                  if (e.key === "Enter")
                    e.currentTarget.blur();
                },
                placeholder: detected.url ?? "http://localhost:6655/anthropic/"
              }),
              /* @__PURE__ */ jsx("button", {
                className: "secondary",
                disabled: busy || !effectiveUrl,
                onClick: () => void runCheck(),
                children: "Check connection"
              })
            ]
          }),
          detected.url && /* @__PURE__ */ jsxs("span", {
            className: "settings-row-hint",
            children: [
              "Detected in ",
              detected.urlSource,
              ": ",
              /* @__PURE__ */ jsx("code", {
                children: detected.url
              }),
              detected.hasToken ? " with a token" : ", no token",
              ".",
              canUseDetected && /* @__PURE__ */ jsxs(Fragment2, {
                children: [
                  " ",
                  /* @__PURE__ */ jsx("button", {
                    className: "link",
                    disabled: busy,
                    onClick: () => void useDetected(),
                    children: "Use detected"
                  })
                ]
              })
            ]
          }),
          !proxy.storedUrl && !detected.url && /* @__PURE__ */ jsx("span", {
            className: "settings-row-hint",
            children: "No proxy is set up anywhere yet — enter the address Claude Code should send its API calls to."
          }),
          /* @__PURE__ */ jsxs("div", {
            className: "auth-row",
            children: [
              /* @__PURE__ */ jsx("input", {
                "aria-label": "Claude API proxy token",
                type: "password",
                autoComplete: "off",
                value: token,
                onChange: (e) => setToken(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter")
                    saveToken();
                },
                placeholder: proxy.storedToken ? "Replace the token" : "Proxy token"
              }),
              /* @__PURE__ */ jsx("button", {
                className: "secondary",
                disabled: busy || !token.trim(),
                onClick: () => void saveToken(),
                children: "Save token"
              })
            ]
          }),
          /* @__PURE__ */ jsx("span", {
            className: "hint",
            children: proxy.storedToken ? /* @__PURE__ */ jsxs(Fragment2, {
              children: [
                "A token is kept on this device, never shown.",
                " ",
                /* @__PURE__ */ jsx("button", {
                  className: "link",
                  onClick: () => void removeToken(),
                  children: "Remove"
                })
              ]
            }) : detected.hasToken ? /* @__PURE__ */ jsxs(Fragment2, {
              children: [
                "Using the token from ",
                detected.tokenSource,
                " — not copied here until you save one or use the detected settings."
              ]
            }) : /* @__PURE__ */ jsx(Fragment2, {
              children: "No token: the proxy is called without one."
            })
          }),
          check && /* @__PURE__ */ jsx("p", {
            className: "hint",
            children: check
          }),
          status && /* @__PURE__ */ jsx("p", {
            className: "error",
            children: status
          })
        ]
      })
    ]
  });
}

// ../../../../plugins/plugins/agent-claude/src/client.tsx
var CLAUDE_SETTINGS_ORDER = CORE_SETTINGS_ORDER.workflow + 50;
function ClaudeSection(_props) {
  return /* @__PURE__ */ jsx(ClaudeSettings, {});
}
var plugin = {
  name: "agent-claude",
  inject: ["settings"],
  apply(ctx) {
    const settings = ctx.need("settings");
    ctx.effect(() => settings.add({
      id: "claude",
      title: "Claude",
      hint: "How the Claude the app starts signs in: your Claude account, or an API proxy with a token kept on this device.",
      order: CLAUDE_SETTINGS_ORDER,
      when: ({ demo, hosted }) => !demo && !hosted,
      Component: ClaudeSection
    }));
  }
};
var client_default2 = plugin;
export {
  client_default2 as default,
  CLAUDE_SETTINGS_ORDER
};

//# debugId=D2C87D10F828D65E64756E2164756E21
//# sourceMappingURL=client.js.map
