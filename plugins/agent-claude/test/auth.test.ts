// How the app's Claude signs in (specs/agents/claude.feature.md "Choose how
// Claude signs in", "API proxy settings are filled in from Claude Code's
// settings", "Sign in to Claude with an email"): what Claude Code's own
// settings say of a proxy, the mode inferred from that, the launch each
// mode produces, the proxy check, the email sign-in driven through a fake
// CLI, and the routes — which never hand the token to the page.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "@specdriven/app/src/server/api";
import { pluginSection } from "@specdriven/app/src/plugins/host/pluginSettings";
import { secretPath, secretStore, setSecretBackend } from "@specdriven/app/src/server/secrets";
import { readState, writeState } from "@specdriven/app/src/server/state";
import { linkExecutable } from "@specdriven/app/tests/helpers/fakeBin";
import {
  cancelLogin,
  checkProxy,
  claudeProcessEnv,
  detectClaudeProxy,
  effectiveClaudeAuth,
  launchFor,
  loginState,
  loginStatus,
  logout,
  parseLoginStatus,
  resetLogin,
  startLogin,
} from "../src/auth";
import { setClaudeAvailability } from "../src/cli";
import { claudeSettingsOf, normalizeClaudeAuth, normalizeClaudeProxyUrl, type ClaudeSettingsValues } from "../src/settings";
import { mountPlugin, quietProfile } from "./app";

/** The proxy token's store, as HostConfig.secrets("token") names it for this plugin. */
const tokenStore = () => secretStore("agent-claude.token");
const token = async () => (await tokenStore().load())?.token ?? null;
/** The plugin's values with what a test sets, the rest default. */
const vals = (o: Partial<ClaudeSettingsValues>): ClaudeSettingsValues => ({ claudeAuth: null, claudeProxyUrl: null, firstResponseSeconds: 15, ...o });
let unmount: () => Promise<void> = async () => {};

const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const realPath = process.env.PATH;
const realConfig = process.env.CLAUDE_CONFIG_DIR;
const SAVED_ENV = ["DEMO_MODE", "SPECDRIVEN_HOSTED", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "SPECDRIVEN_TEST_LOGIN_MARK"] as const;
const savedEnv: Record<string, string | undefined> = {};

let root: string;
let home: string;
let config: string;
let data: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-claude-auth-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-claude-auth-home-"));
  config = join(home, "claude");
  data = join(root, "data");
  await mkdir(config, { recursive: true });
  await mkdir(data, { recursive: true });
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = config;
  for (const name of SAVED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  setSecretBackend("agent-claude.token", null);
  setClaudeAvailability(() => true);
  await writeState({ dataRepo: data, ...quietProfile(data) }, root);
  unmount = await mountPlugin();
});

afterEach(async () => {
  await unmount();
  resetLogin();
  setClaudeAvailability(null);
  setSecretBackend("agent-claude.token", null);
  process.env.PATH = realPath;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
    ["CLAUDE_CONFIG_DIR", realConfig],
    ...SAVED_ENV.map((name) => [name, savedEnv[name]] as const),
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const userSettings = (env: Record<string, string>) =>
  writeFile(join(config, "settings.json"), JSON.stringify({ env }));

/** An environment that reads this test's Claude config, never the machine's. */
const envOf = (extra: Record<string, string> = {}) => ({ CLAUDE_CONFIG_DIR: config, ...extra });

/** The status a refused call throws with, or null when it went through. */
const refused = async (p: Promise<unknown>): Promise<number | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

// --- what Claude Code's own settings say ---------------------------------

test("detectClaudeProxy reads the environment, then each settings file, the later winning", async () => {
  const cwd = join(root, "work");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  expect(await detectClaudeProxy(cwd, {}, config)).toEqual({ url: null, urlSource: null, token: null, tokenSource: null });
  expect(await detectClaudeProxy(cwd, { ANTHROPIC_BASE_URL: "http://env:1", ANTHROPIC_AUTH_TOKEN: "env-token" }, config)).toEqual({
    url: "http://env:1",
    urlSource: "environment",
    token: "env-token",
    tokenSource: "environment",
  });
  await userSettings({ ANTHROPIC_BASE_URL: "http://user:2" });
  const user = await detectClaudeProxy(cwd, { ANTHROPIC_BASE_URL: "http://env:1", ANTHROPIC_AUTH_TOKEN: "env-token" }, config);
  expect(user.url).toBe("http://user:2");
  expect(user.urlSource).toBe(join(config, "settings.json"));
  expect(user.token).toBe("env-token"); // the file named no token: the environment's stands
  await writeFile(join(cwd, ".claude", "settings.json"), "{ not json");
  await writeFile(
    join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://local:3", ANTHROPIC_AUTH_TOKEN: "local-token" } }),
  );
  const local = await detectClaudeProxy(cwd, {}, config);
  expect(local).toEqual({
    url: "http://local:3",
    urlSource: join(cwd, ".claude", "settings.local.json"),
    token: "local-token",
    tokenSource: join(cwd, ".claude", "settings.local.json"),
  });
});

test("the stored choice is normalized; a url must be http(s)", () => {
  expect(normalizeClaudeAuth("login")).toBe("login");
  expect(normalizeClaudeAuth("proxy")).toBe("proxy");
  expect(normalizeClaudeAuth("ldap")).toBeNull();
  expect(normalizeClaudeAuth(undefined)).toBeNull();
  expect(normalizeClaudeProxyUrl(" http://localhost:6655/anthropic/ ")).toBe("http://localhost:6655/anthropic/");
  expect(normalizeClaudeProxyUrl("https://gateway.acme.com")).toBe("https://gateway.acme.com");
  expect(normalizeClaudeProxyUrl("localhost:6655")).toBeNull();
  expect(normalizeClaudeProxyUrl("ftp://x")).toBeNull();
  expect(normalizeClaudeProxyUrl("")).toBeNull();
  expect(normalizeClaudeProxyUrl(7)).toBeNull();
});

// --- the mode in effect, and the launch it makes ---------------------------

test("with nothing stored the mode is inferred — a proxy when Claude Code names one, else the account", async () => {
  const none = await effectiveClaudeAuth(vals({}), data, await token(), envOf());
  expect(none.mode).toBe("login");
  expect(none.inferred).toBe(true);
  expect(none.proxy).toBeNull();

  await userSettings({ ANTHROPIC_BASE_URL: "http://localhost:6655/anthropic/", ANTHROPIC_AUTH_TOKEN: "file-token" });
  const found = await effectiveClaudeAuth(vals({}), data, await token(), envOf());
  expect(found.mode).toBe("proxy");
  expect(found.inferred).toBe(true);
  expect(found.proxy).toEqual({ url: "http://localhost:6655/anthropic/", token: "file-token" });
  expect(found.storedUrl).toBeNull();
  expect(found.storedToken).toBe(false);

  // A stored choice wins over what is detected; stored url and token win
  // over the detected ones.
  const chosen = await effectiveClaudeAuth(vals({ claudeAuth: "login" }), data, await token(), envOf());
  expect(chosen.mode).toBe("login");
  expect(chosen.inferred).toBe(false);
  expect(chosen.proxy).toBeNull();
  await tokenStore().save({ token: "app-token" });
  const own = await effectiveClaudeAuth(vals({ claudeAuth: "proxy", claudeProxyUrl: "http://proxy.test:9/" }), data, await token(), envOf());
  expect(own.proxy).toEqual({ url: "http://proxy.test:9/", token: "app-token" });
  expect(own.storedUrl).toBe("http://proxy.test:9/");
  expect(own.storedToken).toBe(true);
});

test("the launch steers Claude Code through --settings, which beats its own files", async () => {
  const env = {
    CLAUDE_CONFIG_DIR: config,
    PATH: "/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    ANTHROPIC_BASE_URL: "http://env:1",
    ANTHROPIC_AUTH_TOKEN: "env-token",
    ANTHROPIC_API_KEY: "sk-env",
  };
  // The account: every proxy and key is cleared, in the flag and the environment.
  const login = launchFor(await effectiveClaudeAuth(vals({ claudeAuth: "login" }), data, await token(), env), env);
  expect(login.mode).toBe("login");
  expect(login.apiBaseUrl).toBeUndefined();
  expect(JSON.parse(login.extraArgs.settings!)).toEqual({
    env: { ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "" },
  });
  expect(login.env.CLAUDECODE).toBeUndefined();
  expect(login.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  expect(login.env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(login.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(login.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(login.env.PATH).toBe("/bin");

  // The proxy: the app's url and token, and no key to pre-empt the token.
  await tokenStore().save({ token: "app-token" });
  const proxy = launchFor(await effectiveClaudeAuth(vals({ claudeAuth: "proxy", claudeProxyUrl: "http://proxy.test:9/" }), data, await token(), env), env);
  expect(proxy.mode).toBe("proxy");
  expect(proxy.apiBaseUrl).toBe("http://proxy.test:9/");
  expect(JSON.parse(proxy.extraArgs.settings!)).toEqual({
    env: { ANTHROPIC_BASE_URL: "http://proxy.test:9/", ANTHROPIC_AUTH_TOKEN: "app-token", ANTHROPIC_API_KEY: "" },
  });
  expect(proxy.env.CLAUDECODE).toBeUndefined();
  expect(proxy.env.ANTHROPIC_BASE_URL).toBe("http://env:1"); // Claude Code's to override

  // A proxy with no token anywhere: the url alone.
  await tokenStore().clear();
  const plain = envOf({ PATH: "/bin" });
  const bare = launchFor(await effectiveClaudeAuth(vals({ claudeAuth: "proxy", claudeProxyUrl: "http://proxy.test:9/" }), data, await token(), plain), plain);
  expect(JSON.parse(bare.extraArgs.settings!)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://proxy.test:9/" } });

  // Proxy mode with no url at all: Claude Code is left to its own config.
  const unset = launchFor(await effectiveClaudeAuth(vals({ claudeAuth: "proxy" }), data, await token(), plain), plain);
  expect(unset.extraArgs).toEqual({});
  expect(unset.apiBaseUrl).toBeUndefined();
  expect(claudeProcessEnv({ CLAUDECODE: "1", A: "b" })).toEqual({ A: "b" });
});

// --- the proxy check ------------------------------------------------------

test("checkProxy asks for the model list and reads the answer", async () => {
  const seen: { path: string; auth: string | null; key: string | null }[] = [];
  let status = 200;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, auth: req.headers.get("authorization"), key: req.headers.get("x-api-key") });
      return new Response("{}", { status });
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}/anthropic/`;
    expect((await checkProxy(base, "tok")).result).toBe("ok");
    expect(seen[0]).toEqual({ path: "/anthropic/v1/models", auth: "Bearer tok", key: "tok" });
    expect((await checkProxy(`http://127.0.0.1:${server.port}/anthropic`, null)).result).toBe("ok");
    expect(seen[1]).toEqual({ path: "/anthropic/v1/models", auth: null, key: null });
    status = 401;
    expect((await checkProxy(base, "tok")).result).toBe("unauthorized");
    status = 500;
    const odd = await checkProxy(base, "tok");
    expect(odd.result).toBe("unexpected");
    expect(odd.detail).toContain("500");
  } finally {
    server.stop(true);
  }
  const gone = await checkProxy(`http://127.0.0.1:${server.port}/`, "tok");
  expect(gone.result).toBe("unreachable");
  expect((await checkProxy("not a url", null)).result).toBe("unreachable");
});

// --- the account: status, the email sign-in, sign out ---------------------

test("parseLoginStatus reads what claude auth status --json says", () => {
  expect(parseLoginStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}')).toEqual({
    loggedIn: true,
    method: "claude.ai",
    email: "ada@example.com",
  });
  expect(parseLoginStatus('{"loggedIn":false,"authMethod":"none"}')).toEqual({ loggedIn: false, method: "none", email: null });
  expect(parseLoginStatus("garbage")).toEqual({ loggedIn: false, method: "unknown", email: null });
});

test("loginStatus asks the CLI without any key in its environment, and says missing without one", async () => {
  const calls: { cmd: string; args: string[]; env?: Record<string, string | undefined> }[] = [];
  process.env.ANTHROPIC_API_KEY = "sk-stray";
  const status = await loginStatus(async (cmd, args, options) => {
    calls.push({ cmd, args, env: options?.env });
    return { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}', stderr: "" };
  });
  expect(status).toEqual({ loggedIn: true, method: "claude.ai", email: "ada@example.com" });
  expect(calls[0]!.cmd).toBe("claude");
  expect(calls[0]!.args).toEqual(["auth", "status", "--json"]);
  expect(calls[0]!.env?.ANTHROPIC_API_KEY).toBeUndefined();
  setClaudeAvailability(() => false);
  expect(await loginStatus()).toEqual({ loggedIn: false, method: "missing", email: null });
});

// A stand-in `claude`: its login prints the browser url, then "signs in" by
// touching a marker file the status command reads. Constant body — the
// marker's path comes in through the environment (the app's tests/helpers/fakeBin.ts).
const FAKE_CLAUDE = `#!/bin/sh
case "$1 $2" in
  "auth status")
    if [ -f "$SPECDRIVEN_TEST_LOGIN_MARK" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}'
    else
      echo '{"loggedIn":false,"authMethod":"none"}'
    fi
    exit 0 ;;
  "auth login")
    echo "Opening your browser…"
    echo "Browser didn't open? Use the url below to sign in: https://claude.ai/oauth/authorize?email=$4&code=abc."
    /bin/sleep 0.3
    : > "$SPECDRIVEN_TEST_LOGIN_MARK"
    exit 0 ;;
  "auth logout")
    /bin/rm -f "$SPECDRIVEN_TEST_LOGIN_MARK"
    echo "Logged out"
    exit 0 ;;
esac
exit 1
`;

async function fakeClaudeOnPath(): Promise<void> {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  linkExecutable(bin, "claude", FAKE_CLAUDE);
  process.env.PATH = `${bin}:${realPath ?? ""}`;
  process.env.SPECDRIVEN_TEST_LOGIN_MARK = join(home, "logged-in");
  setClaudeAvailability(null);
}

const settle = async (until: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!until() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

test("startLogin drives claude auth login, hands the page the url, and is done once the CLI says so", async () => {
  await fakeClaudeOnPath();
  expect((await loginStatus()).loggedIn).toBe(false);
  expect(loginState()).toBeNull();

  const started = await startLogin("ada@example.com", { pollMs: 50 });
  expect(started.inProgress).toBe(true);
  expect(started.email).toBe("ada@example.com");
  expect(started.url).toBe("https://claude.ai/oauth/authorize?email=ada@example.com&code=abc");
  // One at a time.
  expect(await refused(startLogin("ada@example.com"))).toBe(409);

  await settle(() => !loginState()!.inProgress);
  expect(loginState()).toEqual({ inProgress: false, email: "ada@example.com", url: started.url, done: true, error: null });
  expect(await loginStatus()).toEqual({ loggedIn: true, method: "claude.ai", email: "ada@example.com" });

  await logout();
  expect((await loginStatus()).loggedIn).toBe(false);
});

test("a sign-in can be cancelled, and a bad email or a missing CLI is refused", async () => {
  expect(await refused(startLogin("not an email"))).toBe(400);
  setClaudeAvailability(() => false);
  expect(await refused(startLogin("ada@example.com"))).toBe(502);
  expect(await refused(logout())).toBe(502);

  await fakeClaudeOnPath();
  const started = await startLogin("ada@example.com", { pollMs: 50, urlWaitMs: 10 });
  expect(started.inProgress).toBe(true);
  const cancelled = cancelLogin();
  expect(cancelled).toMatchObject({ inProgress: false, done: false, error: "Sign-in cancelled" });
  // A sign-in that runs out of time ends the same way.
  await rm(join(home, "logged-in"), { force: true });
  await startLogin("ada@example.com", { pollMs: 1000, timeoutMs: 100, urlWaitMs: 10 });
  await settle(() => !loginState()!.inProgress);
  expect(loginState()!.error).toContain("timed out");
});

// --- the routes ------------------------------------------------------------

const call = async (method: string, path: string, body?: unknown) => {
  const res = (await handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

test("GET /api/claude/auth reports the mode, the login and the proxy — never a token", async () => {
  setClaudeAvailability(() => false);
  await userSettings({ ANTHROPIC_BASE_URL: "http://localhost:6655/anthropic/", ANTHROPIC_AUTH_TOKEN: "file-secret" });
  const first = await call("GET", "/api/claude/auth");
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    mode: "proxy",
    inferred: true,
    cliAvailable: false,
    login: { loggedIn: false, method: "missing", email: null },
    proxy: {
      url: "http://localhost:6655/anthropic/",
      storedUrl: null,
      storedToken: false,
      hasToken: true,
      detected: { url: "http://localhost:6655/anthropic/", hasToken: true },
    },
    signIn: null,
  });
  expect(JSON.stringify(first.body)).not.toContain("file-secret");
  expect((first.body.proxy as { detected: { urlSource: string } }).detected.urlSource).toContain("settings.json");

  // "Use detected" copies the url into settings.json and the token into the
  // app's own 0600 store.
  const used = await call("POST", "/api/claude/proxy/detect");
  expect(used.status).toBe(200);
  expect(used.body.proxy).toMatchObject({ storedUrl: "http://localhost:6655/anthropic/", storedToken: true });
  expect(JSON.stringify(used.body)).not.toContain("file-secret");
  // The url goes into the plugin's own section of the settings file
  // (specs/agents/agent-plugins.feature.md), read through the plugin.
  expect(claudeSettingsOf(pluginSection((await readState(root)) as Record<string, unknown>, "agent-claude")).claudeProxyUrl).toBe("http://localhost:6655/anthropic/");
  expect((await readState(root)).pluginSettings).toEqual({ "agent-claude": { adopted: true, claudeProxyUrl: "http://localhost:6655/anthropic/" } });
  expect(await tokenStore().load()).toEqual({ token: "file-secret" });
  expect((await stat(secretPath("agent-claude.token"))).mode & 0o777).toBe(0o600);

  // A pasted token replaces it; removing it leaves the detected one in use.
  expect((await call("POST", "/api/claude/token", { token: "" })).status).toBe(400);
  const pasted = await call("POST", "/api/claude/token", { token: "  pasted-secret " });
  expect(pasted.status).toBe(200);
  expect(await tokenStore().load()).toEqual({ token: "pasted-secret" });
  expect(JSON.stringify(pasted.body)).not.toContain("pasted-secret");
  const removed = await call("DELETE", "/api/claude/token");
  expect(removed.body.proxy).toMatchObject({ storedToken: false, hasToken: true });
  expect(await tokenStore().load()).toBeNull();
});

test("PUT /api/claude/settings stores the choice and the url, and null forgets them", async () => {
  // The top-level keys the values lived under before the plugin are no settings any more.
  expect((await call("PUT", "/api/state", { claudeAuth: "login" })).status).toBe(400);
  const section = async () => pluginSection((await readState(root)) as Record<string, unknown>, "agent-claude");
  const chosen = await call("PUT", "/api/claude/settings", { claudeAuth: "login" });
  expect(chosen.status).toBe(200);
  expect(chosen.body.claudeAuth).toBe("login");
  expect((await section()).claudeAuth).toBe("login");
  expect((await call("PUT", "/api/claude/settings", { claudeAuth: "ldap" })).status).toBe(400);
  expect((await call("PUT", "/api/claude/settings", { claudeProxyUrl: "localhost:6655" })).status).toBe(400);
  const url = await call("PUT", "/api/claude/settings", { claudeAuth: "proxy", claudeProxyUrl: " http://proxy.test:9/ " });
  expect(url.body.claudeProxyUrl).toBe("http://proxy.test:9/");
  expect(await section()).toMatchObject({ claudeAuth: "proxy", claudeProxyUrl: "http://proxy.test:9/" });
  const forgotten = await call("PUT", "/api/claude/settings", { claudeAuth: null, claudeProxyUrl: null });
  expect(forgotten.body).toMatchObject({ claudeAuth: null, claudeProxyUrl: null });
  const left = await section();
  expect("claudeAuth" in left).toBe(false);
  expect("claudeProxyUrl" in left).toBe(false);
  const written = JSON.parse(await readFile(join(root, ".specdriven", "settings.json"), "utf8")) as Record<string, unknown>;
  expect("claudeAuth" in written).toBe(false);
  expect("claudeProxyUrl" in written).toBe(false);
});

test("POST /api/claude/proxy/check reports on the proxy with the token in use", async () => {
  const seen: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(req.headers.get("authorization"));
      return new Response("{}", { status: req.headers.get("authorization") === "Bearer app-token" ? 200 : 401 });
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}/`;
    expect((await call("POST", "/api/claude/proxy/check", {})).status).toBe(400);
    await call("PUT", "/api/claude/settings", { claudeAuth: "proxy", claudeProxyUrl: base });
    expect((await call("POST", "/api/claude/proxy/check", {})).body).toMatchObject({ url: base, result: "unauthorized" });
    await call("POST", "/api/claude/token", { token: "app-token" });
    expect((await call("POST", "/api/claude/proxy/check", {})).body).toMatchObject({ url: base, result: "ok" });
    // The page's unsaved draft is what gets checked when it sends one.
    const draft = await call("POST", "/api/claude/proxy/check", { url: `http://127.0.0.1:${server.port}/other/` });
    expect(draft.body.url).toBe(`http://127.0.0.1:${server.port}/other/`);
    expect(seen).toHaveLength(3);
  } finally {
    server.stop(true);
  }
});

test("the sign-in routes drive the CLI and poll it", async () => {
  await fakeClaudeOnPath();
  expect((await call("POST", "/api/claude/login", { email: "nope" })).status).toBe(400);
  const started = await call("POST", "/api/claude/login", { email: "ada@example.com" });
  expect(started.status).toBe(200);
  expect(started.body.signIn).toMatchObject({ inProgress: true, url: expect.stringContaining("https://claude.ai/") });
  expect((await call("POST", "/api/claude/login", { email: "ada@example.com" })).status).toBe(409);
  await settle(() => !loginState()!.inProgress);
  const polled = await call("GET", "/api/claude/login");
  expect(polled.body.signIn).toMatchObject({ inProgress: false, done: true });
  expect(polled.body.login).toEqual({ loggedIn: true, method: "claude.ai", email: "ada@example.com" });
  const out = await call("POST", "/api/claude/logout");
  expect(out.status).toBe(200);
  expect(out.body.login).toMatchObject({ loggedIn: false });
  const cancelled = await call("DELETE", "/api/claude/login");
  expect(cancelled.status).toBe(200);
});

test("the demo and the hosted app have no Claude sign-in", async () => {
  process.env.DEMO_MODE = "1";
  expect((await call("GET", "/api/claude/auth")).status).toBe(403);
  expect((await call("POST", "/api/claude/token", { token: "x" })).status).toBe(403);
  expect((await call("PUT", "/api/claude/settings", { claudeAuth: "login" })).status).toBe(403);
  delete process.env.DEMO_MODE;
  process.env.SPECDRIVEN_HOSTED = "1";
  expect((await call("GET", "/api/claude/auth")).status).toBe(403);
  expect((await call("POST", "/api/claude/login", { email: "ada@example.com" })).status).toBe(403);
  expect((await call("PUT", "/api/claude/settings", { claudeProxyUrl: "http://x/" })).status).toBe(403);
});

// The Claude agent plugin's own settings (src/settings.ts,
// specs/agents/agent-plugins.feature.md "The Settings page
// shows a plugin's section"): the sign-in, the proxy url and the pane's
// first-response wait live in the plugin's section of settings.json, taken
// over from the top-level keys once, and change through its own route.
test("the plugin adopts the old top-level keys once, and PUT /api/claude/settings changes its own section", async () => {
  await unmount();
  await writeState(
    { dataRepo: data, claudeAuth: "proxy", claudeProxyUrl: "http://old.test:9/", agentFirstResponseSeconds: 30, ...quietProfile(data) } as unknown as Parameters<typeof writeState>[0],
    root,
  );
  unmount = await mountPlugin();
  const adopted = await readState(root);
  expect(adopted.pluginSettings).toEqual({
    "agent-claude": { adopted: true, claudeAuth: "proxy", claudeProxyUrl: "http://old.test:9/", agentFirstResponseSeconds: 30 },
  });
  // The old keys stay in the file; nothing reads them any more.
  expect((adopted as Record<string, unknown>).claudeAuth).toBe("proxy");
  expect(claudeSettingsOf(pluginSection(adopted as Record<string, unknown>, "agent-claude"))).toEqual({ claudeAuth: "proxy", claudeProxyUrl: "http://old.test:9/", firstResponseSeconds: 30 });

  const own = await call("GET", "/api/claude/settings");
  expect(own.status).toBe(200);
  expect(own.body).toEqual({ claudeAuth: "proxy", claudeProxyUrl: "http://old.test:9/", firstResponseSeconds: 30 });
  const changed = await call("PUT", "/api/claude/settings", { claudeAuth: "login", claudeProxyUrl: " http://new.test:9/ ", firstResponseSeconds: 15 });
  expect(changed.status).toBe(200);
  expect(changed.body).toEqual({ claudeAuth: "login", claudeProxyUrl: "http://new.test:9/", firstResponseSeconds: 15 });
  // The section wins over the old keys; the default wait is stored as no key.
  const after = await readState(root);
  expect(after.pluginSettings).toEqual({ "agent-claude": { adopted: true, claudeAuth: "login", claudeProxyUrl: "http://new.test:9/" } });
  expect((after as Record<string, unknown>).claudeAuth).toBe("proxy");
  expect((await call("GET", "/api/claude/auth")).body).toMatchObject({ mode: "login", inferred: false, firstResponseSeconds: 15 });

  // Null forgets a choice; a bad value is refused; the old top-level keys are no settings any more.
  const forgotten = await call("PUT", "/api/claude/settings", { claudeAuth: null, claudeProxyUrl: null });
  expect(forgotten.body).toMatchObject({ claudeAuth: null, claudeProxyUrl: null });
  expect((await call("PUT", "/api/claude/settings", { claudeAuth: "ldap" })).status).toBe(400);
  expect((await call("PUT", "/api/claude/settings", { firstResponseSeconds: -1 })).status).toBe(400);
  expect((await call("PUT", "/api/claude/settings", {})).status).toBe(400);
  expect((await call("PUT", "/api/state", { claudeAuth: "proxy", agentFirstResponseSeconds: 5 })).status).toBe(400);
  expect((await readState(root)).pluginSettings).toEqual({ "agent-claude": { adopted: true } });
  expect((await call("GET", "/api/claude/settings")).body).toEqual({ claudeAuth: null, claudeProxyUrl: null, firstResponseSeconds: 15 });
});

test("a Claude plugin switched off takes its routes and its provider away", async () => {
  expect((await call("GET", "/api/claude/settings")).status).toBe(200);
  await unmount();
  expect(await handleApi(new Request("http://localhost/api/claude/settings"))).toBeNull();
  const noAgent = await call("POST", "/api/agent/chat", { name: "chat", agent: "claude" });
  expect(noAgent.status).toBe(400);
  expect((noAgent.body as { error: string }).error).toContain("agent must be");
  unmount = await mountPlugin();
  expect((await call("GET", "/api/claude/settings")).status).toBe(200);
});
