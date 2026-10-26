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
import type { ChatEvent, ChatSessionMeta, SlashCommandInfo } from "@specdriven/app/src/server/agentChat";
import { createFeature, saveFeature } from "@specdriven/app/src/server/features";
import { PROJECT_SETTINGS_FILE } from "@specdriven/app/src/server/members";
import { pluginSection } from "@specdriven/app/src/plugins/host/pluginSettings";
import { secretStore, setSecretBackend } from "@specdriven/app/src/server/secrets";
import { readState, writeState } from "@specdriven/app/src/server/state";
import {
  InputQueue,
  claudeBaseUrl,
  describeAccount,
  mapSdkMessage,
  setClaudeFirstResponseSeconds,
  setQueryFactory,
} from "../src/provider";
import type { AccountInfoLike, QueryLike } from "../src/provider";
import { setClaudeAvailability } from "../src/cli";
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
  async supportedCommands() {
    return this.commands;
  }
  async accountInfo() {
    return fakeAccount;
  }
}

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

  const state = (await (await api("/api/state")).json()) as { canRunAgentPane: boolean };
  expect(state.canRunAgentPane).toBe(true);
  setClaudeAvailability(() => false);
  const noCli = await api("/api/agent/chat", "POST", { name: "chat", agent: "claude" });
  expect(noCli.status).toBe(502);
  expect((await noCli.json()).error).toContain("Claude CLI not found");
  const again = (await (await api("/api/state")).json()) as { canRunAgentPane: boolean };
  expect(again.canRunAgentPane).toBe(false);
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
    target: "pane",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; name: string; target: string };
  // "pane" is the pre-plugin name for Claude in the pane; the answer names the provider.
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

  // "pane" is what the app stored before agents were providers; it is
  // read as Claude and stored as such (src/server/agentLegacy.ts).
  const stored = await api("/api/state", "PUT", { codeGenTarget: "pane" });
  expect(stored.status).toBe(200);
  expect((await readState(root)).codeGenTarget).toBe("claude");
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
  // Claude Code's own retries are no answer from the API.
  fake.emit(apiRetry(1));
  fake.emit(apiRetry(2));
  const snap = await until(
    () => snapshot(id),
    (s) => s.events.some((e) => e.kind === "note" && e.level === "error"),
  );
  expect(fake.interrupts).toBe(1);
  const note = snap.events.find((e) => e.kind === "note" && e.level === "error");
  expect(note).toMatchObject({ code: "api" });
  expect(note && "text" in note ? note.text : "").toContain(
    "No response from the API at http://127.0.0.1:9 within 0s after 2 retries",
  );
  // Claude Code answers the interrupt with the turn's result; the session
  // stays up for the next try.
  fake.emit(result({ subtype: "error_during_execution", is_error: true, errors: [] }));
  await untilStatus(id, "idle");
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
  expect(JSON.parse(login.extraArgs!.settings!)).toEqual({
    env: { ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "" },
  });
  expect(login.env?.ANTHROPIC_BASE_URL).toBeUndefined();
});
