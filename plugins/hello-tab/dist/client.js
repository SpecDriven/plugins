// specdriven-shim:react
var m = globalThis.__specdriven?.modules?.["react"];
if (!m)
  throw new Error("SpecDriven did not publish react for plugins");
var react_default = m.default ?? m;
var Activity = m.Activity;
var Children = m.Children;
var Component = m.Component;
var Fragment = m.Fragment;
var Profiler = m.Profiler;
var PureComponent = m.PureComponent;
var StrictMode = m.StrictMode;
var Suspense = m.Suspense;
var ViewTransition = m.ViewTransition;
var act = m.act;
var addTransitionType = m.addTransitionType;
var cache = m.cache;
var cacheSignal = m.cacheSignal;
var captureOwnerStack = m.captureOwnerStack;
var cloneElement = m.cloneElement;
var createContext = m.createContext;
var createElement = m.createElement;
var createRef = m.createRef;
var forwardRef = m.forwardRef;
var isValidElement = m.isValidElement;
var lazy = m.lazy;
var memo = m.memo;
var startTransition = m.startTransition;
var unstable_useCacheRefresh = m.unstable_useCacheRefresh;
var use = m.use;
var useActionState = m.useActionState;
var useCallback = m.useCallback;
var useContext = m.useContext;
var useDebugValue = m.useDebugValue;
var useDeferredValue = m.useDeferredValue;
var useEffect = m.useEffect;
var useEffectEvent = m.useEffectEvent;
var useId = m.useId;
var useImperativeHandle = m.useImperativeHandle;
var useInsertionEffect = m.useInsertionEffect;
var useLayoutEffect = m.useLayoutEffect;
var useMemo = m.useMemo;
var useOptimistic = m.useOptimistic;
var useReducer = m.useReducer;
var useRef = m.useRef;
var useState = m.useState;
var useSyncExternalStore = m.useSyncExternalStore;
var useTransition = m.useTransition;
var version = m.version;

// specdriven-shim:react/jsx-runtime
var m2 = globalThis.__specdriven?.modules?.["react/jsx-runtime"];
if (!m2)
  throw new Error("SpecDriven did not publish react/jsx-runtime for plugins");
var jsx_runtime_default = m2.default ?? m2;
var Fragment2 = m2.Fragment;
var jsx = m2.jsx;
var jsxs = m2.jsxs;

// src/client.tsx
var Icon = forwardRef(({ size = 16, ...props }, ref) => /* @__PURE__ */ jsx("svg", {
  ref,
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  ...props,
  children: /* @__PURE__ */ jsx("path", {
    d: "M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"
  })
}));
function Sidebar() {
  return /* @__PURE__ */ jsx("p", {
    style: { padding: "0.75rem", color: "var(--text-2)" },
    children: "Hello Tab"
  });
}
function Pane({ app }) {
  const [reply, setReply] = useState("…");
  useEffect(() => {
    fetch("/api/hello-tab").then((r) => r.json()).then((body) => setReply(JSON.stringify(body))).catch((e) => setReply(String(e)));
  }, []);
  return /* @__PURE__ */ jsxs("div", {
    style: { padding: "1rem" },
    children: [
      /* @__PURE__ */ jsx("h1", {
        children: "Hello Tab"
      }),
      /* @__PURE__ */ jsxs("p", {
        children: [
          "The host half says: ",
          /* @__PURE__ */ jsx("code", {
            children: reply
          })
        ]
      }),
      /* @__PURE__ */ jsx("button", {
        type: "button",
        onClick: app.goHome,
        children: "Home"
      })
    ]
  });
}
var client_default = {
  name: "hello-tab",
  inject: ["tabs"],
  apply(ctx) {
    const tabs = ctx.need("tabs");
    ctx.effect(() => tabs.add({
      id: "hello-tab",
      title: "Hello Tab",
      icon: Icon,
      order: 100,
      route: {
        match: (pathname) => pathname === "/hello-tab" ? {} : null,
        path: () => "/hello-tab",
        key: () => "hello-tab",
        title: () => "Hello Tab",
        home: {}
      },
      Sidebar,
      Pane
    }));
  }
};
export {
  client_default as default
};

//# debugId=E977881EC637EA0A64756E2164756E21
//# sourceMappingURL=client.js.map
