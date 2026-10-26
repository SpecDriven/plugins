// Automates specs/agents/integration-with-pi-dev-agent.feature.md: Pi is a
// choice of agent for a code gen session, and the session it opens is the
// coding agent pane driven over pi's RPC mode. `pi --mode rpc` is swapped for
// a fake the test steers from both ends — the commands the app writes, and
// the JSON lines pi "answers" with — so nothing spawns.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "@specdriven/app/src/server/api";
import { endAllChatSessions } from "@specdriven/app/src/server/agentChat";
import type { ChatEvent, ChatSessionMeta, SlashCommandInfo } from "@specdriven/app/src/server/agentTypes";
import { createFeature, saveFeature } from "@specdriven/app/src/server/features";
import { PROJECT_SETTINGS_FILE } from "@specdriven/app/src/server/members";
import { writeState } from "@specdriven/app/src/server/state";
import {
  jsonlReader,
  mapPiEvent,
  newPiStream,
  piCommands,
  piState,
  setPiSpawn,
} from "../src/piChat";
import type { PiSpawnOptions } from "../src/piChat";
import { setPiAvailability } from "../src/cli";
import { mountPlugin, quietProfile } from "./app";

let unmount: () => Promise<void> = async () => {};

// --- Framing ---------------------------------------------------------------

describe("jsonlReader", () => {
  test("splits on LF only, strips a trailing CR, and holds partial lines", () => {
    const lines: string[] = [];
    const read = jsonlReader((l) => lines.push(l));
    read('{"a":1}\n{"b":');
    expect(lines).toEqual(['{"a":1}']);
    read('2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    // U+2028 is legal inside a JSON string and must not end a record — the
    // reason Node's readline is not protocol-compliant here.
    read('{"c":"a b"}\n');
    expect(lines.at(-1)).toBe('{"c":"a b"}');
  });
});

// --- pi's events → the pane's events ---------------------------------------

describe("mapPiEvent", () => {
  const at = () => 1000;

  test("streams a reply, then keeps the message pi never gave an id", () => {
    const stream = newPiStream();
    const ctx = { turn: 1, now: at };
    expect(mapPiEvent({ type: "agent_start" }, ctx, stream)).toEqual([]);
    expect(
      mapPiEvent({ type: "message_start", message: { role: "assistant", content: [] } }, ctx, stream),
    ).toEqual([]);
    const deltas = mapPiEvent(
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
      },
      ctx,
      stream,
    );
    expect(deltas).toEqual([{ kind: "text_delta", messageId: "pi-1", index: 0, text: "Hel" }]);
    // Thinking deltas are pi's own trace; the pane shows none of it.
    expect(
      mapPiEvent(
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hm" } },
        ctx,
        stream,
      ),
    ).toEqual([]);
    const ended = mapPiEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Hello" },
            { type: "thinking", thinking: "…" },
            { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
          ],
          usage: { cost: { total: 0.002 } },
          stopReason: "toolUse",
        },
      },
      ctx,
      stream,
    );
    expect(ended).toEqual([
      {
        kind: "assistant",
        messageId: "pi-1",
        turn: 1,
        blocks: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "call_1", name: "read", input: { path: "a.ts" } },
        ],
        parentToolUseId: null,
      },
    ]);
  });

  test("a tool result pairs up with its call, and errors are marked", () => {
    const stream = newPiStream();
    expect(
      mapPiEvent(
        {
          type: "tool_execution_end",
          toolCallId: "call_1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "total 48" }, { type: "image" }] },
          isError: false,
        },
        { turn: 1, now: at },
        stream,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        toolUseId: "call_1",
        content: "total 48\n[image]",
        isError: false,
        parentToolUseId: null,
      },
    ]);
  });

  test("a settled turn is the turn footer: its cost, its clock, its errors", () => {
    const stream = newPiStream();
    let now = 1000;
    const ctx = { turn: 2, now: () => now };
    mapPiEvent({ type: "agent_start" }, ctx, stream);
    mapPiEvent(
      {
        type: "message_end",
        message: { role: "assistant", content: [], usage: { cost: { total: 0.25 } } },
      },
      ctx,
      stream,
    );
    now = 3500;
    expect(mapPiEvent({ type: "agent_settled" }, ctx, stream)).toEqual([
      {
        kind: "result",
        turn: 2,
        subtype: "success",
        isError: false,
        costUsd: 0.25,
        durationMs: 2500,
        numTurns: 1,
        denials: 0,
      },
    ]);
    // The next turn starts from nothing.
    expect(stream.costUsd).toBe(0);
    expect(stream.turnStartedAt).toBeNull();
  });

  test("a failed reply becomes an error note and a failed turn", () => {
    const stream = newPiStream();
    const ctx = { turn: 1, now: at };
    const events = mapPiEvent(
      {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "no API key" },
      },
      ctx,
      stream,
    );
    expect(events).toEqual([{ kind: "note", level: "error", code: "api", text: "no API key" }]);
    expect(mapPiEvent({ type: "agent_settled" }, ctx, stream)).toMatchObject([
      { kind: "result", isError: true, subtype: "error", text: "no API key" },
    ]);
  });

  test("an extension's notification is a note, and its dialog says it was dismissed", () => {
    const stream = newPiStream();
    const ctx = { turn: 1, now: at };
    expect(
      mapPiEvent(
        { type: "extension_ui_request", id: "1", method: "notify", message: "Blocked", notifyType: "error" },
        ctx,
        stream,
      ),
    ).toEqual([{ kind: "note", level: "error", code: "api", text: "Pi: Blocked" }]);
    expect(
      mapPiEvent({ type: "extension_ui_request", id: "2", method: "confirm" }, ctx, stream),
    ).toMatchObject([{ kind: "note", level: "info", text: expect.stringContaining("dismissed") }]);
    // TUI decoration has nothing to show here.
    expect(
      mapPiEvent({ type: "extension_ui_request", id: "3", method: "setStatus" }, ctx, stream),
    ).toEqual([]);
    expect(mapPiEvent({ type: "queue_update" }, ctx, stream)).toEqual([]);
  });

  test("state and commands are read out of pi's answers", () => {
    expect(piState({ model: { id: "gpt", name: "Big Model" }, sessionId: "s-1" })).toEqual({
      model: "Big Model",
      sessionId: "s-1",
    });
    expect(piState({ model: null })).toEqual({});
    expect(piState(undefined)).toEqual({});
    expect(
      piCommands({ commands: [{ name: "fix-tests", description: "Fix them" }, { description: "no name" }] }),
    ).toEqual([{ name: "fix-tests", description: "Fix them", argumentHint: "" }]);
  });
});

// --- A pi session over the routes ------------------------------------------

/** A stand-in for `pi --mode rpc`: the test reads the commands the app wrote
    and pushes the JSON lines pi would answer with. */
class FakePi {
  readonly commands: Record<string, unknown>[] = [];
  exited = false;
  killed = false;
  /** Answers for get_state / get_commands, sent as soon as they are asked. */
  model = "Pi Model";
  sessionId = "pi-session-1";
  slash: SlashCommandInfo[] = [{ name: "fix-tests", description: "Fix them", argumentHint: "" }];

  constructor(readonly options: PiSpawnOptions) {}

  write(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const command = JSON.parse(line) as Record<string, unknown>;
      this.commands.push(command);
      this.autoAnswer(command);
    }
  }

  kill(): void {
    this.killed = true;
    this.exit(0);
  }

  /** One line from pi's stdout. */
  emit(event: unknown): void {
    this.options.onStdout(JSON.stringify(event) + "\n");
  }

  stderr(line: string): void {
    this.options.onStderr(line + "\n");
  }

  exit(code: number | null, error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.options.onExit(code, error);
  }

  sent(type: string): Record<string, unknown> | undefined {
    return this.commands.find((c) => c.type === type);
  }

  private autoAnswer(command: Record<string, unknown>): void {
    const id = command.id;
    if (command.type === "get_state") {
      this.emit({
        type: "response",
        command: "get_state",
        id,
        success: true,
        data: { model: { id: "pi-model", name: this.model }, sessionId: this.sessionId },
      });
    } else if (command.type === "get_commands") {
      this.emit({
        type: "response",
        command: "get_commands",
        id,
        success: true,
        data: { commands: this.slash.map((c) => ({ name: c.name, description: c.description })) },
      });
    } else if (command.type === "abort") {
      this.emit({ type: "response", command: "abort", id, success: true });
    }
  }
}

let root: string;
let home: string;
let data: string;
let pis: FakePi[];
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-pi-chat-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-pi-chat-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  pis = [];
  setPiAvailability(() => true);
  setPiSpawn((options) => {
    const fake = new FakePi(options);
    pis.push(fake);
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
  setPiAvailability(null);
  setPiSpawn(null);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
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
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 400)}`);
    await Bun.sleep(10);
  }
}

const untilStatus = (id: string, status: string) =>
  until(() => snapshot(id), (s) => s.meta.status === status);

/** A pi chat that has said hello: spawned, state and commands answered. */
async function idlePiSession(): Promise<{ id: string; pi: FakePi }> {
  const res = await api("/api/agent/chat", "POST", { name: "pi chat", agent: "pi" });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  await untilStatus(meta.id, "idle");
  return { id: meta.id, pi: pis.at(-1)! };
}

test("a pi session spawns `pi --mode rpc` on the work dir and is ready once it answers", async () => {
  const res = await api("/api/agent/chat", "POST", { name: "pi chat", agent: "pi" });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  expect(meta.agent).toBe("pi");
  expect(meta.cwd).toBe(data);
  expect(pis).toHaveLength(1);
  const pi = pis[0]!;
  expect(pi.options.args).toEqual(["--mode", "rpc", "--name", "pi chat"]);
  expect(pi.options.cwd).toBe(data);

  const ready = await untilStatus(meta.id, "idle");
  expect(ready.meta.model).toBe("Pi Model");
  expect(ready.meta.agentSessionId).toBe("pi-session-1");
  expect(ready.commands.map((c) => c.name)).toEqual(["fix-tests"]);
  // Pi runs its own tools; the session says so once, and offers no mode.
  expect(ready.meta.permissionMode).toBe("bypassPermissions");
  const notes = ready.events.filter((e) => e.kind === "note").map((e) => (e as { text: string }).text);
  expect(notes.some((t) => t.includes("Pi Model"))).toBe(true);
  expect(notes.some((t) => t.includes("nothing asks for permission"))).toBe(true);

  // The record sits beside the settings, never in the data repo; it is
  // rewritten as the session learns about itself, so wait for that.
  const file = join(root, ".specdriven", "sessions", meta.id, "session.json");
  const record = await until(
    async () => {
      try {
        return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      } catch {
        // Caught mid-rewrite: the file is empty or half written for a moment.
        return null;
      }
    },
    (r) => r?.agentSessionId === "pi-session-1",
  );
  expect(record).toMatchObject({ agent: "pi", cwd: data, dataRepo: data });
});

test("a turn goes to pi as a prompt command and its reply streams into the log", async () => {
  const { id, pi } = await idlePiSession();
  const sent = await api(`/api/agent/chat/${id}/message`, "POST", { text: "add a quote" });
  expect(sent.status).toBe(200);
  expect(pi.commands.at(-1)).toEqual({ type: "prompt", message: "add a quote" });

  pi.emit({ type: "agent_start" });
  pi.emit({ type: "message_start", message: { role: "assistant", content: [] } });
  pi.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Read" },
  });
  pi.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Reading it" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "specs/quote.feature.md" } },
      ],
      usage: { cost: { total: 0.01 } },
      stopReason: "toolUse",
    },
  });
  pi.emit({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: [{ type: "text", text: "# Quote" }] },
    isError: false,
  });
  pi.emit({ type: "agent_settled" });

  const done = await untilStatus(id, "idle");
  const kinds = done.events.map((e) => e.kind);
  expect(kinds).toContain("user");
  expect(kinds).toContain("assistant");
  expect(kinds).toContain("tool_result");
  const assistant = done.events.find((e) => e.kind === "assistant");
  expect(assistant).toMatchObject({
    blocks: [
      { type: "text", text: "Reading it" },
      { type: "tool_use", id: "call_1", name: "read" },
    ],
  });
  expect(done.events.find((e) => e.kind === "tool_result")).toMatchObject({
    toolUseId: "call_1",
    content: "# Quote",
    isError: false,
  });
  expect(done.events.find((e) => e.kind === "result")).toMatchObject({
    isError: false,
    costUsd: 0.01,
    numTurns: 1,
  });
});

test("Stop sends abort, and pi has no permission mode to switch", async () => {
  const { id, pi } = await idlePiSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  pi.emit({ type: "agent_start" });
  await untilStatus(id, "running");
  expect((await api(`/api/agent/chat/${id}/interrupt`, "POST")).status).toBe(200);
  expect(pi.sent("abort")).toBeTruthy();

  const mode = await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "plan" });
  expect(mode.status).toBe(409);
  expect((await mode.json()).error).toContain("Pi has no permission modes");
});

test("an extension dialog is cancelled rather than left hanging", async () => {
  const { id, pi } = await idlePiSession();
  pi.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", message: "Run it?" });
  const seen = await until(
    () => snapshot(id),
    (s) => s.events.some((e) => e.kind === "note" && /dismissed/.test((e as { text: string }).text)),
  );
  expect(seen.meta.status).toBe("idle");
  expect(pi.commands.at(-1)).toEqual({ type: "extension_ui_response", id: "ui-1", cancelled: true });
});

test("pi exiting on its own ends the session, with its last words on a failure", async () => {
  const { id, pi } = await idlePiSession();
  pi.stderr("fatal: no provider configured");
  pi.exit(3);
  const ended = await untilStatus(id, "error");
  const note = ended.events.filter((e) => e.kind === "note").at(-1) as { text: string };
  expect(note.text).toContain("Pi exited with code 3.");
  expect(note.text).toContain("no provider configured");
});

test("a pi that never starts is reported as a failed session", async () => {
  const { id, pi } = await idlePiSession();
  pi.exit(null, new Error("spawn pi ENOENT"));
  const ended = await untilStatus(id, "error");
  const note = ended.events.filter((e) => e.kind === "note").at(-1) as { text: string; code: string };
  expect(note.code).toBe("spawn_failed");
  expect(note.text).toContain("Could not start Pi: spawn pi ENOENT");
});

// specs/agents/integration-with-pi-dev-agent.feature.md "Choose PI Agent":
// Pi is one of the agents "Start session" offers, and picking it opens the
// generated prompt in the pane as pi's first turn.
test("Start session can open the generated prompt in a pi pane session", async () => {
  const code = join(root, "code");
  await mkdir(code);
  await writeFile(join(data, PROJECT_SETTINGS_FILE), JSON.stringify({ "code-repo": "../code" }));
  const res = await api("/api/agent/session", "POST", {
    name: "implement quotes",
    files: [{ fileName: "specs/quote.feature.md" }],
    target: "pi",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; target: string };
  expect(body.target).toBe("pi");
  const pi = pis.at(-1)!;
  // The session runs in the code repo, and pi is named after the session.
  expect(pi.options.cwd).toBe(code);
  expect(pi.options.args).toEqual(["--mode", "rpc", "--name", "implement quotes"]);
  const prompt = pi.sent("prompt")!;
  expect(prompt.message).toContain("SpecDriven code gen session: implement quotes");
  expect(prompt.message).toContain("## Spec: specs/quote.feature.md");
  expect(prompt.message).toContain("edit the code, not the specifications");

  const snap = await until(() => snapshot(body.id), (s) => s.events.some((e) => e.kind === "user"));
  expect(snap.meta.agent).toBe("pi");
  expect(snap.meta.status).toBe("running");
});

test("an unknown agent is refused, and Pi needs its CLI", async () => {
  const bad = await api("/api/agent/chat", "POST", { name: "x", agent: "nope" });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("agent must be pi");

  setPiAvailability(() => false);
  const gone = await api("/api/agent/chat", "POST", { name: "x", agent: "pi" });
  expect(gone.status).toBe(502);
  expect((await gone.json()).error).toContain("Pi CLI not found");
  // The state says which agents this machine can run.
  const { agents } = (await (await api("/api/state")).json()) as { agents: { id: string; available: boolean }[] };
  expect(agents.find((a) => a.id === "pi")?.available).toBe(false);
});
