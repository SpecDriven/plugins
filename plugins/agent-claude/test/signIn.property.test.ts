// Property-based tests (Hegel) for how the app's Claude signs in
// (specs/agents/claude.feature.md "Choose how Claude signs in", "API proxy
// settings are filled in from Claude Code's settings", in the specs repo):
// the proxy Claude Code's own settings name, the mode inferred from it, the
// launch each mode gets, the plugin's settings patches, what
// `claude auth status` says, the proxy check and the model lists either
// sign-in offers. The routes, switching and plugin reloads as a sequence of
// steps are in signInMachine.property.test.ts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { applyPluginPatch } from "@specdriven/app/src/plugins/host/pluginSettings";
import {
  ACCOUNT_SETTINGS,
  LOGIN_SETS_ASIDE,
  cancelLogin,
  checkProxy,
  claudeProcessEnv,
  detectClaudeProxy,
  effectiveClaudeAuth,
  launchFor,
  onSignInChange,
  parseLoginStatus,
  resetLogin,
  startLogin,
  type EffectiveClaudeAuth,
} from "../src/auth";
import { accountModels, accountModelsOf, forgetAccountModels, modelFamily, type AccountProbe } from "../src/accountModels";
import { fetchProxyModels, proxyModelsOf } from "../src/proxyModels";
import {
  CLAUDE_EFFORTS,
  DEFAULT_AGENT_FIRST_RESPONSE_SECONDS,
  claudeSettingsOf,
  claudeSettingsPatch,
  normalizeAgentFirstResponseSeconds,
  normalizeClaudeProxyUrl,
  normalizeDefaultModel,
} from "../src/settings";

type Env = Record<string, string | undefined>;

const PURE = { testCases: 1000 };
const FILES = { testCases: 300 };
const SLOW = 60_000;

// --- generators -------------------------------------------------------------

/** Anything a JSON settings value could be. */
const jsonValue = gs.oneOf<unknown>(
  gs.just(null),
  gs.booleans(),
  gs.integers({ minValue: -100, maxValue: 100 }),
  gs.text({ maxSize: 20 }),
  gs.arrays(gs.text({ maxSize: 5 }), { maxSize: 2 }),
);

/** A proxy url as people type them: real urls, near misses, junk. */
const urlish = gs.oneOf(
  gs.urls(),
  gs.sampledFrom([
    "http://localhost:6655/anthropic/",
    "https://proxy.test",
    " http://padded.test:9/ ",
    "localhost:6655",
    "ftp://proxy.test/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://",
    "",
    "   ",
  ]),
  gs.text({ maxSize: 30 }),
);

/** An env value: absent, empty or something. */
const envValue = gs.oneOf<string | undefined>(gs.just(undefined), gs.just(""), urlish, gs.text({ minSize: 1, maxSize: 20 }));

/** A settings file: missing, not JSON, JSON with or without an `env` block. */
type SettingsFile =
  | { kind: "missing" }
  | { kind: "garbage"; text: string }
  | { kind: "json"; env: unknown };
const settingsFile = gs.oneOf<SettingsFile>(
  gs.just({ kind: "missing" }),
  gs.text({ maxSize: 20 }).map((text) => ({ kind: "garbage", text })),
  gs.oneOf<unknown>(
    jsonValue,
    gs.record({ ANTHROPIC_BASE_URL: gs.oneOf<unknown>(urlish, jsonValue), ANTHROPIC_AUTH_TOKEN: gs.oneOf<unknown>(gs.text({ maxSize: 20 }), jsonValue) }),
    gs.record({ ANTHROPIC_BASE_URL: gs.oneOf<unknown>(urlish, jsonValue) }),
    gs.record({ ANTHROPIC_AUTH_TOKEN: gs.oneOf<unknown>(gs.text({ maxSize: 20 }), jsonValue) }),
  ).map((env) => ({ kind: "json", env })),
);

const authMode = gs.sampledFrom([null, "login", "proxy"] as const);

/** A plugin section as settings.json may hold it, valid or not. */
const section = gs.record({
  claudeAuth: gs.oneOf<unknown>(authMode, jsonValue),
  claudeProxyUrl: gs.oneOf<unknown>(urlish, jsonValue),
  agentFirstResponseSeconds: gs.oneOf<unknown>(
    gs.integers({ minValue: -5, maxValue: 600 }),
    gs.floats({ allowNan: true, allowInfinity: true }),
    jsonValue,
  ),
  defaultModel: gs.oneOf<unknown>(gs.sampledFrom(["opus", "sonnet", " sonnet ", "claude-opus-4-5[1m]", "two words", ""]), gs.text({ maxSize: 20 }), jsonValue),
  defaultEffort: gs.oneOf<unknown>(gs.sampledFrom([...CLAUDE_EFFORTS]), jsonValue),
});

/** An environment with the variables the sign-in cares about, and others. */
const environment = gs.composite<Env>((tc) => {
  const env: Env = {};
  for (const name of [...LOGIN_SETS_ASIDE, "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const value = tc.draw(envValue);
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of tc.draw(gs.maps(gs.fromRegex("^[A-Z][A-Z0-9_]{0,10}$", { fullmatch: true }), gs.text({ maxSize: 10 }), { maxSize: 3 }))) {
    env[name] ??= value;
  }
  return env;
});

// --- Claude Code's own settings files ----------------------------------------

let dir: string;
let configDir: string;
let cwd: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-claude-props-"));
  configDir = join(dir, "config");
  cwd = join(dir, "project");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(cwd, ".claude"), { recursive: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FILE_PATHS = () => [join(configDir, "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")];

async function writeSettingsFiles(files: SettingsFile[]): Promise<void> {
  await Promise.all(
    FILE_PATHS().map((path, i) => {
      const file = files[i]!;
      if (file.kind === "missing") return rm(path, { force: true });
      return writeFile(path, file.kind === "garbage" ? file.text : JSON.stringify({ env: file.env }));
    }),
  );
}

/** What Claude Code itself would make of the environment and the files:
    each later source overrides a value with a non-empty string. */
function expectedDetection(env: Env, files: SettingsFile[]) {
  let url = env.ANTHROPIC_BASE_URL || null;
  let urlSource: string | null = url ? "environment" : null;
  let token = env.ANTHROPIC_AUTH_TOKEN || null;
  let tokenSource: string | null = token ? "environment" : null;
  FILE_PATHS().forEach((path, i) => {
    const file = files[i]!;
    if (file.kind !== "json" || !file.env || typeof file.env !== "object") return;
    const block = file.env as Record<string, unknown>;
    if (typeof block.ANTHROPIC_BASE_URL === "string" && block.ANTHROPIC_BASE_URL) {
      url = block.ANTHROPIC_BASE_URL;
      urlSource = path;
    }
    if (typeof block.ANTHROPIC_AUTH_TOKEN === "string" && block.ANTHROPIC_AUTH_TOKEN) {
      token = block.ANTHROPIC_AUTH_TOKEN;
      tokenSource = path;
    }
  });
  return { url, urlSource, token, tokenSource };
}

test(
  "the detected proxy is the environment overridden by user, then project, then local settings",
  () =>
    hegel.testAsync(async (tc) => {
      const env = tc.draw(environment);
      const files = [tc.draw(settingsFile), tc.draw(settingsFile), tc.draw(settingsFile)];
      await writeSettingsFiles(files);
      expect(await detectClaudeProxy(cwd, env, configDir)).toEqual(expectedDetection(env, files));
    }, FILES),
  SLOW,
);

test(
  "the effective sign-in: a stored mode wins, else a detected url means the proxy; the plugin's url and token win over detected ones",
  () =>
    hegel.testAsync(async (tc) => {
      const env = { ...tc.draw(environment), CLAUDE_CONFIG_DIR: configDir };
      const files = [tc.draw(settingsFile), tc.draw(settingsFile), tc.draw(settingsFile)];
      await writeSettingsFiles(files);
      const own = claudeSettingsOf(tc.draw(section));
      const stored = tc.draw(gs.optional(gs.text({ minSize: 1, maxSize: 20 })));
      const auth = await effectiveClaudeAuth(own, cwd, stored, env);
      const detected = expectedDetection(env, files);

      const mode = own.claudeAuth ?? (detected.url ? "proxy" : "login");
      expect(auth.mode).toBe(mode);
      expect(auth.inferred).toBe(own.claudeAuth === null);
      expect(auth.storedUrl).toBe(own.claudeProxyUrl);
      expect(auth.storedToken).toBe(stored !== null);
      const url = own.claudeProxyUrl ?? detected.url;
      expect(auth.proxy).toEqual(mode === "proxy" && url ? { url, token: stored ?? detected.token } : null);
    }, FILES),
  SLOW,
);

// --- the launch each sign-in gets ----------------------------------------------

/** What the account sign-in sets aside: the proxy and keys, and the proxy's model names. */
const SIGN_IN_VARS: readonly string[] = LOGIN_SETS_ASIDE;
const NESTING_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

const detectedProxy = gs.record({
  url: gs.optional(urlish),
  urlSource: gs.optional(gs.text({ maxSize: 10 })),
  token: gs.optional(gs.text({ maxSize: 10 })),
  tokenSource: gs.optional(gs.text({ maxSize: 10 })),
});

/** A settled sign-in, built directly rather than detected. */
const settled = (mode: "login" | "proxy" | null) =>
  gs.composite<EffectiveClaudeAuth>((tc) => {
    const m = mode ?? tc.draw(gs.sampledFrom(["login", "proxy"] as const));
    const proxy = m === "proxy" ? tc.draw(gs.optional(gs.record({ url: gs.text({ minSize: 1, maxSize: 30 }), token: gs.optional(gs.text({ minSize: 1, maxSize: 20 })) }))) : null;
    return {
      mode: m,
      inferred: tc.draw(gs.booleans()),
      proxy,
      detected: tc.draw(detectedProxy),
      storedUrl: tc.draw(gs.optional(urlish)),
      storedToken: tc.draw(gs.booleans()),
    };
  });

test("every launch drops the markers that make a nested claude refuse to start, keeps every other variable, and leaves the app's environment alone", () =>
  hegel.test((tc) => {
    const env = tc.draw(environment);
    const before = { ...env };
    const launch = launchFor(tc.draw(settled(null)), env);
    expect(env).toEqual(before);
    for (const name of NESTING_VARS) expect(launch.env).not.toHaveProperty(name);
    for (const [name, value] of Object.entries(env)) {
      if (NESTING_VARS.includes(name)) continue;
      if (launch.mode === "login" && SIGN_IN_VARS.includes(name)) continue;
      expect(launch.env[name]).toBe(value);
    }
  }, PURE));

test("the account sign-in sets every proxy, key and proxy model name aside, in the environment and through --settings", () =>
  hegel.test((tc) => {
    const env = tc.draw(environment);
    const launch = launchFor(tc.draw(settled("login")), env);
    for (const name of SIGN_IN_VARS) expect(launch.env).not.toHaveProperty(name);
    expect(launch.extraArgs).toEqual({ settings: ACCOUNT_SETTINGS });
    expect(JSON.parse(ACCOUNT_SETTINGS)).toEqual({ env: Object.fromEntries(SIGN_IN_VARS.map((name) => [name, ""])) });
    for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"]) {
      expect(SIGN_IN_VARS).toContain(name);
    }
    expect(launch.apiBaseUrl).toBeUndefined();
  }, PURE));

test("the proxy sign-in names its url through --settings, and its token with any API key cleared", () =>
  hegel.test((tc) => {
    const env = tc.draw(environment);
    const auth = tc.draw(settled("proxy"));
    const launch = launchFor(auth, env);
    expect(launch.mode).toBe("proxy");
    expect(launch.env).toEqual(claudeProcessEnv(env));
    if (!auth.proxy) {
      // No url anywhere: Claude Code is left to its own config.
      expect(launch.extraArgs).toEqual({});
      expect(launch.apiBaseUrl).toBeUndefined();
      return;
    }
    expect(launch.apiBaseUrl).toBe(auth.proxy.url);
    expect(Object.keys(launch.extraArgs)).toEqual(["settings"]);
    expect(JSON.parse(launch.extraArgs.settings!)).toEqual({
      env: auth.proxy.token
        ? { ANTHROPIC_BASE_URL: auth.proxy.url, ANTHROPIC_AUTH_TOKEN: auth.proxy.token, ANTHROPIC_API_KEY: "" }
        : { ANTHROPIC_BASE_URL: auth.proxy.url },
    });
  }, PURE));

// --- the plugin's own settings --------------------------------------------------

/** The section after a patch, as the app's HostConfig.settings.write applies it. */
function applied(before: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const state = { pluginSettings: { "agent-claude": { ...before } } } as unknown as Parameters<typeof applyPluginPatch>[0];
  return applyPluginPatch(state, "agent-claude", patch);
}

/** The section's entries with undefined values gone, as JSON would keep them. */
const stored = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));

test("putting back what GET /api/claude/settings answered changes nothing the plugin reads", () =>
  hegel.test((tc) => {
    const before = stored(tc.draw(section));
    const read = claudeSettingsOf(before);
    const parsed = claudeSettingsPatch(read);
    if ("error" in parsed) throw new Error(`the plugin's own answer was refused: ${parsed.error}`);
    expect(claudeSettingsOf(applied(before, parsed.patch))).toEqual(read);
  }, PURE));

/** One field of a PUT body: a valid value, a near miss, or something else entirely. */
const field = {
  claudeAuth: gs.oneOf<unknown>(authMode, gs.sampledFrom(["Login", "PROXY", "ldap", "", 1, true]), jsonValue),
  claudeProxyUrl: gs.oneOf<unknown>(gs.just(null), urlish, jsonValue),
  firstResponseSeconds: gs.oneOf<unknown>(
    gs.integers({ minValue: -3, maxValue: 600 }),
    gs.floats({ allowNan: true, allowInfinity: true }),
    gs.just(DEFAULT_AGENT_FIRST_RESPONSE_SECONDS),
    jsonValue,
  ),
  defaultModel: gs.oneOf<unknown>(gs.just(null), gs.sampledFrom(["opus", " sonnet ", "claude-opus-4-5[1m]", "us.anthropic.claude-sonnet-4-5:0", "two words", ""]), gs.text({ maxSize: 20 }), jsonValue),
  defaultEffort: gs.oneOf<unknown>(gs.just(null), gs.sampledFrom([...CLAUDE_EFFORTS, "huge", "High"]), jsonValue),
};
type Field = keyof typeof field;
const FIELDS = Object.keys(field) as Field[];

/** The value a field reads back as once accepted, or "refused". */
function expectedField(name: Field, value: unknown): unknown {
  switch (name) {
    case "claudeAuth":
      return value === null || value === "login" || value === "proxy" ? value : "refused";
    case "claudeProxyUrl": {
      if (value === null) return null;
      if (typeof value !== "string") return "refused";
      const url = value.trim();
      if (!url) return null;
      try {
        return ["http:", "https:"].includes(new URL(url).protocol) ? url : "refused";
      } catch {
        return "refused";
      }
    }
    case "firstResponseSeconds":
      // Whole seconds, rounded down — but a fraction of a second is one,
      // never 0, which is "no limit".
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "refused";
      return value > 0 && value < 1 ? 1 : Math.floor(value);
    case "defaultModel": {
      if (value === null) return null;
      if (typeof value !== "string") return "refused";
      const model = value.trim();
      if (!model) return null;
      return /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/.test(model) ? model : "refused";
    }
    case "defaultEffort":
      return value === null || (CLAUDE_EFFORTS as readonly unknown[]).includes(value) ? value : "refused";
  }
}

test("a PUT body is taken whole or refused whole, and what it sets reads back as sent, trimmed", () =>
  hegel.test((tc) => {
    const before = stored(tc.draw(section));
    const names = tc.draw(gs.arrays(gs.sampledFrom(FIELDS), { minSize: 0, maxSize: FIELDS.length, unique: true }));
    const body: Record<string, unknown> = {};
    for (const name of names) body[name] = tc.draw(field[name]);
    const expected = Object.fromEntries(names.map((name) => [name, expectedField(name, body[name])]));
    const parsed = claudeSettingsPatch(body);
    if (names.length === 0 || Object.values(expected).includes("refused")) {
      expect(parsed).toHaveProperty("error");
      return;
    }
    if ("error" in parsed) throw new Error(`refused ${JSON.stringify(body)}: ${parsed.error}`);
    const after = applied(before, parsed.patch);
    const read = claudeSettingsOf(after);
    const untouched = claudeSettingsOf(before);
    for (const name of FIELDS) {
      expect(read[name] as unknown).toEqual(name in expected ? expected[name] : untouched[name]);
    }
    // The default wait is stored as no key at all.
    if (read.firstResponseSeconds === DEFAULT_AGENT_FIRST_RESPONSE_SECONDS && "firstResponseSeconds" in expected) {
      expect(after).not.toHaveProperty("agentFirstResponseSeconds");
    }
  }, PURE));

test("switching between the account and the proxy keeps the proxy's url, the wait, the model and the effort", () =>
  hegel.test((tc) => {
    const before = stored(tc.draw(section));
    const parsed = claudeSettingsPatch({ claudeAuth: tc.draw(authMode) });
    if ("error" in parsed) throw new Error(parsed.error);
    const { claudeAuth: _was, ...kept } = claudeSettingsOf(before);
    const { claudeAuth: _now, ...after } = claudeSettingsOf(applied(before, parsed.patch));
    expect(after).toEqual(kept);
  }, PURE));

test("a normalized proxy url is always http or https, and normalizes to itself", () =>
  hegel.test((tc) => {
    const normal = normalizeClaudeProxyUrl(tc.draw(gs.oneOf<unknown>(urlish, jsonValue)));
    if (normal === null) return;
    expect(["http:", "https:"]).toContain(new URL(normal).protocol);
    expect(normalizeClaudeProxyUrl(normal)).toBe(normal);
  }, PURE));

test("a normalized default model normalizes to itself", () =>
  hegel.test((tc) => {
    const model = normalizeDefaultModel(tc.draw(field.defaultModel));
    if (model !== null) expect(normalizeDefaultModel(model)).toBe(model);
  }, PURE));

test("the first-response wait reads as whole seconds, never negative, and normalizes to itself", () =>
  hegel.test((tc) => {
    const seconds = normalizeAgentFirstResponseSeconds(tc.draw(field.firstResponseSeconds));
    expect(Number.isInteger(seconds) && seconds >= 0).toBe(true);
    expect(normalizeAgentFirstResponseSeconds(seconds)).toBe(seconds);
  }, PURE));

// --- what `claude auth status --json` says --------------------------------------

test("any answer from claude auth status reads as a status; only loggedIn: true is a sign-in", () =>
  hegel.test((tc) => {
    const object = tc.draw(
      gs.record({
        loggedIn: gs.oneOf<unknown>(gs.booleans(), gs.sampledFrom(["true", 1, null]), jsonValue),
        authMethod: gs.oneOf<unknown>(gs.sampledFrom(["claude.ai", "api_key", "oauth_token", "none", ""]), jsonValue),
        email: gs.oneOf<unknown>(gs.emails(), gs.just(""), jsonValue),
      }),
    );
    const stdout = tc.draw(gs.oneOf(gs.just(JSON.stringify(object)), gs.text({ maxSize: 40 }), gs.sampledFrom(["null", "[]", "42", '"x"', ""])));
    const status = parseLoginStatus(stdout);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
      expect(status).toEqual({ loggedIn: false, method: "unknown", email: null });
      return;
    }
    const p = parsed as Record<string, unknown>;
    expect(status).toEqual({
      loggedIn: p.loggedIn === true,
      method: typeof p.authMethod === "string" && p.authMethod ? p.authMethod : "none",
      email: typeof p.email === "string" && p.email ? p.email : null,
    });
  }, PURE));

// --- the proxy ------------------------------------------------------------------

/** A proxy token: distinctive enough that finding it in a message means it leaked. */
const secret = gs.fromRegex("^sk-[A-Za-z0-9]{8,24}$", { fullmatch: true });

/** A fetch that answers with `status` and keeps what it was asked. */
function answering(status: number | "throw", seen: { url: string; headers: Record<string, string> }[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
    if (status === "throw") throw new Error("connection refused");
    return new Response("{}", { status });
  }) as typeof fetch;
}

const httpStatus = gs.oneOf(gs.integers({ minValue: 200, maxValue: 599 }), gs.sampledFrom([200, 204, 401, 403, 404, 500, 502]));

test(
  "Check proxy asks GET /v1/models under the url, with or without its trailing slash, and reads the status as ok, unauthorized or unexpected",
  () =>
    hegel.testAsync(async (tc) => {
      const base = tc.draw(gs.oneOf(gs.urls(), gs.sampledFrom(["http://localhost:6655/anthropic", "https://proxy.test/a/b/", "http://p.test/a?key=1", "http://p.test/a#x"])));
      const token = tc.draw(gs.optional(secret));
      const status = tc.draw(gs.oneOf<number | "throw">(httpStatus, gs.just("throw")));
      const seen: { url: string; headers: Record<string, string> }[] = [];
      const plain = await checkProxy(base.replace(/\/+$/, ""), token, answering(status, seen));
      const slashed = await checkProxy(`${base.replace(/\/+$/, "")}/`, token, answering(status, seen));
      expect(slashed).toEqual(plain);
      expect(seen).toHaveLength(2);
      expect(seen[0]!.url).toBe(seen[1]!.url);
      const target = new URL(seen[0]!.url);
      expect(target.pathname.endsWith("/v1/models")).toBe(true);
      expect(target.origin).toBe(new URL(base).origin);
      // Under the url's path — unless it has a query or fragment, which the
      // appended "/" lands in; Claude Code's SDK appends the API path to the
      // string, so no request url follows from such a base either.
      if (!/[?#]/.test(base)) expect(target.pathname.startsWith(new URL(`${base.replace(/\/+$/, "")}/`).pathname)).toBe(true);
      expect(seen[0]!.headers.authorization).toBe(token ? `Bearer ${token}` : undefined);
      expect(seen[0]!.headers["x-api-key"]).toBe(token ?? undefined);
      const expected =
        status === "throw" ? "unreachable" : status >= 200 && status < 300 ? "ok" : status === 401 || status === 403 ? "unauthorized" : "unexpected";
      expect(plain.result).toBe(expected);
      if (token) expect(plain.detail).not.toContain(token);
    }, PURE),
  SLOW,
);

test(
  "Check proxy never throws, whatever is typed as the url",
  () =>
    hegel.testAsync(async (tc) => {
      const url = tc.draw(urlish);
      const result = await checkProxy(url, null, answering(200, []));
      expect(["ok", "unauthorized", "unreachable", "unexpected"]).toContain(result.result);
    }, PURE),
  SLOW,
);

/** A model row as the API or Claude Code might hand it over. */
const modelId = gs.oneOf(
  gs.sampledFrom(["opus", "sonnet", "default", "claude-sonnet-4-6", "claude-opus-4-5[1m]", "two words", "", " opus "]),
  gs.fromRegex("^[a-z][a-z0-9-]{0,12}$", { fullmatch: true }),
  gs.text({ maxSize: 12 }),
);

const firstAppearances = (ids: unknown[]): string[] => {
  const out: string[] = [];
  for (const id of ids) {
    const value = normalizeDefaultModel(id);
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
};

test("a proxy's model list keeps each valid id once, in the order it first came, and at most 200", () =>
  hegel.test((tc) => {
    const rows = tc.draw(
      gs.arrays(
        gs.oneOf<unknown>(gs.record({ id: gs.oneOf<unknown>(modelId, jsonValue), display_name: gs.oneOf<unknown>(gs.text({ maxSize: 12 }), jsonValue) }), jsonValue),
        { maxSize: 30 },
      ),
    );
    const models = proxyModelsOf(rows);
    const ids = rows.map((r) => (r && typeof r === "object" ? (r as { id?: unknown }).id : undefined));
    expect(models.map((m) => m.value)).toEqual(firstAppearances(ids).slice(0, 200));
    for (const m of models) expect(m.displayName.length).toBeGreaterThan(0);
  }, PURE));

test(
  "a proxy's pages are read until it says there are no more, as one list",
  () =>
    hegel.testAsync(async (tc) => {
      const pages = tc.draw(
        gs.arrays(gs.arrays(modelId, { maxSize: 6 }), { minSize: 1, maxSize: 12 }),
      );
      const asked: URL[] = [];
      const fetchFn = (async (input: string | URL) => {
        const url = new URL(String(input));
        asked.push(url);
        const after = url.searchParams.get("after_id");
        const index = after === null ? 0 : Number(after.slice("page-".length)) + 1;
        const page = pages[index] ?? [];
        return Response.json({ data: page.map((id) => ({ id })), has_more: index < pages.length - 1, last_id: `page-${index}` });
      }) as typeof fetch;
      const models = await fetchProxyModels("http://proxy.test/x", null, fetchFn);
      // Ten pages at most, and no further page once 200 models are in.
      const read: unknown[] = [];
      let i = 0;
      for (; i < Math.min(pages.length, 10); i++) {
        read.push(...pages[i]!);
        if (firstAppearances(read).length >= 200) break;
      }
      expect(models.map((m) => m.value)).toEqual(firstAppearances(read).slice(0, 200));
      expect(asked.length).toBe(Math.min(pages.length, 10));
      for (const url of asked) expect(url.pathname).toBe("/x/v1/models");
    }, PURE),
  SLOW,
);

test("a proxy that refuses the token or answers an error status lists nothing and says why", () =>
  hegel.testAsync(async (tc) => {
    const status = tc.draw(gs.integers({ minValue: 300, maxValue: 599 }));
    const token = tc.draw(gs.optional(secret));
    let error: Error | null = null;
    try {
      await fetchProxyModels("http://proxy.test/", token, answering(status, []));
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain(`HTTP ${status}`);
    if (token) expect(error!.message).not.toContain(token);
  }, PURE));

/** The first value of each model family, in order; a value with no family stands alone. */
const firstPerFamily = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const family = modelFamily(value);
    if (family === null) return true;
    if (seen.has(family)) return false;
    seen.add(family);
    return true;
  });
};

test("the account's model menu keeps one valid model per family, the first listed, and its efforts are Claude's levels in order", () =>
  hegel.test((tc) => {
    const rows = tc.draw(
      gs.arrays(
        gs.oneOf<unknown>(
          gs.record({
            value: gs.oneOf<unknown>(modelId, jsonValue),
            resolvedModel: gs.oneOf<unknown>(modelId, jsonValue),
            displayName: gs.oneOf<unknown>(gs.text({ maxSize: 12 }), jsonValue),
            supportsEffort: gs.oneOf<unknown>(gs.booleans(), jsonValue),
            supportedEffortLevels: gs.oneOf<unknown>(gs.arrays(gs.sampledFrom([...CLAUDE_EFFORTS, "huge", 3]), { maxSize: 7 }), jsonValue),
          }),
          jsonValue,
        ),
        { maxSize: 20 },
      ),
    );
    const models = accountModelsOf(rows);
    const values_ = rows.map((r) => (r && typeof r === "object" ? (r as { value?: unknown }).value : undefined));
    expect(models.map((m) => m.value)).toEqual(firstPerFamily(firstAppearances(values_)));
    for (const m of models) {
      const row = rows.find((r) => r && typeof r === "object" && normalizeDefaultModel((r as { value?: unknown }).value) === m.value) as Record<string, unknown>;
      if (row.supportsEffort === false) expect(m.efforts).toEqual([]);
      else if (Array.isArray(row.supportedEffortLevels)) expect(m.efforts).toEqual(CLAUDE_EFFORTS.filter((e) => (row.supportedEffortLevels as unknown[]).includes(e)));
      else expect(m.efforts).toBeUndefined();
      if (m.resolvedModel !== undefined) expect(normalizeDefaultModel(m.resolvedModel)).toBe(m.resolvedModel);
    }
  }, PURE));

// --- the models kept per sign-in ---------------------------------------------------

test(
  "the models are asked for once per sign-in however many ask at once, kept until it changes, and a failed ask is not kept",
  () =>
    hegel.testAsync(async (tc) => {
      forgetAccountModels();
      let asks = 0;
      let answers = 0;
      /** The answer kept, and the sign-in it is for, as the model sees it. */
      let kept: { key: string; n: number } | null = null;
      const answerOf = (n: number): AccountProbe => ({ account: null, models: [{ value: `m${n}`, displayName: "", description: "" }] });
      const served = (n: number) => ({ status: "fulfilled" as const, value: answerOf(n) });
      const steps = tc.draw(
        gs.arrays(gs.sampledFrom(["ask", "askTogether", "forget", "fail", "switchWhileAsking"] as const), { minSize: 1, maxSize: 15 }),
      );
      for (const step of steps) {
        if (step === "forget") {
          forgetAccountModels();
          kept = null;
          continue;
        }
        const key = tc.draw(gs.sampledFrom(["login", "proxy\nhttp://a/\nsk-a", "proxy\nhttp://b/\n"]));
        if (step === "switchWhileAsking") {
          // An answer still on its way when the sign-in changed: it is
          // not kept, and the new sign-in gets an answer of its own.
          tc.assume(kept?.key !== key);
          const other = tc.draw(gs.sampledFrom(["login", "proxy\nhttp://a/\nsk-a", "proxy\nhttp://b/\n"]));
          tc.assume(other !== key && kept?.key !== other);
          let land!: () => void;
          const slow = accountModels(async () => {
            asks++;
            const n = ++answers;
            await new Promise<void>((r) => (land = r));
            return answerOf(n);
          }, Date.now(), key);
          const fresh = accountModels(async () => {
            asks++;
            return answerOf(++answers);
          }, Date.now(), other);
          const freshN = answers;
          const first = await Promise.race([fresh, new Promise((r) => setTimeout(() => r("still waiting for the other sign-in's answer"), 200))]);
          land();
          await slow;
          expect(first).toEqual(answerOf(freshN));
          kept = { key: other, n: freshN };
          const asksBefore = asks;
          expect(await accountModels(async () => answerOf(-1), Date.now(), other)).toEqual(answerOf(freshN));
          expect(asks).toBe(asksBefore);
          continue;
        }
        const fail = step === "fail";
        const ask = async (): Promise<AccountProbe> => {
          asks++;
          await Promise.resolve();
          if (fail) throw new Error("Claude Code exited");
          return answerOf(++answers);
        };
        const callers = step === "askTogether" ? tc.draw(gs.integers({ minValue: 2, maxValue: 5 })) : 1;
        const asksBefore = asks;
        const results = await Promise.allSettled(Array.from({ length: callers }, () => accountModels(ask, Date.now(), key)));
        if (kept?.key === key) {
          expect(asks).toBe(asksBefore);
          for (const r of results) expect(r).toEqual(served(kept.n));
          continue;
        }
        expect(asks).toBe(asksBefore + 1);
        if (fail) {
          for (const r of results) expect(r.status).toBe("rejected");
        } else {
          kept = { key, n: answers };
          for (const r of results) expect(r).toEqual(served(kept.n));
        }
      }
      forgetAccountModels();
    }, PURE),
  SLOW,
);

// --- found by this suite, and fixed ----------------------------------------------

// specs/agents/claude.feature.md S1: the token is "never shown on the page,
// and never sent back to it". A token with a space, a line break or a
// letter outside ASCII in it — a pasted "Bearer sk-…", say — made fetch
// refuse the header and quote it, in Check proxy's `detail` and GET
// /api/claude/models' `error`, both shown on the page.
test(
  "a pasted token never comes back in Check proxy's words or the model list's error, whatever it holds",
  async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: [], has_more: false }) });
    try {
      await hegel.testAsync(async (tc) => {
        // As POST /api/claude/token stores it: trimmed, at most 1024 long.
        const token = `sk-${tc.draw(gs.text({ minSize: 8, maxSize: 40 }))}`.trim();
        const url = `http://127.0.0.1:${server.port}/`;
        const check = await checkProxy(url, token);
        expect(check.detail).not.toContain(token);
        const listed = await fetchProxyModels(url, token).then(
          () => "",
          (e: Error) => e.message,
        );
        expect(listed).not.toContain(token);
      }, FILES);
    } finally {
      server.stop(true);
    }
  },
  SLOW,
);

test(
  "whatever a failed request says, Check proxy and the model list say it without the token",
  () =>
    hegel.testAsync(async (tc) => {
      const token = tc.draw(secret);
      const words = tc.draw(gs.arrays(gs.oneOf(gs.text({ maxSize: 10 }), gs.just(token)), { minSize: 1, maxSize: 4 })).join(" ");
      const failing = (async () => {
        throw new Error(words);
      }) as unknown as typeof fetch;
      expect((await checkProxy("http://proxy.test/", token, failing)).detail).not.toContain(token);
      const listed = await fetchProxyModels("http://proxy.test/", token, failing).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(listed).not.toContain(token);
    }, PURE),
  SLOW,
);

// src/settings.ts: 0 is "no limit". A wait of half a second floored to 0,
// so asking for a very short wait switched the watchdog off.
test("a positive first-response wait never reads back as no limit", () =>
  hegel.test((tc) => {
    const seconds = tc.draw(gs.floats({ minValue: 0, excludeMin: true, allowInfinity: false, allowNan: false }));
    const parsed = claudeSettingsPatch({ firstResponseSeconds: seconds });
    if ("error" in parsed) return;
    expect(claudeSettingsOf(applied({}, parsed.patch)).firstResponseSeconds).toBeGreaterThan(0);
  }, PURE));

// specs/agents/claude.feature.md S11: "Claude Code is not set up" gives way
// once the sign-in fetched it. A sign-in cancelled while Claude Code was
// still downloading never said so when the download landed, though Claude
// Code is there from then on (src/auth.ts LoginFlow.fetched).
test(
  "Claude Code fetched for a sign-in tells the app it is there, even when the sign-in was cancelled meanwhile",
  () =>
    hegel.testAsync(async (tc) => {
      const cancelFirst = tc.draw(gs.booleans());
      let land!: (path: string) => void;
      const download = new Promise<string>((resolve) => (land = resolve));
      let notices = 0;
      const off = onSignInChange(() => notices++);
      try {
        await startLogin("ada@example.com", {
          executable: () => null,
          canFetchBinary: () => true,
          fetchBinary: () => download,
          // What becomes of the sign-in itself does not matter here.
          spawn: (() => {
            throw new Error("no CLI in this test");
          }) as never,
        });
        if (cancelFirst) cancelLogin();
        land("/fetched/claude");
        await download;
        await new Promise((r) => setTimeout(r, 0));
        tc.note(`cancelled before the download landed: ${cancelFirst}`);
        expect(notices).toBe(1);
      } finally {
        off();
        resetLogin();
      }
    }, { testCases: 20 }),
  SLOW,
);
