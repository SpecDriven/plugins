// Settings → Claude's "Default model" (specs/agents/claude.feature.md "Choose
// the model Claude starts on"): a dropdown of the models the app's Settings →
// AI agents lists for Claude (specs/agents/agent-plugins.feature.md "Each
// agent offers the models the data repo lists"), and the free field it was
// before in an app that keeps no lists.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DefaultModel, claudeModelsOf, type ClaudeAuthInfo } from "../src/ui/ClaudeSettings";

const info = (defaultModel: string | null) => ({ defaultModel }) as ClaudeAuthInfo;
const html = (defaultModel: string | null, models: string[] | null) =>
  renderToStaticMarkup(
    <DefaultModel info={info(defaultModel)} models={models} refresh={async () => {}} onError={() => {}} />,
  );

test("the default model is a dropdown of the models the app lists for Claude", () => {
  expect(html(null, ["opus", "sonnet"])).toContain(
    '<select aria-label="Default Claude model"><option value="" selected="">Claude Code&#x27;s default</option><option value="opus">opus</option><option value="sonnet">sonnet</option></select>',
  );
  expect(html("sonnet", ["opus", "sonnet"])).toContain('<option value="sonnet" selected="">sonnet</option>');
  // A default the list no longer holds stays chosen, on offer after the list.
  expect(html("haiku", ["opus"])).toContain(
    '<option value="opus">opus</option><option value="haiku" selected="">haiku</option>',
  );
  expect(html(null, [])).toContain("List some there to choose one here.");
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
