// Automates specs/agents/agent-pane.feature.md over the routes: a
// coding agent session is a live Claude Code chat the app drives itself.
// The Claude Agent SDK is swapped for a fake query the test steers from
// both ends — what Claude "says" and what it asks — so nothing spawns.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { handleApi, reloader } from "@specdriven/app/src/server/api";
import { createChatSession, endAllChatSessions, getChatEvents } from "@specdriven/app/src/server/agentChat";
import * as engine from "@specdriven/app/src/server/agentChat";
import { agents } from "@specdriven/app/src/plugins/host/agents";
import type { ChatEvent, ChatSessionMeta, SlashCommandInfo } from "@specdriven/app/src/server/agentTypes";
import { createFeature, saveFeature } from "@specdriven/app/src/server/features";
import { PROJECT_SETTINGS_FILE } from "@specdriven/app/src/server/members";
import { pluginSection } from "@specdriven/app/src/plugins/host/pluginSettings";
import { secretStore, setSecretBackend } from "@specdriven/app/src/server/secrets";
import { readState, writeState } from "@specdriven/app/src/server/state";
import { categoryId, contextUsageOf, contextWindowOf, tokensInWindow } from "../src/contextUsage";
import {
  InputQueue,
  claudeBaseUrl,
  createClaudeProvider,
  describeAccount,
  mapSdkMessage,
  mcpServerConfigs,
  setClaudeFirstResponseSeconds,
  setClaudeRetryPauseMs,
  setQueryFactory,
} from "../src/provider";
import type { AccountInfoLike, QueryLike } from "../src/provider";
import { ACCOUNT_SETTINGS } from "../src/auth";
import { setClaudeAvailability } from "../src/cli";
import { AGENT_MODELS_FILE } from "../src/models";
import { DEFAULT_SETTINGS } from "../src/settings";
import { mountPlugin, quietProfile } from "./app";

/** The proxy token's store, as HostConfig.secrets("token") names it for this plugin. */
const tokenStore = () => secretStore("agent-claude.token");
let unmount: () => Promise<void> = async () => {};

/** A stand-in for the SDK's Query: the test pushes Claude's messages in and
    reads the user messages the app pushed out. */
class FakeQuery implements QueryLike {
  readonly out = new InputQueue<SDKMessage>();
  readonly inputs: SDKUserMessage[] = [];
  interrupts = 0;
  modes: string[] = [];
  /** What the pane switched mid-session: setModel, applyFlagSettings. */
  models: (string | undefined)[] = [];
  flags: Record<string, unknown>[] = [];
  commands: SlashCommandInfo[] = [
    { name: "compact", description: "Compact the conversation", argumentHint: "" },
    { name: "review", description: "Review code", argumentHint: "[files]" },
  ];
  private waiters: (() => void)[] = [];

  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    void (async () => {
      for await (const m of prompt) {
        this.inputs.push(m);
        for (const w of this.waiters.splice(0)) w();
      }
    })();
    options.abortController?.signal.addEventListener("abort", () => this.out.close());
  }

  emit(message: SDKMessage): void {
    this.out.push(message);
  }

  /** The n-th user message the app pushed (1-based), once it is there. */
  async input(n = 1): Promise<SDKUserMessage> {
    while (this.inputs.length < n) await new Promise<void>((r) => this.waiters.push(r));
    return this.inputs[n - 1]!;
  }

  [Symbol.asyncIterator]() {
    return this.out[Symbol.asyncIterator]();
  }
  async interrupt() {
    this.interrupts += 1;
  }
  async setPermissionMode(mode: string) {
    this.modes.push(mode);
  }
  async setModel(model?: string) {
    this.models.push(model);
  }
  async applyFlagSettings(settings: Record<string, unknown>) {
    this.flags.push(settings);
  }
  /** What the plugin asked of thinking: the budget, and how it is reported. */
  thinkingAsks: [number | null, string | null | undefined][] = [];
  async setMaxThinkingTokens(max: number | null, display?: string | null) {
    this.thinkingAsks.push([max, display]);
    if (fakeThinkingRefused) throw new Error("Unsupported control request: set_max_thinking_tokens");
  }
  async supportedCommands() {
    return this.commands;
  }
  async accountInfo() {
    return fakeAccount;
  }
  /** The details the plugin asked the context count for. */
  contextAsks: string[] = [];
  async getContextUsage(opts?: { detail?: string }) {
    this.contextAsks.push(opts?.detail ?? "full");
    // No answer set: an older Claude Code, which refuses the request.
    if (!fakeContext) throw new Error("Unsupported control request: get_context_usage");
    return fakeContext(opts?.detail ?? "full");
  }
}

/** Whether the next FakeQuery refuses the thinking request, as an older Claude Code would. */
let fakeThinkingRefused = false;

/** What the next FakeQuery answers the context count with; undefined refuses it. */
let fakeContext: ((detail: string) => Promise<unknown>) | undefined;

/** What the next FakeQuery says of the login; undefined, as an older
    Claude Code would. */
let fakeAccount: AccountInfoLike | undefined;

let root: string;
let home: string;
let data: string;
let fakes: FakeQuery[];
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
// The account chip reads Claude Code's settings; keep the developer's own
// ~/.claude and shell out of the tests.
const realClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
const realBaseUrl = process.env.ANTHROPIC_BASE_URL;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-agent-chat-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-agent-chat-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  delete process.env.ANTHROPIC_BASE_URL;
  data = join(root, "data");
  fakes = [];
  fakeAccount = undefined;
  fakeContext = undefined;
  fakeThinkingRefused = false;
  setClaudeAvailability(() => true);
  setQueryFactory(({ prompt, options }) => {
    const fake = new FakeQuery(prompt, options);
    fakes.push(fake);
    return fake;
  });
  await writeState({ dataRepo: data, ...quietProfile(data) }, root);
  unmount = await mountPlugin();
  await createFeature(data, "Quote");
  await saveFeature(data, "specs/quote.feature.md", "# Quote\n\n## Basic @v1\n\nbody\n");
});

afterEach(async () => {
  await endAllChatSessions();
  await unmount();
  reloader.stop();
  setClaudeAvailability(null);
  setQueryFactory(null);
  setClaudeFirstResponseSeconds(null);
  setClaudeRetryPauseMs(null);
  setSecretBackend("agent-claude.token", null);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
    ["CLAUDE_CONFIG_DIR", realClaudeConfig],
    ["ANTHROPIC_BASE_URL", realBaseUrl],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

interface Snapshot {
  meta: ChatSessionMeta;
  commands: SlashCommandInfo[];
  events: ChatEvent[];
}

async function snapshot(id: string): Promise<Snapshot> {
  const res = await api(`/api/agent/chat/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Snapshot;
}

/** The pump is asynchronous; poll until the log says what we wait for. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting; last: ${JSON.stringify(v).slice(0, 400)}`);
    await Bun.sleep(10);
  }
}

const untilStatus = (id: string, status: string) =>
  until(() => snapshot(id), (s) => s.meta.status === status);

/** The third argument of canUseTool, as the SDK passes it. */
const askContext = (extra: Record<string, unknown> = {}) =>
  ({ signal: new AbortController().signal, toolUseID: "tu", requestId: "rq", ...extra }) as Parameters<
    NonNullable<Options["canUseTool"]>
  >[2];

// --- SDK messages as Claude Code emits them (shapes from sdk.d.ts) ---------

const sdk = (m: unknown) => m as SDKMessage;
const init = (sessionId = "claude-1") =>
  sdk({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "2.1.247",
    cwd: "/work",
    tools: ["Bash", "Read", "Edit"],
    mcp_servers: [],
    model: "claude-opus-5",
    permissionMode: "default",
    slash_commands: ["compact", "review"],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "u-init",
    session_id: sessionId,
  });
const messageStart = (id: string) =>
  sdk({
    type: "stream_event",
    event: { type: "message_start", message: { id, type: "message", role: "assistant", content: [] } },
    parent_tool_use_id: null,
    uuid: "u-ms",
    session_id: "claude-1",
  });
const delta = (text: string, index = 0) =>
  sdk({
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
    uuid: "u-d",
    session_id: "claude-1",
  });
/** Claude thinking, as it streams; `parent` is the subagent call it thinks under. */
const thinkingDelta = (thinking: string, index = 0, parent: string | null = null) =>
  sdk({
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } },
    parent_tool_use_id: parent,
    uuid: "u-td",
    session_id: "claude-1",
  });
const assistant = (id: string, content: unknown[]) =>
  sdk({
    type: "assistant",
    message: { id, type: "message", role: "assistant", model: "claude-opus-5", content, stop_reason: null },
    parent_tool_use_id: null,
    uuid: "u-a",
    session_id: "claude-1",
  });
const toolResult = (toolUseId: string, content: unknown, isError = false) =>
  sdk({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    uuid: "u-tr",
    session_id: "claude-1",
  });
const result = (extra: Record<string, unknown> = {}) =>
  sdk({
    type: "result",
    subtype: "success",
    duration_ms: 1200,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 2,
    result: "Done.",
    stop_reason: "end_turn",
    total_cost_usd: 0.0123,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: "u-r",
    session_id: "claude-1",
    ...extra,
  });

/** A session that has said hello: created, init in, idle. */
async function idleSession(): Promise<{ id: string; fake: FakeQuery }> {
  const res = await api("/api/agent/chat", "POST", { name: "chat" });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  const fake = fakes.at(-1)!;
  fake.emit(init());
  await untilStatus(meta.id, "idle");
  return { id: meta.id, fake };
}

test("a session starts Claude on the data repo and is ready once Claude answers", async () => {
  const res = await api("/api/agent/chat", "POST", { name: "first chat" });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  expect(["starting", "idle"]).toContain(meta.status);
  expect(meta.cwd).toBe(data);
  expect(meta.name).toBe("first chat");
  expect(fakes).toHaveLength(1);
  const { options } = fakes[0]!;
  expect(options.cwd).toBe(data);
  expect(options.includePartialMessages).toBe(true);
  // Claude decides its own permissions until the pane picks another mode.
  expect(options.permissionMode).toBe("auto");
  // A session like the CLI would open: Claude Code's prompt and settings.
  expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  expect(options.settingSources).toEqual(["user", "project", "local"]);
  expect(options.additionalDirectories).toBeUndefined();
  expect(typeof options.canUseTool).toBe("function");
  // A dev server started from a Claude Code terminal must not pass the
  // nesting marker on.
  expect(options.env?.CLAUDECODE).toBeUndefined();

  // Ready before any turn: Claude Code answers the command list as soon as
  // it is up, and sends init only with the first message.
  const ready = await untilStatus(meta.id, "idle");
  expect(ready.commands.some((c) => c.description === "Review code")).toBe(true);
  expect(ready.meta.agentSessionId).toBeUndefined();
  expect(ready.events.filter((e) => e.kind === "status").at(-1)).toMatchObject({
    status: "idle",
    commands: expect.arrayContaining([expect.objectContaining({ name: "review" })]),
  });

  fakes[0]!.emit(init("claude-abc"));
  const snap = await until(() => snapshot(meta.id), (s) => s.meta.agentSessionId === "claude-abc");
  expect(snap.meta.status).toBe("idle");
  expect(snap.meta.model).toBe("claude-opus-5");
  const kinds = snap.events.map((e) => e.kind);
  expect(kinds[0]).toBe("status");
  expect(snap.events.find((e) => e.kind === "note")).toMatchObject({
    code: "init",
    text: expect.stringContaining("claude-opus-5"),
  });
  // The init status carries what the session is made of.
  expect(snap.events.find((e) => e.kind === "status" && e.tools)).toMatchObject({
    status: "idle",
    tools: ["Bash", "Read", "Edit"],
    agentSessionId: "claude-abc",
  });

  // The record sits beside the settings — never in the data repo, which is
  // pushed to git.
  // The init's write is queued behind the earlier ones; wait for it to land.
  const record = await until(
    async () =>
      JSON.parse(await readFile(join(root, ".specdriven", "sessions", meta.id, "session.json"), "utf8")),
    (r) => r.agentSessionId === "claude-abc",
  );
  // The record names the provider, not the pane it ran in (src/server/agentLegacy.ts).
  expect(record).toMatchObject({ agent: "claude", cwd: data, dataRepo: data, agentSessionId: "claude-abc" });
  expect(ready.meta.agent).toBe("claude");
  expect(stat(join(data, ".specdriven", "sessions"))).rejects.toThrow();

  const list = (await (await api("/api/agent/chat")).json()) as { sessions: ChatSessionMeta[] };
  expect(list.sessions.map((s) => s.id)).toEqual([meta.id]);
});

test("a turn goes to Claude and its reply streams into the event log", async () => {
  const { id, fake } = await idleSession();
  const sent = await api(`/api/agent/chat/${id}/message`, "POST", { text: "list the files here" });
  expect(sent.status).toBe(200);
  expect(((await sent.json()) as { event: ChatEvent }).event).toMatchObject({
    kind: "user",
    text: "list the files here",
  });
  const input = await fake.input(1);
  expect(input.message.content).toBe("list the files here");
  expect((await snapshot(id)).meta.status).toBe("running");

  // One turn at a time — the pane says Stop first.
  const again = await api(`/api/agent/chat/${id}/message`, "POST", { text: "and again" });
  expect(again.status).toBe(409);
  expect((await again.json()).error).toContain("Stop");

  fake.emit(messageStart("msg_1"));
  fake.emit(delta("Here "));
  fake.emit(delta("you go."));
  await until(
    () => snapshot(id),
    (s) => s.events.filter((e) => e.kind === "text_delta").length === 2,
  );
  expect((await snapshot(id)).events.filter((e) => e.kind === "text_delta")).toMatchObject([
    { messageId: "msg_1", text: "Here " },
    { messageId: "msg_1", text: "you go." },
  ]);
  fake.emit(
    assistant("msg_1", [
      { type: "text", text: "Here you go." },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ]),
  );
  fake.emit(toolResult("tu_1", "a.txt\nb.txt"));
  fake.emit(result());
  const snap = await untilStatus(id, "idle");
  const kinds = snap.events.map((e) => e.kind);
  // The deltas are gone once the final message covers them.
  expect(kinds).not.toContain("text_delta");
  const order = ["user", "assistant", "tool_result", "result"].map((k) => (kinds as string[]).indexOf(k));
  expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
  expect(snap.events.find((e) => e.kind === "assistant")).toMatchObject({
    messageId: "msg_1",
    turn: 1,
    blocks: [
      { type: "text", text: "Here you go." },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ],
  });
  expect(snap.events.find((e) => e.kind === "tool_result")).toMatchObject({
    toolUseId: "tu_1",
    content: "a.txt\nb.txt",
    isError: false,
  });
  expect(snap.events.find((e) => e.kind === "result")).toMatchObject({
    turn: 1,
    subtype: "success",
    costUsd: 0.0123,
    durationMs: 1200,
    numTurns: 2,
    text: "Done.",
    denials: 0,
  });
  // Sequence numbers only ever go up, gaps included.
  const seqs = snap.events.map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(snap.meta.lastSeq).toBe(seqs.at(-1)!);
});

// specs/agents/claude.feature.md "Claude reports its thinking to the pane":
// the pane's Thinking and Verbose transcript views show what Claude thought.
// An app from before those views has no type for the events, so they are
// read here by name; its log carries them all the same.
const kindOf = (e: ChatEvent) => e.kind as string;

test("what Claude thinks streams into the event log and settles as a thinking block of its message", async () => {
  expect((agents.get("claude")!.capabilities as { thinking?: boolean }).thinking).toBe(true);
  const { id, fake } = await idleSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "implement the quote spec" });
  await fake.input(1);
  fake.emit(messageStart("msg_t"));
  fake.emit(thinkingDelta("Read the spec "));
  fake.emit(thinkingDelta("first."));
  const streamed = await until(
    () => snapshot(id),
    (s) => s.events.filter((e) => kindOf(e) === "thinking_delta").length === 2,
  );
  expect(streamed.events.filter((e) => kindOf(e) === "thinking_delta") as unknown[]).toMatchObject([
    { messageId: "msg_t", index: 0, text: "Read the spec " },
    { messageId: "msg_t", index: 0, text: "first." },
  ]);
  // The thought whole, then the words it led to: two blocks of one message.
  fake.emit(assistant("msg_t", [{ type: "thinking", thinking: "Read the spec first.", signature: "sig" }]));
  fake.emit(delta("On it.", 1));
  fake.emit(assistant("msg_t", [{ type: "text", text: "On it." }]));
  fake.emit(result());
  const snap = await untilStatus(id, "idle");
  const said = snap.events.filter((e) => e.kind === "assistant") as unknown as { messageId: string; blocks: unknown[] }[];
  expect(said.map((e) => [e.messageId, e.blocks])).toEqual([
    ["msg_t", [{ type: "thinking", text: "Read the spec first." }]],
    ["msg_t", [{ type: "text", text: "On it." }]],
  ]);
  // The turn ran as any other: thinking is no reply and ends no turn.
  expect(snap.events.find((e) => e.kind === "result")).toMatchObject({ subtype: "success", isError: false });
});

test("mapSdkMessage passes on what Claude thinks, streamed and whole, and nothing for thinking Claude keeps to itself", () => {
  const stream = { messageId: null as string | null };
  mapSdkMessage(messageStart("msg_t"), { turn: 1 }, stream);
  expect(mapSdkMessage(thinkingDelta("Hmm", 0), { turn: 1 }, stream) as unknown[]).toEqual([
    { kind: "thinking_delta", messageId: "msg_t", index: 0, text: "Hmm" },
  ]);
  // A subagent's stream names the call that started it, thinking and words alike.
  expect(mapSdkMessage(thinkingDelta("Look", 0, "task_1"), { turn: 1 }, stream) as unknown[]).toEqual([
    { kind: "thinking_delta", messageId: "msg_t", index: 0, text: "Look", parentToolUseId: "task_1" },
  ]);
  const subagentWords = sdk({
    type: "stream_event",
    event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Found it." } },
    parent_tool_use_id: "task_1",
    uuid: "u-d",
    session_id: "claude-1",
  });
  expect(mapSdkMessage(subagentWords, { turn: 1 }, stream) as unknown[]).toEqual([
    { kind: "text_delta", messageId: "msg_t", index: 1, text: "Found it.", parentToolUseId: "task_1" },
  ]);
  // Thinking Claude Code keeps to itself streams empty, with a signature
  // and a token estimate: nothing for the pane.
  expect(mapSdkMessage(thinkingDelta(""), { turn: 1 }, stream)).toEqual([]);
  const signature = sdk({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    parent_tool_use_id: null,
    uuid: "u-sd",
    session_id: "claude-1",
  });
  expect(mapSdkMessage(signature, { turn: 1 }, stream)).toEqual([]);
  expect(
    mapSdkMessage(sdk({ type: "system", subtype: "thinking_tokens", estimated_tokens: 40, estimated_tokens_delta: 8 }), { turn: 1 }),
  ).toEqual([]);

  // Whole: the thought is a block of its message, before the words; a
  // redacted thought and an empty one add nothing.
  expect(
    mapSdkMessage(
      assistant("msg_t", [
        { type: "thinking", thinking: "Plan it.", signature: "sig" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "thinking", thinking: "  ", signature: "sig" },
        { type: "text", text: "Done." },
      ]),
      { turn: 2 },
    ) as unknown[],
  ).toEqual([
    {
      kind: "assistant",
      messageId: "msg_t",
      turn: 2,
      blocks: [
        { type: "thinking", text: "Plan it." },
        { type: "text", text: "Done." },
      ],
      parentToolUseId: null,
    },
  ]);
  // A message that is nothing but thinking kept back is no event at all.
  expect(mapSdkMessage(assistant("msg_u", [{ type: "thinking", thinking: "", signature: "sig" }]), { turn: 2 })).toEqual([]);
});

test("a session asks Claude Code for a summary of its thinking and leaves thinking itself as its settings have it", async () => {
  const { id, fake } = await idleSession();
  // The budget is left alone (null), only how thinking is reported is asked for.
  expect(fake.thinkingAsks).toEqual([[null, "summarized"]]);
  // Nothing at the start switches thinking on over Claude Code's settings.
  const options = fake.options as { thinking?: unknown; maxThinkingTokens?: unknown };
  expect(options.thinking).toBeUndefined();
  expect(options.maxThinkingTokens).toBeUndefined();
  // Asked once per run of Claude Code, not per message.
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  await fake.input(1);
  fake.emit(result());
  await untilStatus(id, "idle");
  expect(fake.thinkingAsks).toHaveLength(1);
});

test("a Claude Code that refuses the thinking request still runs the session", async () => {
  fakeThinkingRefused = true;
  const { id, fake } = await idleSession();
  expect(fake.thinkingAsks).toEqual([[null, "summarized"]]);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  await fake.input(1);
  fake.emit(assistant("msg_1", [{ type: "text", text: "Going." }]));
  fake.emit(result());
  const snap = await untilStatus(id, "idle");
  expect(snap.events.some((e) => e.kind === "note" && e.level === "error")).toBe(false);
  expect(snap.events.find((e) => e.kind === "assistant")).toMatchObject({ blocks: [{ type: "text", text: "Going." }] });
});

// A 1×1 PNG, as the pane sends a pasted one.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pngBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } } as const;

// Apps from 0.1.230 carry pasted images to the agent; the floor and
// release rows run an older app, whose engine has no images to hand over.
const appHandsImages = "getChatImage" in engine;
test.if(appHandsImages)("pasted images go to Claude as image blocks before the text, and images alone carry no text block", async () => {
  expect((agents.get("claude")!.capabilities as { images?: boolean }).images).toBe(true);
  const { id, fake } = await idleSession();
  const sent = await api(`/api/agent/chat/${id}/message`, "POST", {
    text: "what is wrong here?",
    images: [{ mediaType: "image/png", data: PNG_1X1 }],
  });
  expect(sent.status).toBe(200);
  expect((await fake.input(1)).message.content).toEqual([pngBlock, { type: "text", text: "what is wrong here?" }]);
  fake.emit(result());
  await untilStatus(id, "idle");

  await api(`/api/agent/chat/${id}/message`, "POST", { images: [{ mediaType: "image/png", data: PNG_1X1 }] });
  expect((await fake.input(2)).message.content).toEqual([pngBlock]);

  // A session started from a paste opens with it.
  const res = await api("/api/agent/chat", "POST", {
    name: "from a paste",
    prompt: "explain",
    images: [{ mediaType: "image/png", data: PNG_1X1 }],
  });
  expect(res.status).toBe(200);
  expect((await fakes.at(-1)!.input(1)).message.content).toEqual([pngBlock, { type: "text", text: "explain" }]);
});

test("the event stream replays what a reconnecting pane missed", async () => {
  const { id, fake } = await idleSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "hi" });
  fake.emit(assistant("msg_1", [{ type: "text", text: "Hello." }]));
  fake.emit(result());
  const snap = await untilStatus(id, "idle");
  const assistantSeq = snap.events.find((e) => e.kind === "assistant")!.seq;
  const later = getChatEvents(id, assistantSeq);
  expect(later.map((e) => e.kind)).toEqual(["result", "status"]);
  expect(later.every((e) => e.seq > assistantSeq)).toBe(true);

  const res = await api(`/api/agent/chat/${id}/events?after=${assistantSeq}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n").filter(Boolean).length < 2) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChatEvent);
  expect(lines.map((e) => e.kind)).toEqual(["result", "status"]);

  const missing = await api(`/api/agent/chat/nope/events`);
  expect(missing.status).toBe(404);
});

test("a permission request waits for the pane's answer", async () => {
  const { id, fake } = await idleSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "clean up" });
  const suggestion = {
    type: "addRules" as const,
    rules: [{ toolName: "Bash", ruleContent: "rm *" }],
    behavior: "allow" as const,
    destination: "localSettings" as const,
  };
  const asked = fake.options.canUseTool!(
    "Bash",
    { command: "rm -rf build" },
    askContext({ suggestions: [suggestion] }),
  );
  const snap = await untilStatus(id, "awaiting_input");
  const request = snap.events.find((e) => e.kind === "permission_request")!;
  expect(request).toMatchObject({
    toolName: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [suggestion],
  });
  const requestId = (request as { requestId: string }).requestId;

  // Allow always: the SDK's own suggested rule goes back with the answer.
  const ok = await api(`/api/agent/chat/${id}/permission`, "POST", {
    requestId,
    behavior: "allow",
    remember: true,
  });
  expect(ok.status).toBe(200);
  expect(await asked).toEqual({
    behavior: "allow",
    updatedInput: { command: "rm -rf build" },
    updatedPermissions: [suggestion],
  });
  const after = await untilStatus(id, "running");
  expect(after.events.find((e) => e.kind === "permission_resolved")).toMatchObject({
    requestId,
    behavior: "allow",
    via: "user",
  });
  // Answered is answered.
  const twice = await api(`/api/agent/chat/${id}/permission`, "POST", { requestId, behavior: "deny" });
  expect(twice.status).toBe(404);

  // Deny, with a reason Claude gets to read.
  const denied = fake.options.canUseTool!("Write", { file_path: "x" }, askContext());
  const s2 = await until(
    () => snapshot(id),
    (s) => s.events.filter((e) => e.kind === "permission_request").length === 2,
  );
  const r2 = (s2.events.filter((e) => e.kind === "permission_request").at(-1) as { requestId: string })
    .requestId;
  await api(`/api/agent/chat/${id}/permission`, "POST", { requestId: r2, behavior: "deny", message: "not that file" });
  expect(await denied).toEqual({ behavior: "deny", message: "not that file" });

  // A clarifying question: the answers travel in updatedInput.
  const questions = [
    {
      question: "Which format?",
      header: "Format",
      options: [
        { label: "Summary", description: "short" },
        { label: "Detailed", description: "long" },
      ],
      multiSelect: false,
    },
  ];
  const question = fake.options.canUseTool!("AskUserQuestion", { questions }, askContext());
  const s3 = await until(
    () => snapshot(id),
    (s) => s.events.filter((e) => e.kind === "permission_request").length === 3,
  );
  const r3 = (s3.events.filter((e) => e.kind === "permission_request").at(-1) as { requestId: string })
    .requestId;
  await api(`/api/agent/chat/${id}/permission`, "POST", {
    requestId: r3,
    behavior: "allow",
    updatedInput: { questions, answers: { "Which format?": "Summary" } },
  });
  expect(await question).toEqual({
    behavior: "allow",
    updatedInput: { questions, answers: { "Which format?": "Summary" } },
  });

  const bad = await api(`/api/agent/chat/${id}/permission`, "POST", { requestId: "x", behavior: "maybe" });
  expect(bad.status).toBe(400);
});

test("Stop interrupts the turn and withdraws its open question", async () => {
  const { id, fake } = await idleSession();
  const idle = await api(`/api/agent/chat/${id}/interrupt`, "POST");
  expect(idle.status).toBe(409);

  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  const asked = fake.options.canUseTool!("Bash", { command: "ls" }, askContext());
  await untilStatus(id, "awaiting_input");
  const stopped = await api(`/api/agent/chat/${id}/interrupt`, "POST");
  expect(stopped.status).toBe(200);
  expect(fake.interrupts).toBe(1);
  expect(await asked).toMatchObject({ behavior: "deny" });
  const snap = await untilStatus(id, "running");
  expect(snap.events.find((e) => e.kind === "permission_resolved")).toMatchObject({ via: "interrupt" });
  expect(snap.events.find((e) => e.kind === "note" && e.code === "interrupted")).toBeDefined();
  // Claude answers the interrupt with a result, and the session is idle again.
  fake.emit(result({ subtype: "success", result: "" }));
  await untilStatus(id, "idle");
});

test("the permission mode switches mid-session", async () => {
  const created = await api("/api/agent/chat", "POST", { name: "chat", permissionMode: "acceptEdits" });
  const id = ((await created.json()) as ChatSessionMeta).id;
  const fake = fakes.at(-1)!;
  expect(fake.options.permissionMode).toBe("acceptEdits");
  // The control channel is up before the first turn, so the mode can change
  // before init; init then reports the mode Claude is in.
  await untilStatus(id, "idle");

  const res = await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "plan" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { meta: ChatSessionMeta }).meta.permissionMode).toBe("plan");
  expect(fake.modes).toEqual(["plan"]);
  expect((await snapshot(id)).events.find((e) => e.kind === "mode")).toMatchObject({ permissionMode: "plan" });
  fake.emit(sdk({ ...(init() as object), permissionMode: "plan" }));
  await until(() => snapshot(id), (s) => s.meta.agentSessionId === "claude-1");
  expect((await snapshot(id)).meta.permissionMode).toBe("plan");

  const bad = await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "yolo" });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("permissionMode must be one of");
  const badCreate = await api("/api/agent/chat", "POST", { name: "x", permissionMode: "yolo" });
  expect(badCreate.status).toBe(400);
});

test("the pane is gated by the Settings switch and the CLI on PATH", async () => {
  await writeState({ dataRepo: data, codeGen: false, ...quietProfile(data) }, root);
  const off = await api("/api/agent/chat", "POST", { name: "chat" });
  expect(off.status).toBe(403);
  expect((await off.json()).error).toContain("switched off in Settings");
  await writeState({ dataRepo: data, ...quietProfile(data) }, root);

  const claudeAvailable = async () => {
    const { agents } = (await (await api("/api/state")).json()) as { agents: { id: string; available: boolean }[] };
    return agents.find((a) => a.id === "claude")?.available;
  };
  expect(await claudeAvailable()).toBe(true);
  setClaudeAvailability(() => false);
  const noCli = await api("/api/agent/chat", "POST", { name: "chat", agent: "claude" });
  expect(noCli.status).toBe(502);
  expect((await noCli.json()).error).toContain("Claude Code is not set up");
  expect(await claudeAvailable()).toBe(false);
  expect(fakes).toHaveLength(0);
});

test("a code repo named in project-settings.json is where the chat works", async () => {
  const code = join(root, "code");
  await mkdir(code);
  await writeFile(join(data, PROJECT_SETTINGS_FILE), JSON.stringify({ "code-repo": "../code" }));
  const res = await api("/api/agent/chat", "POST", { name: "chat" });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  expect(meta.cwd).toBe(code);
  expect(meta.codeRepo).toBe(code);
  expect(meta.dataRepo).toBe(data);
  const { options } = fakes[0]!;
  expect(options.cwd).toBe(code);
  // The specs are not in the cwd; Claude may still read them.
  expect(options.additionalDirectories).toEqual([data]);

  await writeFile(join(data, PROJECT_SETTINGS_FILE), JSON.stringify({ "code-repo": "../missing" }));
  const gone = await api("/api/agent/chat", "POST", { name: "chat" });
  expect(gone.status).toBe(400);
  expect((await gone.json()).error).toContain("Code repo not found");
  expect(fakes).toHaveLength(1);
});

test("a folder the pane picks is where the chat works, over the code repo", async () => {
  const code = join(root, "code");
  const other = join(root, "elsewhere");
  await mkdir(code);
  await mkdir(other);
  await writeFile(join(data, PROJECT_SETTINGS_FILE), JSON.stringify({ "code-repo": "../code" }));
  const res = await api("/api/agent/chat", "POST", { name: "chat", cwd: `${other}/` });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  expect(meta.cwd).toBe(other);
  expect(fakes[0]!.options.cwd).toBe(other);
  // The specs still ride along.
  expect(fakes[0]!.options.additionalDirectories).toEqual([data]);

  // The data repo itself is a plain data-repo session.
  const back = (await (await api("/api/agent/chat", "POST", { name: "chat", cwd: data })).json()) as ChatSessionMeta;
  expect(back.cwd).toBe(data);
  expect(back.codeRepo).toBeUndefined();
  expect(fakes[1]!.options.additionalDirectories).toBeUndefined();

  const missing = await api("/api/agent/chat", "POST", { name: "chat", cwd: join(root, "nope") });
  expect(missing.status).toBe(400);
  expect((await missing.json()).error).toContain("Folder not found");
  const relative = await api("/api/agent/chat", "POST", { name: "chat", cwd: "code" });
  expect(relative.status).toBe(400);
  expect(fakes).toHaveLength(2);
});

test("Start session can open the generated prompt in the pane", async () => {
  const res = await api("/api/agent/session", "POST", {
    name: "implement quotes",
    files: [{ fileName: "specs/quote.feature.md" }],
    target: "claude",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; name: string; target: string };
  // The target is the provider id; the answer names it back.
  expect(body).toMatchObject({ name: "implement quotes", target: "claude" });
  const fake = fakes.at(-1)!;
  const first = await fake.input(1);
  expect(first.message.content).toContain("SpecDriven code gen session: implement quotes");
  expect(first.message.content).toContain("## Spec: specs/quote.feature.md");
  expect(first.message.content).toContain("## S1: Basic @v1");
  const snap = await snapshot(body.id);
  expect(snap.meta.name).toBe("implement quotes");
  expect(snap.events.find((e) => e.kind === "user")).toMatchObject({
    text: expect.stringContaining("## Spec: specs/quote.feature.md"),
  });
  // The prompt is already in flight, so the session is running once ready,
  // and init lands on it.
  await untilStatus(body.id, "running");
  fake.emit(init());
  await until(() => snapshot(body.id), (s) => s.meta.agentSessionId === "claude-1");
  expect((await snapshot(body.id)).meta.status).toBe("running");

  // The remembered "Run in" choice is the provider id; "pane", what the app
  // stored before agents were providers, is no longer read.
  const stored = await api("/api/state", "PUT", { codeGenTarget: "claude" });
  expect(stored.status).toBe(200);
  expect((await readState(root)).codeGenTarget).toBe("claude");
  expect((await api("/api/state", "PUT", { codeGenTarget: "pane" })).status).toBe(400);
  expect(((await (await api("/api/state")).json()) as { codeGenTarget: string }).codeGenTarget).toBe("claude");
});

test("ending a session aborts Claude, denies what it asked, and keeps the record", async () => {
  const { id, fake } = await idleSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  const asked = fake.options.canUseTool!("Bash", { command: "ls" }, askContext());
  await untilStatus(id, "awaiting_input");
  const res = await api(`/api/agent/chat/${id}`, "DELETE");
  expect(res.status).toBe(200);
  expect(fake.options.abortController!.signal.aborted).toBe(true);
  expect(await asked).toMatchObject({ behavior: "deny" });
  expect((await api(`/api/agent/chat/${id}`)).status).toBe(404);
  const list = (await (await api("/api/agent/chat")).json()) as { sessions: ChatSessionMeta[] };
  expect(list.sessions).toEqual([]);
  const record = JSON.parse(
    await readFile(join(root, ".specdriven", "sessions", id, "session.json"), "utf8"),
  );
  expect(record.status).toBe("ended");
  expect(typeof record.endedAt).toBe("string");
  expect((await api(`/api/agent/chat/${id}`, "DELETE")).status).toBe(404);
});

test("Claude exiting on its own ends the session with a note", async () => {
  const { id, fake } = await idleSession();
  fake.out.close();
  const snap = await untilStatus(id, "ended");
  expect(snap.events.find((e) => e.kind === "note" && e.code === "ended")).toMatchObject({
    text: expect.stringContaining("exited"),
  });
  const res = await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello?" });
  expect(res.status).toBe(409);
  // A final session still shows its transcript, and its stream closes at once.
  const events = await api(`/api/agent/chat/${id}/events`);
  const text = await events.text();
  const last = JSON.parse(text.trim().split("\n").at(-1)!) as ChatEvent;
  expect(last).toMatchObject({ kind: "status", status: "ended" });
});

test("a Claude that cannot start is a 502 with its words", async () => {
  setQueryFactory(() => {
    throw new Error("spawn claude ENOENT");
  });
  const res = await api("/api/agent/chat", "POST", { name: "chat" });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("spawn claude ENOENT");
  const list = (await (await api("/api/agent/chat")).json()) as { sessions: ChatSessionMeta[] };
  expect(list.sessions).toEqual([]);
});

test("InputQueue hands items over in order and ends when closed", async () => {
  const q = new InputQueue<number>();
  const seen: number[] = [];
  const consumer = (async () => {
    for await (const n of q) seen.push(n);
  })();
  q.push(1);
  q.push(2);
  await Bun.sleep(1);
  q.push(3);
  q.close();
  await consumer;
  expect(seen).toEqual([1, 2, 3]);
  expect(q.closed).toBe(true);
  expect(() => q.push(4)).toThrow();
});

test("mapSdkMessage keeps only what the pane renders", () => {
  const stream = { messageId: null as string | null };
  expect(mapSdkMessage(messageStart("msg_9"), { turn: 1 }, stream)).toEqual([]);
  expect(stream.messageId).toBe("msg_9");
  expect(mapSdkMessage(delta("x", 2), { turn: 1 }, stream)).toEqual([
    { kind: "text_delta", messageId: "msg_9", index: 2, text: "x" },
  ]);
  // Our own input coming back is not news.
  const replay = sdk({
    type: "user",
    message: { role: "user", content: "hi" },
    parent_tool_use_id: null,
    uuid: "u",
    session_id: "s",
    isReplay: true,
  });
  expect(mapSdkMessage(replay, { turn: 1 })).toEqual([]);
  // A structured tool result flattens to text; images are named.
  expect(
    mapSdkMessage(
      toolResult("tu", [{ type: "text", text: "one" }, { type: "image", source: {} }], true),
      { turn: 1 },
    ),
  ).toEqual([
    { kind: "tool_result", toolUseId: "tu", content: "one\n[image]", isError: true, parentToolUseId: null },
  ]);
  // A failed turn carries the CLI's errors as its text.
  expect(
    mapSdkMessage(
      result({ subtype: "error_during_execution", is_error: true, errors: ["boom"], result: undefined }),
      { turn: 3 },
    ),
  ).toMatchObject([{ kind: "result", turn: 3, subtype: "error_during_execution", isError: true, text: "boom" }]);
  expect(mapSdkMessage(sdk({ type: "system", subtype: "status", status: "compacting" }), { turn: 1 })).toEqual([]);
});

test("describeAccount reads Claude Code's account answer", () => {
  // Shapes Claude Code 2.1.x sends in its initialize answer.
  expect(describeAccount({ email: "a@b.c", subscriptionType: "Claude Max", apiProvider: "firstParty" })).toMatchObject({
    billing: "plan",
    label: "Claude Max",
  });
  expect(describeAccount({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }).billing).toBe("plan");
  expect(describeAccount({ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }).billing).toBe("api");
  expect(describeAccount({ apiKeySource: "/login managed key", email: "a@b.c" }).billing).toBe("api");
  expect(describeAccount({ tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" })).toMatchObject({
    billing: "api",
    label: "Auth token",
  });
  expect(describeAccount({ tokenSource: "apiKeyHelper" }).billing).toBe("api");
  expect(describeAccount({ subscriptionType: "Claude API", email: "a@b.c" }).billing).toBe("api");
  expect(describeAccount({ apiProvider: "bedrock" })).toMatchObject({ billing: "provider", label: "Amazon Bedrock" });
  // Nobody signed in: Claude Code still sends tokenSource "none".
  expect(describeAccount({ tokenSource: "none", apiProvider: "firstParty" }).billing).toBe("none");
  expect(describeAccount({}).billing).toBe("none");
});

test("a Claude session shows how it is billed once Claude Code says", async () => {
  fakeAccount = { email: "dev@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" };
  const res = await api("/api/agent/chat", "POST", { name: "chat" });
  const { id } = (await res.json()) as ChatSessionMeta;
  const snap = await untilStatus(id, "idle");
  expect(snap.meta.account).toMatchObject({ billing: "plan", label: "Claude Max" });
  // The pane learns it from the same status event that says "idle".
  const ready = snap.events.find((e) => e.kind === "status" && e.status === "idle");
  expect(ready).toMatchObject({ account: { billing: "plan" } });
});

test("a Claude Code that does not say leaves the session without an account", async () => {
  const { id } = await idleSession();
  expect((await snapshot(id)).meta.account).toBeUndefined();
});

// --- a sign-in that changes under a live session -----------------------------
// (specs/agents/claude.feature.md "A live session picks up a new sign-in"):
// signed in with an email while a session ran, the pane kept the old
// account until the app was restarted. An app from before the registry's
// `changed` has no way to say so; there the plugin runs as before.

const registry = agents as { changed?(id: string): void };
const signInChanged = () => registry.changed!("claude");
const appTellsSignInChanges = typeof registry.changed === "function";

test.if(appTellsSignInChanges)("a sign-in change restarts an idle Claude session under it, carrying the conversation on", async () => {
  fakeAccount = {};
  const { id, fake } = await idleSession();
  expect((await snapshot(id)).meta.account).toMatchObject({ billing: "none", label: "Not logged in" });
  expect((await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "plan" })).status).toBe(200);
  // One more that has not had a turn yet: no conversation to carry on.
  const fresh = (await (await api("/api/agent/chat", "POST", { name: "fresh" })).json()) as ChatSessionMeta;
  await untilStatus(fresh.id, "idle");
  const freshFake = fakes.at(-1)!;

  fakeAccount = { email: "ada@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" };
  signInChanged();
  const snap = await until(() => snapshot(id), (s) => s.meta.account?.label === "Claude Max");
  expect(snap.meta.status).toBe("idle");
  expect(snap.events.filter((e) => e.kind === "note").at(-1)).toMatchObject({
    level: "info",
    text: "Claude's sign-in changed — restarted with Claude Max; the conversation carries on.",
  });
  // The next run resumes Claude Code's conversation, in the mode the pane is in;
  // the old one is gone.
  const next = fakes.find((f) => f.options.resume === "claude-1")!;
  expect(next.options.permissionMode).toBe("plan");
  expect(next.options.cwd).toBe(data);
  expect(fake.options.abortController!.signal.aborted).toBe(true);
  const freshNext = await until(async () => fakes.filter((f) => f !== freshFake && f !== fake && f !== next), (l) => l.length === 1);
  expect(freshNext[0]!.options.resume).toBeUndefined();
  expect(freshFake.options.abortController!.signal.aborted).toBe(true);

  // The next turn goes to the new run, and the old one's end is not the session's.
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "carry on" });
  expect((await next.input(1)).message.content).toBe("carry on");
  expect(fake.inputs).toHaveLength(0);
  next.emit(init());
  next.emit(result());
  const after = await untilStatus(id, "idle");
  expect(after.events.some((e) => e.kind === "note" && e.code === "ended")).toBe(false);
});

test.if(appTellsSignInChanges)("a turn under way finishes before the session picks up a new sign-in", async () => {
  const { id, fake } = await idleSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "hi" });
  await fake.input(1);
  signInChanged();
  await Bun.sleep(30);
  expect(fakes).toHaveLength(1);
  expect(fake.options.abortController!.signal.aborted).toBe(false);

  fake.emit(result());
  const next = (await until(async () => fakes[1], (f) => f !== undefined))!;
  expect(next.options.resume).toBe("claude-1");
  await until(() => snapshot(id), (s) => s.events.some((e) => e.kind === "note" && e.text.includes("sign-in changed")));
  expect((await snapshot(id)).meta.status).toBe("idle");
});

test.if(appTellsSignInChanges)("a new sign-in that cannot start Claude leaves the session as it was, saying so", async () => {
  const { id, fake } = await idleSession();
  setQueryFactory(() => {
    throw new Error("spawn claude ENOENT");
  });
  signInChanged();
  const snap = await until(() => snapshot(id), (s) => s.events.some((e) => e.kind === "note" && e.level === "error"));
  expect(snap.events.filter((e) => e.kind === "note").at(-1)).toMatchObject({
    text: "Could not pick up the new Claude sign-in: spawn claude ENOENT — start a new session.",
  });
  expect(snap.meta.status).toBe("idle");
  expect(fake.options.abortController!.signal.aborted).toBe(false);
});

test("describeAccount names a moved base URL, a local one as a proxy", () => {
  const token = { tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" };
  expect(describeAccount(token, "http://localhost:6655/anthropic/")).toEqual({
    billing: "api",
    label: "API:PROXY",
    detail: "API:localhost:6655",
  });
  expect(describeAccount(token, "http://127.0.0.1:8080").label).toBe("API:PROXY");
  expect(describeAccount(token, "https://llm.example.com/v1")).toMatchObject({
    label: "API:llm.example.com",
    detail: "API:llm.example.com",
  });
  // Even over a plan login, the calls go where the base URL says.
  expect(describeAccount({ subscriptionType: "Claude Max" }, "http://localhost:6655").label).toBe("API:PROXY");
  // Not a URL: the credential decides.
  expect(describeAccount(token, "not a url").label).toBe("Auth token");
  // A cloud provider ignores ANTHROPIC_BASE_URL.
  expect(describeAccount({ apiProvider: "bedrock" }, "http://localhost:6655").label).toBe("Amazon Bedrock");
});

test("claudeBaseUrl reads the settings Claude Code loads, the later file winning", async () => {
  const config = join(home, "claude-config");
  const cwd = join(root, "work");
  await mkdir(config, { recursive: true });
  await mkdir(join(cwd, ".claude"), { recursive: true });
  expect(await claudeBaseUrl(cwd, {}, config)).toBeUndefined();
  expect(await claudeBaseUrl(cwd, { ANTHROPIC_BASE_URL: "http://env:1" }, config)).toBe("http://env:1");
  await writeFile(join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://user:2" } }));
  expect(await claudeBaseUrl(cwd, { ANTHROPIC_BASE_URL: "http://env:1" }, config)).toBe("http://user:2");
  await writeFile(join(cwd, ".claude", "settings.json"), "{ not json");
  await writeFile(
    join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://local:3" } }),
  );
  expect(await claudeBaseUrl(cwd, {}, config)).toBe("http://local:3");
});

test("a Claude session behind a local proxy says API:PROXY", async () => {
  await mkdir(join(home, "claude"), { recursive: true });
  await writeFile(
    join(home, "claude", "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://localhost:6655/anthropic/" } }),
  );
  fakeAccount = { tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" };
  const res = await api("/api/agent/chat", "POST", { name: "chat" });
  const { id } = (await res.json()) as ChatSessionMeta;
  const snap = await untilStatus(id, "idle");
  expect(snap.meta.account).toEqual({ billing: "api", label: "API:PROXY", detail: "API:localhost:6655" });
});

// --- The first-response watchdog (specs/agents/agent-pane.feature.md "A
// Claude turn fails fast when the API proxy does not answer") ---------------

const apiRetry = (attempt: number) =>
  sdk({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: 10,
    retry_delay_ms: 500,
    error_status: null,
    error: "unknown",
    uuid: `u-retry-${attempt}`,
    session_id: "claude-1",
  });

/** A Claude chat with a first-response wait of `seconds`, idle and ready. */
async function watchedSession(seconds: number): Promise<{ id: string; fake: FakeQuery }> {
  // The Settings value is whole seconds; the provider's seam takes a fraction.
  setClaudeFirstResponseSeconds(async () => seconds);
  const meta = await createChatSession({
    place: { dataRepo: data },
    name: "chat",
    agent: "claude",
    sessionsDir: join(root, ".specdriven", "sessions"),
  });
  const fake = fakes.at(-1)!;
  fake.emit(init());
  await untilStatus(meta.id, "idle");
  return { id: meta.id, fake };
}

test("a Claude turn behind a proxy that does not answer is stopped after the wait", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  const { id, fake } = await watchedSession(0.05);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello" });
  // Claude Code's own retries are no answer from the API — and three of
  // them are three requests that failed, so the pane sends nothing again.
  fake.emit(apiRetry(1));
  fake.emit(apiRetry(2));
  fake.emit(apiRetry(3));
  const snap = await until(
    () => snapshot(id),
    (s) => s.events.some((e) => e.kind === "note" && e.level === "error"),
  );
  expect(fake.interrupts).toBe(1);
  const note = snap.events.find((e) => e.kind === "note" && e.level === "error");
  expect(note).toMatchObject({ code: "api" });
  expect(note && "text" in note ? note.text : "").toContain(
    "No response from the API at http://127.0.0.1:9 within 0s, after 3 tries",
  );
  expect(fake.inputs.length).toBe(1);
  // Claude Code answers the interrupt with the turn's result; the session
  // stays up for the next try.
  fake.emit(result({ subtype: "error_during_execution", is_error: true, errors: [] }));
  await untilStatus(id, "idle");
});

/** Claude Code's answer to an interrupt: the stopped turn's result. */
const stoppedTurn = () => result({ subtype: "error_during_execution", is_error: true, errors: [] });

const notes = (snap: Awaited<ReturnType<typeof snapshot>>, level: string) =>
  snap.events.filter((e) => e.kind === "note" && e.level === level && e.code === "api").map((e) => ("text" in e ? e.text : ""));

test("a Claude turn whose request the proxy leaves unanswered is sent again, three tries in all", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  setClaudeRetryPauseMs(20);
  const { id, fake } = await watchedSession(0.05);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello" });
  const first = await fake.input(1);

  // The first try: stopped after the wait, and said so — not as an error.
  await until(async () => fake.interrupts, (n) => n === 1);
  expect(notes(await snapshot(id), "info").at(-1)).toContain(
    "No response from the API at http://127.0.0.1:9 within 0s — trying again in 0s (try 2 of 3)",
  );
  fake.emit(stoppedTurn());
  // The same message again after the pause; the turn is still the one turn.
  expect(await fake.input(2)).toBe(first);
  expect((await snapshot(id)).meta.status).toBe("running");

  await until(async () => fake.interrupts, (n) => n === 2);
  expect(notes(await snapshot(id), "info").at(-1)).toContain("(try 3 of 3)");
  fake.emit(stoppedTurn());
  expect(await fake.input(3)).toBe(first);

  // The third try stays silent too: now the turn is stopped, with the error.
  await until(async () => fake.interrupts, (n) => n === 3);
  const failed = await until(() => snapshot(id), (s) => notes(s, "error").length > 0);
  expect(notes(failed, "error")).toEqual([
    "No response from the API at http://127.0.0.1:9 within 0s, after 3 tries — is the proxy running? " +
      "The turn was stopped; send it again once the proxy is up. (Settings → Claude sets this wait.)",
  ]);
  expect(failed.events.some((e) => e.kind === "result")).toBe(false);
  fake.emit(stoppedTurn());
  const snap = await untilStatus(id, "idle");
  // Only the last try's result reaches the pane; nothing is sent a fourth time.
  expect(snap.events.filter((e) => e.kind === "result").length).toBe(1);
  await Bun.sleep(120);
  expect(fake.inputs.length).toBe(3);
  expect(fake.interrupts).toBe(3);
});

test("a Claude turn whose second try gets an answer runs on", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  setClaudeRetryPauseMs(20);
  const { id, fake } = await watchedSession(0.05);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello" });
  await until(async () => fake.interrupts, (n) => n === 1);
  // What the stopped try still says is not shown.
  fake.emit(assistant("msg-late", [{ type: "text", text: "too late" }]));
  fake.emit(stoppedTurn());
  await fake.input(2);
  fake.emit(
    sdk({ type: "stream_event", event: { type: "ping" }, parent_tool_use_id: null, uuid: "u-p", session_id: "claude-1" }),
  );
  await Bun.sleep(120);
  expect(fake.interrupts).toBe(1);
  fake.emit(result());
  const snap = await untilStatus(id, "idle");
  expect(notes(snap, "error")).toEqual([]);
  expect(snap.events.filter((e) => e.kind === "result")).toMatchObject([{ subtype: "success" }]);
  expect(snap.events.some((e) => e.kind === "assistant")).toBe(false);
  expect(fake.inputs.length).toBe(2);
});

test("Claude Code's own retries count toward the three tries", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  setClaudeRetryPauseMs(20);
  const { id, fake } = await watchedSession(0.05);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello" });
  // Two requests failed before the wait ran out: one more try is left.
  fake.emit(apiRetry(1));
  fake.emit(apiRetry(2));
  await until(async () => fake.interrupts, (n) => n === 1);
  expect(notes(await snapshot(id), "info").at(-1)).toContain("(try 3 of 3)");
  fake.emit(stoppedTurn());
  await fake.input(2);
  await until(async () => fake.interrupts, (n) => n === 2);
  const snap = await until(() => snapshot(id), (s) => notes(s, "error").length > 0);
  expect(notes(snap, "error")[0]).toContain("within 0s, after 3 tries");
  fake.emit(stoppedTurn());
  await untilStatus(id, "idle");
  expect(fake.inputs.length).toBe(2);
});

test("Stop while the pane waits to try again ends the turn, with nothing sent again", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  setClaudeRetryPauseMs(150);
  const { id, fake } = await watchedSession(0.05);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello" });
  await until(async () => fake.interrupts, (n) => n === 1);
  fake.emit(stoppedTurn());
  await Bun.sleep(30);
  // In the pause between tries Claude Code has no turn to interrupt: the
  // stopped try's result ends the turn.
  expect((await api(`/api/agent/chat/${id}/interrupt`, "POST")).status).toBe(200);
  const snap = await untilStatus(id, "idle");
  expect(snap.events.filter((e) => e.kind === "result").length).toBe(1);
  expect(fake.interrupts).toBe(1);
  await Bun.sleep(250);
  expect(fake.inputs.length).toBe(1);

  // Stopped before Claude Code answered the pane's interrupt: that answer
  // ends the turn when it comes.
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "again" });
  await until(async () => fake.interrupts, (n) => n === 2);
  expect((await api(`/api/agent/chat/${id}/interrupt`, "POST")).status).toBe(200);
  expect((await snapshot(id)).meta.status).toBe("running");
  fake.emit(stoppedTurn());
  await untilStatus(id, "idle");
  await Bun.sleep(250);
  expect(fake.inputs.length).toBe(2);
  expect(fake.interrupts).toBe(2);
});

test("a prompt a session starts with is tried again the same way", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  setClaudeFirstResponseSeconds(async () => 0.05);
  setClaudeRetryPauseMs(20);
  await createChatSession({
    place: { dataRepo: data },
    name: "chat",
    agent: "claude",
    prompt: "explain",
    sessionsDir: join(root, ".specdriven", "sessions"),
  });
  const fake = fakes.at(-1)!;
  const first = await fake.input(1);
  await until(async () => fake.interrupts, (n) => n === 1);
  fake.emit(stoppedTurn());
  expect(await fake.input(2)).toBe(first);
});

test("a Claude turn whose API answers in time is left to run", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  const { id, fake } = await watchedSession(0.05);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello" });
  // Any streamed event counts — the API's `ping` keepalive too.
  fake.emit(
    sdk({ type: "stream_event", event: { type: "ping" }, parent_tool_use_id: null, uuid: "u-p", session_id: "claude-1" }),
  );
  await Bun.sleep(120);
  expect(fake.interrupts).toBe(0);
  expect((await snapshot(id)).meta.status).toBe("running");
});

test("a Claude turn without a proxy, or with no limit set, has no wait", async () => {
  const direct = await watchedSession(0.05);
  await api(`/api/agent/chat/${direct.id}/message`, "POST", { text: "hello" });
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  const unlimited = await watchedSession(0);
  await api(`/api/agent/chat/${unlimited.id}/message`, "POST", { text: "hello" });
  await Bun.sleep(120);
  expect(direct.fake.interrupts).toBe(0);
  expect(unlimited.fake.interrupts).toBe(0);
});

test("the first-response wait is a setting, 15 seconds unless changed", async () => {
  const read = async () => ((await (await api("/api/claude/settings")).json()) as { firstResponseSeconds: number });
  const stored = async () => pluginSection((await readState(root)) as Record<string, unknown>, "agent-claude").agentFirstResponseSeconds;
  expect((await read()).firstResponseSeconds).toBe(15);
  const off = await api("/api/claude/settings", "PUT", { firstResponseSeconds: 0 });
  expect(off.status).toBe(200);
  expect((await read()).firstResponseSeconds).toBe(0);
  expect(await stored()).toBe(0);
  await api("/api/claude/settings", "PUT", { firstResponseSeconds: 30.7 });
  expect((await read()).firstResponseSeconds).toBe(30);
  // The default is stored as no key at all.
  await api("/api/claude/settings", "PUT", { firstResponseSeconds: 15 });
  expect(await stored()).toBeUndefined();
  const bad = await api("/api/claude/settings", "PUT", { firstResponseSeconds: -1 });
  expect(bad.status).toBe(400);
});

test("a new session starts on the default model Settings names while the list holds it, else the first listed, else Claude Code's own", async () => {
  expect((await api("/api/agent/chat", "POST", { name: "plain" })).status).toBe(200);
  expect("model" in fakes.at(-1)!.options).toBe(false);

  // Settings → Claude lists Claude's models in the data repo: the first,
  // the one Settings → Claude shows chosen.
  await mkdir(join(data, ".specdriven"), { recursive: true });
  await writeFile(join(data, AGENT_MODELS_FILE), JSON.stringify({ claude: ["claude-sonnet-4-6", "opus"] }));
  expect((await api("/api/agent/chat", "POST", { name: "listed" })).status).toBe(200);
  expect(fakes.at(-1)!.options.model).toBe("claude-sonnet-4-6");

  await writeState({ dataRepo: data, pluginSettings: { "agent-claude": { adopted: true, defaultModel: "opus" } }, ...quietProfile(data) }, root);
  expect((await api("/api/agent/chat", "POST", { name: "opus" })).status).toBe(200);
  expect(fakes.at(-1)!.options.model).toBe("opus");

  // A default the list does not hold is not used: the list's first is.
  await writeState({ dataRepo: data, pluginSettings: { "agent-claude": { adopted: true, defaultModel: "sonnet" } }, ...quietProfile(data) }, root);
  expect((await api("/api/agent/chat", "POST", { name: "sonnet" })).status).toBe(200);
  expect(fakes.at(-1)!.options.model).toBe("claude-sonnet-4-6");
});

test.if(appTellsSignInChanges)("a session carried on under a new sign-in keeps the model it ran on", async () => {
  await writeState({ dataRepo: data, pluginSettings: { "agent-claude": { adopted: true, defaultModel: "opus" } }, ...quietProfile(data) }, root);
  const { fake } = await idleSession();
  expect(fake.options.model).toBe("opus");
  // Claude Code resolved the alias; the default changes meanwhile.
  await writeState({ dataRepo: data, pluginSettings: { "agent-claude": { adopted: true, defaultModel: "haiku" } }, ...quietProfile(data) }, root);
  signInChanged();
  const next = await until(async () => fakes.find((f) => f.options.resume === "claude-1"), (f) => f !== undefined);
  expect(next!.options.model).toBe("claude-opus-5");
});

// The pane's composer bar (specs/agents/claude.feature.md "Pick Claude's
// model and effort in the pane") needs an app that hands a session a model
// and effort and switches them mid-session.
const appHasComposerBar = "setChatModel" in engine;

/** A session's effort; ChatSessionMeta has it only from the app that has the bar. */
const effortOf = (meta: ChatSessionMeta) => (meta as { effort?: string }).effort;

test.if(appHasComposerBar)("a session starts on the model and effort the pane picked, over the defaults Settings names", async () => {
  await writeState(
    { dataRepo: data, pluginSettings: { "agent-claude": { adopted: true, defaultModel: "opus", defaultEffort: "low" } }, ...quietProfile(data) },
    root,
  );
  const picked = (await (await api("/api/agent/chat", "POST", { name: "picked", model: "sonnet", effort: "max" })).json()) as ChatSessionMeta;
  expect(fakes.at(-1)!.options).toMatchObject({ model: "sonnet", effort: "max" });
  fakes.at(-1)!.emit(init());
  expect(effortOf((await untilStatus(picked.id, "idle")).meta)).toBe("max");

  const plain = (await (await api("/api/agent/chat", "POST", { name: "plain" })).json()) as ChatSessionMeta;
  expect(fakes.at(-1)!.options).toMatchObject({ model: "opus", effort: "low" });
  fakes.at(-1)!.emit(init());
  // The effort Settings names is the session's, though the pane sent none.
  expect(effortOf((await untilStatus(plain.id, "idle")).meta)).toBe("low");

  await writeState({ dataRepo: data, pluginSettings: { "agent-claude": { adopted: true } }, ...quietProfile(data) }, root);
  expect((await api("/api/agent/chat", "POST", { name: "bare" })).status).toBe(200);
  expect("effort" in fakes.at(-1)!.options).toBe(false);
});

test.if(appHasComposerBar)("the pane switches a running Claude's model and effort, and the pick becomes Settings → Claude's default", async () => {
  const { id, fake } = await idleSession();
  expect((await api(`/api/agent/chat/${id}/model`, "PUT", { model: "haiku" })).status).toBe(200);
  expect((await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: "xhigh" })).status).toBe(200);
  expect(fake.models).toEqual(["haiku"]);
  expect(fake.flags).toEqual([{ effortLevel: "xhigh" }]);
  expect((await snapshot(id)).meta).toMatchObject({ model: "haiku", effort: "xhigh" });
  expect((await readState(root)).pluginSettings?.["agent-claude"]).toMatchObject({ defaultModel: "haiku", defaultEffort: "xhigh" });
  expect((await (await api("/api/claude/settings")).json())).toMatchObject({ defaultModel: "haiku", defaultEffort: "xhigh" });
  // Back to Claude Code's own: undefined to the SDK, null in Settings.
  await api(`/api/agent/chat/${id}/model`, "PUT", { model: null });
  await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: null });
  expect(fake.models).toEqual(["haiku", undefined]);
  expect(fake.flags.at(-1)).toEqual({ effortLevel: null });
  expect((await readState(root)).pluginSettings?.["agent-claude"]).toEqual({ adopted: true });
});

test.if(appHasComposerBar)("the pane's choices are the models the sign-in offers, else Claude Code's aliases, narrowed to the data repo's list", async () => {
  const listed = await (await api("/api/agent/agents/claude/choices")).json();
  expect({ ...listed.choices, account: undefined }).toEqual({
    models: [
      { value: "opus", displayName: "Opus", description: "Claude Code's latest Opus" },
      { value: "sonnet", displayName: "Sonnet", description: "Claude Code's latest Sonnet" },
      { value: "haiku", displayName: "Haiku", description: "Claude Code's latest Haiku" },
    ],
    model: null,
    effort: null,
  });
  await mkdir(join(data, ".specdriven"), { recursive: true });
  await writeFile(join(data, AGENT_MODELS_FILE), JSON.stringify({ claude: ["claude-sonnet-4-6", "opus"] }));
  const fromRepo = (await (await api("/api/agent/agents/claude/choices")).json()).choices;
  expect(fromRepo.models.map((m: { value: string }) => m.value)).toEqual(["claude-sonnet-4-6", "opus"]);
  expect(fromRepo.model).toBe("claude-sonnet-4-6");

  // A pick before any session: PUT defaults writes Settings → Claude.
  const saved = await api("/api/agent/agents/claude/defaults", "PUT", { model: "opus", effort: "high" });
  expect(saved.status).toBe(200);
  expect((await saved.json()).choices).toMatchObject({ model: "opus", effort: "high" });

  // Signed in with an account (or behind a proxy that lists them): its
  // menu, effort levels and all.
  const offered = async () => [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5", efforts: ["low", "high"] as ("low" | "high")[] },
    { value: "haiku", displayName: "Haiku", description: "", efforts: [] as [] },
  ];
  const provider = createClaudeProvider({ accountModels: offered });
  expect(await provider.choices!({ dataRepo: null })).toEqual({
    models: [
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5", efforts: ["low", "high"] },
      { value: "haiku", displayName: "Haiku", efforts: [] },
    ],
    model: null,
    effort: null,
  });
  // The data repo's list narrows it: its names, in its order, each the
  // offered row (by value or the id an alias resolves to), a stranger bare.
  const narrowed = createClaudeProvider({ accountModels: offered, listedModels: async () => ["haiku", "claude-opus-5-5", "my-model"] });
  expect(await narrowed.choices!({ dataRepo: null })).toEqual({
    models: [
      { value: "haiku", displayName: "Haiku", efforts: [] },
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5", efforts: ["low", "high"] },
      { value: "my-model", displayName: "my-model" },
    ],
    model: "haiku",
    effort: null,
  });
  // A default in Settings the list does not hold gives way to the list's
  // first; the same model under its other name (an alias of a listed id) is held.
  const stale = createClaudeProvider({
    accountModels: offered,
    listedModels: async () => ["claude-opus-5-5", "haiku"],
    settings: async () => ({ ...DEFAULT_SETTINGS, defaultModel: "sonnet" }),
  });
  expect((await stale.choices!({ dataRepo: null })).model).toBe("claude-opus-5-5");
  const aliased = createClaudeProvider({
    accountModels: offered,
    listedModels: async () => ["claude-opus-5-5"],
    settings: async () => ({ ...DEFAULT_SETTINGS, defaultModel: "default" }),
  });
  expect((await aliased.choices!({ dataRepo: null })).model).toBe("default");
  // An account list that fails to come is no list.
  const failing = createClaudeProvider({ accountModels: async () => Promise.reject(new Error("down")) });
  expect((await failing.choices!({ dataRepo: null })).models.map((m) => m.value)).toEqual(["opus", "sonnet", "haiku"]);
  // With nowhere to keep it, a default is refused.
  await expect(failing.setDefaults!({ model: "opus" })).rejects.toThrow("Claude keeps no defaults here");
});

test.if("setChatModel" in engine && typeof registry.changed === "function")("a session carried on under a new sign-in keeps the model and effort the pane switched to", async () => {
  const { id } = await idleSession();
  await api(`/api/agent/chat/${id}/model`, "PUT", { model: "haiku" });
  await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: "xhigh" });
  signInChanged();
  const next = await until(async () => fakes.find((f) => f.options.resume === "claude-1"), (f) => f !== undefined);
  expect(next!.options).toMatchObject({ model: "haiku", effort: "xhigh" });
});

test("the sign-in Settings chose reaches Claude as a --settings override (src/auth.ts)", async () => {
  // The proxy: the plugin's url and token, over whatever Claude Code's files say.
  const choose = (section: Record<string, unknown>) =>
    writeState({ dataRepo: data, pluginSettings: { "agent-claude": { adopted: true, ...section } }, ...quietProfile(data) }, root);
  await choose({ claudeAuth: "proxy", claudeProxyUrl: "http://proxy.test:9/" });
  await tokenStore().save({ token: "app-token" });
  fakeAccount = { apiProvider: "firstParty" };
  const proxied = await api("/api/agent/chat", "POST", { name: "proxied" });
  expect(proxied.status).toBe(200);
  const proxy = fakes.at(-1)!.options;
  expect(JSON.parse(proxy.extraArgs!.settings!)).toEqual({
    env: { ANTHROPIC_BASE_URL: "http://proxy.test:9/", ANTHROPIC_AUTH_TOKEN: "app-token", ANTHROPIC_API_KEY: "" },
  });
  expect(proxy.env?.CLAUDECODE).toBeUndefined();
  const meta = (await proxied.json()) as ChatSessionMeta;
  fakes.at(-1)!.emit(init());
  const ready = await untilStatus(meta.id, "idle");
  // The chip names the proxy the app chose, not one from a settings file.
  expect(ready.meta.account?.label).toBe("API:proxy.test");

  // The account: the proxy is set aside, so Claude Code's own login answers.
  await choose({ claudeAuth: "login" });
  const account = await api("/api/agent/chat", "POST", { name: "account" });
  expect(account.status).toBe(200);
  const login = fakes.at(-1)!.options;
  expect(JSON.parse(login.extraArgs!.settings!)).toEqual(JSON.parse(ACCOUNT_SETTINGS));
  expect(login.env?.ANTHROPIC_BASE_URL).toBeUndefined();
});

test("mcpServerConfigs keys the SDK's stdio configs by server name", () => {
  expect(mcpServerConfigs([{ name: "wiki", command: "/bin/x", args: ["a", "b"], env: { K: "v" } }])).toEqual({
    wiki: { type: "stdio", command: "/bin/x", args: ["a", "b"], env: { K: "v" } },
  });
});

// --- The session popover's context meter -------------------------------------
// (specs/agents/claude.feature.md "Claude reports its context usage to the
// pane"): an app with the meter lends the host a `context` and offers Refresh.
/** A session's context count; ChatSessionMeta has it only from the app that has the meter. */
type Count = { totalTokens: number; maxTokens: number | null; detail: string; model?: string; slices?: unknown[] };
const contextOf = (meta: ChatSessionMeta) => (meta as { context?: Count }).context;

/** Claude Code 2.1.318's answer for a fresh session, trimmed (recorded 2026-11-07). */
const ANSWER = {
  categories: [
    { id: "system_prompt", name: "System prompt", tokens: 241, color: "promptBorder", kind: "used" },
    { id: "system_tools", name: "System tools", tokens: 6_397, color: "inactive", kind: "used" },
    { name: "MCP tools", tokens: 1_900, color: "cyan" },
    { name: "MCP tools (deferred)", tokens: 800, color: "cyan", isDeferred: true },
    { name: "Memory files", tokens: 1_200, color: "orange" },
    { id: "skills", name: "Skills", tokens: 1_995, color: "warning", kind: "used" },
    { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33_000, color: "inactive", kind: "buffer" },
    { id: "free_space", name: "Free space", tokens: 155_267, color: "promptBorder", kind: "free" },
  ],
  totalTokens: 11_733,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 6,
  model: "claude-sonnet-4-6",
  memoryFiles: [{ path: "/work/CLAUDE.md", type: "Project", tokens: 1_200 }],
  mcpTools: [
    { name: "mcp__wiki__search", serverName: "wiki", tokens: 1_100, isLoaded: true },
    { name: "mcp__wiki__get_page", serverName: "wiki", tokens: 800 },
    { name: "mcp__jira__create", serverName: "jira", tokens: 800, isLoaded: false },
  ],
  systemTools: [{ name: "Bash", tokens: 3_000 }],
  agents: [],
  skills: { totalSkills: 1, includedSkills: 1, tokens: 1_995, skillFrontmatter: [{ name: "wordwrap", source: "userSettings", tokens: 3 }] },
  autoCompactThreshold: 167_000,
  isAutoCompactEnabled: true,
  apiUsage: null,
  gridRows: [],
};

test("Claude Code's context count becomes the pane's slices, with what each is made of", () => {
  const usage = contextUsageOf(ANSWER, "summary", "2026-11-07T10:00:00.000Z");
  expect(usage).toMatchObject({ model: "claude-sonnet-4-6", totalTokens: 11_733, maxTokens: 200_000, autoCompactAt: 167_000, detail: "estimate" });
  expect(usage.slices!.map((s) => [s.id, s.kind])).toEqual([
    ["system_prompt", "used"],
    ["system_tools", "used"],
    ["mcp_tools", "used"],
    ["mcp_tools_deferred", "deferred"],
    ["memory_files", "used"],
    ["skills", "used"],
    ["autocompact_buffer", "buffer"],
    ["free_space", "free"],
  ]);
  const by = (id: string) => usage.slices!.find((s) => s.id === id)!;
  expect(by("mcp_tools").items).toEqual([
    { name: "mcp__wiki__search", detail: "wiki", tokens: 1_100 },
    { name: "mcp__wiki__get_page", detail: "wiki", tokens: 800 },
  ]);
  expect(by("mcp_tools_deferred").items).toEqual([{ name: "mcp__jira__create", detail: "jira", tokens: 800 }]);
  expect(by("memory_files").items).toEqual([{ name: "work/CLAUDE.md", detail: "Project", tokens: 1_200 }]);
  expect(by("skills").items).toEqual([{ name: "wordwrap", detail: "userSettings", tokens: 3 }]);
  expect(by("system_tools").items).toEqual([{ name: "Bash", tokens: 3_000 }]);
  expect(by("free_space").items).toBeUndefined();
  // Measured on request; no autocompact, no reserve point.
  expect(contextUsageOf({ ...ANSWER, isAutoCompactEnabled: false }, "full", "x")).not.toHaveProperty("autoCompactAt");
  expect(contextUsageOf(ANSWER, "full", "x").detail).toBe("measured");
  expect(categoryId({ name: "Custom agents" })).toBe("custom_agents");
  // The totals an older Claude Code still gives.
  expect(tokensInWindow({ input_tokens: 10, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 300, output_tokens: 40 })).toBe(2_350);
  expect(tokensInWindow({})).toBeNull();
  expect(contextWindowOf({ "claude-opus-5": { contextWindow: 1_000_000 }, "claude-haiku-4-5": { contextWindow: 200_000 } }, "claude-opus-5")).toBe(1_000_000);
  expect(contextWindowOf({ "claude-haiku-4-5": { contextWindow: 200_000 } }, "opus")).toBe(200_000);
  expect(contextWindowOf({}, null)).toBeNull();
});

test.if("refreshChatContext" in engine)("Claude counts its context once ready and after every turn, and Refresh measures it", async () => {
  fakeContext = async () => ANSWER;
  const { id, fake } = await idleSession();
  // Counted once the session is ready: the cheap count.
  const first = await until(() => snapshot(id), (s) => contextOf(s.meta) !== undefined);
  expect(contextOf(first.meta)).toMatchObject({ totalTokens: 11_733, maxTokens: 200_000, detail: "estimate" });
  expect(fake.contextAsks).toEqual(["summary"]);

  // After a turn, once the composer is free again.
  fakeContext = async () => ({ ...ANSWER, totalTokens: 40_000 });
  expect((await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello" })).status).toBe(200);
  fake.emit(assistant("m1", [{ type: "text", text: "Hi." }]));
  fake.emit(result());
  const after = await until(() => snapshot(id), (s) => contextOf(s.meta)?.totalTokens === 40_000);
  // Plain strings: an app without the meter has no "context" event kind.
  const kinds: string[] = after.events.map((e) => e.kind);
  expect(kinds.lastIndexOf("context")).toBeGreaterThan(kinds.lastIndexOf("result"));
  expect(kinds.filter((k) => k === "context")).toHaveLength(1);
  expect(fake.contextAsks).toEqual(["summary", "summary"]);

  // A compaction changes the count: Claude says so, and it is counted again.
  fakeContext = async () => ({ ...ANSWER, totalTokens: 15_000 });
  fake.emit(sdk({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 40_000 }, uuid: "u-c", session_id: "claude-1" }));
  await until(() => snapshot(id), (s) => contextOf(s.meta)?.totalTokens === 15_000);

  // Refresh: every category counted.
  const refreshed = await api(`/api/agent/chat/${id}/context`, "POST", { detail: "full" });
  expect(refreshed.status).toBe(200);
  expect(((await refreshed.json()) as { context: { detail: string } }).context.detail).toBe("measured");
  expect(fake.contextAsks.at(-1)).toBe("full");
  // A count that fails after one that worked keeps the last, and says so on Refresh.
  fakeContext = async () => {
    throw new Error("control request timed out");
  };
  const failed = await api(`/api/agent/chat/${id}/context`, "POST", { detail: "full" });
  expect(failed.status).toBe(502);
  expect(contextOf((await snapshot(id)).meta)?.detail).toBe("measured");
});

test.if("refreshChatContext" in engine)("a Claude Code that cannot count its context is asked once, then each turn's totals stand in", async () => {
  const { id, fake } = await idleSession();
  await until(async () => fake.contextAsks.length, (n) => n === 1);
  // Nothing to say before a request has been made.
  expect(contextOf((await snapshot(id)).meta)).toBeUndefined();

  expect((await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello" })).status).toBe(200);
  fake.emit(
    sdk({
      type: "assistant",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "Hi." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 20_000, output_tokens: 488 },
      },
      parent_tool_use_id: null,
      uuid: "u-a",
      session_id: "claude-1",
    }),
  );
  fake.emit(result({ modelUsage: { "claude-opus-5": { contextWindow: 200_000 } } }));
  const s = await until(() => snapshot(id), (v) => contextOf(v.meta) !== undefined);
  expect(contextOf(s.meta)).toMatchObject({ model: "claude-opus-5", totalTokens: 21_500, maxTokens: 200_000, detail: "estimate" });
  expect(contextOf(s.meta)).not.toHaveProperty("slices");
  expect(fake.contextAsks).toHaveLength(1);
});

// specs/agents/agent-pane.feature.md "The pane header says whether the
// agent spends an account or the API": the chip before any session.
import { describeSignIn } from "../src/provider";

test("describeSignIn says API through the proxy, or the Claude account and whether it is signed in", () => {
  expect(describeSignIn({ mode: "proxy", proxyUrl: "http://localhost:6655/anthropic/", login: null })).toEqual({
    billing: "api",
    label: "API:PROXY",
    detail: "API calls go to localhost:6655",
  });
  expect(describeSignIn({ mode: "proxy", proxyUrl: "https://gw.example.com/v1", login: null })).toMatchObject({
    billing: "api",
    label: "API:gw.example.com",
  });
  expect(describeSignIn({ mode: "proxy", proxyUrl: null, login: null })).toMatchObject({ billing: "api", label: "API" });
  const login = (loggedIn: boolean, method: string, email: string | null) =>
    describeSignIn({ mode: "login", proxyUrl: null, login: { loggedIn, method, email } });
  expect(login(true, "claude.ai", "a@b.c")).toEqual({ billing: "plan", label: "Claude account", detail: "Claude account · a@b.c" });
  expect(login(true, "oauth_token", null)).toMatchObject({ billing: "plan", label: "Claude plan" });
  expect(login(false, "none", null)).toMatchObject({ billing: "none", label: "Not logged in" });
  expect(login(false, "missing", null).billing).toBe("none");
});

test("the pane's choices carry the sign-in a new session would start under, when the host says", async () => {
  const signIn = async () => describeSignIn({ mode: "proxy", proxyUrl: "http://127.0.0.1:4000", login: null });
  const choices = (await createClaudeProvider({ signIn }).choices({ dataRepo: null })) as import("../src/paneContract").AgentChoices; expect(choices.account).toMatchObject({ billing: "api" });
  expect("account" in (await createClaudeProvider().choices({ dataRepo: null }))).toBe(false);
  // A sign-in that cannot be read leaves the menus as they are.
  const broken = createClaudeProvider({ signIn: async () => Promise.reject(new Error("no CLI")) });
  expect((await broken.choices({ dataRepo: null })).models.length).toBeGreaterThan(0);
});

test.if(appHasComposerBar)("the app's choices route carries the sign-in, Not logged in with no one signed in", async () => {
  const { choices } = await (await api("/api/agent/agents/claude/choices")).json();
  expect(choices.account).toMatchObject({ billing: "none", label: "Not logged in" });
});
