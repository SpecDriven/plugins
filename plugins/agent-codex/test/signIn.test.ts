// How the app's Codex signs in (specs/agents/codex.feature.md "Choose how
// Codex signs in", "API settings are filled in from Codex's own config",
// "Sign in to Codex with a ChatGPT account"): the stored choice, what
// Codex's own config says of an API, the launch each mode produces, the
// API check, the ChatGPT sign-in driven through a fake CLI, and the routes
// — the key never leaving the host.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "@specdriven/app/src/server/api";
import { endAllChatSessions } from "@specdriven/app/src/server/agentChat";
import type { ChatSessionMeta } from "@specdriven/app/src/server/agentTypes";
import { setSecretBackend } from "@specdriven/app/src/server/secrets";
import { writeState } from "@specdriven/app/src/server/state";
import {
  ACCOUNT_ARGS,
  API_KEY_ENV,
  CodexAuthError,
  NOT_SIGNED_IN,
  cancelLogin,
  checkApi,
  detectCodexApi,
  effectiveCodexAuth,
  launchFor,
  loginState,
  loginStatus,
  logout,
  readCodexConfig,
  resetLogin,
  setLoginStatus,
  startLogin,
  type LoginStatus,
} from "../src/auth";
import { setCodexAvailability } from "../src/cli";
import { setCodexSpawn, type CodexSpawnOptions } from "../src/codexChat";
import { forgetModels } from "../src/models";
import { codexExecArgs } from "../src/oneShot";
import { describeSignIn } from "../src/provider";
import { DEFAULT_SETTINGS, OPENAI_API_URL, codexSettingsOf, codexSettingsPatch } from "../src/settings";
import { mountPlugin, quietProfile } from "./app";

const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const realCodexHome = process.env.CODEX_HOME;
const SAVED_ENV = ["DEMO_MODE", "SPECDRIVEN_HOSTED", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "GATEWAY_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

let root: string;
let home: string;
let codexHome: string;
let data: string;
let unmount: () => Promise<void> = async () => {};
let spawned: CodexSpawnOptions[];
let stub: ReturnType<typeof Bun.serve> | null = null;

const SIGNED_IN: LoginStatus = { loggedIn: true, method: "chatgpt", email: "pat@example.com" };
const SIGNED_OUT: LoginStatus = { loggedIn: false, method: "none", email: null };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-codex-auth-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-codex-auth-home-"));
  codexHome = join(home, "codex");
  data = join(root, "data");
  await mkdir(codexHome, { recursive: true });
  await mkdir(data, { recursive: true });
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  process.env.CODEX_HOME = codexHome;
  for (const name of SAVED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  setSecretBackend("agent-codex.key", null);
  setCodexAvailability(() => true);
  setLoginStatus(async () => SIGNED_OUT);
  spawned = [];
  // A Codex that starts and says nothing: enough to read what it was started with.
  setCodexSpawn((options) => {
    spawned.push(options);
    return { write: () => {}, end: () => {}, kill: () => options.onExit(null) };
  });
  await writeState({ dataRepo: data, ...quietProfile(data) }, root);
  unmount = await mountPlugin();
});

afterEach(async () => {
  await endAllChatSessions();
  await unmount();
  resetLogin();
  forgetModels();
  setCodexAvailability(null);
  setLoginStatus(null);
  setCodexSpawn(null);
  setSecretBackend("agent-codex.key", null);
  await stub?.stop(true);
  stub = null;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
    ["CODEX_HOME", realCodexHome],
    ...SAVED_ENV.map((name) => [name, savedEnv[name]] as const),
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Codex's own config and sign-in, as files in this test's Codex home. */
const codexConfig = (toml: string) => writeFile(join(codexHome, "config.toml"), toml);
const codexAuthFile = (auth: Record<string, unknown>) => writeFile(join(codexHome, "auth.json"), JSON.stringify(auth));

const GATEWAY = `model_provider = "gateway"
forced_login_method = "api"
model = "gpt-test"

[model_providers.gateway]
name = "Gateway"
base_url = "http://localhost:6655/openai/v1"
requires_openai_auth = true
wire_api = "responses"
`;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const res = (await handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** A stand-in API: lists two models to whoever brings the key, and keeps what it was asked. */
function startApi(key: string | null = "sk-test-key"): { url: string; seen: { path: string; auth: string | null }[] } {
  const seen: { path: string; auth: string | null }[] = [];
  stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const auth = req.headers.get("authorization");
      seen.push({ path: new URL(req.url).pathname, auth });
      if (key && auth !== `Bearer ${key}`) return Response.json({ error: { message: "bad key" } }, { status: 401 });
      return Response.json({ object: "list", data: [{ id: "gpt-test", object: "model" }, { id: "gpt-test-mini", object: "model" }] });
    },
  });
  return { url: `http://127.0.0.1:${stub.port}/v1`, seen };
}

// --- the plugin's own settings ------------------------------------------------

test("the stored choice is normalized; an address must be http(s), and loses its trailing slash", () => {
  expect(codexSettingsOf({})).toEqual(DEFAULT_SETTINGS);
  expect(codexSettingsOf({ codexAuth: "api", codexApiUrl: " https://api.test/v1/ ", defaultModel: " gpt-test " })).toEqual({
    codexAuth: "api",
    codexApiUrl: "https://api.test/v1",
    defaultModel: "gpt-test",
  });
  expect(codexSettingsOf({ codexAuth: "ldap", codexApiUrl: "localhost:6655", defaultModel: "two words" })).toEqual(DEFAULT_SETTINGS);
  expect(codexSettingsPatch({ codexAuth: "login" })).toEqual({ patch: { codexAuth: "login" } });
  expect(codexSettingsPatch({ codexAuth: null, codexApiUrl: "", defaultModel: "" })).toEqual({
    patch: { codexAuth: null, codexApiUrl: null, defaultModel: null },
  });
  expect(codexSettingsPatch({ codexAuth: "proxy" })).toEqual({ error: "codexAuth must be login, api or null" });
  expect(codexSettingsPatch({ codexApiUrl: "ftp://api.test" })).toEqual({ error: "codexApiUrl must be an http:// or https:// url" });
  expect(codexSettingsPatch({})).toEqual({ error: "codexAuth, codexApiUrl or defaultModel is required" });
});

// --- what Codex's own config says ----------------------------------------------

test("readCodexConfig reads the provider Codex's config names, its address and key variable, and a required login", () => {
  const config = readCodexConfig(`${GATEWAY}env_key = "GATEWAY_KEY"\n\n[model_providers."other one"]\nbase_url = 'https://other.test/v1'\n\n[mcp_servers.x]\nbase_url = "nope"\n`);
  expect(config.modelProvider).toBe("gateway");
  expect(config.forcedLoginMethod).toBe("api");
  expect(config.providers.gateway).toEqual({ baseUrl: "http://localhost:6655/openai/v1", envKey: "GATEWAY_KEY" });
  expect(config.providers["other one"]).toEqual({ baseUrl: "https://other.test/v1", envKey: null });
  expect(Object.keys(config.providers)).toEqual(["gateway", "other one"]);
  // A top-level key after a table belongs to the table, as in TOML.
  expect(readCodexConfig('[features]\nmodel_provider = "x"\n').modelProvider).toBeNull();
  expect(readCodexConfig('openai_base_url = "https://eu.api.test/v1" # the EU one\n').openaiBaseUrl).toBe("https://eu.api.test/v1");
});

test("detectCodexApi finds the address in Codex's config and the key in its auth.json, or in the variable the provider names", async () => {
  expect(await detectCodexApi({}, codexHome)).toEqual({ url: null, urlSource: null, key: null, keySource: null, requiresApiKey: false });
  await codexConfig(GATEWAY);
  await codexAuthFile({ auth_mode: "apikey", OPENAI_API_KEY: "sk-from-auth-json" });
  expect(await detectCodexApi({}, codexHome)).toEqual({
    url: "http://localhost:6655/openai/v1",
    urlSource: join(codexHome, "config.toml"),
    key: "sk-from-auth-json",
    keySource: join(codexHome, "auth.json"),
    requiresApiKey: true,
  });
  // A provider that names a variable takes its key from the environment.
  await codexConfig(`${GATEWAY}env_key = "GATEWAY_KEY"\n`);
  const fromEnv = await detectCodexApi({ GATEWAY_KEY: "sk-from-env" }, codexHome);
  expect([fromEnv.key, fromEnv.keySource]).toEqual(["sk-from-env", "environment"]);
  // A ChatGPT login on file is no API key.
  await codexConfig("");
  await codexAuthFile({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "x" } });
  expect((await detectCodexApi({}, codexHome)).key).toBeNull();
});

test("with no choice stored, an API in Codex's own config means the API, and nothing there means the ChatGPT account", async () => {
  const env = { CODEX_HOME: codexHome };
  const none = await effectiveCodexAuth(DEFAULT_SETTINGS, null, env);
  expect([none.mode, none.inferred, none.api, none.url, none.own]).toEqual(["login", true, null, null, false]);
  await codexConfig(GATEWAY);
  await codexAuthFile({ OPENAI_API_KEY: "sk-detected" });
  const detected = await effectiveCodexAuth(DEFAULT_SETTINGS, null, env);
  expect([detected.mode, detected.inferred, detected.own]).toEqual(["api", true, false]);
  expect(detected.api).toEqual({ url: "http://localhost:6655/openai/v1", key: "sk-detected" });
  // The stored choice, address and key win over Codex's own.
  const own = await effectiveCodexAuth({ ...DEFAULT_SETTINGS, codexAuth: "api", codexApiUrl: "https://api.test/v1" }, "sk-own", env);
  expect([own.inferred, own.own, own.storedKey]).toEqual([false, true, true]);
  expect(own.api).toEqual({ url: "https://api.test/v1", key: "sk-own" });
  const account = await effectiveCodexAuth({ ...DEFAULT_SETTINGS, codexAuth: "login" }, "sk-own", env);
  expect([account.mode, account.api, account.url]).toEqual(["login", null, "http://localhost:6655/openai/v1"]);
  // A key with no address anywhere is OpenAI's own API.
  await codexConfig("");
  await rm(join(codexHome, "auth.json"));
  expect((await effectiveCodexAuth({ ...DEFAULT_SETTINGS, codexAuth: "api" }, "sk-own", env)).api).toEqual({ url: OPENAI_API_URL, key: "sk-own" });
  expect((await effectiveCodexAuth({ ...DEFAULT_SETTINGS, codexAuth: "api" }, null, env)).api).toBeNull();
});

// --- the launch ------------------------------------------------------------------

test("the API sign-in reaches Codex as a model provider of its own, its key in the environment and on no command line", async () => {
  const auth = await effectiveCodexAuth({ ...DEFAULT_SETTINGS, codexAuth: "api", codexApiUrl: "https://api.test/v1" }, "sk-own", { CODEX_HOME: codexHome });
  const launch = launchFor(auth, false, { PATH: "/bin", [API_KEY_ENV]: "stale" });
  expect(launch.mode).toBe("api");
  expect(launch.apiBaseUrl).toBe("https://api.test/v1");
  expect(launch.args).toEqual([
    "-c",
    'model_provider="specdriven"',
    "-c",
    `model_providers.specdriven={ name = "API", base_url = "https://api.test/v1", wire_api = "responses", env_key = "${API_KEY_ENV}" }`,
  ]);
  expect(launch.env).toEqual({ PATH: "/bin", [API_KEY_ENV]: "sk-own" });
  expect(launch.args.join(" ")).not.toContain("sk-own");
  // With no key anywhere the provider names no variable, and none is set.
  const keyless = launchFor(
    await effectiveCodexAuth({ ...DEFAULT_SETTINGS, codexAuth: "api", codexApiUrl: "http://localhost:9/v1" }, null, { CODEX_HOME: codexHome }),
    false,
    { [API_KEY_ENV]: "stale" },
  );
  expect(keyless.args[3]).toBe('model_providers.specdriven={ name = "API", base_url = "http://localhost:9/v1", wire_api = "responses" }');
  expect(keyless.env).toEqual({});
  // The same overrides lead `codex exec`'s own flags for a one-shot turn.
  expect(codexExecArgs("/w", "/o", null, "gpt-test", launch.args).slice(0, 6)).toEqual(["exec", ...launch.args, "--ephemeral"]);
});

test("the API sign-in keeps a ChatGPT login on file from being signed out, and leaves Codex alone with nothing of its own", async () => {
  await codexConfig(GATEWAY);
  await codexAuthFile({ OPENAI_API_KEY: "sk-detected" });
  const env = { CODEX_HOME: codexHome };
  // Nothing stored: Codex's own config, as it stands.
  const plain = launchFor(await effectiveCodexAuth(DEFAULT_SETTINGS, null, env), true, {});
  expect([plain.mode, plain.args, plain.apiBaseUrl]).toEqual(["api", [], "http://localhost:6655/openai/v1"]);
  // A key of the plugin's own, the address Codex's config names: a
  // provider — and the ChatGPT login said to be the one in use, so a
  // config that requires API keys does not sign it out.
  const own = launchFor(await effectiveCodexAuth(DEFAULT_SETTINGS, "sk-own", env), true, {});
  expect(own.args.slice(-2)).toEqual(["-c", 'forced_login_method="chatgpt"']);
  expect(own.args[3]).toContain('base_url = "http://localhost:6655/openai/v1"');
  expect(own.env).toEqual({ [API_KEY_ENV]: "sk-own" });
  expect(launchFor(await effectiveCodexAuth(DEFAULT_SETTINGS, "sk-own", env), false, {}).args).toHaveLength(4);
});

test("the account sign-in sets the API aside, and is never required of a Codex with no ChatGPT login", async () => {
  await codexConfig(GATEWAY);
  const auth = await effectiveCodexAuth({ ...DEFAULT_SETTINGS, codexAuth: "login" }, "sk-own", { CODEX_HOME: codexHome });
  const launch = launchFor(auth, true, { PATH: "/bin", OPENAI_API_KEY: "sk-env", CODEX_API_KEY: "sk-env", OPENAI_BASE_URL: "http://x", [API_KEY_ENV]: "sk-own" });
  expect(launch.args).toEqual(["-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"']);
  expect(launch.env).toEqual({ PATH: "/bin" });
  expect(launch.apiBaseUrl).toBeUndefined();
  // Requiring the ChatGPT login of a Codex that holds an API key signs
  // the key out: the launch is refused before any Codex starts.
  let refusal: unknown;
  try {
    launchFor(auth, false, {});
  } catch (e) {
    refusal = e;
  }
  expect(refusal).toBeInstanceOf(CodexAuthError);
  expect((refusal as CodexAuthError).message).toBe(NOT_SIGNED_IN);
  expect((refusal as CodexAuthError).status).toBe(502);
});

test("describeSignIn says the API and its host, or the ChatGPT account and whether it is signed in", () => {
  expect(describeSignIn({ mode: "api", apiUrl: "https://api.openai.com/v1", login: null })).toEqual({
    billing: "api",
    label: "API:api.openai.com",
    detail: "API calls go to api.openai.com",
  });
  expect(describeSignIn({ mode: "api", apiUrl: "http://localhost:6655/openai/v1", login: null }).label).toBe("API:LOCAL");
  expect(describeSignIn({ mode: "api", apiUrl: null, login: null })).toMatchObject({ billing: "api", label: "API" });
  expect(describeSignIn({ mode: "login", apiUrl: null, login: SIGNED_IN })).toEqual({
    billing: "plan",
    label: "ChatGPT account",
    detail: "ChatGPT account · pat@example.com",
  });
  expect(describeSignIn({ mode: "login", apiUrl: null, login: SIGNED_OUT })).toMatchObject({ billing: "none", label: "Not logged in" });
});

// --- the ChatGPT login -------------------------------------------------------------

test("loginStatus asks `codex login status` as the account sign-in starts Codex: a ChatGPT login, or none", async () => {
  const asked: string[][] = [];
  const runner = (stderr: string, exitCode: number) => async (_cmd: string, args: string[]) => {
    asked.push(args);
    return { exitCode, stdout: "", stderr };
  };
  expect(await loginStatus(runner("Logged in using ChatGPT\n", 0), "/bin/codex")).toEqual({ loggedIn: true, method: "chatgpt", email: null });
  expect(asked[0]).toEqual([...ACCOUNT_ARGS, "login", "status"]);
  // An API key is no ChatGPT login, whatever Codex says of it; nor is nothing.
  expect((await loginStatus(runner("API key configured - sk-***\n", 0), "/bin/codex")).loggedIn).toBe(false);
  expect(await loginStatus(runner("Not logged in\n", 1), "/bin/codex")).toEqual(SIGNED_OUT);
  expect(await loginStatus(runner("", 0), null)).toEqual({ loggedIn: false, method: "missing", email: null });
});

/** A stand-in for the `codex login` child: prints, then waits to be killed. */
class FakeLogin extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  pid = 4242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.exitCode = 143;
    return true;
  }
}

test("Sign in runs `codex login` under the account sign-in, and is done once the CLI reports a ChatGPT login", async () => {
  const child = new FakeLogin();
  const commands: string[][] = [];
  let status = SIGNED_OUT;
  const started = startLogin({
    executable: () => "/bin/codex",
    spawn: ((_cmd: string, args: string[]) => {
      commands.push(args);
      setTimeout(() => child.stderr.emit("data", "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?client_id=abc.\n"), 5);
      return child;
    }) as never,
    status: async () => status,
    pollMs: 10,
    urlWaitMs: 500,
  });
  const state = await started;
  expect(commands).toEqual([[...ACCOUNT_ARGS, "login"]]);
  expect(state).toEqual({ inProgress: true, url: "https://auth.openai.com/oauth/authorize?client_id=abc", done: false, error: null });
  // One at a time.
  await expect(startLogin({ executable: () => "/bin/codex" })).rejects.toMatchObject({ status: 409 });
  status = SIGNED_IN;
  await Bun.sleep(40);
  expect(loginState()).toMatchObject({ inProgress: false, done: true, error: null });
  expect(child.killed).toBe(true);
});

test("a cancelled sign-in stops the CLI, and Sign out is refused unless a ChatGPT account is signed in", async () => {
  const child = new FakeLogin();
  await startLogin({ executable: () => "/bin/codex", spawn: (() => child) as never, status: async () => SIGNED_OUT, pollMs: 1000, urlWaitMs: 1 });
  expect(cancelLogin()).toMatchObject({ inProgress: false, done: false, error: "Sign-in cancelled" });
  expect(child.killed).toBe(true);
  await expect(startLogin({ executable: () => null })).rejects.toMatchObject({ status: 502 });
  // Codex keeps one sign-in: a sign-out with an API key on file would take the key.
  const asked: string[][] = [];
  const runner = (said: string, code: number) => async (_cmd: string, args: string[]) => {
    asked.push(args);
    return { exitCode: args.at(-1) === "status" ? code : 0, stdout: "", stderr: args.at(-1) === "status" ? said : "" };
  };
  await expect(logout(runner("Not logged in", 1), "/bin/codex")).rejects.toMatchObject({ status: 409 });
  expect(asked.some((args) => args.includes("logout"))).toBe(false);
  await logout(runner("Logged in using ChatGPT", 0), "/bin/codex");
  expect(asked.at(-1)).toEqual(["logout"]);
});

// --- the API check -------------------------------------------------------------------

test("Check connection asks the API for its model list with the key, and never says the key back", async () => {
  const api = startApi();
  expect(await checkApi(api.url, "sk-test-key")).toEqual({ result: "ok", detail: "Reachable, and the key was accepted" });
  expect(api.seen.at(-1)).toEqual({ path: "/v1/models", auth: "Bearer sk-test-key" });
  expect(await checkApi(api.url, "sk-wrong")).toEqual({ result: "unauthorized", detail: "The API refused the key (HTTP 401)" });
  expect(await checkApi(api.url, null)).toEqual({ result: "unauthorized", detail: "The API wants a key (HTTP 401)" });
  expect((await checkApi(api.url, "two words")).result).toBe("unauthorized");
  const failing = (async () => {
    throw new Error("connect failed with sk-test-key in the header");
  }) as unknown as typeof fetch;
  const down = await checkApi("http://127.0.0.1:9/v1", "sk-test-key", failing);
  expect(down.result).toBe("unreachable");
  expect(down.detail).toContain("[key]");
  expect(down.detail).not.toContain("sk-test-key");
  const odd = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  expect(await checkApi(api.url, null, odd)).toEqual({ result: "unexpected", detail: "Reachable, but it answered HTTP 500" });
});

// --- the routes ------------------------------------------------------------------------

test("GET /api/codex/auth reports the mode, the ChatGPT login and the API — never a key", async () => {
  const empty = await call("GET", "/api/codex/auth");
  expect(empty.status).toBe(200);
  expect(empty.body).toMatchObject({ mode: "login", inferred: true, cliAvailable: true, login: SIGNED_OUT, defaultModel: null, signIn: null });
  expect(empty.body.api).toMatchObject({ url: null, storedUrl: null, storedKey: false, hasKey: false });

  await codexConfig(GATEWAY);
  await codexAuthFile({ auth_mode: "apikey", OPENAI_API_KEY: "sk-detected-secret" });
  const detected = await call("GET", "/api/codex/auth");
  expect(detected.body).toMatchObject({ mode: "api", inferred: true });
  expect(detected.body.api).toMatchObject({ url: "http://localhost:6655/openai/v1", storedUrl: null, storedKey: false, hasKey: true });
  expect(detected.body.api.detected).toMatchObject({ url: "http://localhost:6655/openai/v1", hasKey: true, requiresApiKey: true });
  expect(JSON.stringify(detected.body)).not.toContain("sk-detected-secret");

  // "Use detected" copies the address and the key host-side.
  const used = await call("POST", "/api/codex/api/detect");
  expect(used.body.api).toMatchObject({ storedUrl: "http://localhost:6655/openai/v1", storedKey: true });
  expect(JSON.stringify(used.body)).not.toContain("sk-detected-secret");

  // A pasted key is kept, never said back; a key a request cannot carry is refused.
  expect((await call("POST", "/api/codex/key", { key: "" })).status).toBe(400);
  expect((await call("POST", "/api/codex/key", { key: "Bearer sk-pasted" })).status).toBe(400);
  const pasted = await call("POST", "/api/codex/key", { key: "  sk-pasted-secret " });
  expect(pasted.body.api.storedKey).toBe(true);
  expect(JSON.stringify(pasted.body)).not.toContain("sk-pasted-secret");
  const removed = await call("DELETE", "/api/codex/key");
  expect(removed.body.api).toMatchObject({ storedKey: false, hasKey: true });
});

test("PUT /api/codex/settings stores the choice, the address and the model, and null forgets them", async () => {
  const chosen = await call("PUT", "/api/codex/settings", { codexAuth: "login" });
  expect(chosen.body).toEqual({ codexAuth: "login", codexApiUrl: null, defaultModel: null });
  expect((await call("GET", "/api/codex/auth")).body).toMatchObject({ mode: "login", inferred: false });
  expect((await call("PUT", "/api/codex/settings", { codexAuth: "proxy" })).status).toBe(400);
  expect((await call("PUT", "/api/codex/settings", { codexApiUrl: "localhost:6655" })).status).toBe(400);
  const api = await call("PUT", "/api/codex/settings", { codexAuth: "api", codexApiUrl: " http://api.test:9/v1/ ", defaultModel: "gpt-test" });
  expect(api.body).toEqual({ codexAuth: "api", codexApiUrl: "http://api.test:9/v1", defaultModel: "gpt-test" });
  expect((await call("GET", "/api/codex/settings")).body).toEqual(api.body);
  const forgotten = await call("PUT", "/api/codex/settings", { codexAuth: null, codexApiUrl: null, defaultModel: null });
  expect(forgotten.body).toEqual({ codexAuth: null, codexApiUrl: null, defaultModel: null });
});

test("the sign-in routes refuse in the demo and the hosted app", async () => {
  process.env.DEMO_MODE = "1";
  expect((await call("GET", "/api/codex/auth")).status).toBe(403);
  expect((await call("POST", "/api/codex/key", { key: "sk-x" })).status).toBe(403);
  delete process.env.DEMO_MODE;
  process.env.SPECDRIVEN_HOSTED = "1";
  expect((await call("PUT", "/api/codex/settings", { codexAuth: "api" })).status).toBe(403);
});

test("Check connection and the model list go to the address in effect with the stored key", async () => {
  const api = startApi();
  expect((await call("POST", "/api/codex/api/check", {})).status).toBe(400);
  await call("PUT", "/api/codex/settings", { codexAuth: "api", codexApiUrl: api.url });
  expect((await call("POST", "/api/codex/api/check", {})).body).toMatchObject({ url: api.url, result: "unauthorized" });
  await call("POST", "/api/codex/key", { key: "sk-test-key" });
  expect((await call("POST", "/api/codex/api/check", {})).body).toEqual({ url: api.url, result: "ok", detail: "Reachable, and the key was accepted" });
  // An address typed but not saved yet is the one checked.
  expect((await call("POST", "/api/codex/api/check", { url: "http://127.0.0.1:9/v1" })).body).toMatchObject({ url: "http://127.0.0.1:9/v1", result: "unreachable" });
  // The models the API lists are the ones Settings and the pane offer.
  const models = await call("GET", "/api/codex/models");
  expect(models.body.models.map((m: { value: string }) => m.value)).toEqual(["gpt-test", "gpt-test-mini"]);
  expect(api.seen.every((r) => r.path === "/v1/models")).toBe(true);
});

// --- a session under each sign-in ----------------------------------------------------

test("a session under the API sign-in starts Codex with the API as its provider and the key in its environment", async () => {
  await call("PUT", "/api/codex/settings", { codexAuth: "api", codexApiUrl: "http://api.test:9/v1", defaultModel: "gpt-test" });
  await call("POST", "/api/codex/key", { key: "sk-session-key" });
  const res = await call("POST", "/api/agent/chat", { name: "api chat", agent: "codex" });
  expect(res.status).toBe(200);
  expect((res.body as ChatSessionMeta).agent).toBe("codex");
  const codex = spawned.at(-1)!;
  expect(codex.args.slice(0, 5)).toEqual([
    "app-server",
    "-c",
    'model_provider="specdriven"',
    "-c",
    `model_providers.specdriven={ name = "API", base_url = "http://api.test:9/v1", wire_api = "responses", env_key = "${API_KEY_ENV}" }`,
  ]);
  expect(codex.env?.[API_KEY_ENV]).toBe("sk-session-key");
  expect(codex.args.join(" ")).not.toContain("sk-session-key");
});

test("a session under the account sign-in is refused while no ChatGPT account is signed in, and starts once one is", async () => {
  await codexAuthFile({ auth_mode: "apikey", OPENAI_API_KEY: "sk-on-file" });
  await call("PUT", "/api/codex/settings", { codexAuth: "login" });
  const refused = await call("POST", "/api/agent/chat", { name: "account chat", agent: "codex" });
  expect(refused.status).toBe(502);
  expect(refused.body.error).toBe(NOT_SIGNED_IN);
  // No Codex was started: nothing could sign the API key out.
  expect(spawned).toHaveLength(0);
  setLoginStatus(async () => SIGNED_IN);
  const started = await call("POST", "/api/agent/chat", { name: "account chat", agent: "codex" });
  expect(started.status).toBe(200);
  expect(spawned.at(-1)!.args).toEqual(["app-server", ...ACCOUNT_ARGS]);
  expect(spawned.at(-1)!.env?.[API_KEY_ENV]).toBeUndefined();
});
