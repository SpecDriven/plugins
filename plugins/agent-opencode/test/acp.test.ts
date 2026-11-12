// The pure parts: OpenCode's ACP updates → the pane's events, the session
// config, the process's OPENCODE_CONFIG_CONTENT, the model menu, and the
// one-shot turns through `opencode run`.

import { describe, expect, test, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcpClient,
  acpCommands,
  acpConfig,
  effortToAcp,
  finishAcpTurn,
  flattenToolContent,
  mapAcpUpdate,
  newAcpStream,
  paneTool,
  setOpencodeSpawn,
  startAcpTurn,
} from "../src/acp";
import type { OpencodeSpawnOptions } from "../src/acp";
import { findOpencode, installerPath } from "../src/cli";
import { askingRules, parseResolvedAgents, sessionConfigContent } from "../src/config";
import { modelMenu, parseModels } from "../src/models";
import { oneShotMessage, opencodeOneShot, parseAnswer, runArgs } from "../src/oneShot";
import { acpMcpServer } from "../src/provider";
import { FakeOpencode } from "./fakeOpencode";

afterEach(() => {
  setOpencodeSpawn(null);
});

describe("mapAcpUpdate", () => {
  test("text chunks stream, and a message is whole when the next one or a tool begins", () => {
    const stream = newAcpStream();
    const ctx = { turn: 1 };
    expect(mapAcpUpdate({ sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "He" } }, ctx, stream)).toEqual([
      { kind: "text_delta", messageId: "a", index: 0, text: "He" },
    ]);
    mapAcpUpdate({ sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "llo" } }, ctx, stream);
    const next = mapAcpUpdate({ sessionUpdate: "agent_message_chunk", messageId: "b", content: { type: "text", text: "Hi" } }, ctx, stream);
    expect(next).toEqual([
      { kind: "assistant", messageId: "a", turn: 1, blocks: [{ type: "text", text: "Hello" }], parentToolUseId: null },
      { kind: "text_delta", messageId: "b", index: 0, text: "Hi" },
    ]);
    // Thoughts, plans and replays are not the pane's.
    expect(mapAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } }, ctx, stream)).toEqual([]);
    expect(mapAcpUpdate({ sessionUpdate: "plan", entries: [] }, ctx, stream)).toEqual([]);
    const tool = mapAcpUpdate(
      { sessionUpdate: "tool_call", toolCallId: "t", kind: "read", name: "read", status: "in_progress", rawInput: { filePath: "a.ts" } },
      ctx,
      stream,
    );
    expect(tool).toEqual([
      { kind: "assistant", messageId: "b", turn: 1, blocks: [{ type: "text", text: "Hi" }], parentToolUseId: null },
      {
        kind: "assistant",
        messageId: "tool-t",
        turn: 1,
        blocks: [{ type: "tool_use", id: "t", name: "Read", input: { filePath: "a.ts", file_path: "a.ts" } }],
        parentToolUseId: null,
      },
    ]);
  });

  test("text that goes on under the same message id after a tool call is a piece of its own", () => {
    const stream = newAcpStream();
    const ctx = { turn: 1 };
    const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text } });
    mapAcpUpdate(chunk("Before."), ctx, stream);
    mapAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "t", kind: "read", name: "read", status: "in_progress", rawInput: { path: "a" } }, ctx, stream);
    // The pane keys a message by its id: the same id again would be glued
    // onto the text above the tool's row.
    expect(mapAcpUpdate(chunk("After."), ctx, stream)).toEqual([{ kind: "text_delta", messageId: "m#2", index: 0, text: "After." }]);
    expect(finishAcpTurn({ stopReason: "end_turn" }, ctx, stream)[0]).toMatchObject({ messageId: "m#2", blocks: [{ type: "text", text: "After." }] });
    // A new turn starts the count again.
    expect(mapAcpUpdate(chunk("Next turn."), { turn: 2 }, stream)[0]).toMatchObject({ messageId: "m" });
  });

  test("a tool's row waits for its input, and its result closes it", () => {
    const stream = newAcpStream();
    const ctx = { turn: 2 };
    // OpenCode announces a shell call with its folder alone; the command comes as it starts.
    expect(
      mapAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "sh", kind: "execute", name: "shell", title: "shell", status: "pending", rawInput: { cwd: "/w" } }, ctx, stream),
    ).toEqual([]);
    const started = mapAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "sh", status: "in_progress", title: "ls", rawInput: { command: "ls", workdir: "/w" } },
      ctx,
      stream,
    );
    expect(started).toMatchObject([{ blocks: [{ type: "tool_use", id: "sh", name: "Bash", input: { command: "ls" } }] }]);
    // A row already shown is shown again when what it says has changed, and only then.
    expect(mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "sh", status: "in_progress", rawInput: { command: "ls -la", workdir: "/w" } }, ctx, stream)).toMatchObject([
      { messageId: "tool-sh", blocks: [{ type: "tool_use", id: "sh", input: { command: "ls -la" } }] },
    ]);
    expect(mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "sh", status: "completed", content: [] }, ctx, stream)).toEqual([
      { kind: "tool_result", toolUseId: "sh", content: "", isError: false, parentToolUseId: null },
    ]);
    expect(mapAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "t", kind: "edit", name: "write", status: "pending", rawInput: {} }, ctx, stream)).toEqual([]);
    const shown = mapAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress", rawInput: { path: "x.md", content: "y" }, locations: [{ path: "/w/x.md" }] },
      ctx,
      stream,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ blocks: [{ type: "tool_use", name: "Write", input: { file_path: "x.md" } }] });
    // Updates after the row is shown add none.
    expect(mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" }, ctx, stream)).toEqual([]);
    expect(
      mapAcpUpdate(
        { sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed", content: [{ type: "content", content: { type: "text", text: "EACCES" } }] },
        ctx,
        stream,
      ),
    ).toEqual([{ kind: "tool_result", toolUseId: "t", content: "EACCES", isError: true, parentToolUseId: null }]);
    expect(stream.tools.size).toBe(0);
  });

  test("a turn's footer: its duration, its share of the session's cost, how it stopped", () => {
    const stream = newAcpStream();
    let now = 1000;
    startAcpTurn(stream, () => now);
    stream.cost = 0.3;
    now = 4000;
    expect(finishAcpTurn({ stopReason: "end_turn" }, { turn: 1, now: () => now }, stream).at(-1)).toEqual({
      kind: "result",
      turn: 1,
      subtype: "success",
      isError: false,
      costUsd: 0.3,
      durationMs: 3000,
      numTurns: 1,
      denials: 0,
    });
    startAcpTurn(stream, () => now);
    expect(finishAcpTurn({ stopReason: "max_tokens" }, { turn: 2, now: () => now }, stream).at(-1)).toMatchObject({
      subtype: "error",
      isError: true,
      costUsd: null,
      text: "OpenCode stopped: max tokens",
    });
  });
});

describe("paneTool", () => {
  test("ACP's kinds become the pane's tool names", () => {
    expect(paneTool({ kind: "execute", name: "shell", title: "ls -la", rawInput: {} })).toEqual({ name: "Bash", input: { command: "ls -la" } });
    expect(paneTool({ kind: "edit", name: "edit", rawInput: { filePath: "a.ts" } }).name).toBe("Edit");
    expect(paneTool({ kind: "search", name: "glob", rawInput: { pattern: "**/*.ts" } })).toEqual({ name: "Glob", input: { pattern: "**/*.ts" } });
    expect(paneTool({ kind: "search", name: "grep", rawInput: { pattern: "TODO" } }).name).toBe("Grep");
    expect(paneTool({ kind: "fetch", name: "webfetch", rawInput: { url: "https://x" } })).toEqual({ name: "WebFetch", input: { url: "https://x" } });
    expect(paneTool({ kind: "other", name: "todowrite", rawInput: { todos: [] } })).toEqual({ name: "todowrite", input: { todos: [] } });
  });

  test("a tool's content as one string: text, diffs, or its raw output", () => {
    expect(
      flattenToolContent([
        { type: "content", content: { type: "text", text: "ok" } },
        { type: "diff", path: "/w/a.ts", oldText: "x", newText: "y" },
        { type: "diff", path: "/w/b.ts", oldText: null, newText: "y" },
      ]),
    ).toBe("ok\nChanged /w/a.ts\nCreated /w/b.ts");
    expect(flattenToolContent([], { output: "raw" })).toBe("raw");
  });
});

describe("session config", () => {
  const options = [
    { id: "model", category: "model", currentValue: "a/b", options: [{ value: "a/b", name: "A B" }] },
    { id: "effort", category: "thought_level", currentValue: "default", options: ["low", "high", "xhigh", "default"].map((value) => ({ value, name: value })) },
    { id: "mode", category: "mode", currentValue: "build", options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
  ];

  test("config options by category", () => {
    const config = acpConfig(options);
    expect(config.model).toEqual({ id: "model", current: "a/b", values: [{ value: "a/b", name: "A B" }] });
    expect(config.mode?.values.map((v) => v.value)).toEqual(["build", "plan"]);
  });

  test("the pane's effort levels as OpenCode offers them", () => {
    const effort = acpConfig(options).effort!;
    expect(effortToAcp("high", effort)).toBe("high");
    expect(effortToAcp("max", effort)).toBe("xhigh");
    expect(effortToAcp(null, effort)).toBe("default");
    expect(effortToAcp("medium", effort)).toBeNull();
  });

  test("slash commands, with the hint for their input", () => {
    expect(acpCommands([{ name: "review", description: "review changes", input: { hint: "commit|branch" } }, { description: "no name" }])).toEqual([
      { name: "review", description: "review changes", argumentHint: "commit|branch" },
    ]);
  });

  test("the app's MCP servers as ACP's stdio servers", () => {
    expect(acpMcpServer({ name: "confluence", command: "node", args: ["mcp.js"], env: { TOKEN_FILE: "/t" } })).toEqual({
      name: "confluence",
      command: "node",
      args: ["mcp.js"],
      env: [{ name: "TOKEN_FILE", value: "/t" }],
    });
  });
});

describe("sessionConfigContent", () => {
  test("asks for edits, commands and fetches, over what the environment already says", () => {
    expect(JSON.parse(sessionConfigContent(undefined))).toEqual({ permission: { edit: "ask", bash: "ask", webfetch: "ask" } });
    expect(JSON.parse(sessionConfigContent(JSON.stringify({ model: "a/b", permission: { bash: "deny", read: "allow" } })))).toEqual({
      model: "a/b",
      permission: { bash: "deny", read: "allow", edit: "ask", webfetch: "ask" },
    });
    expect(JSON.parse(sessionConfigContent("not json"))).toEqual({ permission: { edit: "ask", bash: "ask", webfetch: "ask" } });
  });
});

describe("an agent's rules, asking", () => {
  test("allow becomes ask, in order, and a deny or an ask stays what it was", () => {
    const rules = [
      { action: "*", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "shell", resource: "git *", effect: "deny" },
      { action: "shell", resource: "git status*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
    ];
    // The last match wins in OpenCode: "*" stated again moves to the end,
    // where it now hides the git rules — as it did in the user's own list.
    expect(Object.entries(askingRules(rules, "shell"))).toEqual([
      ["git *", "deny"],
      ["git status*", "ask"],
      ["*", "ask"],
    ]);
    expect(askingRules(rules, "edit")).toEqual({ "*": "ask" });
    // An agent that may do nothing (`* * deny`) is not given an ask.
    expect(askingRules([{ action: "*", resource: "*", effect: "deny" }], "edit")).toEqual({ "*": "deny" });
  });

  test("`opencode debug agents` output, and a config that keeps what else an agent's section says", () => {
    const agents = parseResolvedAgents(
      JSON.stringify([
        { id: "build", mode: "primary", permissions: [{ action: "shell", resource: "rm *", effect: "deny" }, { action: 1 }] },
        { name: "no id" },
      ]),
    );
    expect(agents).toEqual([{ id: "build", rules: [{ action: "shell", resource: "rm *", effect: "deny" }] }]);
    expect(parseResolvedAgents("Error: no such command")).toBeNull();
    const config = JSON.parse(sessionConfigContent(JSON.stringify({ agent: { build: { model: "a/b", permission: { read: "allow" } } } }), agents));
    expect(config.agent.build).toEqual({
      model: "a/b",
      permission: { read: "allow", edit: { "*": "ask" }, bash: { "*": "ask", "rm *": "deny" }, webfetch: { "*": "ask" } },
    });
  });
});

describe("where the CLI is", () => {
  const realPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = realPath;
  });

  test("PATH first, else where OpenCode's installer puts it — a desktop app's PATH lacks that folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "specdriven-opencode-home-"));
    try {
      process.env.PATH = join(home, "empty");
      expect(findOpencode(home)).toBeNull();
      const installed = installerPath(home);
      await mkdir(join(home, ".opencode", "bin"), { recursive: true });
      await writeFile(installed, "#!/bin/sh\n");
      await chmod(installed, 0o755);
      expect(findOpencode(home)).toBe(installed);
      await mkdir(join(home, "bin"));
      await writeFile(join(home, "bin", "opencode"), "#!/bin/sh\n");
      await chmod(join(home, "bin", "opencode"), 0o755);
      process.env.PATH = join(home, "bin");
      expect(findOpencode(home)).toBe(join(home, "bin", "opencode"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("modelMenu", () => {
  const catalog = ["a/1", "a/2", "b/1"];
  test("the data repo's list, whole and in its order", () => {
    expect(modelMenu({ catalog, listed: ["b/1", "x/9", "b/1"], recent: ["a/1"], defaultModel: "a/2" }).map((m) => m.value)).toEqual(["b/1", "x/9"]);
  });
  test("else the default and the recent models OpenCode still offers", () => {
    expect(modelMenu({ catalog, listed: [], recent: ["b/1", "gone/1", "a/2"], defaultModel: "a/2" }).map((m) => m.value)).toEqual(["a/2", "b/1"]);
  });
  test("else the catalog", () => {
    expect(modelMenu({ catalog, listed: [], recent: [], defaultModel: null }).map((m) => m.value)).toEqual(catalog);
  });
  test("`opencode models` output: one provider/model per line, and nothing else", () => {
    expect(parseModels("a/1\nopenrouter/z-ai/glm-4.7\n\nSome notice\n  b/2  \n")).toEqual(["a/1", "openrouter/z-ai/glm-4.7", "b/2"]);
  });
});

describe("AcpClient", () => {
  test("answers come back by id, errors with their detail, and an exit settles what is pending", async () => {
    let fake: FakeOpencode | null = null;
    const requests: string[] = [];
    let exited: number | null | undefined;
    const client = new AcpClient({
      bin: "opencode",
      args: ["acp"],
      cwd: "/",
      env: {},
      onNotification: () => {},
      onRequest: (_id, method) => requests.push(method),
      onStderr: () => {},
      onExit: (code) => {
        exited = code;
      },
      spawn: (options) => (fake = new FakeOpencode(options)),
    });
    const init = await client.request("initialize", {});
    expect(init).toMatchObject({ ok: true, result: { agentInfo: { name: "OpenCode" } } });
    const pending = client.request("session/prompt", {}, 0);
    fake!.send({ id: 99, method: "fs/read_text_file", params: {} });
    expect(requests).toEqual(["fs/read_text_file"]);
    fake!.send({ id: 2, error: { code: -32000, message: "Auth required", data: { message: "run opencode auth login" } } });
    expect(await pending).toEqual({ ok: false, error: "Auth required: run opencode auth login", code: -32000 });
    const hanging = client.request("session/prompt", {}, 0);
    fake!.exit(1);
    expect(await hanging).toEqual({ ok: false, error: "OpenCode exited" });
    expect(exited).toBe(1);
  });
});

describe("one-shot turns", () => {
  function fakeRun(lines: Record<string, unknown>[], code = 0): { spawned: OpencodeSpawnOptions[]; procs: FakeOpencode[] } {
    const spawned: OpencodeSpawnOptions[] = [];
    const procs: FakeOpencode[] = [];
    setOpencodeSpawn((options) => {
      spawned.push(options);
      const proc = new FakeOpencode(options);
      procs.push(proc);
      queueMicrotask(() => {
        for (const line of lines) options.onStdout(JSON.stringify(line) + "\n");
        proc.exit(code);
      });
      return proc;
    });
    return { spawned, procs };
  }

  test("`opencode run` with the Plan agent; the text parts are the answer, parsed when a schema asks", async () => {
    const { spawned, procs } = fakeRun([
      { type: "step_start" },
      { type: "text", part: { type: "text", text: '{"hours":' } },
      { type: "text", part: { type: "text", text: " 3}" } },
      { type: "step_finish" },
    ]);
    const schema = { type: "object", properties: { hours: { type: "number" } } };
    const result = await opencodeOneShot({ cwd: "/w", systemPrompt: "You estimate.", prompt: "How long?", schema, model: "a/b", timeoutMs: 5000 });
    expect(result).toEqual({ text: '{"hours": 3}', structured: { hours: 3 }, isError: false });
    // A private server (no background service left behind), read-only, out
    // of OpenCode's session list; the message on stdin, which is then closed.
    expect(spawned[0]!.args).toEqual(["run", "--standalone", "--format", "json", "--agent", "plan", "--archived", "-m", "a/b"]);
    expect(runArgs()).toEqual(["run", "--standalone", "--format", "json", "--agent", "plan", "--archived"]);
    expect(procs[0]!.stdin).toBe(oneShotMessage({ systemPrompt: "You estimate.", prompt: "How long?", schema }));
    expect(procs[0]!.stdin).toStartWith("You estimate.\n\nHow long?\n\nAnswer with one JSON value");
    expect(procs[0]!.ended).toBe(true);
    expect(spawned[0]!.cwd).toBe("/w");
  });

  test("an error event is the answer's absence, in OpenCode's words", async () => {
    fakeRun([{ type: "error", error: { type: "provider.no-route", message: "Model unavailable: nope/x" } }]);
    expect(await opencodeOneShot({ cwd: "/", systemPrompt: "", prompt: "hi", timeoutMs: 5000 })).toEqual({
      text: "Model unavailable: nope/x",
      isError: true,
    });
  });

  test("a fenced JSON answer still parses", () => {
    expect(parseAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseAnswer("not json")).toBeUndefined();
  });
});
