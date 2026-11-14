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

// plugins/agent-claude/src/modelMenu.ts
function narrowModels(all, listed) {
  if (listed.length === 0)
    return [...all];
  const out = [];
  for (const name of listed) {
    const row = all.find((m3) => m3.value === name) ?? all.find((m3) => m3.resolvedModel === name);
    out.push(row ?? { value: name, displayName: name, description: "" });
  }
  return out;
}
function inList(model, all, listed) {
  if (listed.includes(model))
    return true;
  if (all.length === 0)
    return listed.length === 0;
  return narrowModels(all, listed).some((m3) => m3.value === model || m3.resolvedModel === model);
}

// plugins/agent-claude/src/settings.ts
var DEFAULT_AGENT_FIRST_RESPONSE_SECONDS = 15;
var CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
var CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku", "opusplan"];

// specdriven-shim:react/jsx-runtime
var m3 = globalThis.__specdriven?.modules?.["react/jsx-runtime"];
if (!m3)
  throw new Error("SpecDriven did not publish react/jsx-runtime for plugins");
var jsx_runtime_default = m3.default ?? m3;
var Fragment2 = m3.Fragment;
var jsx = m3.jsx;
var jsxs = m3.jsxs;

// plugins/agent-claude/src/ui/ClaudeSettings.tsx
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
async function fetchAccountModels() {
  const result = await call("GET", "/api/claude/models");
  return result.ok && result.data.models.length > 0 ? result.data.models : null;
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
  login: "Sessions use the Claude account Claude Code is signed in to. A proxy or API key in Claude Code's own settings is set aside for them.",
  proxy: "Sessions send their API calls to the address below (an API proxy or gateway), with its token. That overrides whatever Claude Code's own settings say."
};
function claudeModelsOf(settings) {
  const all = settings.agentModels;
  if (!all || typeof all !== "object" || Array.isArray(all))
    return null;
  const list = all.claude;
  return Array.isArray(list) ? list.filter((m4) => typeof m4 === "string") : [];
}
function ClaudeSettings({ models = null } = {}) {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState(null);
  const [account, setAccount] = useState(null);
  const accountKey = info?.mode === "login" ? info.login.loggedIn ? info.login.email ?? "" : null : info?.mode === "proxy" && info.proxy.url ? `proxy ${info.proxy.url} ${info.proxy.hasToken}` : null;
  const [modelsAsk, setModelsAsk] = useState(0);
  const reloadModels = () => setModelsAsk((n) => n + 1);
  useEffect(() => {
    setAccount(null);
    if (accountKey === null)
      return;
    let live = true;
    fetchAccountModels().then((models2) => {
      if (live)
        setAccount(models2);
    });
    return () => {
      live = false;
    };
  }, [accountKey, modelsAsk]);
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
                children: "API"
              })
            ]
          })
        ]
      }),
      info.mode === "login" ? /* @__PURE__ */ jsx(ClaudeAccount, {
        info,
        onChange: setInfo,
        refresh,
        reloadModels,
        onModels: setAccount
      }) : /* @__PURE__ */ jsx(ClaudeProxy, {
        info,
        refresh,
        onError: setError,
        reloadModels
      }),
      info.mode === "proxy" && /* @__PURE__ */ jsx(ProxyTimeout, {
        info,
        refresh,
        onError: setError
      }),
      /* @__PURE__ */ jsx(DefaultModel, {
        info,
        models,
        account: accountKey === null ? null : account,
        offeredBy: info.mode === "proxy" ? "the proxy" : "your Claude account",
        refresh,
        onError: setError
      }),
      /* @__PURE__ */ jsx(DefaultEffort, {
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
              "A turn in the coding agent pane that gets no response from the API in this time is sent again after a short pause, and stopped with an error once three tries got none — instead of retrying for minutes while the API is down. 0 waits as long as Claude Code retries; the default is ",
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
var EFFORT_NAMES = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
};
function DefaultEffort({
  info,
  refresh,
  onError
}) {
  const pick = async (value) => {
    const failed = await patchClaudeSettings({ defaultEffort: value ? value : null });
    onError(failed);
    await refresh();
  };
  return /* @__PURE__ */ jsxs("label", {
    className: "settings-row",
    children: [
      /* @__PURE__ */ jsxs("span", {
        className: "settings-row-label",
        children: [
          "Default effort",
          /* @__PURE__ */ jsx("span", {
            className: "settings-row-hint",
            children: "How hard Claude thinks in the coding agent pane, unless you pick another level there. A level the model does not take is lowered to one it does. Applies to sessions started after the change."
          })
        ]
      }),
      /* @__PURE__ */ jsxs("select", {
        "aria-label": "Default Claude effort",
        value: info.defaultEffort ?? "",
        onChange: (e) => void pick(e.target.value),
        children: [
          /* @__PURE__ */ jsx("option", {
            value: "",
            children: "Claude Code's default"
          }),
          CLAUDE_EFFORTS.map((e) => /* @__PURE__ */ jsx("option", {
            value: e,
            children: EFFORT_NAMES[e]
          }, e))
        ]
      })
    ]
  });
}
function DefaultModel({
  info,
  models,
  account = null,
  offeredBy = "your Claude account",
  refresh,
  onError
}) {
  const [draft, setDraft] = useState(info.defaultModel ?? "");
  useEffect(() => setDraft(info.defaultModel ?? ""), [info.defaultModel]);
  const commit = async (value = draft) => {
    const model = value.trim();
    setDraft(model);
    if (model === (info.defaultModel ?? ""))
      return;
    const failed = await patchClaudeSettings({ defaultModel: model || null });
    onError(failed);
    if (failed)
      setDraft(info.defaultModel ?? "");
    await refresh();
  };
  if (account && account.length > 0) {
    const menu = narrowModels(account, models ?? []).map((m4) => ({ description: "", ...m4 }));
    const shown = draft && inList(draft, account, models ?? []) ? draft : menu[0].value;
    const options = menu.some((m4) => m4.value === shown) ? menu : [...menu, account.find((m4) => m4.value === shown) ?? { value: shown, displayName: shown, description: "" }];
    const narrowed = models !== null && models.length > 0;
    return /* @__PURE__ */ jsxs("label", {
      className: "settings-row",
      children: [
        /* @__PURE__ */ jsxs("span", {
          className: "settings-row-label",
          children: [
            "Default model",
            /* @__PURE__ */ jsxs("span", {
              className: "settings-row-hint",
              children: [
                "The model the coding agent pane and the app's other Claude calls start on, from the models ",
                offeredBy,
                " offers",
                narrowed ? ", narrowed to the Claude models listed below" : "",
                ". Applies to sessions started after the change."
              ]
            })
          ]
        }),
        /* @__PURE__ */ jsx("select", {
          "aria-label": "Default Claude model",
          value: shown,
          onChange: (e) => void commit(e.target.value),
          children: options.map((m4) => /* @__PURE__ */ jsx("option", {
            value: m4.value,
            title: m4.description || undefined,
            children: accountModelLabel(m4, account)
          }, m4.value))
        })
      ]
    });
  }
  if (models) {
    const shown = (draft && models.includes(draft) ? draft : models[0]) || "";
    const options = models;
    return /* @__PURE__ */ jsxs("label", {
      className: "settings-row",
      children: [
        /* @__PURE__ */ jsxs("span", {
          className: "settings-row-label",
          children: [
            "Default model",
            /* @__PURE__ */ jsxs("span", {
              className: "settings-row-hint",
              children: [
                "The model the coding agent pane and the app's other Claude calls start on, from the Claude models listed below, the first until you choose another.",
                shown ? "" : " List some below to choose one here; until then Claude Code chooses.",
                " Applies to sessions started after the change."
              ]
            })
          ]
        }),
        shown ? /* @__PURE__ */ jsx("select", {
          "aria-label": "Default Claude model",
          value: shown,
          onChange: (e) => void commit(e.target.value),
          children: options.map((m4) => /* @__PURE__ */ jsx("option", {
            value: m4,
            children: m4
          }, m4))
        }) : /* @__PURE__ */ jsx("select", {
          "aria-label": "Default Claude model",
          value: "",
          disabled: true,
          children: /* @__PURE__ */ jsx("option", {
            value: "",
            children: "No models listed"
          })
        })
      ]
    });
  }
  return /* @__PURE__ */ jsxs("label", {
    className: "settings-row",
    children: [
      /* @__PURE__ */ jsxs("span", {
        className: "settings-row-label",
        children: [
          "Default model",
          /* @__PURE__ */ jsxs("span", {
            className: "settings-row-hint",
            children: [
              "The model the coding agent pane and the app's other Claude calls start on — an alias such as ",
              /* @__PURE__ */ jsx("code", {
                children: "opus"
              }),
              " or ",
              /* @__PURE__ */ jsx("code", {
                children: "sonnet"
              }),
              ", or a full model id. Empty uses Claude Code's own default. Applies to sessions started after the change."
            ]
          })
        ]
      }),
      /* @__PURE__ */ jsx("input", {
        "aria-label": "Default Claude model",
        list: "claude-model-aliases",
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => void commit(),
        onKeyDown: (e) => {
          if (e.key === "Enter")
            e.currentTarget.blur();
        },
        placeholder: "Claude Code's default",
        autoComplete: "off",
        spellCheck: false
      }),
      /* @__PURE__ */ jsx("datalist", {
        id: "claude-model-aliases",
        children: CLAUDE_MODEL_ALIASES.map((alias) => /* @__PURE__ */ jsx("option", {
          value: alias
        }, alias))
      })
    ]
  });
}
function accountModelLabel(model, account) {
  const row = !model.description && account.find((m4) => m4.resolvedModel === model.value) || model;
  const name = row.description.split(" · ")[0]?.trim() || row.displayName;
  return name && name !== model.value ? `${name} — ${model.value}` : model.value;
}
function signInCheckText(login, models, error, account = null) {
  if (account?.billing === "none") {
    return "Not signed in — the Claude Code started under the account found no account, token or key. Sign in below.";
  }
  if (!login.loggedIn)
    return "Not signed in — the Claude CLI has no account. Sign in below.";
  if (login.method === "api_key")
    return "Signed in with an API key, not a Claude account — sign in below.";
  const who = login.email ? `Signed in as ${login.email}` : "Signed in to a Claude account";
  if (error)
    return `${who}, but Claude Code could not list the account's models: ${error}`;
  if (models.length === 0)
    return `${who}, but Claude Code listed no models for the account.`;
  return `${who} — Claude Code started under the account and lists ${models.length} model${models.length === 1 ? "" : "s"}.`;
}
function ClaudeAccount({
  info,
  onChange,
  refresh,
  reloadModels,
  onModels
}) {
  const [email, setEmail] = useState(info.login.email ?? "");
  const [status, setStatus] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const signIn = info.signIn;
  const inProgress = signIn?.inProgress ?? false;
  const signedIn = info.login.loggedIn && info.login.method !== "api_key";
  useEffect(() => {
    if (!inProgress)
      return;
    let live = true;
    const tick = async () => {
      const result = await call("GET", "/api/claude/login");
      if (!live || !result.ok)
        return;
      const next = result.data.signIn;
      if (next?.inProgress) {
        onChange({ ...info, signIn: next, login: result.data.login });
      } else {
        await refresh();
        if (next?.done)
          reloadModels();
      }
    };
    const timer = setInterval(() => void tick(), signIn?.download ? 500 : 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [inProgress, Boolean(signIn?.download)]);
  const start = async () => {
    setBusy(true);
    setStatus(null);
    setCheck(null);
    const result = await call("POST", "/api/claude/login", { email: email.trim() });
    setBusy(false);
    if (!result.ok)
      return setStatus(result.error);
    onChange({ ...info, signIn: result.data.signIn });
  };
  const cancel = async () => {
    await call("DELETE", "/api/claude/login");
    await refresh();
  };
  const signOut = async () => {
    setBusy(true);
    setStatus(null);
    setCheck(null);
    const result = await call("POST", "/api/claude/logout");
    setBusy(false);
    if (!result.ok)
      return setStatus(result.error);
    await refresh();
    setCheck("Signed out.");
  };
  const checkSignIn = async () => {
    setBusy(true);
    setStatus(null);
    setCheck("Checking — asking the Claude CLI, then starting a Claude Code under the account…");
    const result = await call("POST", "/api/claude/login/check");
    setBusy(false);
    if (!result.ok) {
      setCheck(null);
      return setStatus(result.error);
    }
    const { login, models, error, account = null } = result.data;
    onChange({ ...info, login: account?.billing === "none" ? { loggedIn: false, method: "none", email: null } : login });
    onModels(models.length > 0 ? models : null);
    setCheck(signInCheckText(login, models, error, account));
  };
  const who = !info.login.loggedIn ? /* @__PURE__ */ jsxs(Fragment2, {
    children: [
      /* @__PURE__ */ jsx("strong", {
        children: "Not signed in."
      }),
      " Enter the email of your Claude account to sign in through the browser."
    ]
  }) : info.login.method === "api_key" ? /* @__PURE__ */ jsxs(Fragment2, {
    children: [
      /* @__PURE__ */ jsx("strong", {
        children: "Signed in with an API key, not a Claude account"
      }),
      " — sessions in this mode set it aside, so sign in below."
    ]
  }) : info.login.email ? /* @__PURE__ */ jsxs(Fragment2, {
    children: [
      "Signed in as ",
      /* @__PURE__ */ jsx("strong", {
        children: info.login.email
      }),
      "."
    ]
  }) : /* @__PURE__ */ jsx(Fragment2, {
    children: "Signed in with a token Claude Code found in its environment."
  });
  return /* @__PURE__ */ jsxs("div", {
    className: "settings-row auth-section",
    children: [
      /* @__PURE__ */ jsx("span", {
        className: "auth-title",
        children: "Claude account"
      }),
      !info.cliAvailable && !info.canFetchClaude ? /* @__PURE__ */ jsx("p", {
        className: "hint",
        children: "Claude Code is not published for this platform — install the claude command, then come back here."
      }) : !info.cliAvailable ? /* @__PURE__ */ jsx("p", {
        className: "hint",
        children: "Enter the email of your Claude account to sign in through the browser. Claude Code is not installed, so the app downloads it first (about 90 MB, once)."
      }) : /* @__PURE__ */ jsx("p", {
        className: "hint",
        role: "status",
        children: who
      }),
      inProgress && signIn?.download ? /* @__PURE__ */ jsxs(Fragment2, {
        children: [
          /* @__PURE__ */ jsxs("p", {
            className: "hint",
            role: "status",
            children: [
              "Downloading Claude Code — ",
              downloadText(signIn.download),
              "…"
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
      }) : inProgress ? /* @__PURE__ */ jsxs(Fragment2, {
        children: [
          /* @__PURE__ */ jsx("p", {
            className: "hint",
            role: "status",
            children: "Finish signing in in the browser window Claude Code opened — approve the sign-in there. This page updates by itself once Claude Code has the account; nothing is pasted here."
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
      }) : signedIn ? /* @__PURE__ */ jsxs("div", {
        className: "auth-row",
        children: [
          /* @__PURE__ */ jsx("button", {
            className: "secondary",
            disabled: busy,
            onClick: () => void checkSignIn(),
            children: "Check sign-in"
          }),
          /* @__PURE__ */ jsx("button", {
            className: "secondary",
            disabled: busy,
            onClick: () => void signOut(),
            children: "Sign out"
          })
        ]
      }) : (info.cliAvailable || info.canFetchClaude) && /* @__PURE__ */ jsxs("div", {
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
            children: "Sign in"
          }),
          info.cliAvailable && /* @__PURE__ */ jsx("button", {
            className: "secondary",
            disabled: busy,
            onClick: () => void checkSignIn(),
            children: "Check sign-in"
          })
        ]
      }),
      check && !inProgress && /* @__PURE__ */ jsx("p", {
        className: "hint",
        role: "status",
        children: check
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
var MB = 1024 * 1024;
function downloadText(d) {
  const mb = (n) => Math.round(n / MB);
  return d.totalBytes ? `${mb(d.receivedBytes)} of ${mb(d.totalBytes)} MB` : `${mb(d.receivedBytes)} MB`;
}
function ClaudeProxy({
  info,
  refresh,
  onError,
  reloadModels
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
    if (result.ok && result.data.result === "ok")
      reloadModels?.();
  };
  const detected = proxy.detected;
  const canUseDetected = detected.url !== null && (detected.url !== proxy.storedUrl || detected.hasToken && !proxy.storedToken);
  const effectiveUrl = urlDraft.trim() || proxy.url;
  return /* @__PURE__ */ jsxs("div", {
    className: "settings-row auth-section",
    children: [
      /* @__PURE__ */ jsx("span", {
        className: "auth-title",
        children: "API"
      }),
      /* @__PURE__ */ jsxs("div", {
        className: "paste-token",
        children: [
          /* @__PURE__ */ jsxs("div", {
            className: "auth-row",
            children: [
              /* @__PURE__ */ jsx("input", {
                "aria-label": "Claude API url",
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
                "aria-label": "Claude API token",
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

// plugins/agent-claude/src/client.tsx
var CLAUDE_SETTINGS_ORDER = CORE_SETTINGS_ORDER.workflow + 50;
function ClaudeSection({ settings }) {
  return /* @__PURE__ */ jsx(ClaudeSettings, {
    models: claudeModelsOf(settings)
  });
}
var plugin = {
  name: "agent-claude",
  inject: ["settings"],
  apply(ctx) {
    const settings = ctx.need("settings");
    ctx.effect(() => settings.add({
      id: "claude",
      title: "Claude",
      hint: "How the Claude the app starts signs in — your Claude account, or the API with a token kept on this device — and the model it starts on.",
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

//# debugId=A598B55A640424AE64756E2164756E21
//# sourceMappingURL=client.js.map
