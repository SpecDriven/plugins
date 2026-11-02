// Settings → Claude's "Default model" (specs/agents/claude.feature.md "Choose
// the model Claude starts on"): a dropdown of the models the app's Settings →
// AI agents lists for Claude (specs/agents/agent-plugins.feature.md "Each
// agent offers the models the data repo lists"), the first chosen until
// another is, and the free field it was before in an app that keeps no lists;
// signed in with a Claude account, every model the account offers.

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ACCOUNT_MODELS_TTL_MS,
  accountModels,
  accountModelsOf,
  fetchAccountModels,
  forgetAccountModels,
  type AccountModel,
} from "../src/accountModels";
import { AGENT_MODELS_FILE, listedClaudeModels } from "../src/models";
import type { QueryLike } from "../src/provider";
import { DEFAULT_SETTINGS } from "../src/settings";
import { DefaultModel, accountModelLabel, claudeModelsOf, type ClaudeAuthInfo } from "../src/ui/ClaudeSettings";

const info = (defaultModel: string | null) => ({ defaultModel }) as ClaudeAuthInfo;
const html = (defaultModel: string | null, models: string[] | null, account: AccountModel[] | null = null) =>
  renderToStaticMarkup(
    <DefaultModel info={info(defaultModel)} models={models} account={account} refresh={async () => {}} onError={() => {}} />,
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
  // A default the list no longer holds stays chosen, on offer after the list.
  expect(html("haiku", ["opus"])).toContain(
    '<option value="opus">opus</option><option value="haiku" selected="">haiku</option>',
  );
  const none = html(null, []);
  expect(none).toContain("List some there to choose one here");
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
  // It shows the model a new Claude starts on: the chosen one, else the
  // first the data repo lists — offered after the account's when it has
  // none by that name, named after the row it resolves to.
  expect(html("opus", ["haiku"], ACCOUNT)).toMatch(/<option value="opus"[^>]* selected="">Opus 4.8 — opus</);
  expect(html(null, ["haiku"], ACCOUNT)).toContain('<option value="haiku" selected="">Haiku — haiku</option>');
  expect(html("claude-opus-4-8", [], ACCOUNT)).toContain(
    '<option value="haiku">Haiku — haiku</option><option value="claude-opus-4-8" selected="">Opus 4.8 — claude-opus-4-8</option>',
  );
  expect(html("my-model", null, ACCOUNT)).toContain('<option value="my-model" selected="">my-model</option>');
  // No account list (not signed in, or Claude Code could not say): as before.
  expect(html(null, ["opus"], [])).toContain('<option value="opus" selected="">opus</option>');
  expect(accountModelLabel({ value: "x", displayName: "x", description: "" }, ACCOUNT)).toBe("x");
});

test("Claude Code's model rows become account models, dropping what is no model id and repeats", () => {
  expect(
    accountModelsOf([
      { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus", description: "Opus 4.8", supportsEffort: true },
      { value: "opus", displayName: "Again", description: "" },
      { value: "two words", displayName: "Bad", description: "" },
      { value: "haiku", resolvedModel: 4 },
      null,
    ]),
  ).toEqual([
    { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus", description: "Opus 4.8" },
    { value: "haiku", displayName: "haiku", description: "" },
  ]);
  expect(accountModelsOf(undefined)).toEqual([]);
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
  expect(await fetchAccountModels(DEFAULT_SETTINGS, process.cwd(), null, () => ({}) as QueryLike)).toEqual([]);
});

test("the account's models are asked for once, shared, and again after the TTL or a sign-in change", async () => {
  forgetAccountModels();
  let asks = 0;
  const ask = async () => {
    asks++;
    return [{ value: `m${asks}`, displayName: "", description: "" }];
  };
  const [a, b] = await Promise.all([accountModels(ask), accountModels(ask)]);
  expect(a).toEqual(b);
  expect(asks).toBe(1);
  expect((await accountModels(ask))[0]!.value).toBe("m1");
  expect((await accountModels(ask, Date.now() + ACCOUNT_MODELS_TTL_MS + 1))[0]!.value).toBe("m2");
  forgetAccountModels();
  expect((await accountModels(ask))[0]!.value).toBe("m3");
  forgetAccountModels();
});
