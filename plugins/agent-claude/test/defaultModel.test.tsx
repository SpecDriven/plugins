// Settings → Claude's "Default model" (specs/agents/claude.feature.md "Choose
// the model Claude starts on"): a dropdown of the models the sign-in offers —
// the Claude account's, or the proxy's GET /v1/models — narrowed to the names
// the "Claude models" list the app adds to Settings → Claude names, when it names any
// (specs/agents/agent-plugins.feature.md "Each agent offers the models the
// data repo lists"), the first chosen until another is; with no such list and
// nothing offered, the list alone, and the free field it was before in an app
// that keeps no lists.

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ACCOUNT_MODELS_TTL_MS,
  accountModels,
  accountModelsOf,
  modelFamily,
  fetchAccountModels,
  forgetAccountModels,
  type AccountModel,
} from "../src/accountModels";
import { inList, narrowModels } from "../src/modelMenu";
import { AGENT_MODELS_FILE, listedClaudeModels } from "../src/models";
import { fetchProxyModels, proxyModelsOf } from "../src/proxyModels";
import type { QueryLike } from "../src/provider";
import { DEFAULT_SETTINGS } from "../src/settings";
import { DefaultEffort, DefaultModel, accountModelLabel, claudeModelsOf, type ClaudeAuthInfo } from "../src/ui/ClaudeSettings";

const info = (defaultModel: string | null) => ({ defaultModel }) as ClaudeAuthInfo;
const html = (defaultModel: string | null, models: string[] | null, account: AccountModel[] | null = null, offeredBy?: string) =>
  renderToStaticMarkup(
    <DefaultModel info={info(defaultModel)} models={models} account={account} offeredBy={offeredBy} refresh={async () => {}} onError={() => {}} />,
  );

const ACCOUNT: AccountModel[] = [
  { value: "default", resolvedModel: "claude-sonnet-4-6", displayName: "Default (recommended)", description: "Use the default model (currently Sonnet 4.6)" },
  { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus", description: "Opus 4.8 · Best for everyday, complex tasks · $5/$25 per Mtok" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable" },
  { value: "haiku", displayName: "Haiku", description: "" },
];

test("the default model is a dropdown of only the models the app lists for Claude, the first until another is chosen", () => {
  expect(html(null, ["opus", "sonnet"])).toContain(
    '<select aria-label="Default Claude model"><option value="opus" selected="">opus</option><option value="sonnet">sonnet</option></select>',
  );
  expect(html("sonnet", ["opus", "sonnet"])).toContain('<option value="sonnet" selected="">sonnet</option>');
  // A default the list does not hold is not used: the list's first is chosen.
  expect(html("haiku", ["opus"])).toContain(
    '<select aria-label="Default Claude model"><option value="opus" selected="">opus</option></select>',
  );
  const none = html(null, []);
  expect(none).toContain("List some below to choose one here");
  expect(none).toContain(
    '<select aria-label="Default Claude model" disabled=""><option value="" selected="">No models listed</option></select>',
  );
  expect(html(null, ["opus"])).not.toContain("Claude Code&#x27;s default");
});

test("an app that keeps no model lists leaves the default model a free field", () => {
  const free = html("opus", null);
  expect(free).not.toContain("<select");
  expect(free).toMatch(/<input aria-label="Default Claude model" list="claude-model-aliases"[^>]*value="opus"/);
});

test("Claude's list comes from the app's state payload, keyed by agent", () => {
  expect(claudeModelsOf({ agentModels: { claude: ["opus", 4], codex: ["gpt-5-codex"] } })).toEqual(["opus"]);
  expect(claudeModelsOf({ agentModels: { codex: ["gpt-5-codex"] } })).toEqual([]);
  expect(claudeModelsOf({})).toBeNull();
  expect(claudeModelsOf({ agentModels: [] })).toBeNull();
});

test("the host reads Claude's list from the data repo's agent-models.json, in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "specdriven-claude-models-"));
  try {
    expect(await listedClaudeModels(null)).toEqual([]);
    expect(await listedClaudeModels(dir)).toEqual([]);
    await mkdir(join(dir, ".specdriven"));
    await writeFile(
      join(dir, AGENT_MODELS_FILE),
      JSON.stringify({ claude: ["claude-sonnet-4-6", "two words", 3, "opus"], codex: ["gpt-5-codex"] }),
    );
    expect(await listedClaudeModels(dir)).toEqual(["claude-sonnet-4-6", "opus"]);
    await writeFile(join(dir, AGENT_MODELS_FILE), "{ not json");
    expect(await listedClaudeModels(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("signed in with a Claude account, the default model is a dropdown of every model the account offers", () => {
  const all = html(null, null, ACCOUNT);
  expect(all).toContain("from the models your Claude account offers");
  expect(all).toContain(
    '<option value="default" title="Use the default model (currently Sonnet 4.6)" selected="">Use the default model (currently Sonnet 4.6) — default</option>' +
      '<option value="opus" title="Opus 4.8 · Best for everyday, complex tasks · $5/$25 per Mtok">Opus 4.8 — opus</option>' +
      '<option value="claude-fable-5-1[1m]" title="Fable 5.1 · Most capable">Fable 5.1 — claude-fable-5-1[1m]</option>' +
      '<option value="haiku">Haiku — haiku</option>',
  );
  // A default the menu holds under its other name stays on offer after it,
  // named after the row it resolves to.
  expect(html("claude-opus-4-8", [], ACCOUNT)).toContain(
    '<option value="haiku">Haiku — haiku</option><option value="claude-opus-4-8" selected="">Opus 4.8 — claude-opus-4-8</option>',
  );
  // One the account does not offer at all — chosen under the API before the
  // switch to the account — is not used: the menu's first is, and nothing else is offered.
  const other = html("claude-sonnet-4-5", null, ACCOUNT);
  expect(other).toContain('<option value="default" title="Use the default model (currently Sonnet 4.6)" selected="">');
  expect(other).not.toContain("claude-sonnet-4-5");
  // No account list (not signed in, or Claude Code could not say): the data repo's alone.
  expect(html(null, ["opus"], [])).toContain('<option value="opus" selected="">opus</option>');
  expect(accountModelLabel({ value: "x", displayName: "x", description: "" }, ACCOUNT)).toBe("x");
});

test("the names Settings → Claude lists narrow the offered models, in the list's order, the first chosen until another is", () => {
  // Each listed name is the offered row for it — by value, or by the id an
  // alias resolves to — and a name offered under neither is kept bare.
  expect(narrowModels(ACCOUNT, ["haiku", "claude-opus-4-8", "my-model"])).toEqual([
    { value: "haiku", displayName: "Haiku", description: "" },
    { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus", description: "Opus 4.8 · Best for everyday, complex tasks · $5/$25 per Mtok" },
    { value: "my-model", displayName: "my-model", description: "" },
  ]);
  expect(narrowModels(ACCOUNT, [])).toEqual(ACCOUNT);
  const narrowed = html(null, ["haiku", "opus"], ACCOUNT);
  expect(narrowed).toContain("narrowed to the Claude models listed below");
  expect(narrowed).toContain(
    '<option value="haiku" selected="">Haiku — haiku</option><option value="opus" title="Opus 4.8 · Best for everyday, complex tasks · $5/$25 per Mtok">Opus 4.8 — opus</option>',
  );
  expect(narrowed).not.toContain('value="default"');
  expect(html("opus", ["haiku", "opus"], ACCOUNT)).toMatch(/<option value="opus"[^>]* selected="">Opus 4.8 — opus</);
  // A default the list does not hold is not used: the narrowed menu's first
  // is chosen, and nothing else is offered. The same model under its other
  // name — an alias whose id is listed — is held.
  const lost = html("default", ["haiku"], ACCOUNT);
  expect(lost).toContain('<select aria-label="Default Claude model"><option value="haiku" selected="">Haiku — haiku</option></select>');
  expect(html("opus", ["haiku", "claude-opus-4-8"], ACCOUNT)).toMatch(/<option value="opus"[^>]* selected="">Opus 4.8 — opus</);
  expect(inList("claude-opus-4-8", ACCOUNT, ["opus"])).toBe(true);
  expect(inList("default", ACCOUNT, ["opus"])).toBe(false);
  expect(inList("anything", ACCOUNT, [])).toBe(false);
  expect(inList("claude-opus-4-8", ACCOUNT, [])).toBe(true);
  // Nothing offered (signed out, a proxy that lists none): nothing to hold it against.
  expect(inList("anything", [], [])).toBe(true);
  expect(inList("anything", [], ["opus"])).toBe(false);
  // Behind a proxy the models are the proxy's, said so.
  const proxied = html(null, null, [{ value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: "Claude Sonnet 4.6" }], "the proxy");
  expect(proxied).toContain("from the models the proxy offers.");
  expect(proxied).toContain('<option value="claude-sonnet-4-6" title="Claude Sonnet 4.6" selected="">Claude Sonnet 4.6 — claude-sonnet-4-6</option>');
});

test("the proxy's GET /v1/models answer becomes the menu, page by page, with the token the way Claude Code sends it", async () => {
  const seen: { path: string; query: string; auth: string | null; key: string | null; version: string | null }[] = [];
  let status = 200;
  const pages: Record<string, unknown> = {
    "": { data: [{ id: "claude-opus-4-8", display_name: "Claude Opus 4.8" }, { id: "claude-opus-4-8", display_name: "Again" }, { id: "two words" }, { id: "claude-sonnet-4-6" }], has_more: true, last_id: "claude-sonnet-4-6" },
    "claude-sonnet-4-6": { data: [{ id: "claude-haiku-4-5", display_name: " Claude Haiku 4.5 " }], has_more: false, last_id: "claude-haiku-4-5" },
  };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, query: url.search, auth: req.headers.get("authorization"), key: req.headers.get("x-api-key"), version: req.headers.get("anthropic-version") });
      if (status !== 200) return new Response("{}", { status });
      return Response.json(pages[url.searchParams.get("after_id") ?? ""] ?? {});
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}/anthropic`;
    expect(await fetchProxyModels(base, "tok")).toEqual([
      { value: "claude-opus-4-8", displayName: "Claude Opus 4.8", description: "Claude Opus 4.8" },
      { value: "claude-sonnet-4-6", displayName: "claude-sonnet-4-6", description: "" },
      { value: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", description: "Claude Haiku 4.5" },
    ]);
    expect(seen).toEqual([
      { path: "/anthropic/v1/models", query: "?limit=100", auth: "Bearer tok", key: "tok", version: "2023-06-01" },
      { path: "/anthropic/v1/models", query: "?limit=100&after_id=claude-sonnet-4-6", auth: "Bearer tok", key: "tok", version: "2023-06-01" },
    ]);
    // No token: none sent. An answer with no list is no models.
    pages[""] = { object: "list" };
    expect(await fetchProxyModels(`${base}/`, null)).toEqual([]);
    expect(seen[2]).toMatchObject({ auth: null, key: null });
    status = 401;
    await expect(fetchProxyModels(base, "tok")).rejects.toThrow("The proxy refused the token (HTTP 401)");
    status = 503;
    await expect(fetchProxyModels(base, null)).rejects.toThrow("HTTP 503");
  } finally {
    server.stop(true);
  }
  await expect(fetchProxyModels(`http://127.0.0.1:${server.port}/`, "tok")).rejects.toThrow();
  expect(proxyModelsOf("nope")).toEqual([]);
});

test("Claude Code's model rows become account models, dropping what is no model id and repeats", () => {
  expect(
    accountModelsOf([
      { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus", description: "Opus 4.8", supportsEffort: true },
      { value: "opus", displayName: "Again", description: "" },
      { value: "two words", displayName: "Bad", description: "" },
      { value: "haiku", resolvedModel: 4 },
      null,
      // An organization's explicit ids of models already offered: one row
      // per family, the first listed, so the menu stays short.
      { value: "claude-opus-4-7", displayName: "Opus 4.7", description: "Best for everyday, complex tasks" },
      { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1" },
      { value: "claude-fable-5", displayName: "Fable 5", description: "" },
      { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "" },
      { value: "us.anthropic.claude-sonnet-4-6:0", displayName: "Bedrock Sonnet", description: "" },
    ]),
  ).toEqual([
    { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus", description: "Opus 4.8" },
    { value: "haiku", displayName: "haiku", description: "" },
    { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1" },
    { value: "us.anthropic.claude-sonnet-4-6:0", displayName: "Bedrock Sonnet", description: "" },
  ]);
  expect(accountModelsOf(undefined)).toEqual([]);
  expect(["default", "opus", "claude-opus-4-8[1m]", "claude-haiku-4-5-20251001", "us.anthropic.claude-sonnet-4-6:0"].map(modelFamily)).toEqual([
    "default",
    "opus",
    "opus",
    "haiku",
    null,
  ]);
});

test("an account model keeps the effort levels Claude Code lists for it", () => {
  expect(
    accountModelsOf([
      { value: "opus", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high", "max", "turbo"] },
      { value: "haiku", displayName: "Haiku", description: "", supportsEffort: false, supportedEffortLevels: ["low"] },
      { value: "sonnet", displayName: "Sonnet", description: "" },
    ]).map((m) => [m.value, m.efforts]),
  ).toEqual([
    ["opus", ["low", "high", "max"]],
    ["haiku", []],
    ["sonnet", undefined],
  ]);
});

test("Default effort is a select of Claude Code's levels, Claude Code's own default when none is set", () => {
  const effort = (defaultEffort: ClaudeAuthInfo["defaultEffort"]) =>
    renderToStaticMarkup(<DefaultEffort info={{ defaultEffort } as ClaudeAuthInfo} refresh={async () => {}} onError={() => {}} />);
  expect(effort(null)).toContain(
    '<option value="" selected="">Claude Code&#x27;s default</option><option value="low">Low</option><option value="medium">Medium</option>' +
      '<option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Max</option>',
  );
  expect(effort("xhigh")).toContain('<option value="xhigh" selected="">Extra high</option>');
  // A plugin host from before the setting says nothing: the same as none.
  expect(effort(undefined)).toContain('<option value="" selected="">');
});

test("asking for the account's models gives up when Claude Code does not answer in time", async () => {
  let aborted: AbortController | undefined;
  const hung = await fetchAccountModels(DEFAULT_SETTINGS, process.cwd(), null, ({ options }) => {
    aborted = options.abortController;
    return { supportedModels: () => new Promise(() => {}) } as unknown as QueryLike;
  }, 20).catch((e: Error) => e.message);
  expect(hung).toBe("Claude Code did not list its models in time");
  expect(aborted!.signal.aborted).toBe(true);
  // A Claude Code too old to list them lists none.
  expect(await fetchAccountModels(DEFAULT_SETTINGS, process.cwd(), null, () => ({}) as QueryLike)).toEqual({ account: null, models: [] });
  // One that found no account, token or key lists none either, and is not
  // asked for them (specs/agents/claude.feature.md "Sign in to Claude with an email").
  let listed = 0;
  const nobody = await fetchAccountModels({ ...DEFAULT_SETTINGS, claudeAuth: "login" }, process.cwd(), null, () =>
    ({ accountInfo: async () => ({ tokenSource: "none", apiProvider: "firstParty" }), supportedModels: async () => (listed++, [{ value: "opus", displayName: "Opus", description: "" }]) }) as unknown as QueryLike,
  );
  expect(nobody).toMatchObject({ account: { billing: "none" }, models: [] });
  expect(listed).toBe(0);
});

test("the account's models are asked for once, shared, and again after the TTL or a sign-in change", async () => {
  forgetAccountModels();
  let asks = 0;
  const ask = async () => {
    asks++;
    return { account: null, models: [{ value: `m${asks}`, displayName: "", description: "" }] };
  };
  const [a, b] = await Promise.all([accountModels(ask), accountModels(ask)]);
  expect(a).toEqual(b);
  expect(asks).toBe(1);
  expect((await accountModels(ask)).models[0]!.value).toBe("m1");
  expect((await accountModels(ask, Date.now() + ACCOUNT_MODELS_TTL_MS + 1)).models[0]!.value).toBe("m2");
  forgetAccountModels();
  expect((await accountModels(ask)).models[0]!.value).toBe("m3");
  forgetAccountModels();
});
