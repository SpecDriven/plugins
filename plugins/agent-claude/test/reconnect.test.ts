// Automates specs/agents/agent-pane.feature.md S14 "Switching folders tries
// the agent's API again" for Claude: the provider's reconnect checks the
// proxy a session in the folder would use, tries an unreachable one a few
// times, and says whether it answered; an account sign-in has nothing to try.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyCheck } from "../src/auth";
import { RECONNECT_PAUSE_MS, RECONNECT_TRIES, reconnectProxy, withReconnect, type ReconnectDeps } from "../src/reconnect";
import { claudeSettingsOf } from "../src/settings";

let dir: string;
let config: string;
let cwd: string;
let checks: { url: string; token: string | null }[];
let pauses: number[];
let answered: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-claude-reconnect-"));
  config = join(dir, "claude-config");
  cwd = join(dir, "code");
  await mkdir(config, { recursive: true });
  await mkdir(cwd, { recursive: true });
  checks = [];
  pauses = [];
  answered = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Deps with the given settings section, token and check answers in turn. */
function deps(section: Record<string, unknown>, results: ProxyCheck[], token: string | null = null): ReconnectDeps {
  const queue = [...results];
  return {
    settings: async () => claudeSettingsOf(section),
    token: async () => token,
    env: { CLAUDE_CONFIG_DIR: config },
    check: async (url, t) => {
      checks.push({ url, token: t });
      const result = queue.shift() ?? "unreachable";
      return { result, detail: result === "unreachable" ? "Could not reach http://localhost:6655: no answer in time" : result };
    },
    sleep: async (ms) => {
      pauses.push(ms);
    },
    answered: () => {
      answered += 1;
    },
  };
}

const PROXY = { claudeAuth: "proxy", claudeProxyUrl: "http://localhost:6655/anthropic/" };

test("a proxy that answers is reported as answering, after one check with the stored token", async () => {
  const found = await reconnectProxy(cwd, deps(PROXY, ["ok"], "app-token"));
  expect(found).toEqual({ ok: true, detail: "The API at http://localhost:6655/anthropic/ answers", url: "http://localhost:6655/anthropic/" });
  expect(checks).toEqual([{ url: "http://localhost:6655/anthropic/", token: "app-token" }]);
  expect(pauses).toEqual([]);
  expect(answered).toBe(1);
});

test("an unreachable proxy is tried again a moment later, and answers the second time", async () => {
  const found = await reconnectProxy(cwd, deps(PROXY, ["unreachable", "ok"]));
  expect(found?.ok).toBe(true);
  expect(checks.length).toBe(2);
  expect(pauses).toEqual([RECONNECT_PAUSE_MS]);
});

test("a proxy that never answers is reported down after every try, naming its address", async () => {
  const found = await reconnectProxy(cwd, deps(PROXY, []));
  expect(found?.ok).toBe(false);
  expect(found?.url).toBe("http://localhost:6655/anthropic/");
  expect(found?.detail).toContain(`No answer from the API at http://localhost:6655/anthropic/ after ${RECONNECT_TRIES} tries — is the proxy running?`);
  expect(checks.length).toBe(RECONNECT_TRIES);
  expect(pauses.length).toBe(RECONNECT_TRIES - 1);
  expect(answered).toBe(0);
});

test("a proxy that refuses the token is an answer: not tried again, and reported as not ready", async () => {
  const found = await reconnectProxy(cwd, deps(PROXY, ["unauthorized"]));
  expect(found?.ok).toBe(false);
  expect(found?.detail).toContain("refuses the token");
  expect(checks.length).toBe(1);
});

test("a proxy that answers something other than the model list still answers", async () => {
  expect((await reconnectProxy(cwd, deps(PROXY, ["unexpected"])))?.ok).toBe(true);
});

test("an account sign-in has nothing to try", async () => {
  expect(await reconnectProxy(cwd, deps({ claudeAuth: "login" }, ["ok"]))).toBeNull();
  // Nothing chosen and no proxy anywhere: the account too.
  expect(await reconnectProxy(cwd, deps({}, ["ok"]))).toBeNull();
  expect(checks).toEqual([]);
});

test("the proxy is the one the folder's own Claude Code settings name, when Settings names none", async () => {
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(
    join(cwd, ".claude", "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://localhost:7777/", ANTHROPIC_AUTH_TOKEN: "folder-token" } }),
  );
  const found = await reconnectProxy(cwd, deps({}, ["ok"]));
  expect(found?.url).toBe("http://localhost:7777/");
  expect(checks).toEqual([{ url: "http://localhost:7777/", token: "folder-token" }]);
});

test("withReconnect gives the provider the app's reconnect hook", async () => {
  const provider = withReconnect({ id: "claude" }, deps(PROXY, ["ok"]));
  expect((await provider.reconnect({ cwd }))?.ok).toBe(true);
});
