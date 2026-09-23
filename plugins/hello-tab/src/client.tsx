// The browser half: registers a tab. `react` here is the app's own — the
// bundle is built over it — so hooks, context and the design tokens are
// shared. Icons: bundle what you need (e.g. from lucide-react) or draw one.

import { forwardRef, useEffect, useState } from "react";

type Disposer = () => void | Promise<void>;
interface View {}
/** What the app hands the tab's components (src/plugins/client/tabs.ts TabApp). */
interface TabApp {
  goHome(): void;
}
interface Ctx {
  need(key: "tabs"): { add(tab: unknown): Disposer };
  effect(run: () => Disposer): Disposer;
}

const Icon = forwardRef<SVGSVGElement, { size?: number | string; className?: string }>(
  ({ size = 16, ...props }, ref) => (
    <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
    </svg>
  ),
);

function Sidebar() {
  return <p style={{ padding: "0.75rem", color: "var(--text-2)" }}>Hello Tab</p>;
}

function Pane({ app }: { view: View; app: TabApp; navigate: (view: View) => void }) {
  const [reply, setReply] = useState<string>("…");
  useEffect(() => {
    fetch("/api/hello-tab")
      .then((r) => r.json())
      .then((body) => setReply(JSON.stringify(body)))
      .catch((e) => setReply(String(e)));
  }, []);
  return (
    <div style={{ padding: "1rem" }}>
      <h1>Hello Tab</h1>
      <p>The host half says: <code>{reply}</code></p>
      <button type="button" onClick={app.goHome}>Home</button>
    </div>
  );
}

export default {
  name: "hello-tab",
  inject: ["tabs"],
  apply(ctx: Ctx) {
    const tabs = ctx.need("tabs");
    ctx.effect(() =>
      tabs.add({
        id: "hello-tab",
        title: "Hello Tab",
        icon: Icon,
        order: 100,
        route: {
          match: (pathname: string) => (pathname === "/hello-tab" ? {} : null),
          path: () => "/hello-tab",
          key: () => "hello-tab",
          title: () => "Hello Tab",
          home: {},
        },
        Sidebar,
        Pane,
      }),
    );
  },
};
