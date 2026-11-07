// A stateful property test (Hegel) of Claude's sign-in as the app runs it
// (specs/agents/claude.feature.md "Choose how Claude signs in", "Sign in to
// Claude with an email", "API proxy settings are filled in from Claude
// Code's settings", "Choose the model Claude starts on";
// specs/agents/agent-plugins.feature.md, in the specs repo): the plugin
// mounted in the app, driven through its routes by random sequences of
// steps — an email sign-in and sign-out through a stand-in `claude`,
// switching between the account and an API proxy, the proxy's url and
// token, Claude Code's own settings changing underneath, "Use detected",
// "Check sign-in", and the plugin reloaded, switched off and on — with what
// Settings → Claude shows, the models every menu offers, the launch every
// Claude gets and the app's "sign-in changed" notices checked against a
// model of what the steps did.
//
// SPECDRIVEN_PROPERTY_CASES runs more sequences (default 20).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { handleApi } from "@specdriven/app/src/server/api";
import { agents } from "@specdriven/app/src/plugins/host/agents";
import { pluginSection } from "@specdriven/app/src/plugins/host/pluginSettings";
import { secretStore, setSecretBackend } from "@specdriven/app/src/server/secrets";
import { readState, writeState } from "@specdriven/app/src/server/state";
import { linkExecutable } from "@specdriven/app/tests/helpers/fakeBin";
import { LOGIN_SETTINGS, claudeLaunch, loginState, resetLogin } from "../src/auth";
import { forgetAccountModels } from "../src/accountModels";
import { setClaudeAvailability } from "../src/cli";
import { setQueryFactory, type QueryLike } from "../src/provider";
import { DEFAULT_AGENT_FIRST_RESPONSE_SECONDS, claudeSettingsOf } from "../src/settings";
import { mountPlugin, quietProfile } from "./app";

const CASES = Number(process.env.SPECDRIVEN_PROPERTY_CASES) || 20;
const STEPS = 25;

// A stand-in `claude`: `auth status` names whoever the mark file holds,
// `auth login --email <e>` signs <e> in (an email starting with "slow"
// takes long enough to be cancelled first), `auth logout` signs out.
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = "--settings" ]; then shift 2; fi
case "$1 $2" in
  "auth status")
    if [ -f "$SPECDRIVEN_TEST_LOGIN_MARK" ]; then
      printf '{"loggedIn":true,"authMethod":"claude.ai","email":"%s"}\\n' "$(/bin/cat "$SPECDRIVEN_TEST_LOGIN_MARK")"
    else
      echo '{"loggedIn":false,"authMethod":"none"}'
    fi
    exit 0 ;;
  "auth login")
    echo "Browser didn't open? Use the url below to sign in: https://claude.ai/oauth/authorize?code=abc"
    case "$4" in slow*) /bin/sleep 5 ;; *) /bin/sleep 0.02 ;; esac
    printf '%s' "$4" > "$SPECDRIVEN_TEST_LOGIN_MARK"
    exit 0 ;;
  "auth logout")
    /bin/rm -f "$SPECDRIVEN_TEST_LOGIN_MARK"
    exit 0 ;;
esac
exit 1
`;

const EMAILS = ["ada@example.com", "bo@example.com"] as const;
/** The model a stand-in account offers: one named for whoever is signed in. */
const accountModel = (email: string) => {
  const name = email.split("@")[0]!;
  return { value: `model-${name}`, displayName: name, description: "" };
};

// Stand-in proxies: one that wants the token "sk-proxy-a", one open to
// all, one that is not there.
const TOKENS = ["sk-proxy-a", "sk-proxy-b"] as const;
const FILE_TOKENS = ["sk-proxy-a", "sk-file-c"] as const;
let proxyA: ReturnType<typeof Bun.serve>;
let proxyB: ReturnType<typeof Bun.serve>;
let urlA: string;
let urlB: string;
let urlDead: string;

beforeAll(async () => {
  proxyA = Bun.serve({
    port: 0,
    fetch: (req) =>
      req.headers.get("authorization") === "Bearer sk-proxy-a"
        ? Response.json({ data: [{ id: "a-model", display_name: "A model" }], has_more: false })
        : new Response("{}", { status: 401 }),
  });
  proxyB = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ id: "b-model", display_name: "B model" }], has_more: false }) });
  // A port that was open and is closed again: nothing answers there.
  const gone = Bun.serve({ port: 0, fetch: () => new Response("") });
  urlDead = `http://127.0.0.1:${gone.port}/`;
  gone.stop(true);
  urlA = `http://127.0.0.1:${proxyA.port}/`;
  urlB = `http://127.0.0.1:${proxyB.port}/anthropic`;
});

afterAll(() => {
  proxyA.stop(true);
  proxyB.stop(true);
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  if (!res) return null;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** The route's answer; the plugin must be there to give one. */
const answered = async (method: string, path: string, body?: unknown) => {
  const res = await call(method, path, body);
  if (!res) throw new Error(`${method} ${path}: no route — the plugin is not mounted`);
  return res;
};

const settle = async (until: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!until() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

const NOTICES = typeof (agents as { changed?: unknown }).changed === "function";

/** What the steps did, as the model keeps it. */
interface Model {
  mounted: boolean;
  /** The plugin's own settings. */
  claudeAuth: "login" | "proxy" | null;
  proxyUrl: string | null;
  token: string | null;
  firstResponseSeconds: number;
  /** What Claude Code's own ~/.claude/settings.json says of a proxy. */
  fileUrl: string | null;
  fileToken: string | null;
  /** Who the CLI is signed in as. */
  signedIn: string | null;
  /** "Sign-in changed" notices the app should have had. */
  notices: number;
  /** Someone signed in or out with `claude` in a terminal, and nothing has
      had the models asked for again since: the menus may still offer the
      models asked for before, for the ten minutes they are kept
      (src/accountModels.ts). A proxy that changed underneath is no such
      case: the models are kept per proxy and token. */
  menusMayLag: boolean;
}

interface Run {
  model: Model;
  root: string;
  home: string;
  config: string;
  data: string;
  mark: string;
  unmount: (() => Promise<void>) | null;
  notices: number;
  /** Anything the stand-in Claude Code saw that it should not have. */
  wrongLaunches: string[];
}

/** A step that tells the app the sign-in changed: the models are asked for afresh. */
function told(m: Model): void {
  m.notices++;
  m.menusMayLag = false;
}

const effectiveMode = (m: Model) => m.claudeAuth ?? (m.fileUrl ? "proxy" : "login");

/** The models every menu offers, as GET /api/claude/models answers. */
function expectedModels(m: Model): { status: number; models: unknown[] } {
  if (effectiveMode(m) === "login") return { status: 200, models: m.signedIn ? [accountModel(m.signedIn)] : [] };
  const url = m.proxyUrl ?? m.fileUrl;
  if (!url) return { status: 200, models: [] };
  const token = m.token ?? m.fileToken;
  if (url === urlB) return { status: 200, models: [{ value: "b-model", displayName: "B model", description: "B model" }] };
  if (url === urlA && token === "sk-proxy-a") return { status: 200, models: [{ value: "a-model", displayName: "A model", description: "A model" }] };
  return { status: 502, models: [] };
}

async function writeClaudeCodeSettings(run: Run): Promise<void> {
  const env: Record<string, string> = {};
  if (run.model.fileUrl) env.ANTHROPIC_BASE_URL = run.model.fileUrl;
  if (run.model.fileToken) env.ANTHROPIC_AUTH_TOKEN = run.model.fileToken;
  await writeFile(join(run.config, "settings.json"), JSON.stringify({ env }));
}

const proxyUrl = () => gs.sampledFrom([urlA, urlB, urlDead]);

const machine: hegel.stateful.StateMachine<Run> = {
  rules: {
    async signInWithEmail(tc, run) {
      tc.assume(run.model.mounted);
      const email = tc.draw(gs.sampledFrom(EMAILS));
      const started = await answered("POST", "/api/claude/login", { email });
      expect(started.status).toBe(200);
      await settle(() => !loginState()?.inProgress);
      expect(loginState()).toMatchObject({ inProgress: false, done: true, error: null });
      run.model.signedIn = email;
      told(run.model);
    },

    async cancelSignIn(tc, run) {
      tc.assume(run.model.mounted);
      const started = await answered("POST", "/api/claude/login", { email: "slow@example.com" });
      expect(started.status).toBe(200);
      expect(started.body.signIn).toMatchObject({ inProgress: true });
      // A second sign-in waits for the first.
      expect((await answered("POST", "/api/claude/login", { email: "ada@example.com" })).status).toBe(409);
      const cancelled = await answered("DELETE", "/api/claude/login");
      expect(cancelled.body.signIn).toMatchObject({ inProgress: false, done: false, error: "Sign-in cancelled" });
    },

    async signOut(tc, run) {
      tc.assume(run.model.mounted);
      expect((await answered("POST", "/api/claude/logout")).status).toBe(200);
      run.model.signedIn = null;
      told(run.model);
    },

    // Signed in or out with `claude` in a terminal: the app is not told.
    async signInOutsideTheApp(tc, run) {
      const email = tc.draw(gs.optional(gs.sampledFrom(EMAILS)));
      if (email) await writeFile(run.mark, email);
      else await rm(run.mark, { force: true });
      run.model.signedIn = email;
      run.model.menusMayLag = true;
    },

    async chooseMode(tc, run) {
      tc.assume(run.model.mounted);
      const mode = tc.draw(gs.sampledFrom([null, "login", "proxy"] as const));
      const res = await answered("PUT", "/api/claude/settings", { claudeAuth: mode });
      expect(res.status).toBe(200);
      run.model.claudeAuth = mode;
      told(run.model);
    },

    async enterProxyUrl(tc, run) {
      tc.assume(run.model.mounted);
      const url = tc.draw(gs.oneOf<string | null>(proxyUrl(), gs.just(null), gs.just(""), proxyUrl().map((u) => `  ${u} `)));
      const res = await answered("PUT", "/api/claude/settings", { claudeProxyUrl: url });
      expect(res.status).toBe(200);
      run.model.proxyUrl = url?.trim() || null;
      told(run.model);
    },

    async switchModeAndUrlTogether(tc, run) {
      tc.assume(run.model.mounted);
      const mode = tc.draw(gs.sampledFrom(["login", "proxy"] as const));
      const url = tc.draw(proxyUrl());
      expect((await answered("PUT", "/api/claude/settings", { claudeAuth: mode, claudeProxyUrl: url })).status).toBe(200);
      run.model.claudeAuth = mode;
      run.model.proxyUrl = url;
      told(run.model);
    },

    async changeTheWait(tc, run) {
      tc.assume(run.model.mounted);
      const seconds = tc.draw(gs.integers({ minValue: 0, maxValue: 120 }));
      expect((await answered("PUT", "/api/claude/settings", { firstResponseSeconds: seconds })).status).toBe(200);
      run.model.firstResponseSeconds = seconds;
    },

    async refusedSettings(tc, run) {
      tc.assume(run.model.mounted);
      const body = tc.draw(
        gs.sampledFrom([
          { claudeAuth: "ldap" },
          { claudeAuth: "proxy", claudeProxyUrl: "localhost:6655" },
          { claudeProxyUrl: "ftp://proxy.test/" },
          { claudeAuth: "login", firstResponseSeconds: -1 },
          { claudeAuth: "proxy", defaultModel: "two words" },
          {},
        ]),
      );
      expect((await answered("PUT", "/api/claude/settings", body)).status).toBe(400);
    },

    async pasteToken(tc, run) {
      tc.assume(run.model.mounted);
      const token = tc.draw(gs.sampledFrom(TOKENS));
      expect((await answered("POST", "/api/claude/token", { token: ` ${token} ` })).status).toBe(200);
      run.model.token = token;
      told(run.model);
    },

    async refusedToken(tc, run) {
      tc.assume(run.model.mounted);
      // Nothing, too long, or what no request header can carry.
      const token = tc.draw(gs.sampledFrom(["", "   ", "x".repeat(1025), "Bearer sk-proxy-a", "sk-proxy\na", "sk-pröxy", "sk-proxy\u0000a"]));
      expect((await answered("POST", "/api/claude/token", { token })).status).toBe(400);
    },

    async removeToken(tc, run) {
      tc.assume(run.model.mounted);
      expect((await answered("DELETE", "/api/claude/token")).status).toBe(200);
      run.model.token = null;
      told(run.model);
    },

    // Claude Code's own settings change underneath: the app is not told.
    async editClaudeCodeSettings(tc, run) {
      run.model.fileUrl = tc.draw(gs.optional(proxyUrl()));
      run.model.fileToken = tc.draw(gs.optional(gs.sampledFrom(FILE_TOKENS)));
      await writeClaudeCodeSettings(run);
    },

    async useDetected(tc, run) {
      tc.assume(run.model.mounted);
      const res = await answered("POST", "/api/claude/proxy/detect");
      if (!run.model.fileUrl) {
        expect(res.status).toBe(404);
        return;
      }
      expect(res.status).toBe(200);
      run.model.proxyUrl = run.model.fileUrl;
      if (run.model.fileToken) run.model.token = run.model.fileToken;
      told(run.model);
    },

    async checkProxy(tc, run) {
      tc.assume(run.model.mounted);
      const res = await answered("POST", "/api/claude/proxy/check", {});
      const url = run.model.proxyUrl ?? run.model.fileUrl;
      if (!url) {
        expect(res.status).toBe(400);
        return;
      }
      const token = run.model.token ?? run.model.fileToken;
      const result = url === urlB ? "ok" : url === urlDead ? "unreachable" : token === "sk-proxy-a" ? "ok" : "unauthorized";
      expect(res.body).toMatchObject({ url, result });
      // A proxy check has the models asked for again.
      run.model.menusMayLag = false;
    },

    async checkSignIn(tc, run) {
      tc.assume(run.model.mounted);
      const res = await answered("POST", "/api/claude/login/check");
      const m = run.model;
      expect(res.body.login).toMatchObject({ loggedIn: m.signedIn !== null });
      const account = m.signedIn !== null && effectiveMode(m) === "login";
      expect(res.body.models).toEqual(account ? [accountModel(m.signedIn!)] : []);
      expect(res.body.account === null).toBe(!account);
      // From then on the menus offer what it found.
      m.menusMayLag = false;
    },

    async reloadPlugin(tc, run) {
      tc.assume(run.model.mounted);
      await run.unmount!();
      run.unmount = await mountPlugin();
    },

    async switchPluginOff(tc, run) {
      tc.assume(run.model.mounted);
      await run.unmount!();
      run.unmount = null;
      run.model.mounted = false;
    },

    async switchPluginOn(tc, run) {
      tc.assume(!run.model.mounted);
      run.unmount = await mountPlugin();
      run.model.mounted = true;
    },
  },

  invariants: {
    settingsShowWhatTheStepsChose: {
      alwaysCheck: true,
      async check(_tc, run) {
        const m = run.model;
        const auth = await call("GET", "/api/claude/auth");
        if (!m.mounted) {
          // Switched off: its routes and its provider are gone.
          expect(auth).toBeNull();
          expect(agents.get("claude")).toBeUndefined();
          return;
        }
        expect(agents.list().filter((p) => p.id === "claude")).toHaveLength(1);
        expect(auth!.status).toBe(200);
        expect(auth!.body).toMatchObject({
          mode: effectiveMode(m),
          inferred: m.claudeAuth === null,
          cliAvailable: true,
          login: m.signedIn ? { loggedIn: true, method: "claude.ai", email: m.signedIn } : { loggedIn: false, method: "none", email: null },
          proxy: {
            url: m.proxyUrl ?? m.fileUrl,
            storedUrl: m.proxyUrl,
            storedToken: m.token !== null,
            hasToken: m.token !== null || m.fileToken !== null,
            detected: { url: m.fileUrl, hasToken: m.fileToken !== null },
          },
          firstResponseSeconds: m.firstResponseSeconds,
        });
        // The page learns whether there is a token, never the token.
        const page = JSON.stringify(auth!.body);
        for (const token of [...TOKENS, ...FILE_TOKENS]) expect(page).not.toContain(token);

        expect((await answered("GET", "/api/claude/settings")).body).toEqual({
          claudeAuth: m.claudeAuth,
          claudeProxyUrl: m.proxyUrl,
          firstResponseSeconds: m.firstResponseSeconds,
          defaultModel: null,
          defaultEffort: null,
        });
      },
    },

    // What settings.json and the token store hold is what every Claude the
    // app starts is launched with — the pane, the estimate, self-fix.
    everyClaudeIsLaunchedAsChosen: {
      alwaysCheck: true,
      async check(_tc, run) {
        const m = run.model;
        const own = claudeSettingsOf(pluginSection((await readState(run.root)) as Record<string, unknown>, "agent-claude"));
        const stored = (await secretStore("agent-claude.token").load())?.token ?? null;
        expect(stored).toBe(m.token);
        const launch = await claudeLaunch(own, run.data, stored);
        expect(launch.mode).toBe(effectiveMode(m));
        if (launch.mode === "login") {
          expect(launch.extraArgs).toEqual({ settings: LOGIN_SETTINGS });
          return;
        }
        const url = m.proxyUrl ?? m.fileUrl;
        const token = m.token ?? m.fileToken;
        expect(launch.apiBaseUrl).toBe(url ?? undefined);
        expect(launch.extraArgs.settings ? JSON.parse(launch.extraArgs.settings) : null).toEqual(
          url ? { env: { ANTHROPIC_BASE_URL: url, ...(token ? { ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: "" } : {}) } } : null,
        );
      },
    },

    // Every model menu — Settings → Claude's Default model, the pane's —
    // offers what the sign-in in effect offers, never an earlier one's.
    // Asked after every step, as the app's pages keep asking.
    theMenusOfferTheSignInsModels: {
      alwaysCheck: true,
      async check(tc, run) {
        if (!run.model.mounted || run.model.menusMayLag) return;
        const res = await answered("GET", "/api/claude/models");
        const expected = expectedModels(run.model);
        tc.note(`models: expected ${JSON.stringify(expected)}, got ${res.status} ${JSON.stringify(res.body)}`);
        expect(res.status).toBe(expected.status);
        expect(res.body.models).toEqual(expected.models);
      },
    },

    // Every step that changes the sign-in tells the app once, so the pane
    // and its live sessions pick it up; nothing else does.
    theAppIsToldOfEverySignInChange: {
      alwaysCheck: true,
      check(_tc, run) {
        if (NOTICES) expect(run.notices).toBe(run.model.notices);
        expect(run.wrongLaunches).toEqual([]);
      },
    },
  },
};

/** A fresh app with the plugin mounted, the stand-in `claude` first on
    PATH, and nobody signed in. */
async function setUp(): Promise<Run & { restore: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "specdriven-claude-machine-"));
  const home = await mkdtemp(join(tmpdir(), "specdriven-claude-machine-home-"));
  const run: Run = {
    model: {
      mounted: true,
      claudeAuth: null,
      proxyUrl: null,
      token: null,
      firstResponseSeconds: DEFAULT_AGENT_FIRST_RESPONSE_SECONDS,
      fileUrl: null,
      fileToken: null,
      signedIn: null,
      notices: 0,
      menusMayLag: false,
    },
    root,
    home,
    config: join(home, "claude"),
    data: join(root, "data"),
    mark: join(home, "logged-in"),
    unmount: null,
    notices: 0,
    wrongLaunches: [],
  };
  const saved = { ...process.env };
  for (const name of ["DEMO_MODE", "SPECDRIVEN_HOSTED", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    delete process.env[name];
  }
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(run.config, { recursive: true });
  await mkdir(run.data, { recursive: true });
  linkExecutable(bin, "claude", FAKE_CLAUDE);
  Object.assign(process.env, {
    SPECDRIVEN_ROOT: root,
    SPECDRIVEN_HOME: home,
    CLAUDE_CONFIG_DIR: run.config,
    SPECDRIVEN_TEST_LOGIN_MARK: run.mark,
    PATH: `${bin}:${saved.PATH ?? ""}`,
  });
  setSecretBackend("agent-claude.token", null);
  setClaudeAvailability(null);
  resetLogin();
  forgetAccountModels();
  // The Claude Code asked for the account's models: signed in as the
  // account and nothing else, it names whoever the CLI says.
  setQueryFactory(({ options }) => {
    if (options.extraArgs?.settings !== LOGIN_SETTINGS) run.wrongLaunches.push(`account models asked with ${JSON.stringify(options.extraArgs)}`);
    return {
      accountInfo: async () => {
        const email = await readFile(run.mark, "utf8").catch(() => null);
        return email ? { email, subscriptionType: "max" } : { apiKeySource: "none", tokenSource: "none" };
      },
      supportedModels: async () => {
        const email = await readFile(run.mark, "utf8").catch(() => null);
        return email ? [accountModel(email)] : [];
      },
    } as unknown as QueryLike;
  });
  const unsubscribe = agents.subscribe((c) => {
    if (String(c.type) === "changed" && c.id === "claude") run.notices++;
  });
  await writeState({ dataRepo: run.data, ...quietProfile(run.data) }, root);
  run.unmount = await mountPlugin();
  const restore = async () => {
    unsubscribe();
    resetLogin();
    if (run.unmount) await run.unmount();
    setQueryFactory(null);
    setClaudeAvailability(null);
    forgetAccountModels();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  };
  return Object.assign(run, { restore });
}

test(
  "Settings → Claude, the model menus and every launch follow any sequence of sign-ins, switches and plugin reloads",
  () =>
    hegel.testAsync(
      async (tc) => {
        const run = await setUp();
        try {
          await hegel.stateful.runAsync(tc, machine, run, { stepCount: STEPS });
        } finally {
          await run.restore();
        }
      },
      { testCases: CASES },
    ),
  600_000,
);

// Found by this suite, against specs/agents/claude.feature.md S7: "Check
// sign-in" asked afresh only when someone was signed in, so after a
// sign-out in a terminal — or a proxy that turned up in Claude Code's own
// settings while nobody was signed in — "Default model" kept the models it
// was offering before, for the ten minutes they are kept.
test(
  "after Check sign-in the menus offer what it found, whatever changed outside the app before",
  () =>
    hegel.testAsync(
      async (tc) => {
        const run = await setUp();
        try {
          const m = run.model;
          if (tc.draw(gs.booleans())) {
            m.signedIn = tc.draw(gs.sampledFrom(EMAILS));
            await writeFile(run.mark, m.signedIn);
          }
          // The menus are asked, and keep the answer.
          await answered("GET", "/api/claude/models");
          // Then, outside the app: a sign-in or sign-out in a terminal, or a
          // proxy in Claude Code's own settings.
          if (tc.draw(gs.booleans())) {
            m.signedIn = tc.draw(gs.optional(gs.sampledFrom(EMAILS)));
            if (m.signedIn) await writeFile(run.mark, m.signedIn);
            else await rm(run.mark, { force: true });
          } else {
            m.fileUrl = tc.draw(proxyUrl());
            m.fileToken = tc.draw(gs.optional(gs.sampledFrom(FILE_TOKENS)));
            await writeClaudeCodeSettings(run);
          }
          await answered("POST", "/api/claude/login/check");
          const res = await answered("GET", "/api/claude/models");
          const expected = expectedModels(m);
          tc.note(`signed in: ${m.signedIn}, mode: ${effectiveMode(m)}; expected ${JSON.stringify(expected)}, got ${res.status} ${JSON.stringify(res.body)}`);
          expect(res.status).toBe(expected.status);
          expect(res.body.models).toEqual(expected.models);
        } finally {
          await run.restore();
        }
      },
      { testCases: 50 },
    ),
  600_000,
);
