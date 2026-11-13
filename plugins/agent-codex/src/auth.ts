// How the app's Codex signs in (specs/agents/codex.feature.md "Choose how
// Codex signs in", "API settings are filled in from Codex's own config",
// "Sign in to Codex with a ChatGPT account", in the specs repo). Two ways:
// the ChatGPT account the Codex CLI is signed in to, or the API — an
// address and a key, prefilled from what Codex's own config
// (~/.codex/config.toml, ~/.codex/auth.json) already says, kept in the
// plugin's own stores (its section of the settings file for the address,
// its secret store for the key) and never written back into Codex's files.
//
// The choice reaches a Codex the app starts as `-c` overrides on its
// command line, which win over ~/.codex/config.toml for that process alone
// (launchFor): the API as a model provider of its own whose key comes from
// an environment variable, so the key is on no command line; the account
// as the built-in OpenAI provider with the ChatGPT login.
//
// Codex keeps one sign-in (auth.json), and signs it out when a launch
// requires the other kind ("ChatGPT login is required, but an API key is
// currently being used. Logging out." — checked against codex-cli 0.169 on
// 2026-11-13). So the ChatGPT login is never required of a Codex before
// `codex login status` has said it is there, and where it is there, a
// launch says so over a config of Codex's own that would require an API
// key. `login status` itself only reads.
//
// Node APIs only — this module also runs under Electron.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger, run, which } from "@specdriven/host";
import type { RunResult } from "@specdriven/host";
import { CODEX_BIN } from "./cli";
import { CODEX_CLIENT_INFO, CodexClient } from "./codexChat";
import { tomlString } from "./mcpConfig";
import { OPENAI_API_URL, normalizeCodexApiUrl, normalizeCodexAuth, type CodexAuthMode, type CodexSettingsValues } from "./settings";

type Env = Record<string, string | undefined>;

const log = getLogger("agent-codex");

export class CodexAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Codex's own folder, where its config and sign-in live. */
export function codexHome(env: Env = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

// ---------------------------------------------------------------------------
// What Codex's own config says of an API.

/** The few keys of ~/.codex/config.toml the sign-in turns on. */
export interface CodexConfig {
  /** The top-level `model_provider`, or null for Codex's own (OpenAI). */
  modelProvider: string | null;
  /** The top-level `openai_base_url`: another address for the OpenAI provider. */
  openaiBaseUrl: string | null;
  /** `forced_login_method`: "chatgpt" or "api" when Codex's config requires one. */
  forcedLoginMethod: string | null;
  /** Each `[model_providers.<id>]` table's address and key variable. */
  providers: Record<string, { baseUrl: string | null; envKey: string | null }>;
}

/** A TOML string value — "basic" or 'literal' — or null for anything else. */
function tomlValue(raw: string): string | null {
  const value = raw.trim();
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (basic) {
    try {
      return JSON.parse(`"${basic[1]}"`) as string;
    } catch {
      return basic[1]!;
    }
  }
  const literal = /^'([^']*)'/.exec(value);
  return literal ? literal[1]! : null;
}

/**
 * Read the sign-in's keys out of a config.toml: the top-level ones before
 * any table, and each `[model_providers.<id>]` table. Not a TOML parser —
 * a line it cannot read adds nothing, and a profile's or a project's
 * overrides are not followed.
 */
export function readCodexConfig(text: string): CodexConfig {
  const config: CodexConfig = { modelProvider: null, openaiBaseUrl: null, forcedLoginMethod: null, providers: {} };
  let table: string | null = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]/.exec(trimmed);
    if (header) {
      const provider = /^model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/.exec(header[1]!.trim());
      table = provider ? (provider[1] ?? provider[2] ?? provider[3])! : null;
      if (table && !config.providers[table]) config.providers[table] = { baseUrl: null, envKey: null };
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!pair || table === null) continue;
    const value = tomlValue(pair[2]!);
    if (value === null) continue;
    if (table === "") {
      if (pair[1] === "model_provider") config.modelProvider = value;
      if (pair[1] === "openai_base_url") config.openaiBaseUrl = value;
      if (pair[1] === "forced_login_method") config.forcedLoginMethod = value;
    } else {
      const provider = config.providers[table]!;
      if (pair[1] === "base_url") provider.baseUrl = value;
      if (pair[1] === "env_key") provider.envKey = value;
    }
  }
  return config;
}

/** What Codex's own config says of an API. */
export interface DetectedApi {
  url: string | null;
  /** The config file the address came from. */
  urlSource: string | null;
  key: string | null;
  /** "environment" or the file the key came from. */
  keySource: string | null;
  /** Codex's own config requires API keys (`forced_login_method = "api"`):
      a Codex started outside the app signs a ChatGPT account out. */
  requiresApiKey: boolean;
}

/**
 * The API Codex would use on its own: the address of the model provider
 * its config names (else its `openai_base_url`), and the key that goes with
 * it — the environment variable that provider names, else the API key
 * `codex login --with-api-key` left in auth.json.
 */
export async function detectCodexApi(env: Env = process.env, home: string = codexHome(env)): Promise<DetectedApi> {
  const found: DetectedApi = { url: null, urlSource: null, key: null, keySource: null, requiresApiKey: false };
  const configFile = join(home, "config.toml");
  let envKey: string | null = null;
  try {
    const config = readCodexConfig(await readFile(configFile, "utf8"));
    const provider = config.modelProvider ? config.providers[config.modelProvider] : undefined;
    const url = normalizeCodexApiUrl(provider?.baseUrl ?? (provider ? null : config.openaiBaseUrl));
    if (url) {
      found.url = url;
      found.urlSource = configFile;
    }
    envKey = provider?.envKey ?? null;
    found.requiresApiKey = config.forcedLoginMethod === "api";
  } catch {
    // No config: Codex's own defaults, which name no address.
  }
  if (envKey && env[envKey]) {
    found.key = env[envKey]!;
    found.keySource = "environment";
    return found;
  }
  const authFile = join(home, "auth.json");
  try {
    const key = (JSON.parse(await readFile(authFile, "utf8")) as { OPENAI_API_KEY?: unknown })?.OPENAI_API_KEY;
    if (typeof key === "string" && key) {
      found.key = key;
      found.keySource = authFile;
    }
  } catch {
    // No sign-in on file adds nothing.
  }
  return found;
}

/** The sign-in as settled for one launch: the mode, and the API it uses. */
export interface EffectiveCodexAuth {
  mode: CodexAuthMode;
  /** True when no mode is stored and this one was inferred. */
  inferred: boolean;
  /** The API an api-mode launch calls — the address in effect and its key;
      null in login mode, or when api mode has no address or key anywhere. */
  api: { url: string; key: string | null } | null;
  /** The address in effect whatever the mode: the stored one, else the
      detected one, else OpenAI's own once there is a key; null with none. */
  url: string | null;
  /** Whether the plugin holds an address or a key of its own: only then is
      a launch given a provider — else Codex is left to its own config. */
  own: boolean;
  detected: DetectedApi;
  /** The address the settings file holds, if any. */
  storedUrl: string | null;
  /** Whether the plugin's own secret store holds a key. */
  storedKey: boolean;
}

export async function effectiveCodexAuth(
  own: CodexSettingsValues,
  /** The key the plugin's secret store holds, or null. */
  storedKey: string | null,
  env: Env = process.env,
): Promise<EffectiveCodexAuth> {
  const detected = await detectCodexApi(env);
  const chosen = normalizeCodexAuth(own.codexAuth);
  const mode = chosen ?? (detected.url || detected.key ? "api" : "login");
  const storedUrl = normalizeCodexApiUrl(own.codexApiUrl);
  const key = storedKey ?? detected.key;
  // A key with no address anywhere is OpenAI's own API.
  const url = storedUrl ?? detected.url ?? (key ? OPENAI_API_URL : null);
  return {
    mode,
    inferred: chosen === null,
    api: mode === "api" && url ? { url, key } : null,
    url,
    own: storedUrl !== null || storedKey !== null,
    detected,
    storedUrl,
    storedKey: storedKey !== null,
  };
}

// ---------------------------------------------------------------------------
// The launch: what a Codex the app starts is given.

/** The model provider an api-mode launch defines, and the variable its key rides in. */
export const API_PROVIDER = "specdriven";
export const API_KEY_ENV = "SPECDRIVEN_CODEX_API_KEY";

/** What the account sign-in sets aside in the environment: a key or an
    address meant for the API. */
export const LOGIN_SETS_ASIDE = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", API_KEY_ENV] as const;

/** The `-c` overrides of the account sign-in: Codex's own provider, with the ChatGPT login. */
export const ACCOUNT_ARGS = ["-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"'] as const;

/** What a Codex the app starts is given: its environment and `-c` overrides. */
export interface CodexLaunch {
  mode: CodexAuthMode;
  env: Env;
  /** `-c key=value` pairs, for after the subcommand (`app-server`, `exec`). */
  args: string[];
  /** Where the API calls go when the app says where; undefined otherwise. */
  apiBaseUrl: string | undefined;
}

/** The launch that changes nothing: Codex's own config and sign-in. */
export function plainLaunch(env: Env = process.env): CodexLaunch {
  return { mode: "api", env, args: [], apiBaseUrl: undefined };
}

/**
 * The launch for a settled sign-in — pure, so a test can check it.
 * `chatgpt` is whether `codex login status` found a ChatGPT login: the
 * account sign-in is only ever required of a Codex that has one.
 */
export function launchFor(auth: EffectiveCodexAuth, chatgpt: boolean, env: Env = process.env): CodexLaunch {
  const processEnv: Env = { ...env };
  if (auth.mode === "login") {
    if (!chatgpt) throw new CodexAuthError(NOT_SIGNED_IN, 502);
    for (const name of LOGIN_SETS_ASIDE) delete processEnv[name];
    return { mode: "login", env: processEnv, args: [...ACCOUNT_ARGS], apiBaseUrl: undefined };
  }
  delete processEnv[API_KEY_ENV];
  if (!auth.api || !auth.own) {
    // Nothing of the plugin's own: Codex is left to its own config.
    return { mode: "api", env: processEnv, args: [], apiBaseUrl: auth.api?.url };
  }
  const { url, key } = auth.api;
  if (key) processEnv[API_KEY_ENV] = key;
  const provider = [
    `name = ${tomlString("API")}`,
    `base_url = ${tomlString(url)}`,
    'wire_api = "responses"',
    ...(key ? [`env_key = ${tomlString(API_KEY_ENV)}`] : []),
  ];
  return {
    mode: "api",
    env: processEnv,
    args: [
      "-c",
      `model_provider=${tomlString(API_PROVIDER)}`,
      "-c",
      `model_providers.${API_PROVIDER}={ ${provider.join(", ")} }`,
      // A ChatGPT login on file stays: Codex's own config may require API
      // keys, and would sign the account out on its way to an API that
      // needs neither.
      ...(chatgpt ? ["-c", 'forced_login_method="chatgpt"'] : []),
    ],
    apiBaseUrl: url,
  };
}

export const NOT_SIGNED_IN = "Codex is not signed in to a ChatGPT account — sign in in Settings → Codex, or choose the API there";

// ---------------------------------------------------------------------------
// The ChatGPT login: what `codex login status` says, `codex login` driven
// from Settings — the CLI opens the browser, the sign-in finishes there,
// and the poll on `login status` notices — and `codex logout`.

export interface LoginStatus {
  /** A ChatGPT account is signed in. */
  loggedIn: boolean;
  /** "chatgpt"; "none"; "missing" without a CLI. */
  method: string;
  /** The account's email, when Codex says. */
  email: string | null;
}

export type Runner = (cmd: string, args: string[], options?: { env?: Env }) => Promise<RunResult>;

const codexBin = (): string | null => which(CODEX_BIN);

let statusProbe: (() => Promise<LoginStatus>) | null = null;

/** Swap what `loginStatus` answers (a test with no Codex to ask); null
    restores the CLI. Returns the previous one. */
export function setLoginStatus(fn: (() => Promise<LoginStatus>) | null): (() => Promise<LoginStatus>) | null {
  const previous = statusProbe;
  statusProbe = fn;
  return previous;
}

/**
 * Whether the Codex CLI holds a ChatGPT login, asked as the account
 * sign-in starts it (ACCOUNT_ARGS): `codex login status` answers "Logged
 * in using ChatGPT" for one, and "Not logged in" for an API key or
 * nothing — it only reads, so asking signs nothing out.
 */
export async function loginStatus(runner: Runner = run, bin: string | null = codexBin()): Promise<LoginStatus> {
  if (statusProbe && runner === run) return statusProbe();
  if (!bin) return { loggedIn: false, method: "missing", email: null };
  const result = await runner(bin, [...ACCOUNT_ARGS, "login", "status"], { env: process.env });
  const said = `${result.stdout}\n${result.stderr}`;
  const loggedIn = result.exitCode === 0 && /chatgpt/i.test(said);
  log.debug("codex login status", { exit: result.exitCode, loggedIn });
  return { loggedIn, method: loggedIn ? "chatgpt" : "none", email: null };
}

/** How long a Codex started to say who is signed in gets to answer. */
const ACCOUNT_TIMEOUT_MS = 8000;

/**
 * The email of the ChatGPT account, asked of a `codex app-server` started
 * under the account sign-in for nothing else (`account/read`). Only for a
 * Codex `login status` found signed in; null when it does not say.
 */
export async function accountEmail(cwd: string = process.cwd()): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (email: string | null) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(email);
    };
    const client = new CodexClient({
      cwd,
      extraArgs: [...ACCOUNT_ARGS],
      onNotification: () => {},
      onServerRequest: (id) => client.respondError(id, "not supported"),
      onStderr: () => {},
      onExit: () => done(null),
    });
    void (async () => {
      const init = await client.request(
        "initialize",
        { clientInfo: CODEX_CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } },
        ACCOUNT_TIMEOUT_MS,
      );
      if (!init.ok) return done(null);
      const read = await client.request("account/read", {}, ACCOUNT_TIMEOUT_MS);
      const account = read.ok ? (read.result.account as { type?: unknown; email?: unknown } | null) : null;
      done(account && account.type === "chatgpt" && typeof account.email === "string" && account.email ? account.email : null);
    })();
  });
}

/** A sign-in started from Settings, as the page polls it. */
export interface LoginState {
  inProgress: boolean;
  /** The page the CLI printed for the browser, once it has. */
  url: string | null;
  done: boolean;
  error: string | null;
}

interface LoginFlow extends LoginState {
  child: ChildProcess | null;
  output: string[];
  timer: ReturnType<typeof setTimeout> | null;
  poll: ReturnType<typeof setTimeout> | null;
  urlWaiters: (() => void)[];
}

let flow: LoginFlow | null = null;

// Who wants to know that the sign-in changed (src/host.ts tells the app).
const signInListeners = new Set<() => void>();

/** Call `fn` whenever the sign-in changes: a sign-in done, a sign-out.
    Returns the unsubscribe. */
export function onSignInChange(fn: () => void): () => void {
  signInListeners.add(fn);
  return () => {
    signInListeners.delete(fn);
  };
}

function signInChanged(): void {
  for (const fn of [...signInListeners]) {
    try {
      fn();
    } catch (e) {
      console.error(`[agent-codex] sign-in listener: ${(e as Error).message}`);
    }
  }
}

export interface LoginDeps {
  spawn?: typeof nodeSpawn;
  status?: () => Promise<LoginStatus>;
  /** How often the login is checked for (ms). */
  pollMs?: number;
  /** How long the browser gets before the sign-in is given up (ms). */
  timeoutMs?: number;
  /** How long to wait for the CLI to print its url before answering (ms). */
  urlWaitMs?: number;
  /** The Codex to run; default: the `codex` on PATH. */
  executable?: () => string | null;
}

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_MS = 2000;
const URL_WAIT_MS = 1500;

function publicState(f: LoginFlow): LoginState {
  return { inProgress: f.inProgress, url: f.url, done: f.done, error: f.error };
}

/** The sign-in under way or last finished, or null when none was started. */
export function loginState(): LoginState | null {
  return flow ? publicState(flow) : null;
}

const CANCELLED = "Sign-in cancelled";

function finish(f: LoginFlow, error: string | null): void {
  if (!f.inProgress) return;
  f.inProgress = false;
  f.done = error === null;
  f.error = error;
  if (error === null) log.info("sign-in done");
  else if (error === CANCELLED) log.info("sign-in cancelled");
  else log.warn("sign-in ended without a login", { error, output: f.output.slice(-3).join(" | ") });
  if (f.timer) clearTimeout(f.timer);
  if (f.poll) clearTimeout(f.poll);
  f.timer = null;
  f.poll = null;
  const child = f.child;
  f.child = null;
  if (child && child.exitCode === null) child.kill();
  for (const wake of f.urlWaiters.splice(0)) wake();
  if (error === null) signInChanged();
}

/**
 * Start `codex login` under the account sign-in: the CLI opens the browser
 * on ChatGPT's sign-in page and prints its url; the sign-in is done once
 * `codex login status` says so. One at a time. Codex keeps one sign-in, so
 * an API key in its auth.json is replaced by the account.
 */
export async function startLogin(deps: LoginDeps = {}): Promise<LoginState> {
  if (flow?.inProgress) throw new CodexAuthError("A sign-in is already in progress", 409);
  const codex = (deps.executable ?? codexBin)();
  if (!codex) throw new CodexAuthError("The Codex CLI is not installed — install the codex command, then sign in", 502);
  const status = deps.status ?? (() => loginStatus());
  const f: LoginFlow = { inProgress: true, url: null, done: false, error: null, child: null, output: [], timer: null, poll: null, urlWaiters: [] };
  flow = f;
  let child: ChildProcess;
  try {
    child = (deps.spawn ?? nodeSpawn)(codex, [...ACCOUNT_ARGS, "login"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    finish(f, `Could not start the Codex CLI: ${(e as Error).message}`);
    return publicState(f);
  }
  f.child = child;
  log.info("sign-in started", { codex, pid: child.pid ?? "?" });
  const onData = (data: Buffer | string) => {
    const text = String(data);
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    f.output = [...f.output, ...lines].slice(-20);
    if (!f.url) {
      const match = /https:\/\/[^\s'"<>)\]]+/.exec(text);
      if (match) {
        f.url = match[0].replace(/[.,;]+$/, "");
        for (const wake of f.urlWaiters.splice(0)) wake();
      }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => finish(f, `Could not start the Codex CLI: ${e.message}`));
  child.on("exit", (code) => {
    if (!f.inProgress) return;
    // The CLI returns once the browser has come back — or gave up.
    void status().then(
      (s) => {
        if (!f.inProgress) return;
        if (s.loggedIn) finish(f, null);
        else finish(f, `Sign-in ended without a login (exit ${code ?? "?"})${f.output.length ? `: ${f.output.slice(-2).join(" ")}` : ""}`);
      },
      (e: Error) => finish(f, `Sign-in ended, but asking who is signed in failed: ${e.message}`),
    );
  });
  const pollMs = deps.pollMs ?? LOGIN_POLL_MS;
  const check = async () => {
    if (!f.inProgress) return;
    try {
      if ((await status()).loggedIn) return finish(f, null);
    } catch {
      // Asked again on the next tick.
    }
    if (f.inProgress) f.poll = setTimeout(() => void check(), pollMs);
  };
  f.poll = setTimeout(() => void check(), pollMs);
  f.timer = setTimeout(() => finish(f, "Sign-in timed out — try again"), deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
  // Give the CLI a moment to print its url, so the first answer carries it.
  await new Promise<void>((resolve) => {
    if (f.url || !f.inProgress) return resolve();
    f.urlWaiters.push(resolve);
    setTimeout(resolve, deps.urlWaitMs ?? URL_WAIT_MS);
  });
  return publicState(f);
}

/** Stop a sign-in under way; nothing when none is. */
export function cancelLogin(): LoginState | null {
  if (flow?.inProgress) finish(flow, CANCELLED);
  return loginState();
}

/** Stop and forget any sign-in, as if none was ever started (tests). */
export function resetLogin(): void {
  cancelLogin();
  flow = null;
}

/** `codex logout` — also drops any sign-in under way. Only ever asked of a
    Codex with a ChatGPT login: Codex keeps one sign-in, and a sign-out
    takes whichever it holds. */
export async function logout(runner: Runner = run, bin: string | null = codexBin()): Promise<void> {
  cancelLogin();
  if (!bin) throw new CodexAuthError("The Codex CLI is not installed", 502);
  if (!(await loginStatus(runner, bin)).loggedIn) throw new CodexAuthError("No ChatGPT account is signed in", 409);
  const result = await runner(bin, ["logout"], { env: process.env });
  if (result.exitCode !== 0) {
    throw new CodexAuthError(`Could not sign out: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`, 502);
  }
  log.info("signed out");
  signInChanged();
}

// ---------------------------------------------------------------------------
// The API: is it there, and does it take the key?

/** A key a request header can carry: printable ASCII, no spaces. */
export const SENDABLE_KEY = /^[\x21-\x7e]+$/;

export const UNSENDABLE_KEY = "The API key has characters a request cannot carry — a space, a line break or a letter outside ASCII";

/** A message with every copy of the key taken out, for words that go back
    to the page: the key is never sent back to it. */
export function withoutKey(message: string, key: string | null): string {
  return key ? message.split(key).join("[key]") : message;
}

/** `<address>/models`: the API's model list, as Codex's `base_url` places it. */
export function modelsUrl(url: string): URL {
  return new URL("models", url.endsWith("/") ? url : `${url}/`);
}

export type ApiCheck = "ok" | "unauthorized" | "unreachable" | "unexpected";

/** One request the API answers cheaply — GET <address>/models — with the
    key the way Codex sends it (a bearer token). */
export async function checkApi(
  url: string,
  key: string | null,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<{ result: ApiCheck; detail: string }> {
  let target: URL;
  try {
    target = modelsUrl(url);
  } catch {
    return { result: "unreachable", detail: "Not a url" };
  }
  if (key && !SENDABLE_KEY.test(key)) return { result: "unauthorized", detail: UNSENDABLE_KEY };
  try {
    const res = await fetchFn(target, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { result: "ok", detail: key ? "Reachable, and the key was accepted" : "Reachable" };
    if (res.status === 401 || res.status === 403) {
      return { result: "unauthorized", detail: key ? `The API refused the key (HTTP ${res.status})` : `The API wants a key (HTTP ${res.status})` };
    }
    return { result: "unexpected", detail: `Reachable, but it answered HTTP ${res.status}` };
  } catch (e) {
    const message = (e as Error).name === "TimeoutError" ? "no answer in time" : withoutKey((e as Error).message, key);
    return { result: "unreachable", detail: `Could not reach ${target.origin}: ${message}` };
  }
}
