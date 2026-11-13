// The models Codex offers (specs/agents/codex.feature.md "Codex lists the
// models its sign-in offers"): with the API, the API's own list — GET
// <address>/models with the key; with a ChatGPT account, Codex's own list
// for it — narrowed to the names the data repo lists for Codex when it
// lists any; in the pane's menu, in Settings → Codex's "Default model", and
// as the model a session starts on. And Settings → Codex itself ("Choose
// how Codex signs in", "Sign in to Codex with a ChatGPT account").

import { expect, test, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { modelLabel, narrowModels, type CodexModel } from "../src/modelMenu";
import {
  AGENT_MODELS_FILE,
  CODEX_MODELS_FILE,
  MODELS_TTL_MS,
  accountModelsOf,
  apiModelsOf,
  fetchApiModels,
  forgetModels,
  listedCodexModels,
  offeredModels,
} from "../src/models";
import { createCodexProvider } from "../src/provider";
import { DEFAULT_SETTINGS } from "../src/settings";
import {
  CodexAccount,
  CodexApi,
  DefaultModel,
  apiCheckText,
  codexModelsOf,
  signInCheckText,
  type CodexAuthInfo,
} from "../src/ui/CodexSettings";

afterEach(() => forgetModels());

const API_MODELS: CodexModel[] = [
  { value: "gpt-test", displayName: "gpt-test", description: "" },
  { value: "gpt-test-mini", displayName: "gpt-test-mini", description: "" },
];

/** A fetch that answers with this, and remembers what it was asked. */
function answering(body: unknown, status = 200, seen: { url: string; auth: string | null }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

// --- what the sign-in offers ---------------------------------------------------

test("the API's models are read from GET <address>/models with the key as a bearer token", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const list = { object: "list", data: [{ id: "gpt-test", object: "model" }, { id: "gpt-test" }, { id: "two words" }, { id: "gpt-test-mini", display_name: "Mini" }, { nope: 1 }] };
  expect(await fetchApiModels("http://localhost:6655/openai/v1", "sk-key", answering(list, 200, seen))).toEqual([
    { value: "gpt-test", displayName: "gpt-test", description: "" },
    { value: "gpt-test-mini", displayName: "Mini", description: "" },
  ]);
  expect(seen).toEqual([{ url: "http://localhost:6655/openai/v1/models", auth: "Bearer sk-key" }]);
  // No key, no header; a bare list is a list too.
  expect(await fetchApiModels("https://api.test/v1/", null, answering([{ id: "m1" }], 200, seen))).toEqual([{ value: "m1", displayName: "m1", description: "" }]);
  expect(seen.at(-1)).toEqual({ url: "https://api.test/v1/models", auth: null });
  expect(apiModelsOf("nope")).toEqual([]);
});

test("an API that refuses the key, or fails, says why without the key", async () => {
  await expect(fetchApiModels("https://api.test/v1", "sk-key", answering({}, 401))).rejects.toThrow("The API refused the key (HTTP 401)");
  await expect(fetchApiModels("https://api.test/v1", null, answering({}, 403))).rejects.toThrow("The API wants a key (HTTP 403)");
  await expect(fetchApiModels("https://api.test/v1", "sk-key", answering({}, 500))).rejects.toThrow("The API answered HTTP 500 to /models");
  await expect(fetchApiModels("https://api.test/v1", "two words")).rejects.toThrow("characters a request cannot carry");
  const failing = (async () => {
    throw new Error("could not send header Bearer sk-key");
  }) as unknown as typeof fetch;
  const said = await fetchApiModels("https://api.test/v1", "sk-key", failing).catch((e: Error) => e.message);
  expect(said).toBe("could not send header Bearer [key]");
});

test("a ChatGPT account's models are Codex's own list for it, the hidden ones left out", () => {
  const rows = [
    { id: "gpt-a", model: "gpt-a", displayName: "GPT-A", description: "The workhorse", hidden: false, isDefault: true },
    { id: "gpt-b", model: "gpt-b", displayName: "GPT-B", description: "", hidden: true },
    { id: "gpt-a", model: "gpt-a", displayName: "again" },
    { model: "gpt-c" },
  ];
  expect(accountModelsOf(rows)).toEqual([
    { value: "gpt-a", displayName: "GPT-A", description: "The workhorse" },
    { value: "gpt-c", displayName: "gpt-c", description: "" },
  ]);
  expect(accountModelsOf(null)).toEqual([]);
});

test("the sign-in's models are asked for once per sign-in, kept a while, and asked again when it changes", async () => {
  let asks = 0;
  const ask = async () => {
    asks += 1;
    return API_MODELS;
  };
  const t0 = 1_000_000;
  expect(await offeredModels(ask, "api a", t0)).toEqual(API_MODELS);
  expect(await offeredModels(ask, "api a", t0 + 1000)).toEqual(API_MODELS);
  expect(asks).toBe(1);
  // Another address or key is another sign-in: its own answer.
  await offeredModels(ask, "api b", t0 + 1000);
  expect(asks).toBe(2);
  await offeredModels(ask, "api b", Date.now() + MODELS_TTL_MS + 1);
  expect(asks).toBe(3);
  forgetModels();
  await offeredModels(ask, "api b");
  expect(asks).toBe(4);
  // A failed ask is not kept.
  forgetModels();
  await expect(offeredModels(async () => Promise.reject(new Error("down")), "api c")).rejects.toThrow("down");
  expect(await offeredModels(ask, "api c")).toEqual(API_MODELS);
});

test("the data repo's list for Codex narrows the menu, in its own order, keeping a name the sign-in does not offer", async () => {
  expect(narrowModels(API_MODELS, [])).toEqual(API_MODELS);
  expect(narrowModels(API_MODELS, ["gpt-test-mini", "gpt-other"])).toEqual([
    { value: "gpt-test-mini", displayName: "gpt-test-mini", description: "" },
    { value: "gpt-other", displayName: "gpt-other", description: "" },
  ]);
  expect(modelLabel({ value: "gpt-a", displayName: "GPT-A", description: "" })).toBe("GPT-A — gpt-a");
  expect(modelLabel(API_MODELS[0]!)).toBe("gpt-test");
  const data = await mkdtemp(join(tmpdir(), "specdriven-codex-models-"));
  try {
    expect(await listedCodexModels(data)).toEqual([]);
    await mkdir(join(data, ".specdriven"));
    // The app's old shared file is read until Codex has a file of its own.
    await writeFile(join(data, AGENT_MODELS_FILE), JSON.stringify({ claude: ["opus"], codex: ["gpt-old"] }));
    expect(await listedCodexModels(data)).toEqual(["gpt-old"]);
    await writeFile(join(data, CODEX_MODELS_FILE), JSON.stringify(["gpt-test", "two words", 7, "gpt-test-mini"]));
    expect(await listedCodexModels(data)).toEqual(["gpt-test", "gpt-test-mini"]);
    expect(await listedCodexModels(null)).toEqual([]);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

// --- the pane's menu ---------------------------------------------------------------

test("the pane's model menu is what the sign-in offers, narrowed by the data repo's list, with the default a session starts on", async () => {
  const saved: Record<string, unknown>[] = [];
  let listed: string[] = [];
  let own = { ...DEFAULT_SETTINGS };
  const provider = createCodexProvider({
    settings: async () => own,
    listedModels: async () => listed,
    offeredModels: async () => [{ value: "gpt-a", displayName: "GPT-A", description: "The workhorse" }, ...API_MODELS],
    signIn: async () => ({ billing: "api", label: "API:LOCAL", detail: "API calls go to localhost:6655" }),
    saveSettings: async (patch) => {
      saved.push(patch);
    },
  });
  expect(provider.capabilities).toMatchObject({ hasAccount: true, canChangeModelMidSession: true });
  const all = await provider.choices!({ dataRepo: null });
  expect(all).toEqual({
    models: [
      { value: "gpt-a", displayName: "GPT-A", description: "The workhorse" },
      { value: "gpt-test", displayName: "gpt-test" },
      { value: "gpt-test-mini", displayName: "gpt-test-mini" },
    ],
    // Nothing chosen, nothing listed: Codex's own default.
    model: null,
    effort: null,
    account: { billing: "api", label: "API:LOCAL", detail: "API calls go to localhost:6655" },
  });
  expect(await provider.reportedModels!()).toEqual(["gpt-a", "gpt-test", "gpt-test-mini"]);
  own = { ...own, defaultModel: "gpt-test-mini" };
  expect((await provider.choices!({ dataRepo: null })).model).toBe("gpt-test-mini");
  // A list in the data repo narrows the menu; a default it does not hold gives way to its first.
  listed = ["gpt-test", "gpt-a"];
  const narrowed = await provider.choices!({ dataRepo: null });
  expect(narrowed.models.map((m) => m.value)).toEqual(["gpt-test", "gpt-a"]);
  expect(narrowed.model).toBe("gpt-test");
  // A pick in the pane becomes Settings → Codex's default.
  await provider.setDefaults!({ model: "gpt-a" });
  await provider.setDefaults!({ effort: "high" });
  expect(saved).toEqual([{ defaultModel: "gpt-a" }]);
});

test("a Codex with no Settings of its own offers no model menu and no account chip", () => {
  const plain = createCodexProvider();
  expect(plain.choices).toBeUndefined();
  expect(plain.setDefaults).toBeUndefined();
  expect(plain.capabilities.hasAccount).toBe(false);
  expect(plain.capabilities.canChangeModelMidSession).toBeUndefined();
});

// --- Settings → Codex ---------------------------------------------------------------

const info = (extra: Partial<CodexAuthInfo> = {}): CodexAuthInfo => ({
  mode: "api",
  inferred: false,
  cliAvailable: true,
  login: { loggedIn: false, method: "none", email: null },
  api: {
    url: null,
    storedUrl: null,
    storedKey: false,
    hasKey: false,
    detected: { url: null, urlSource: null, hasKey: false, keySource: null, requiresApiKey: false },
  },
  defaultModel: null,
  signIn: null,
  ...extra,
});
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const modelHtml = (defaultModel: string | null, models: string[] | null, offered: CodexModel[] | null = null, offeredBy?: string) =>
  renderToStaticMarkup(
    <DefaultModel info={info({ defaultModel })} models={models} offered={offered} offeredBy={offeredBy} refresh={async () => {}} onError={() => {}} />,
  );

test("Default model is a dropdown of the models the API lists, with Codex's own default until one is chosen", () => {
  const out = modelHtml(null, [], API_MODELS);
  expect(out).toContain(
    '<select aria-label="Default Codex model"><option value="" selected="">Codex&#x27;s default</option><option value="gpt-test">gpt-test</option><option value="gpt-test-mini">gpt-test-mini</option></select>',
  );
  expect(out).toContain("from the models the API lists.");
  expect(modelHtml("gpt-test-mini", [], API_MODELS)).toContain('<option value="gpt-test-mini" selected="">gpt-test-mini</option>');
  // A default the API no longer lists stays on offer, so opening the menu never changes it.
  expect(modelHtml("gpt-gone", null, API_MODELS)).toContain('<option value="gpt-gone" selected="">gpt-gone</option>');
  expect(modelHtml(null, [], API_MODELS, "your ChatGPT account offers")).toContain("from the models your ChatGPT account offers.");
});

test("Default model is narrowed to the Codex models the data repo lists, the first until another is chosen", () => {
  const out = modelHtml(null, ["gpt-test-mini", "gpt-other"], API_MODELS);
  expect(out).toContain(
    '<select aria-label="Default Codex model"><option value="gpt-test-mini" selected="">gpt-test-mini</option><option value="gpt-other">gpt-other</option></select>',
  );
  expect(out).toContain("narrowed to the Codex models listed below");
  expect(out).not.toContain("Codex&#x27;s default");
  // A default the list does not hold is not used: the list's first is.
  expect(modelHtml("gpt-test", ["gpt-test-mini"], API_MODELS)).toContain('<option value="gpt-test-mini" selected="">');
  // The list alone serves while the sign-in offers nothing.
  expect(modelHtml("gpt-b", ["gpt-a", "gpt-b"])).toContain('<option value="gpt-b" selected="">gpt-b</option>');
});

test("with no model list from the sign-in and none in the data repo, Default model is a field for a model id", () => {
  const out = modelHtml("gpt-typed", []);
  expect(out).toContain('<input aria-label="Default Codex model"');
  expect(out).toContain('value="gpt-typed"');
  expect(out).toContain("Once the API answers with its model list, this becomes a menu of those models.");
  expect(codexModelsOf({ agentModels: { claude: ["opus"], codex: ["gpt-a", 3] } })).toEqual(["gpt-a"]);
  expect(codexModelsOf({ agentModels: { claude: ["opus"] } })).toEqual([]);
  expect(codexModelsOf({})).toBeNull();
});

const apiHtml = (api: Partial<CodexAuthInfo["api"]>) =>
  renderToStaticMarkup(<CodexApi info={info({ api: { ...info().api, ...api } })} refresh={async () => {}} onError={() => {}} />);

test("the API shows what Codex's own config carries, with Use detected, and never calls the address a proxy", () => {
  const detected = { url: "http://localhost:6655/openai/v1", urlSource: "~/.codex/config.toml", hasKey: true, keySource: "~/.codex/auth.json", requiresApiKey: true };
  const out = apiHtml({ url: detected.url, hasKey: true, detected });
  expect(out).toContain('aria-label="Codex API address"');
  expect(out).toContain('placeholder="http://localhost:6655/openai/v1"');
  expect(out).toContain("Detected in ~/.codex/config.toml: <code>http://localhost:6655/openai/v1</code> with a key.");
  expect(out).toContain("Using the key from ~/.codex/auth.json");
  expect(buttons(out)).toEqual(["Check connection", "Use detected", "Save key"]);
  expect(out.toLowerCase()).not.toContain("proxy");
  // Once the app has its own copy there is nothing left to use.
  const own = apiHtml({ url: detected.url, storedUrl: detected.url, storedKey: true, hasKey: true, detected });
  expect(buttons(own)).toEqual(["Check connection", "Save key", "Remove"]);
  expect(own).toContain("A key is kept on this device, never shown.");
  expect(own).toContain('placeholder="Replace the key"');
});

test("with no address anywhere the API is OpenAI's own, called with the key", () => {
  const out = apiHtml({});
  expect(out).toContain('placeholder="https://api.openai.com/v1"');
  expect(out).toContain("with a key, Codex calls OpenAI&#x27;s API (<code>https://api.openai.com/v1</code>)");
  expect(out).toContain("No key: the API is called without one.");
  expect(buttons(out)).toEqual(["Check connection", "Save key"]);
  expect(apiCheckText("ok", "Reachable, and the key was accepted")).toBe("OK — Reachable, and the key was accepted");
  expect(apiCheckText("unauthorized", "The API refused the key (HTTP 401)")).toBe("Wrong key — The API refused the key (HTTP 401)");
  expect(apiCheckText("unreachable", "no answer")).toBe("Unreachable — no answer");
});

const accountHtml = (extra: Partial<CodexAuthInfo> = {}) =>
  renderToStaticMarkup(
    <CodexAccount info={info({ mode: "login", ...extra })} onChange={() => {}} refresh={async () => {}} reloadModels={() => {}} onModels={() => {}} />,
  );

test("signed out, the ChatGPT account says so plainly and offers Sign in and a check", () => {
  const out = accountHtml();
  expect(out).toContain("<strong>Not signed in.</strong> Sign in with your ChatGPT account through the browser.");
  expect(buttons(out)).toEqual(["Sign in", "Check sign-in"]);
  expect(out).not.toContain("Codex keeps one sign-in");
});

test("signed in, the ChatGPT account names the account and offers Check sign-in and Sign out", () => {
  const out = accountHtml({ login: { loggedIn: true, method: "chatgpt", email: "pat@example.com" } });
  expect(out).toContain("Signed in as <strong>pat@example.com</strong>.");
  expect(buttons(out)).toEqual(["Check sign-in", "Sign out"]);
  expect(accountHtml({ login: { loggedIn: true, method: "chatgpt", email: null } })).toContain("Signed in to a ChatGPT account.");
});

test("the ChatGPT account warns that signing in replaces Codex's own API key, and of a config that signs the account out", () => {
  const detected = { url: null, urlSource: null, hasKey: true, keySource: "~/.codex/auth.json", requiresApiKey: true };
  const out = accountHtml({ api: { ...info().api, hasKey: true, detected } });
  expect(out).toContain("Codex keeps one sign-in: signing in replaces the API key in ~/.codex/auth.json.");
  expect(out).toContain("switch to API and choose “Use detected” first");
  expect(out).toContain("a Codex started outside the app signs the ChatGPT account out again");
  // With the app's own copy of the key, nothing is lost.
  expect(accountHtml({ api: { ...info().api, hasKey: true, storedKey: true, detected } })).toContain("The app has its own copy for the API.");
  // A key in the environment is not replaced by a sign-in.
  expect(accountHtml({ api: { ...info().api, hasKey: true, detected: { ...detected, keySource: "environment", requiresApiKey: false } } })).not.toContain(
    "Codex keeps one sign-in",
  );
});

test("while the browser sign-in is under way the section says to finish it there and offers only Cancel; with no Codex there is nothing to sign in with", () => {
  const out = accountHtml({ signIn: { inProgress: true, url: "https://auth.openai.com/oauth/authorize", done: false, error: null } });
  expect(out).toContain("Finish signing in in the browser window Codex opened");
  expect(buttons(out)).toEqual(["Cancel"]);
  expect(out).not.toContain("href=");
  const missing = accountHtml({ cliAvailable: false });
  expect(missing).toContain("install the codex command");
  expect(buttons(missing)).toEqual([]);
});

test("the sign-in check's finding is one sentence: the account, and whether Codex lists its models", () => {
  const pat = { loggedIn: true, method: "chatgpt", email: "pat@example.com" };
  expect(signInCheckText(pat, API_MODELS, null)).toBe("Signed in as pat@example.com — Codex started under the account and lists 2 models.");
  expect(signInCheckText(pat, API_MODELS.slice(0, 1), null)).toContain("lists 1 model.");
  expect(signInCheckText(pat, [], null)).toBe("Signed in as pat@example.com, but Codex listed no models for the account.");
  expect(signInCheckText(pat, [], "Codex exited")).toBe("Signed in as pat@example.com, but Codex could not list the account's models: Codex exited");
  expect(signInCheckText({ loggedIn: false, method: "none", email: null }, [], null)).toBe(
    "Not signed in — the Codex CLI has no ChatGPT account. Sign in below.",
  );
});
