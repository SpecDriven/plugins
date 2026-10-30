// The app's one-shot turns (src/server/estimate.ts, src/server/jiraWikiImport.ts)
// through the Claude Agent SDK: the options the query is started with, with
// the SDK swapped for a fake that answers at once, so nothing spawns.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeProvider, InputQueue } from "../src/provider";
import type { QueryLike } from "../src/provider";

let home: string;
const realClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
const realBaseUrl = process.env.ANTHROPIC_BASE_URL;

beforeEach(async () => {
  // claudeLaunch reads Claude Code's settings; keep the developer's own out.
  home = await mkdtemp(join(tmpdir(), "specdriven-claude-oneshot-"));
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  delete process.env.ANTHROPIC_BASE_URL;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  if (realClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeConfig;
  if (realBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = realBaseUrl;
});

/** A provider whose queries answer `{"ok": true}` at once; the options each was started with. */
function answering() {
  const started: Options[] = [];
  const provider = createClaudeProvider({
    available: () => true,
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage> | string; options: Options }) => {
      void prompt;
      started.push(options);
      const out = new InputQueue<SDKMessage>();
      out.push({
        type: "result",
        subtype: "success",
        result: '{"ok": true}',
        structured_output: { ok: true },
        is_error: false,
      } as unknown as SDKMessage);
      out.close();
      return { [Symbol.asyncIterator]: () => out[Symbol.asyncIterator]() } as unknown as QueryLike;
    },
  });
  return { provider, started };
}

const request = { cwd: "/work/dir", systemPrompt: "You answer.", prompt: "Well?", timeoutMs: 5000 };

test("a model asked for is the query's model", async () => {
  const { provider, started } = answering();
  const result = await provider.oneShot!({ ...request, model: "claude-sonnet-4-6" });
  expect(result).toEqual({ text: '{"ok": true}', structured: { ok: true }, isError: false });
  expect(started[0]!.model).toBe("claude-sonnet-4-6");
});

test("no model asked for leaves Claude Code's own default", async () => {
  const { provider, started } = answering();
  await provider.oneShot!(request);
  expect("model" in started[0]!).toBe(false);
});
