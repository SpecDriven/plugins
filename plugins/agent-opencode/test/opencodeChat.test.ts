// Automates specs/agents/opencode.feature.md (specs repo): OpenCode is a
// choice of agent in the coding agent pane, driven over `opencode acp`.
// The CLI is swapped for a fake (test/fakeOpencode.ts) the test steers from
// both ends, so nothing spawns.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "@specdriven/app/src/server/api";
import { endAllChatSessions } from "@specdriven/app/src/server/agentChat";
import type { ChatEvent, ChatSessionMeta, SlashCommandInfo } from "@specdriven/app/src/server/agentTypes";
import { createFeature, saveFeature } from "@specdriven/app/src/server/features";
import { PROJECT_SETTINGS_FILE } from "@specdriven/app/src/server/members";
import { readState, writeState } from "@specdriven/app/src/server/state";
import { setOpencodeSpawn } from "../src/acp";
import { setOpencodeAvailability } from "../src/cli";
import { setModelLister } from "../src/models";
import { FakeOpencode, MODELS } from "./fakeOpencode";
import { mountPlugin, quietProfile } from "./app";

let unmount: () => Promise<void> = async () => {};
let root: string;
let home: string;
let data: string;
let fakes: FakeOpencode[];
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const realState = process.env.XDG_STATE_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-opencode-chat-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-opencode-chat-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  // OpenCode's own recent models: none, unless a test writes them.
  process.env.XDG_STATE_HOME = join(home, "state");
  data = join(root, "data");
  fakes = [];
  setOpencodeAvailability(() => true);
  setOpencodeSpawn((options) => {
    const fake = new FakeOpencode(options);
    fakes.push(fake);
    return fake;
  });
  setModelLister(async () => MODELS);
  await writeState({ dataRepo: data, ...quietProfile(data) }, root);
  unmount = await mountPlugin();
  await createFeature(data, "Quote");
  await saveFeature(data, "specs/quote.feature.md", "# Quote\n\n## Basic @v1\n\nbody\n");
});

afterEach(async () => {
  await endAllChatSessions();
  await unmount();
  reloader.stop();
  setOpencodeAvailability(null);
  setOpencodeSpawn(null);
  setModelLister(null);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
    ["XDG_STATE_HOME", realState],
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

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 600)}`);
    await Bun.sleep(10);
  }
}

const untilStatus = (id: string, status: string) => until(() => snapshot(id), (s) => s.meta.status === status);

const untilEvent = (id: string, ok: (e: ChatEvent) => boolean) =>
  until(() => snapshot(id), (s) => s.events.some(ok)).then((s) => s.events.filter(ok));

/** An OpenCode chat that has said hello: spawned, handshake and session answered. */
async function idleSession(body: Record<string, unknown> = {}): Promise<{ id: string; oc: FakeOpencode }> {
  const res = await api("/api/agent/chat", "POST", { name: "opencode chat", agent: "opencode", ...body });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  await untilStatus(meta.id, "idle");
  return { id: meta.id, oc: fakes.at(-1)! };
}

const notes = (s: Snapshot) => s.events.filter((e) => e.kind === "note").map((e) => (e as { text: string }).text);

test("an OpenCode session spawns `opencode acp` on the work dir, asking for edits and commands", async () => {
  const res = await api("/api/agent/chat", "POST", { name: "opencode chat", agent: "opencode" });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  expect(meta.agent).toBe("opencode");
  const oc = fakes[0]!;
  expect(oc.options.args).toEqual(["acp"]);
  expect(oc.options.cwd).toBe(data);
  // OpenCode runs edits and commands unasked by default; this process asks.
  const config = JSON.parse(oc.options.env.OPENCODE_CONFIG_CONTENT!) as { permission: Record<string, string> };
  expect(config.permission).toMatchObject({ edit: "ask", bash: "ask", webfetch: "ask" });

  const ready = await untilStatus(meta.id, "idle");
  expect(oc.calls("initialize")[0]!.params).toMatchObject({ protocolVersion: 1, clientInfo: { name: "specdriven" } });
  expect(oc.calls("session/new")[0]!.params).toEqual({ cwd: data, mcpServers: [] });
  expect(ready.meta.model).toBe(MODELS[0]);
  expect(ready.meta.agentSessionId).toBe("ses_fake_1");
  expect(ready.meta.permissionMode).toBe("default");
  expect(ready.commands.map((c) => c.name)).toEqual(["review"]);
  expect(notes(ready).some((t) => t.includes("OpenCode 9.9.9") && t.includes(MODELS[0]!))).toBe(true);

  const file = join(root, ".specdriven", "sessions", meta.id, "session.json");
  const record = await until(
    async () => {
      try {
        return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    (r) => r?.agentSessionId === "ses_fake_1",
  );
  expect(record).toMatchObject({ agent: "opencode", cwd: data, dataRepo: data });
});

test("a turn goes out as session/prompt, and its reply, tools, context and cost stream into the log", async () => {
  const { id, oc } = await idleSession();
  expect((await api(`/api/agent/chat/${id}/message`, "POST", { text: "add a quote" })).status).toBe(200);
  const prompt = await until(async () => oc.calls("session/prompt"), (c) => c.length === 1);
  expect(prompt[0]!.params).toEqual({ sessionId: "ses_fake_1", prompt: [{ type: "text", text: "add a quote" }] });
  expect((await snapshot(id)).meta.status).toBe("running");

  oc.update({ sessionUpdate: "agent_thought_chunk", messageId: "m0", content: { type: "text", text: "hmm" } });
  oc.update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Running " } });
  oc.update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "it" } });
  oc.update({ sessionUpdate: "tool_call", toolCallId: "t1", name: "shell", title: "shell", kind: "execute", status: "pending", rawInput: {} });
  oc.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", kind: "execute", title: "ls", rawInput: { command: "ls", workdir: data } });
  oc.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "specs\n" } }],
  });
  oc.update({ sessionUpdate: "usage_update", used: 5400, size: 131072, cost: { amount: 0.25, currency: "USD" } });
  oc.update({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Done." } });
  oc.finishPrompt();

  // The log keeps whole messages (the deltas only stream to open panes).
  const done = await untilStatus(id, "idle");
  const assistant = done.events.filter((e) => e.kind === "assistant") as Extract<ChatEvent, { kind: "assistant" }>[];
  expect(assistant.map((a) => a.blocks)).toEqual([
    [{ type: "text", text: "Running it" }],
    [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", workdir: data } }],
    [{ type: "text", text: "Done." }],
  ]);
  expect(done.events.find((e) => e.kind === "tool_result")).toMatchObject({ toolUseId: "t1", content: "specs\n", isError: false });
  expect(done.meta.context).toMatchObject({ totalTokens: 5400, maxTokens: 131072, model: MODELS[0] });
  expect(done.events.find((e) => e.kind === "result")).toMatchObject({ isError: false, costUsd: 0.25, numTurns: 1 });

  // OpenCode's cost is the session's so far: the next turn's footer is its own share.
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "again" });
  await until(async () => oc.calls("session/prompt"), (c) => c.length === 2);
  oc.update({ sessionUpdate: "usage_update", used: 6000, size: 131072, cost: { amount: 0.4, currency: "USD" } });
  oc.finishPrompt();
  const results = await until(
    async () => (await snapshot(id)).events.filter((e) => e.kind === "result") as Extract<ChatEvent, { kind: "result" }>[],
    (r) => r.length === 2,
  );
  expect(results[1]!.costUsd).toBeCloseTo(0.15, 6);
});

// A 1×1 PNG, as the pane sends a pasted one.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("pasted images go to OpenCode as image blocks of the prompt", async () => {
  const { id, oc } = await idleSession();
  await api(`/api/agent/chat/${id}/message`, "POST", {
    text: "what is wrong here?",
    images: [{ mediaType: "image/png", data: PNG_1X1 }],
  });
  const prompt = await until(async () => oc.calls("session/prompt"), (c) => c.length === 1);
  expect(prompt[0]!.params!.prompt).toEqual([
    { type: "text", text: "what is wrong here?" },
    { type: "image", data: PNG_1X1, mimeType: "image/png" },
  ]);
});

const PERMISSION_OPTIONS = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
];

function askPermission(oc: FakeOpencode, rpcId: number, toolCall: Record<string, unknown>): void {
  oc.send({
    id: rpcId,
    method: "session/request_permission",
    params: { sessionId: oc.sessionId, toolCall, options: PERMISSION_OPTIONS },
  });
}

const shellCall = (command: string) => ({
  toolCallId: `call-${command}`,
  name: "shell",
  title: command,
  kind: "execute",
  status: "pending",
  rawInput: { command },
});

const writeCall = {
  toolCallId: "call-write",
  name: "write",
  title: "hello.txt",
  kind: "edit",
  status: "pending",
  rawInput: { path: "hello.txt", content: "hi" },
  locations: [{ path: "/work/hello.txt" }],
};

async function runningTurn(oc: FakeOpencode, id: string): Promise<void> {
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  await until(async () => oc.calls("session/prompt"), (c) => c.length >= 1);
}

test("OpenCode's permission requests are the pane's cards: once, always, or a refusal", async () => {
  const { id, oc } = await idleSession();
  await runningTurn(oc, id);

  askPermission(oc, 0, shellCall("ls"));
  const [card] = (await untilEvent(id, (e) => e.kind === "permission_request")) as Extract<ChatEvent, { kind: "permission_request" }>[];
  expect(card).toMatchObject({ toolName: "Bash", input: { command: "ls" }, title: "OpenCode wants to run a command" });
  expect(card!.suggestions).toEqual([
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "session" },
  ]);
  // The row the card is about is already in the log.
  expect((await snapshot(id)).events.some((e) => e.kind === "assistant" && JSON.stringify(e).includes("call-ls"))).toBe(true);
  await api(`/api/agent/chat/${id}/permission`, "POST", { requestId: card!.requestId, behavior: "allow" });
  await until(async () => oc.answer(0), (a) => a !== undefined);
  expect(oc.answer(0)!.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

  askPermission(oc, 1, shellCall("bun test"));
  const second = (await untilEvent(id, (e) => e.kind === "permission_request")).at(-1) as { requestId: string };
  await api(`/api/agent/chat/${id}/permission`, "POST", { requestId: second.requestId, behavior: "allow", remember: true });
  await until(async () => oc.answer(1), (a) => a !== undefined);
  expect(oc.answer(1)!.result).toEqual({ outcome: { outcome: "selected", optionId: "always" } });

  askPermission(oc, 2, writeCall);
  const third = (await untilEvent(id, (e) => e.kind === "permission_request")).at(-1) as { requestId: string; toolName: string; input: unknown };
  expect(third.toolName).toBe("Write");
  expect(third.input).toMatchObject({ file_path: "hello.txt", content: "hi" });
  await api(`/api/agent/chat/${id}/permission`, "POST", { requestId: third.requestId, behavior: "deny", message: "not that file" });
  await until(async () => oc.answer(2), (a) => a !== undefined);
  expect(oc.answer(2)!.result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });

  oc.finishPrompt();
  const done = await untilStatus(id, "idle");
  expect(done.events.find((e) => e.kind === "result")).toMatchObject({ denials: 1 });
  expect(notes(done).some((t) => t.includes("does not take a reason"))).toBe(true);
});

test("bypass answers every request itself, and accept edits answers the edits", async () => {
  const { id, oc } = await idleSession({ permissionMode: "bypassPermissions" });
  expect((await snapshot(id)).meta.permissionMode).toBe("bypassPermissions");
  await runningTurn(oc, id);
  askPermission(oc, 0, shellCall("rm -rf build"));
  await until(async () => oc.answer(0), (a) => a !== undefined);
  expect(oc.answer(0)!.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

  expect((await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "acceptEdits" })).status).toBe(200);
  askPermission(oc, 1, writeCall);
  await until(async () => oc.answer(1), (a) => a !== undefined);
  expect(oc.answer(1)!.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
  askPermission(oc, 2, shellCall("ls"));
  await untilEvent(id, (e) => e.kind === "permission_request");
  expect(oc.answer(2)).toBeUndefined();
  expect((await snapshot(id)).events.filter((e) => e.kind === "permission_request")).toHaveLength(1);
});

test("plan mode is OpenCode's Plan agent, and leaving it is its Build agent", async () => {
  const { id, oc } = await idleSession();
  expect((await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "plan" })).status).toBe(200);
  expect(oc.calls("session/set_config_option").at(-1)!.params).toEqual({ sessionId: "ses_fake_1", configId: "mode", value: "plan" });
  expect(oc.mode).toBe("plan");
  expect((await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "default" })).status).toBe(200);
  expect(oc.mode).toBe("build");
  // OpenCode has no classifier to stand for "auto".
  expect((await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "auto" })).status).toBe(400);

  // A session started in plan mode starts on the Plan agent.
  const planned = await idleSession({ permissionMode: "plan" });
  expect(planned.oc.mode).toBe("plan");
});

test("Stop cancels the turn and withdraws an open card", async () => {
  const { id, oc } = await idleSession();
  await runningTurn(oc, id);
  askPermission(oc, 0, shellCall("make"));
  await untilEvent(id, (e) => e.kind === "permission_request");

  expect((await api(`/api/agent/chat/${id}/interrupt`, "POST")).status).toBe(200);
  expect(oc.calls("session/cancel")).toEqual([
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "ses_fake_1" } },
  ]);
  await until(async () => oc.answer(0), (a) => a !== undefined);
  expect(oc.answer(0)!.result).toEqual({ outcome: { outcome: "cancelled" } });

  oc.finishPrompt({ stopReason: "cancelled" });
  const done = await untilStatus(id, "idle");
  expect(done.events.find((e) => e.kind === "result")).toMatchObject({ subtype: "interrupted", isError: false, denials: 0 });
  // The call that never finished does not stay open.
  expect(done.events.find((e) => e.kind === "tool_result")).toMatchObject({ toolUseId: "call-make", content: "Stopped" });
});

test("a turn OpenCode refuses ends with its words", async () => {
  const { id, oc } = await idleSession();
  await runningTurn(oc, id);
  oc.failPrompt("Model unavailable: nope/model");
  const done = await untilStatus(id, "idle");
  expect(done.events.find((e) => e.kind === "result")).toMatchObject({ isError: true, text: "Model unavailable: nope/model" });
});

test("the model and effort switch mid-session, and become what new sessions start on", async () => {
  const { id, oc } = await idleSession();
  const model = await api(`/api/agent/chat/${id}/model`, "PUT", { model: "openai/gpt-6" });
  expect(model.status).toBe(200);
  expect(oc.model).toBe("openai/gpt-6");
  expect((await snapshot(id)).meta.model).toBe("openai/gpt-6");

  const unknown = await api(`/api/agent/chat/${id}/model`, "PUT", { model: "nope/model" });
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error).toContain("Unknown model nope/model");

  expect((await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: "high" })).status).toBe(200);
  expect(oc.effort).toBe("high");
  // OpenCode's top level is xhigh; "max" means it.
  expect((await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: "max" })).status).toBe(200);
  expect(oc.effort).toBe("xhigh");
  // null: OpenCode's own default.
  expect((await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: null })).status).toBe(200);
  expect(oc.effort).toBe("default");
  expect((await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: "medium" })).status).toBe(200);

  // The picks are kept in the plugin's settings.
  const state = (await readState(root)) as { pluginSettings?: Record<string, Record<string, unknown>> };
  expect(state.pluginSettings?.["agent-opencode"]).toMatchObject({ defaultModel: "openai/gpt-6", defaultEffort: "medium" });
  const choices = (await (await api("/api/agent/agents/opencode/choices")).json()) as {
    choices: { model: string; effort: string; models: { value: string }[] };
  };
  expect(choices.choices.model).toBe("openai/gpt-6");
  expect(choices.choices.effort).toBe("medium");

  const next = await idleSession();
  expect(next.oc.model).toBe("openai/gpt-6");
  expect(next.oc.effort).toBe("medium");
  expect((await snapshot(next.id)).meta).toMatchObject({ model: "openai/gpt-6", effort: "medium" });
});

test("the model menu is the data repo's list when it has one, else OpenCode's recent models", async () => {
  const read = async () =>
    ((await (await api("/api/agent/agents/opencode/choices")).json()) as { choices: { models: { value: string }[] } }).choices.models.map(
      (m) => m.value,
    );
  // No recent models: the catalog fills the menu.
  expect(await read()).toEqual(MODELS);

  await mkdir(join(home, "state", "opencode"), { recursive: true });
  await writeFile(
    join(home, "state", "opencode", "model.json"),
    JSON.stringify({ recent: [{ providerID: "openai", modelID: "gpt-6" }, { providerID: "gone", modelID: "old" }] }),
  );
  expect(await read()).toEqual(["openai/gpt-6"]);

  await mkdir(join(data, ".specdriven"), { recursive: true });
  await writeFile(join(data, ".specdriven", "opencode-models.json"), JSON.stringify(["anthropic/claude-opus-5-5", "lmstudio/local"]));
  expect(await read()).toEqual(["anthropic/claude-opus-5-5", "lmstudio/local"]);
});

test("OpenCode exiting on its own ends the session, with its last words on a failure", async () => {
  const { id, oc } = await idleSession();
  oc.stderr("fatal: no provider configured");
  oc.exit(3);
  const ended = await untilStatus(id, "error");
  const note = notes(ended).at(-1)!;
  expect(note).toContain("OpenCode exited with code 3.");
  expect(note).toContain("no provider configured");
});

test("an OpenCode that never starts, or refuses the session, is a failed session", async () => {
  const res = await api("/api/agent/chat", "POST", { name: "x", agent: "opencode" });
  const meta = (await res.json()) as ChatSessionMeta;
  fakes.at(-1)!.exit(null, new Error("spawn opencode ENOENT"));
  const ended = await untilStatus(meta.id, "error");
  const note = ended.events.filter((e) => e.kind === "note").at(-1) as { text: string; code: string };
  expect(note.code).toBe("spawn_failed");
  expect(note.text).toContain("Could not start OpenCode: spawn opencode ENOENT");

  setOpencodeSpawn((options) => {
    const fake = new FakeOpencode(options);
    fake.failNew = "No provider is configured";
    fakes.push(fake);
    return fake;
  });
  const refused = (await (await api("/api/agent/chat", "POST", { name: "y", agent: "opencode" })).json()) as ChatSessionMeta;
  const failed = await untilStatus(refused.id, "error");
  expect(notes(failed).at(-1)).toContain("Could not start OpenCode: No provider is configured");
});

// specs/agents/opencode.feature.md: OpenCode is one of the agents "Start
// session" offers, and picking it opens the generated prompt in the pane
// as OpenCode's first turn.
test("Start session can open the generated prompt in an OpenCode pane session", async () => {
  const code = join(root, "code");
  await mkdir(code);
  await writeFile(join(data, PROJECT_SETTINGS_FILE), JSON.stringify({ "code-repo": "../code" }));
  const res = await api("/api/agent/session", "POST", {
    name: "implement quotes",
    files: [{ fileName: "specs/quote.feature.md" }],
    target: "opencode",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; target: string };
  expect(body.target).toBe("opencode");
  const oc = fakes.at(-1)!;
  expect(oc.options.cwd).toBe(code);
  const prompt = await until(async () => oc.calls("session/prompt"), (c) => c.length === 1);
  const text = (prompt[0]!.params!.prompt as { text: string }[])[0]!.text;
  expect(text).toContain("SpecDriven code gen session: implement quotes");
  expect(text).toContain("## Spec: specs/quote.feature.md");
  const snap = await until(() => snapshot(body.id), (s) => s.meta.status === "running");
  expect(snap.meta.agent).toBe("opencode");
});

test("OpenCode needs its CLI", async () => {
  setOpencodeAvailability(() => false);
  const gone = await api("/api/agent/chat", "POST", { name: "x", agent: "opencode" });
  expect(gone.status).toBe(502);
  expect((await gone.json()).error).toContain("OpenCode CLI not found");
  const { agents } = (await (await api("/api/state")).json()) as { agents: { id: string; available: boolean }[] };
  expect(agents.find((a) => a.id === "opencode")?.available).toBe(false);
});
