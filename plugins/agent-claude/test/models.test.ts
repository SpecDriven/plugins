// Claude's list of allowed models in the data repo (src/models.ts): the
// app's per-agent `.specdriven/claude-models.json`, the old shared
// `agent-models.json` while a data repo still has only that, and the models
// the signed-in account offers, which the app checks the list against.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_MODELS_FILE, CLAUDE_MODELS_FILE, listedClaudeModels, withReportedModels } from "../src/models";

test("the host reads Claude's list from the data repo's claude-models.json, in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "specdriven-claude-models-file-"));
  try {
    await mkdir(join(dir, ".specdriven"));
    await writeFile(join(dir, CLAUDE_MODELS_FILE), JSON.stringify(["sonnet", "two words", 3, "claude-opus-5-5"]));
    // Claude's own file wins over the old shared one.
    await writeFile(join(dir, AGENT_MODELS_FILE), JSON.stringify({ claude: ["haiku"] }));
    expect(await listedClaudeModels(dir)).toEqual(["sonnet", "claude-opus-5-5"]);
    await writeFile(join(dir, CLAUDE_MODELS_FILE), JSON.stringify({ claude: ["opus"] }));
    expect(await listedClaudeModels(dir)).toEqual([]);
    await writeFile(join(dir, CLAUDE_MODELS_FILE), "{ not json");
    expect(await listedClaudeModels(dir)).toEqual([]);
    // With no file of its own, the old shared file's list still counts.
    await rm(join(dir, CLAUDE_MODELS_FILE));
    expect(await listedClaudeModels(dir)).toEqual(["haiku"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the models the API reports are every value and id the account offers, or none to check against", async () => {
  const account = [
    { value: "default", displayName: "Default", description: "", resolvedModel: "claude-opus-5-5" },
    { value: "sonnet", displayName: "Sonnet", description: "", resolvedModel: "claude-sonnet-5-5" },
    { value: "opus", displayName: "Opus", description: "", resolvedModel: "claude-opus-5-5" },
  ];
  const provider = withReportedModels({ id: "claude" }, async () => account);
  expect(provider.id).toBe("claude");
  expect(await provider.reportedModels()).toEqual(["default", "claude-opus-5-5", "sonnet", "claude-sonnet-5-5", "opus"]);
  expect(await withReportedModels({}, async () => []).reportedModels()).toBeNull();
  expect(
    await withReportedModels({}, async () => {
      throw new Error("offline");
    }).reportedModels(),
  ).toBeNull();
});
