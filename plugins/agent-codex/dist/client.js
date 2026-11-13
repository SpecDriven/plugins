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

// plugins/agent-codex/src/modelMenu.ts
function narrowModels(all, listed) {
  if (listed.length === 0)
    return [...all];
  return listed.map((name) => all.find((m3) => m3.value === name) ?? { value: name, displayName: name, description: "" });
}
function modelLabel(model) {
  return model.displayName && model.displayName !== model.value ? `${model.displayName} — ${model.value}` : model.value;
}

// plugins/agent-codex/src/settings.ts
var OPENAI_API_URL = "https://api.openai.com/v1";

// specdriven-shim:react/jsx-runtime
var m3 = globalThis.__specdriven?.modules?.["react/jsx-runtime"];
if (!m3)
  throw new Error("SpecDriven did not publish react/jsx-runtime for plugins");
var jsx_runtime_default = m3.default ?? m3;
var Fragment2 = m3.Fragment;
var jsx = m3.jsx;
var jsxs = m3.jsxs;

// plugins/agent-codex/src/ui/CodexSettings.tsx
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
async function patchCodexSettings(patch) {
  const result = await call("PUT", "/api/codex/settings", patch);
  return result.ok ? null : result.error;
}
async function fetchCodexAuth() {
  const result = await call("GET", "/api/codex/auth");
  return result.ok ? result.data : null;
}
async function fetchOfferedModels() {
  const result = await call("GET", "/api/codex/models");
  return result.ok && result.data.models.length > 0 ? result.data.models : null;
}
var MODE_HINT = {
  login: "Sessions use the ChatGPT account the Codex CLI is signed in to. An API address or key in Codex's own config is set aside for them.",
  api: "Sessions send their API calls to the address below, with its key. That overrides whatever Codex's own config says."
};
function codexModelsOf(settings) {
  const all = settings.agentModels;
  if (!all || typeof all !== "object" || Array.isArray(all))
    return null;
  const list = all.codex;
  return Array.isArray(list) ? list.filter((m4) => typeof m4 === "string") : [];
}
function CodexSettings({ models = null } = {}) {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState(null);
  const [offered, setOffered] = useState(null);
  const signInKey = info?.mode === "login" ? info.login.loggedIn ? `login ${info.login.email ?? ""}` : null : info?.mode === "api" && info.api.url ? `api ${info.api.url} ${info.api.hasKey} ${info.api.storedKey}` : null;
  const [modelsAsk, setModelsAsk] = useState(0);
  const reloadModels = () => setModelsAsk((n) => n + 1);
  useEffect(() => {
    setOffered(null);
    if (signInKey === null)
      return;
    let live = true;
    fetchOfferedModels().then((list) => {
      if (live)
        setOffered(list);
    });
    return () => {
      live = false;
    };
  }, [signInKey, modelsAsk]);
  const refresh = async () => {
    const next = await fetchCodexAuth();
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
      children: "Could not read how Codex signs in."
    });
  if (!info)
    return /* @__PURE__ */ jsx("p", {
      className: "hint",
      children: "Checking how Codex signs in…"
    });
  const pickMode = async (mode) => {
    setInfo({ ...info, mode, inferred: false });
    setError(await patchCodexSettings({ codexAuth: mode }));
    await refresh();
  };
  return /* @__PURE__ */ jsxs("div", {
    className: "codex-settings",
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
                  info.inferred ? "Chosen for you from Codex's own config — pick one to keep it. " : "",
                  MODE_HINT[info.mode]
                ]
              })
            ]
          }),
          /* @__PURE__ */ jsxs("select", {
            "aria-label": "Codex sign-in",
            value: info.mode,
            onChange: (e) => void pickMode(e.target.value),
            children: [
              /* @__PURE__ */ jsx("option", {
                value: "login",
                children: "ChatGPT account"
              }),
              /* @__PURE__ */ jsx("option", {
                value: "api",
                children: "API"
              })
            ]
          })
        ]
      }),
      info.mode === "login" ? /* @__PURE__ */ jsx(CodexAccount, {
        info,
        onChange: setInfo,
        refresh,
        reloadModels,
        onModels: setOffered
      }) : /* @__PURE__ */ jsx(CodexApi, {
        info,
        refresh,
        onError: setError,
        reloadModels
      }),
      /* @__PURE__ */ jsx(DefaultModel, {
        info,
        models,
        offered: signInKey === null ? null : offered,
        offeredBy: info.mode === "api" ? "the API lists" : "your ChatGPT account offers",
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
function DefaultModel({
  info,
  models,
  offered = null,
  offeredBy = "the API lists",
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
    const failed = await patchCodexSettings({ defaultModel: model || null });
    onError(failed);
    if (failed)
      setDraft(info.defaultModel ?? "");
    await refresh();
  };
  const listed = models ?? [];
  const narrowed = listed.length > 0;
  if (offered && offered.length > 0 || narrowed) {
    const menu = narrowModels(offered ?? [], listed);
    const shown = narrowed ? draft && listed.includes(draft) ? draft : menu[0].value : draft;
    const options = !shown || menu.some((m4) => m4.value === shown) ? menu : [...menu, { value: shown, displayName: shown, description: "" }];
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
                "The model the coding agent pane and the app's other Codex calls start on, from the models",
                " ",
                offered && offered.length > 0 ? offeredBy : "listed below",
                narrowed && offered && offered.length > 0 ? ", narrowed to the Codex models listed below" : "",
                ". Applies to sessions started after the change."
              ]
            })
          ]
        }),
        /* @__PURE__ */ jsxs("select", {
          "aria-label": "Default Codex model",
          value: shown,
          onChange: (e) => void commit(e.target.value),
          children: [
            !narrowed && /* @__PURE__ */ jsx("option", {
              value: "",
              children: "Codex's default"
            }),
            options.map((m4) => /* @__PURE__ */ jsx("option", {
              value: m4.value,
              title: m4.description || undefined,
              children: modelLabel(m4)
            }, m4.value))
          ]
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
              "The model the coding agent pane and the app's other Codex calls start on — a model id. Empty uses Codex's own default. Once ",
              info.mode === "api" ? "the API answers with its model list" : "a ChatGPT account is signed in",
              ", this becomes a menu of those models. Applies to sessions started after the change."
            ]
          })
        ]
      }),
      /* @__PURE__ */ jsx("input", {
        "aria-label": "Default Codex model",
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => void commit(),
        onKeyDown: (e) => {
          if (e.key === "Enter")
            e.currentTarget.blur();
        },
        placeholder: "Codex's default",
        autoComplete: "off",
        spellCheck: false
      })
    ]
  });
}
function signInCheckText(login, models, error) {
  if (!login.loggedIn)
    return "Not signed in — the Codex CLI has no ChatGPT account. Sign in below.";
  const who = login.email ? `Signed in as ${login.email}` : "Signed in to a ChatGPT account";
  if (error)
    return `${who}, but Codex could not list the account's models: ${error}`;
  if (models.length === 0)
    return `${who}, but Codex listed no models for the account.`;
  return `${who} — Codex started under the account and lists ${models.length} model${models.length === 1 ? "" : "s"}.`;
}
function CodexAccount({
  info,
  onChange,
  refresh,
  reloadModels,
  onModels
}) {
  const [status, setStatus] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const signIn = info.signIn;
  const inProgress = signIn?.inProgress ?? false;
  const signedIn = info.login.loggedIn;
  const { detected, storedKey } = info.api;
  useEffect(() => {
    if (!inProgress)
      return;
    let live = true;
    const tick = async () => {
      const result = await call("GET", "/api/codex/login");
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
    const result = await call("POST", "/api/codex/login");
    setBusy(false);
    if (!result.ok)
      return setStatus(result.error);
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
    if (!result.ok)
      return setStatus(result.error);
    await refresh();
    setCheck("Signed out.");
  };
  const checkSignIn = async () => {
    setBusy(true);
    setStatus(null);
    setCheck("Checking — asking the Codex CLI, then starting a Codex under the account…");
    const result = await call("POST", "/api/codex/login/check");
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
  const who = !signedIn ? /* @__PURE__ */ jsxs(Fragment2, {
    children: [
      /* @__PURE__ */ jsx("strong", {
        children: "Not signed in."
      }),
      " Sign in with your ChatGPT account through the browser."
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
    children: "Signed in to a ChatGPT account."
  });
  const replacesKey = !signedIn && detected.hasKey && detected.keySource !== "environment";
  return /* @__PURE__ */ jsxs("div", {
    className: "settings-row auth-section",
    children: [
      /* @__PURE__ */ jsx("span", {
        className: "auth-title",
        children: "ChatGPT account"
      }),
      !info.cliAvailable ? /* @__PURE__ */ jsx("p", {
        className: "hint",
        children: "The Codex CLI is not installed — install the codex command (npm i -g @openai/codex), then come back here."
      }) : /* @__PURE__ */ jsx("p", {
        className: "hint",
        role: "status",
        children: who
      }),
      info.cliAvailable && replacesKey && /* @__PURE__ */ jsxs("p", {
        className: "hint",
        children: [
          "Codex keeps one sign-in: signing in replaces the API key in ",
          detected.keySource,
          ".",
          storedKey ? " The app has its own copy for the API." : " To keep it for the API, switch to API and choose “Use detected” first."
        ]
      }),
      info.cliAvailable && detected.requiresApiKey && /* @__PURE__ */ jsxs("p", {
        className: "hint",
        children: [
          "Codex's own config requires API keys (",
          /* @__PURE__ */ jsx("code", {
            children: 'forced_login_method = "api"'
          }),
          "): the app's sessions set that aside, but a Codex started outside the app signs the ChatGPT account out again."
        ]
      }),
      !info.cliAvailable ? null : inProgress ? /* @__PURE__ */ jsxs(Fragment2, {
        children: [
          /* @__PURE__ */ jsx("p", {
            className: "hint",
            role: "status",
            children: "Finish signing in in the browser window Codex opened. This page updates by itself once Codex has the account; nothing is pasted here."
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
      }) : /* @__PURE__ */ jsxs("div", {
        className: "auth-row",
        children: [
          /* @__PURE__ */ jsx("button", {
            className: "secondary",
            disabled: busy,
            onClick: () => void start(),
            children: "Sign in"
          }),
          /* @__PURE__ */ jsx("button", {
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
function apiCheckText(result, detail) {
  const lead = result === "ok" ? "OK" : result === "unauthorized" ? "Wrong key" : result === "unreachable" ? "Unreachable" : "Odd answer";
  return `${lead} — ${detail}`;
}
function CodexApi({
  info,
  refresh,
  onError,
  reloadModels
}) {
  const { api } = info;
  const [urlDraft, setUrlDraft] = useState(api.storedUrl ?? "");
  const [key, setKey] = useState("");
  const [status, setStatus] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setUrlDraft(api.storedUrl ?? ""), [api.storedUrl]);
  const commitUrl = async () => {
    const url = urlDraft.trim();
    if (url === (api.storedUrl ?? ""))
      return;
    setStatus(null);
    onError(await patchCodexSettings({ codexApiUrl: url || null }));
    await refresh();
  };
  const saveKey = async () => {
    if (!key.trim())
      return;
    setBusy(true);
    setStatus(null);
    const result = await call("POST", "/api/codex/key", { key: key.trim() });
    setBusy(false);
    if (!result.ok)
      return setStatus(result.error);
    setKey("");
    await refresh();
  };
  const removeKey = async () => {
    setStatus(null);
    const result = await call("DELETE", "/api/codex/key");
    if (!result.ok)
      return setStatus(result.error);
    await refresh();
  };
  const useDetected = async () => {
    setBusy(true);
    setStatus(null);
    const result = await call("POST", "/api/codex/api/detect");
    setBusy(false);
    if (!result.ok)
      return setStatus(result.error);
    await refresh();
  };
  const runCheck = async () => {
    setBusy(true);
    setCheck("Checking…");
    const result = await call("POST", "/api/codex/api/check", {
      url: urlDraft.trim() || undefined
    });
    setBusy(false);
    setCheck(result.ok ? apiCheckText(result.data.result, result.data.detail) : result.error);
    if (result.ok && result.data.result === "ok")
      reloadModels?.();
  };
  const detected = api.detected;
  const canUseDetected = detected.url !== null && detected.url !== api.storedUrl || detected.hasKey && !api.storedKey;
  const effectiveUrl = urlDraft.trim() || api.url;
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
                "aria-label": "Codex API address",
                className: "paste-token-host",
                value: urlDraft,
                onChange: (e) => setUrlDraft(e.target.value),
                onBlur: () => void commitUrl(),
                onKeyDown: (e) => {
                  if (e.key === "Enter")
                    e.currentTarget.blur();
                },
                placeholder: detected.url ?? OPENAI_API_URL
              }),
              /* @__PURE__ */ jsx("button", {
                className: "secondary",
                disabled: busy || !effectiveUrl,
                onClick: () => void runCheck(),
                children: "Check connection"
              })
            ]
          }),
          (detected.url || detected.hasKey) && /* @__PURE__ */ jsxs("span", {
            className: "settings-row-hint",
            children: [
              detected.url ? /* @__PURE__ */ jsxs(Fragment2, {
                children: [
                  "Detected in ",
                  detected.urlSource,
                  ": ",
                  /* @__PURE__ */ jsx("code", {
                    children: detected.url
                  }),
                  detected.hasKey ? " with a key" : ", no key",
                  "."
                ]
              }) : /* @__PURE__ */ jsxs(Fragment2, {
                children: [
                  "Detected an API key in ",
                  detected.keySource,
                  "."
                ]
              }),
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
          !api.storedUrl && !detected.url && /* @__PURE__ */ jsxs("span", {
            className: "settings-row-hint",
            children: [
              "No address is set anywhere: with a key, Codex calls OpenAI's API (",
              /* @__PURE__ */ jsx("code", {
                children: OPENAI_API_URL
              }),
              "). Enter another address to send its API calls there."
            ]
          }),
          /* @__PURE__ */ jsxs("div", {
            className: "auth-row",
            children: [
              /* @__PURE__ */ jsx("input", {
                "aria-label": "Codex API key",
                type: "password",
                autoComplete: "off",
                value: key,
                onChange: (e) => setKey(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter")
                    saveKey();
                },
                placeholder: api.storedKey ? "Replace the key" : "API key"
              }),
              /* @__PURE__ */ jsx("button", {
                className: "secondary",
                disabled: busy || !key.trim(),
                onClick: () => void saveKey(),
                children: "Save key"
              })
            ]
          }),
          /* @__PURE__ */ jsx("span", {
            className: "hint",
            children: api.storedKey ? /* @__PURE__ */ jsxs(Fragment2, {
              children: [
                "A key is kept on this device, never shown.",
                " ",
                /* @__PURE__ */ jsx("button", {
                  className: "link",
                  onClick: () => void removeKey(),
                  children: "Remove"
                })
              ]
            }) : detected.hasKey ? /* @__PURE__ */ jsxs(Fragment2, {
              children: [
                "Using the key from ",
                detected.keySource,
                " — not copied here until you save one or use the detected settings."
              ]
            }) : /* @__PURE__ */ jsx(Fragment2, {
              children: "No key: the API is called without one."
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

// plugins/agent-codex/src/client.tsx
var CODEX_SETTINGS_ORDER = CORE_SETTINGS_ORDER.workflow + 60;
function CodexSection({ settings }) {
  return /* @__PURE__ */ jsx(CodexSettings, {
    models: codexModelsOf(settings)
  });
}
var plugin = {
  name: "agent-codex",
  inject: ["settings"],
  apply(ctx) {
    const settings = ctx.need("settings");
    ctx.effect(() => settings.add({
      id: "codex",
      title: "Codex",
      hint: "How the Codex the app starts signs in — your ChatGPT account, or the API with a key kept on this device — and the model it starts on.",
      order: CODEX_SETTINGS_ORDER,
      when: ({ demo, hosted }) => !demo && !hosted,
      Component: CodexSection
    }));
  }
};
var client_default2 = plugin;
export {
  client_default2 as default,
  CODEX_SETTINGS_ORDER
};

//# debugId=6CEDCD9AEDCFD56F64756E2164756E21
//# sourceMappingURL=client.js.map
