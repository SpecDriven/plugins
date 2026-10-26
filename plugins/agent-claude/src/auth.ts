// How the app's Claude signs in (specs/agents/claude.feature.md "Choose how
// Claude signs in", "API proxy settings are filled in from Claude Code's
// settings", "Sign in to Claude with an email"). Two ways: the claude.ai
// account the Claude CLI is signed in to, or an API proxy — a base url and a
// bearer token, prefilled from what Claude Code's own settings files and the
// environment already say, kept in the plugin's own stores (its section of
// settings.json for the url, its secret store for the token) and never
// written back into Claude Code's files.
//
// Claude Code applies the `env` block of ~/.claude/settings.json on top of
// the environment it is started with, so a value handed to the spawned
// process is not enough to steer it: the `--settings <json>` flag (the SDK's
// extraArgs) is what wins over every settings file, and an empty string there
// clears a value. Every Claude the app starts — the coding agent pane, the
// task estimate, self-fix — goes through claudeLaunch for that reason.
//
// Node APIs only — this module also runs under Electron.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "@specdriven/host";
import type { RunResult } from "@specdriven/host";
import { CLAUDE_BIN, claudeAvailable } from "./cli";
import { normalizeClaudeAuth, normalizeClaudeProxyUrl, type ClaudeAuthMode, type ClaudeSettingsValues } from "./settings";

type Env = Record<string, string | undefined>;

export class ClaudeAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The CLI's own config dir, where its user settings file lives. */
export function claudeConfigDir(env: Env = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** What Claude Code's settings and the environment say of a proxy. */
export interface DetectedProxy {
  url: string | null;
  /** "environment" or the settings file the url came from. */
  urlSource: string | null;
  token: string | null;
  tokenSource: string | null;
}

/**
 * The proxy Claude Code would use on its own: ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN from the environment it inherits, overridden by the
 * `env` block of each settings file it loads (settingSources: user, then
 * project, then local — the later one wins).
 */
export async function detectClaudeProxy(
  cwd: string,
  env: Env = process.env,
  configDir: string = claudeConfigDir(env),
): Promise<DetectedProxy> {
  const found: DetectedProxy = {
    url: env.ANTHROPIC_BASE_URL || null,
    urlSource: env.ANTHROPIC_BASE_URL ? "environment" : null,
    token: env.ANTHROPIC_AUTH_TOKEN || null,
    tokenSource: env.ANTHROPIC_AUTH_TOKEN ? "environment" : null,
  };
  for (const file of [
    join(configDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ]) {
    try {
      const block = (JSON.parse(await readFile(file, "utf8")) as { env?: Record<string, unknown> })?.env;
      if (!block || typeof block !== "object") continue;
      const url = block.ANTHROPIC_BASE_URL;
      if (typeof url === "string" && url) {
        found.url = url;
        found.urlSource = file;
      }
      const token = block.ANTHROPIC_AUTH_TOKEN;
      if (typeof token === "string" && token) {
        found.token = token;
        found.tokenSource = file;
      }
    } catch {
      // Missing or unreadable settings add nothing.
    }
  }
  return found;
}

/** The environment a Claude the app starts inherits. */
export function claudeProcessEnv(env: Env = process.env): Env {
  // A dev server started from inside a Claude Code terminal inherits the
  // marker that makes a nested `claude` refuse to start; the chat is not
  // nested in any sense that matters.
  const copy: Env = { ...env };
  delete copy.CLAUDECODE;
  delete copy.CLAUDE_CODE_ENTRYPOINT;
  return copy;
}

/** The sign-in as settled for one launch: the mode, and the proxy it uses. */
export interface EffectiveClaudeAuth {
  mode: ClaudeAuthMode;
  /** True when no mode is stored and this one was inferred. */
  inferred: boolean;
  /** The proxy a proxy-mode launch goes through; null in login mode, or
      when proxy mode has no url anywhere. */
  proxy: { url: string; token: string | null } | null;
  detected: DetectedProxy;
  /** The url settings.json holds, if any. */
  storedUrl: string | null;
  /** Whether the app's own token store holds a token. */
  storedToken: boolean;
}

export async function effectiveClaudeAuth(
  own: ClaudeSettingsValues,
  cwd: string,
  /** The token the plugin's secret store holds, or null. */
  storedToken: string | null,
  env: Env = process.env,
): Promise<EffectiveClaudeAuth> {
  const detected = await detectClaudeProxy(cwd, env);
  const chosen = normalizeClaudeAuth(own.claudeAuth);
  const mode = chosen ?? (detected.url ? "proxy" : "login");
  const storedUrl = normalizeClaudeProxyUrl(own.claudeProxyUrl);
  const url = storedUrl ?? detected.url;
  const token = storedToken ?? detected.token;
  return {
    mode,
    inferred: chosen === null,
    proxy: mode === "proxy" && url ? { url, token } : null,
    detected,
    storedUrl,
    storedToken: storedToken !== null,
  };
}

/** What a Claude the app starts is given: its environment and CLI flags. */
export interface ClaudeLaunch {
  mode: ClaudeAuthMode;
  env: Env;
  /** The SDK's extraArgs: `--settings <json>` when the sign-in needs it. */
  extraArgs: Record<string, string>;
  /** Where the API calls go when the app moved them; undefined otherwise. */
  apiBaseUrl: string | undefined;
}

/** The launch for a settled sign-in — pure, so a test can check it. */
export function launchFor(auth: EffectiveClaudeAuth, env: Env = process.env): ClaudeLaunch {
  const processEnv = claudeProcessEnv(env);
  if (auth.mode === "login") {
    // The claude.ai login and nothing else: a proxy or key the settings
    // files or environment carry would pre-empt it.
    delete processEnv.ANTHROPIC_BASE_URL;
    delete processEnv.ANTHROPIC_AUTH_TOKEN;
    delete processEnv.ANTHROPIC_API_KEY;
    const settings = { env: { ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "" } };
    return { mode: "login", env: processEnv, extraArgs: { settings: JSON.stringify(settings) }, apiBaseUrl: undefined };
  }
  if (!auth.proxy) {
    // Proxy mode with no url anywhere: Claude Code is left to its own config.
    return { mode: "proxy", env: processEnv, extraArgs: {}, apiBaseUrl: undefined };
  }
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: auth.proxy.url,
      // The bearer token is the proxy's credential; an API key would win
      // over it, so one in the environment is cleared alongside.
      ...(auth.proxy.token ? { ANTHROPIC_AUTH_TOKEN: auth.proxy.token, ANTHROPIC_API_KEY: "" } : {}),
    },
  };
  return { mode: "proxy", env: processEnv, extraArgs: { settings: JSON.stringify(settings) }, apiBaseUrl: auth.proxy.url };
}

/** The launch every Claude the app starts gets, from the plugin's settings and token. */
export async function claudeLaunch(
  own: ClaudeSettingsValues,
  cwd: string,
  storedToken: string | null,
  env: Env = process.env,
): Promise<ClaudeLaunch> {
  return launchFor(await effectiveClaudeAuth(own, cwd, storedToken, env), env);
}

// ---------------------------------------------------------------------------
// The claude.ai login: what `claude auth status` says, `claude auth login`
// driven from Settings, `claude auth logout`.

export interface LoginStatus {
  loggedIn: boolean;
  /** Claude Code's authMethod: "claude.ai", "api_key", "none"; "missing"
      without a CLI, "unknown" when its answer made no sense. */
  method: string;
  email: string | null;
}

export type Runner = (cmd: string, args: string[], options?: { env?: Env }) => Promise<RunResult>;

/** Claude Code's `auth status --json`, as a LoginStatus. */
export function parseLoginStatus(stdout: string): LoginStatus {
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown };
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return {
      loggedIn: parsed.loggedIn === true,
      method: typeof parsed.authMethod === "string" && parsed.authMethod ? parsed.authMethod : "none",
      email: typeof parsed.email === "string" && parsed.email ? parsed.email : null,
    };
  } catch {
    return { loggedIn: false, method: "unknown", email: null };
  }
}

export async function loginStatus(runner: Runner = run): Promise<LoginStatus> {
  if (!claudeAvailable()) return { loggedIn: false, method: "missing", email: null };
  // The account alone: a key in the environment would read as a login,
  // and the account sign-in sets it aside anyway (launchFor). The CLI's
  // `auth status` takes no --settings, so a key in a settings file still
  // shows — as "api_key", which the page explains.
  const env = claudeProcessEnv();
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const result = await runner(CLAUDE_BIN, ["auth", "status", "--json"], { env });
  if (result.exitCode !== 0 && !result.stdout.trim()) return { loggedIn: false, method: "unknown", email: null };
  return parseLoginStatus(result.stdout);
}

/** A sign-in started from Settings, as the page polls it. */
export interface LoginState {
  inProgress: boolean;
  email: string;
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

export interface LoginDeps {
  spawn?: typeof nodeSpawn;
  status?: () => Promise<LoginStatus>;
  /** How often the login is checked for (ms). */
  pollMs?: number;
  /** How long the browser gets before the sign-in is given up (ms). */
  timeoutMs?: number;
  /** How long to wait for the CLI to print its url before answering (ms). */
  urlWaitMs?: number;
}

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_MS = 2000;
const URL_WAIT_MS = 1500;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicState(f: LoginFlow): LoginState {
  return { inProgress: f.inProgress, email: f.email, url: f.url, done: f.done, error: f.error };
}

/** The sign-in under way or last finished, or null when none was started. */
export function loginState(): LoginState | null {
  return flow ? publicState(flow) : null;
}

function finish(f: LoginFlow, error: string | null): void {
  if (!f.inProgress) return;
  f.inProgress = false;
  f.done = error === null;
  f.error = error;
  if (f.timer) clearTimeout(f.timer);
  if (f.poll) clearTimeout(f.poll);
  f.timer = null;
  f.poll = null;
  const child = f.child;
  f.child = null;
  if (child && child.exitCode === null) child.kill();
  for (const wake of f.urlWaiters.splice(0)) wake();
}

/**
 * Start `claude auth login --email <email>`: the CLI opens the browser and
 * prints the sign-in page's url (kept for the page, for when it could not);
 * the sign-in is done once `claude auth status` says so. One at a time.
 */
export async function startLogin(email: string, deps: LoginDeps = {}): Promise<LoginState> {
  const address = email.trim();
  if (!EMAIL.test(address)) throw new ClaudeAuthError("Enter the email of your Claude account", 400);
  if (flow?.inProgress) throw new ClaudeAuthError("A sign-in is already in progress", 409);
  if (!claudeAvailable()) throw new ClaudeAuthError("The Claude CLI is not on PATH", 502);
  const status = deps.status ?? (() => loginStatus());
  const f: LoginFlow = {
    inProgress: true,
    email: address,
    url: null,
    done: false,
    error: null,
    child: null,
    output: [],
    timer: null,
    poll: null,
    urlWaiters: [],
  };
  flow = f;
  let child: ChildProcess;
  try {
    child = (deps.spawn ?? nodeSpawn)(CLAUDE_BIN, ["auth", "login", "--email", address], {
      env: claudeProcessEnv() as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    finish(f, `Could not start the Claude CLI: ${(e as Error).message}`);
    return publicState(f);
  }
  f.child = child;
  const onData = (data: Buffer | string) => {
    const text = String(data);
    f.output = [...f.output, ...text.split("\n").filter((l) => l.trim())].slice(-20);
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
  child.on("error", (e) => finish(f, `Could not start the Claude CLI: ${e.message}`));
  child.on("exit", (code) => {
    if (!f.inProgress) return;
    // The CLI returns once the browser has come back — or gave up.
    void status().then((s) => {
      if (!f.inProgress) return;
      if (s.loggedIn) finish(f, null);
      else finish(f, `Sign-in ended without a login (exit ${code ?? "?"})${f.output.length ? `: ${f.output.slice(-2).join(" ")}` : ""}`);
    });
  });
  const pollMs = deps.pollMs ?? LOGIN_POLL_MS;
  const check = async () => {
    if (!f.inProgress) return;
    try {
      if ((await status()).loggedIn) return finish(f, null);
    } catch {
      // Ask again next time.
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
  if (flow?.inProgress) finish(flow, "Sign-in cancelled");
  return loginState();
}

/** Stop and forget any sign-in, as if none was ever started (tests). */
export function resetLogin(): void {
  cancelLogin();
  flow = null;
}

/** `claude auth logout` — also drops any sign-in under way. */
export async function logout(runner: Runner = run): Promise<void> {
  cancelLogin();
  if (!claudeAvailable()) throw new ClaudeAuthError("The Claude CLI is not on PATH", 502);
  const result = await runner(CLAUDE_BIN, ["auth", "logout"], { env: claudeProcessEnv() });
  if (result.exitCode !== 0) {
    throw new ClaudeAuthError(`Could not sign out: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`, 502);
  }
}

// ---------------------------------------------------------------------------
// The proxy: is it there, and does it take the token?

export type ProxyCheck = "ok" | "unauthorized" | "unreachable" | "unexpected";

/**
 * One request the API answers cheaply — GET /v1/models — with the token the
 * way Claude Code would send it (bearer, and as the key header too).
 */
export async function checkProxy(
  url: string,
  token: string | null,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<{ result: ProxyCheck; detail: string }> {
  let target: URL;
  try {
    target = new URL("v1/models", url.endsWith("/") ? url : `${url}/`);
  } catch {
    return { result: "unreachable", detail: "Not a url" };
  }
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers["x-api-key"] = token;
  }
  try {
    const res = await fetchFn(target, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { result: "ok", detail: token ? "Reachable, and the token was accepted" : "Reachable" };
    if (res.status === 401 || res.status === 403) {
      return { result: "unauthorized", detail: token ? `The proxy refused the token (HTTP ${res.status})` : `The proxy wants a token (HTTP ${res.status})` };
    }
    return { result: "unexpected", detail: `Reachable, but it answered HTTP ${res.status}` };
  } catch (e) {
    const message = (e as Error).name === "TimeoutError" ? "no answer in time" : (e as Error).message;
    return { result: "unreachable", detail: `Could not reach ${target.origin}: ${message}` };
  }
}
