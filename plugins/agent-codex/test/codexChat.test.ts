// Codex is a choice of agent for a code gen session, and the session it opens
// is the coding agent pane driven over Codex's app-server protocol
// (src/server/codexChat.ts). `codex app-server` is swapped for a fake the
// test steers from both ends — the requests the app writes, and the JSON
// lines Codex "answers" with, including the requests Codex makes of the
// client — so nothing spawns.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "@specdriven/app/src/server/api";
import { endAllChatSessions } from "@specdriven/app/src/server/agentChat";
import type { ChatEvent, ChatSessionMeta, SlashCommandInfo } from "@specdriven/app/src/server/agentChat";
import { createFeature, saveFeature } from "@specdriven/app/src/server/features";
import { PROJECT_SETTINGS_FILE } from "@specdriven/app/src/server/members";
import { writeState } from "@specdriven/app/src/server/state";
import {
  codexAnswers,
  codexPolicy,
  codexQuestions,
  codexSandboxPolicy,
  codexThreadInfo,
  mapCodexNotification,
  newCodexStream,
  setCodexSpawn,
} from "../src/codexChat";
import type { CodexSpawnOptions } from "../src/codexChat";
import { setCodexAvailability } from "../src/cli";
import { mountPlugin, quietProfile } from "./app";

let unmount: () => Promise<void> = async () => {};

// --- Permission modes → Codex's policies ------------------------------------

describe("codexPolicy", () => {
  test("maps the pane's four modes onto an approval policy and a sandbox", () => {
    expect(codexPolicy("default")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(codexPolicy("acceptEdits")).toEqual({ approvalPolicy: "on-failure", sandbox: "workspace-write" });
    expect(codexPolicy("plan")).toEqual({ approvalPolicy: "on-request", sandbox: "read-only" });
    expect(codexPolicy("bypassPermissions")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(codexSandboxPolicy("read-only")).toEqual({ type: "readOnly", networkAccess: false });
    expect(codexSandboxPolicy("danger-full-access")).toEqual({ type: "dangerFullAccess" });
    expect(codexSandboxPolicy("workspace-write")).toMatchObject({ type: "workspaceWrite", networkAccess: false });
  });

  test("reads the model, the thread id and the CLI version off thread/start", () => {
    expect(
      codexThreadInfo({ thread: { id: "t-1", cliVersion: "0.141.0" }, model: "gpt-5.5" }),
    ).toEqual({ threadId: "t-1", model: "gpt-5.5", cliVersion: "0.141.0" });
    expect(codexThreadInfo({})).toEqual({});
    expect(codexThreadInfo(undefined)).toEqual({});
  });
});

// --- Codex's notifications → the pane's events -----------------------------

describe("mapCodexNotification", () => {
  const at = () => 1000;
  const item = (value: Record<string, unknown>) => ({ threadId: "t", turnId: "turn-1", item: value });

  test("streams a reply under the item's id, then keeps the whole message", () => {
    const stream = newCodexStream();
    const ctx = { turn: 1, now: at };
    expect(mapCodexNotification("turn/started", { turn: { id: "turn-1" } }, ctx, stream)).toEqual([]);
    expect(stream.turnId).toBe("turn-1");
    expect(
      mapCodexNotification("item/started", item({ type: "agentMessage", id: "m1", text: "" }), ctx, stream),
    ).toEqual([]);
    expect(
      mapCodexNotification(
        "item/agentMessage/delta",
        { threadId: "t", turnId: "turn-1", itemId: "m1", delta: "Hel" },
        ctx,
        stream,
      ),
    ).toEqual([{ kind: "text_delta", messageId: "m1", index: 0, text: "Hel" }]);
    // Reasoning is Codex's own trace; the pane shows none of it.
    expect(
      mapCodexNotification(
        "item/reasoning/summaryTextDelta",
        { threadId: "t", turnId: "turn-1", itemId: "r1", delta: "hm" },
        ctx,
        stream,
      ),
    ).toEqual([]);
    expect(
      mapCodexNotification(
        "item/completed",
        item({ type: "agentMessage", id: "m1", text: "Hello", phase: "final_answer" }),
        ctx,
        stream,
      ),
    ).toEqual([
      {
        kind: "assistant",
        messageId: "m1",
        turn: 1,
        blocks: [{ type: "text", text: "Hello" }],
        parentToolUseId: null,
      },
    ]);
  });

  test("a command is a Bash tool row: its call when it starts, its output when it ends", () => {
    const stream = newCodexStream();
    const ctx = { turn: 1, now: at };
    const started = mapCodexNotification(
      "item/started",
      item({ type: "commandExecution", id: "c1", command: "ls -la", cwd: "/repo", status: "inProgress" }),
      ctx,
      stream,
    );
    expect(started).toEqual([
      {
        kind: "assistant",
        messageId: "c1",
        turn: 1,
        blocks: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls -la", cwd: "/repo" } }],
        parentToolUseId: null,
      },
    ]);
    expect(
      mapCodexNotification(
        "item/completed",
        item({
          type: "commandExecution",
          id: "c1",
          command: "ls -la",
          cwd: "/repo",
          status: "failed",
          aggregatedOutput: "total 48\n",
          exitCode: 2,
        }),
        ctx,
        stream,
      ),
    ).toEqual([
      { kind: "tool_result", toolUseId: "c1", content: "total 48\n[exit code 2]", isError: true, parentToolUseId: null },
    ]);
    // An item that completes without having started still gets its call.
    const both = mapCodexNotification(
      "item/completed",
      item({ type: "commandExecution", id: "c2", command: "pwd", status: "completed", aggregatedOutput: "/repo", exitCode: 0 }),
      ctx,
      stream,
    );
    expect(both.map((e) => e.kind)).toEqual(["assistant", "tool_result"]);
  });

  test("a file change is an Edit tool row naming its files, with the diffs as output", () => {
    const stream = newCodexStream();
    const ctx = { turn: 1, now: at };
    const changes = [
      { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "-a\n+b" },
      { path: "src/b.ts", kind: { type: "add" }, diff: "+new" },
    ];
    const started = mapCodexNotification(
      "item/started",
      item({ type: "fileChange", id: "f1", changes, status: "inProgress" }),
      ctx,
      stream,
    );
    expect(started).toMatchObject([
      {
        kind: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "f1",
            name: "Edit",
            input: { file_path: "update src/a.ts, add src/b.ts", files: ["update src/a.ts", "add src/b.ts"] },
          },
        ],
      },
    ]);
    expect(
      mapCodexNotification("item/completed", item({ type: "fileChange", id: "f1", changes, status: "completed" }), ctx, stream),
    ).toEqual([
      {
        kind: "tool_result",
        toolUseId: "f1",
        content: "update src/a.ts\n-a\n+b\n\nadd src/b.ts\n+new",
        isError: false,
        parentToolUseId: null,
      },
    ]);
  });

  test("an MCP tool call and a web search are tool rows too", () => {
    const stream = newCodexStream();
    const ctx = { turn: 1, now: at };
    expect(
      mapCodexNotification(
        "item/completed",
        item({
          type: "mcpToolCall",
          id: "mcp1",
          server: "github",
          tool: "get_issue",
          status: "completed",
          arguments: { number: 7 },
          result: { content: [{ type: "text", text: "Issue #7" }, { type: "image" }] },
          error: null,
        }),
        ctx,
        stream,
      ),
    ).toMatchObject([
      { kind: "assistant", blocks: [{ type: "tool_use", id: "mcp1", name: "github/get_issue", input: { number: 7 } }] },
      { kind: "tool_result", toolUseId: "mcp1", content: "Issue #7\n[image]", isError: false },
    ]);
    expect(
      mapCodexNotification("item/started", item({ type: "webSearch", id: "w1", query: "bun test" }), ctx, stream),
    ).toMatchObject([{ kind: "assistant", blocks: [{ type: "tool_use", name: "WebSearch", input: { query: "bun test" } }] }]);
  });

  test("a completed turn is the turn footer: its clock, its denials, its errors", () => {
    const stream = newCodexStream();
    let now = 1000;
    const ctx = { turn: 2, now: () => now };
    mapCodexNotification("turn/started", { turn: { id: "turn-2" } }, ctx, stream);
    stream.denials = 1;
    now = 3500;
    expect(
      mapCodexNotification(
        "turn/completed",
        { threadId: "t", turn: { id: "turn-2", status: "completed", error: null, durationMs: null } },
        ctx,
        stream,
      ),
    ).toEqual([
      {
        kind: "result",
        turn: 2,
        subtype: "success",
        isError: false,
        costUsd: null,
        durationMs: 2500,
        numTurns: 1,
        denials: 1,
      },
    ]);
    // The next turn starts from nothing.
    expect(stream.turnId).toBeNull();
    expect(stream.denials).toBe(0);
    expect(stream.turnStartedAt).toBeNull();
  });

  test("a failed turn carries Codex's error, and a retried one only a note", () => {
    const stream = newCodexStream();
    const ctx = { turn: 1, now: at };
    expect(
      mapCodexNotification(
        "error",
        { error: { message: "rate limited", codexErrorInfo: null }, willRetry: true, threadId: "t", turnId: "x" },
        ctx,
        stream,
      ),
    ).toEqual([{ kind: "note", level: "info", code: "api", text: "Retrying after rate limited…" }]);
    expect(
      mapCodexNotification(
        "error",
        { error: { message: "not logged in", codexErrorInfo: "unauthorized" }, willRetry: false, threadId: "t", turnId: "x" },
        ctx,
        stream,
      ),
    ).toEqual([{ kind: "note", level: "error", code: "api", text: "not logged in (unauthorized)" }]);
    // The note said it already; the footer does not say it twice.
    const failed = mapCodexNotification(
      "turn/completed",
      {
        threadId: "t",
        turn: { id: "x", status: "failed", error: { message: "not logged in", codexErrorInfo: "unauthorized" }, durationMs: 40 },
      },
      ctx,
      stream,
    );
    expect(failed).toMatchObject([{ kind: "result", subtype: "error", isError: true, durationMs: 40 }]);
    expect((failed[0] as { text?: string }).text).toBeUndefined();
    // A turn that fails without a note carries its error on the footer — and
    // an upstream API body is unwrapped to its message.
    const body = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "model not supported" } });
    expect(
      mapCodexNotification(
        "turn/completed",
        { threadId: "t", turn: { id: "z", status: "failed", error: { message: body, codexErrorInfo: "badRequest" }, durationMs: 4 } },
        ctx,
        stream,
      ),
    ).toMatchObject([{ kind: "result", subtype: "error", isError: true, text: "model not supported (badRequest)" }]);
    // An interrupted turn is over, not failed.
    expect(
      mapCodexNotification(
        "turn/completed",
        { threadId: "t", turn: { id: "y", status: "interrupted", error: null, durationMs: 10 } },
        ctx,
        stream,
      ),
    ).toMatchObject([{ kind: "result", subtype: "interrupted", isError: false }]);
  });

  test("warnings, compaction and reroutes are notes; the rest is nothing", () => {
    const stream = newCodexStream();
    const ctx = { turn: 1, now: at };
    expect(mapCodexNotification("warning", { threadId: null, message: "Slow network" }, ctx, stream)).toEqual([
      { kind: "note", level: "info", code: "api", text: "Codex: Slow network" },
    ]);
    expect(
      mapCodexNotification("configWarning", { summary: "Unknown key", details: "features.x" }, ctx, stream),
    ).toEqual([{ kind: "note", level: "info", code: "api", text: "Codex config: Unknown key — features.x" }]);
    expect(
      mapCodexNotification("item/completed", item({ type: "contextCompaction", id: "cc" }), ctx, stream),
    ).toEqual([{ kind: "note", level: "info", code: "compact", text: "Context compacted." }]);
    expect(
      mapCodexNotification("model/rerouted", { fromModel: "a", toModel: "b", reason: "x" }, ctx, stream),
    ).toEqual([{ kind: "note", level: "info", code: "api", text: "Codex switched to b." }]);
    expect(mapCodexNotification("thread/tokenUsage/updated", {}, ctx, stream)).toEqual([]);
    expect(mapCodexNotification("mcpServer/startupStatus/updated", {}, ctx, stream)).toEqual([]);
  });

  test("questions round-trip: Codex's ids in, the card's answers by question text out", () => {
    const questions = codexQuestions({
      questions: [
        { id: "q1", header: "Scope", question: "Which module?", isOther: true, isSecret: false, options: [{ label: "auth", description: "Sign-in" }] },
        { id: "q2", header: "", question: "Proceed?", isOther: false, isSecret: false, options: null },
        { header: "no id", question: "skipped" },
      ],
    });
    expect(questions).toEqual([
      {
        id: "q1",
        question: { question: "Which module?", header: "Scope", options: [{ label: "auth", description: "Sign-in" }], multiSelect: false },
      },
      { id: "q2", question: { question: "Proceed?", header: "", options: [], multiSelect: false } },
    ]);
    expect(codexAnswers(questions, { "Which module?": "auth" })).toEqual({
      answers: { q1: { answers: ["auth"] }, q2: { answers: [] } },
    });
  });
});

// --- A Codex session over the routes ----------------------------------------

/** Set before a session starts to have its fake refuse `thread/start`. */
let refuseThread = false;

/** A stand-in for `codex app-server`: the test reads the requests the app
    wrote and pushes the JSON lines Codex would answer with. */
class FakeCodex {
  readonly requests: Record<string, unknown>[] = [];
  /** The app's answers to the server's own requests, by request id. */
  readonly replies: Record<string, unknown>[] = [];
  exited = false;
  killed = false;
  model = "gpt-5.5";
  threadId = "thread-1";
  /** When false, thread/start answers with an error. The handshake runs
      before the route answers, so a test sets `refuseThread` beforehand. */
  threadStarts = !refuseThread;

  constructor(readonly options: CodexSpawnOptions) {}

  write(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.method === "string") {
        this.requests.push(message);
        this.autoAnswer(message);
      } else {
        this.replies.push(message);
      }
    }
  }

  kill(): void {
    this.killed = true;
    this.exit(0);
  }

  /** One line from Codex's stdout. */
  emit(message: unknown): void {
    this.options.onStdout(JSON.stringify(message) + "\n");
  }

  notify(method: string, params: unknown): void {
    this.emit({ method, params });
  }

  /** A request from the server to the client. */
  ask(id: string | number, method: string, params: unknown): void {
    this.emit({ id, method, params });
  }

  stderr(line: string): void {
    this.options.onStderr(line + "\n");
  }

  exit(code: number | null, error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.options.onExit(code, error);
  }

  sent(method: string): Record<string, unknown> | undefined {
    return this.requests.find((r) => r.method === method);
  }

  allSent(method: string): Record<string, unknown>[] {
    return this.requests.filter((r) => r.method === method);
  }

  reply(id: string | number): Record<string, unknown> | undefined {
    return this.replies.find((r) => r.id === id);
  }

  private autoAnswer(request: Record<string, unknown>): void {
    const id = request.id;
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "initialize":
        this.emit({ id, result: { userAgent: "codex", codexHome: "/h", platformFamily: "unix", platformOs: "macos" } });
        return;
      case "thread/start":
        if (!this.threadStarts) {
          this.emit({ id, error: { code: -32000, message: "no auth" } });
          return;
        }
        this.emit({
          id,
          result: {
            thread: { id: this.threadId, cliVersion: "0.141.0", cwd: params.cwd, status: { type: "idle" }, turns: [] },
            model: this.model,
            modelProvider: "openai",
            cwd: params.cwd,
            approvalPolicy: params.approvalPolicy,
          },
        });
        return;
      case "thread/name/set":
        this.emit({ id, result: {} });
        return;
      case "turn/start": {
        const turn = { id: `turn-${this.allSent("turn/start").length}`, status: "inProgress", items: [], error: null };
        this.emit({ id, result: { turn } });
        this.notify("turn/started", { threadId: this.threadId, turn });
        return;
      }
      case "turn/interrupt":
      case "turn/steer":
        this.emit({ id, result: {} });
        return;
      default:
        this.emit({ id, error: { code: -32601, message: `unknown ${request.method}` } });
    }
  }
}

let root: string;
let home: string;
let data: string;
let fakes: FakeCodex[];
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-codex-chat-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-codex-chat-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  fakes = [];
  refuseThread = false;
  setCodexAvailability(() => true);
  setCodexSpawn((options) => {
    const fake = new FakeCodex(options);
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
  setCodexAvailability(null);
  setCodexSpawn(null);
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

const noteTexts = (s: Snapshot) => s.events.filter((e) => e.kind === "note").map((e) => (e as { text: string }).text);

/** A Codex chat that has said hello: spawned, initialized, thread started. */
async function idleCodexSession(permissionMode?: string): Promise<{ id: string; codex: FakeCodex }> {
  const res = await api("/api/agent/chat", "POST", {
    name: "codex chat",
    agent: "codex",
    ...(permissionMode ? { permissionMode } : {}),
  });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  await untilStatus(meta.id, "idle");
  return { id: meta.id, codex: fakes.at(-1)! };
}

test("a codex session spawns `codex app-server` on the work dir and is ready once its thread starts", async () => {
  const res = await api("/api/agent/chat", "POST", { name: "codex chat", agent: "codex" });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  expect(meta.agent).toBe("codex");
  expect(meta.cwd).toBe(data);
  expect(meta.permissionMode).toBe("default");
  expect(fakes).toHaveLength(1);
  const codex = fakes[0]!;
  expect(codex.options.args).toEqual(["app-server"]);
  expect(codex.options.cwd).toBe(data);

  const ready = await untilStatus(meta.id, "idle");
  expect(ready.meta.model).toBe("gpt-5.5");
  expect(ready.meta.agentSessionId).toBe("thread-1");
  // The handshake, in order, with the pane's mode as Codex's policy.
  expect(codex.requests.map((r) => r.method)).toEqual(["initialize", "thread/start", "thread/name/set"]);
  expect(codex.sent("initialize")!.params).toMatchObject({ clientInfo: { name: "specdriven" } });
  expect(codex.sent("thread/start")!.params).toEqual({
    cwd: data,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  expect(codex.sent("thread/name/set")!.params).toEqual({ threadId: "thread-1", name: "codex chat" });
  const notes = noteTexts(ready);
  expect(notes.some((t) => t.includes("Codex 0.141.0") && t.includes("gpt-5.5"))).toBe(true);
  expect(notes.some((t) => t.includes("approval policy and sandbox"))).toBe(true);

  // The record sits beside the settings, never in the data repo; it is
  // rewritten as the session learns about itself, so wait for that.
  const file = join(root, ".specdriven", "sessions", meta.id, "session.json");
  const record = await until(
    async () => {
      try {
        return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    (r) => r?.agentSessionId === "thread-1",
  );
  expect(record).toMatchObject({ agent: "codex", cwd: data, dataRepo: data });
});

test("a turn goes to Codex as turn/start and its items stream into the log", async () => {
  const { id, codex } = await idleCodexSession();
  const sent = await api(`/api/agent/chat/${id}/message`, "POST", { text: "add a quote" });
  expect(sent.status).toBe(200);
  const turn = codex.sent("turn/start")!;
  expect(turn.params).toEqual({
    threadId: "thread-1",
    input: [{ type: "text", text: "add a quote", text_elements: [] }],
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  });
  await untilStatus(id, "running");

  const t = { threadId: "thread-1", turnId: "turn-1" };
  codex.notify("item/started", { ...t, item: { type: "agentMessage", id: "m1", text: "" } });
  codex.notify("item/agentMessage/delta", { ...t, itemId: "m1", delta: "Read" });
  codex.notify("item/completed", { ...t, item: { type: "agentMessage", id: "m1", text: "Reading it" } });
  codex.notify("item/started", {
    ...t,
    item: { type: "commandExecution", id: "c1", command: "cat quote.feature.md", cwd: data, status: "inProgress" },
  });
  codex.notify("item/completed", {
    ...t,
    item: {
      type: "commandExecution",
      id: "c1",
      command: "cat quote.feature.md",
      cwd: data,
      status: "completed",
      aggregatedOutput: "# Quote\n",
      exitCode: 0,
    },
  });
  codex.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", error: null, durationMs: 1200 },
  });

  const done = await untilStatus(id, "idle");
  const kinds = done.events.map((e) => e.kind);
  expect(kinds).toContain("user");
  // The delta streamed while the reply was under way; once the whole
  // message is in, the log drops the delta as dead weight for replay.
  expect(kinds).not.toContain("text_delta");
  expect(kinds).toContain("assistant");
  expect(kinds).toContain("tool_result");
  expect(done.events.find((e) => e.kind === "assistant")).toMatchObject({
    messageId: "m1",
    blocks: [{ type: "text", text: "Reading it" }],
  });
  expect(done.events.find((e) => e.kind === "tool_result")).toMatchObject({
    toolUseId: "c1",
    content: "# Quote",
    isError: false,
  });
  expect(done.events.find((e) => e.kind === "result")).toMatchObject({
    isError: false,
    costUsd: null,
    durationMs: 1200,
    numTurns: 1,
  });
});

test("a command approval is a permission card; Allow once, Allow always and Deny become Codex's decisions", async () => {
  const { id, codex } = await idleCodexSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  await untilStatus(id, "running");
  const t = { threadId: "thread-1", turnId: "turn-1" };
  codex.notify("item/started", {
    ...t,
    item: { type: "commandExecution", id: "c1", command: "rm -rf build", cwd: data, status: "inProgress" },
  });
  codex.ask(1, "item/commandExecution/requestApproval", {
    ...t,
    itemId: "c1",
    startedAtMs: 1,
    command: "rm -rf build",
    cwd: data,
    reason: "needs to escape the sandbox",
  });
  const asked = await untilStatus(id, "awaiting_input");
  const card = asked.events.find((e) => e.kind === "permission_request") as Extract<
    ChatEvent,
    { kind: "permission_request" }
  >;
  expect(card).toMatchObject({
    toolName: "Bash",
    input: { command: "rm -rf build", cwd: data, reason: "needs to escape the sandbox" },
    title: "Codex wants to run a command",
  });
  // "Allow always" is on offer: a session-scoped rule stands in for the SDK's.
  expect(card.suggestions).toHaveLength(1);

  // Allow once.
  const once = await api(`/api/agent/chat/${id}/permission`, "POST", {
    requestId: card.requestId,
    behavior: "allow",
  });
  expect(once.status).toBe(200);
  expect(codex.reply(1)).toEqual({ id: 1, result: { decision: "accept" } });
  const back = await untilStatus(id, "running");
  expect(back.events.find((e) => e.kind === "permission_resolved")).toMatchObject({
    requestId: card.requestId,
    behavior: "allow",
    via: "user",
  });

  // Allow always, with an execpolicy amendment Codex proposed.
  codex.ask(2, "item/commandExecution/requestApproval", {
    ...t,
    itemId: "c1",
    startedAtMs: 2,
    command: "git push",
    proposedExecpolicyAmendment: ["git", "push"],
  });
  const asked2 = await untilStatus(id, "awaiting_input");
  const card2 = asked2.events.filter((e) => e.kind === "permission_request").at(-1) as { requestId: string };
  await api(`/api/agent/chat/${id}/permission`, "POST", {
    requestId: card2.requestId,
    behavior: "allow",
    remember: true,
  });
  expect(codex.reply(2)).toEqual({
    id: 2,
    result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "push"] } } },
  });
  await untilStatus(id, "running");

  // Deny, with a reason — declined for Codex, and the reason steered in.
  codex.ask(3, "item/commandExecution/requestApproval", { ...t, itemId: "c1", startedAtMs: 3, command: "curl x" });
  const asked3 = await untilStatus(id, "awaiting_input");
  const card3 = asked3.events.filter((e) => e.kind === "permission_request").at(-1) as { requestId: string };
  await api(`/api/agent/chat/${id}/permission`, "POST", {
    requestId: card3.requestId,
    behavior: "deny",
    message: "no network here",
  });
  expect(codex.reply(3)).toEqual({ id: 3, result: { decision: "decline" } });
  const steer = codex.sent("turn/steer")!;
  expect(steer.params).toMatchObject({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: expect.stringContaining("no network here") }],
  });
  await untilStatus(id, "running");

  // The denial counts on the turn footer.
  codex.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null, durationMs: 5 } });
  const done = await untilStatus(id, "idle");
  expect(done.events.find((e) => e.kind === "result")).toMatchObject({ denials: 1 });
});

test("a file change approval lists the files its item named; Allow always is for the session", async () => {
  const { id, codex } = await idleCodexSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  await untilStatus(id, "running");
  const t = { threadId: "thread-1", turnId: "turn-1" };
  codex.notify("item/started", {
    ...t,
    item: {
      type: "fileChange",
      id: "f1",
      status: "inProgress",
      changes: [{ path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "-a\n+b" }],
    },
  });
  codex.ask("r-1", "item/fileChange/requestApproval", { ...t, itemId: "f1", startedAtMs: 1, reason: "outside the workspace" });
  const asked = await untilStatus(id, "awaiting_input");
  const card = asked.events.find((e) => e.kind === "permission_request") as Extract<
    ChatEvent,
    { kind: "permission_request" }
  >;
  expect(card).toMatchObject({
    toolName: "Edit",
    input: { file_path: "update src/a.ts", files: ["update src/a.ts"], reason: "outside the workspace" },
    title: "Codex wants to change files",
  });
  await api(`/api/agent/chat/${id}/permission`, "POST", { requestId: card.requestId, behavior: "allow", remember: true });
  expect(codex.reply("r-1")).toEqual({ id: "r-1", result: { decision: "acceptForSession" } });
});

test("a question from Codex is the question card, answered by question id", async () => {
  const { id, codex } = await idleCodexSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  await untilStatus(id, "running");
  codex.ask(9, "item/tool/requestUserInput", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "q",
    questions: [
      { id: "q1", header: "Scope", question: "Which module?", isOther: true, isSecret: false, options: [{ label: "auth", description: "" }] },
    ],
    autoResolutionMs: null,
  });
  const asked = await untilStatus(id, "awaiting_input");
  const card = asked.events.find((e) => e.kind === "permission_request") as Extract<
    ChatEvent,
    { kind: "permission_request" }
  >;
  expect(card.toolName).toBe("AskUserQuestion");
  expect(card.input.questions).toMatchObject([{ question: "Which module?", header: "Scope", multiSelect: false }]);
  await api(`/api/agent/chat/${id}/permission`, "POST", {
    requestId: card.requestId,
    behavior: "allow",
    updatedInput: { questions: card.input.questions, answers: { "Which module?": "auth" } },
  });
  expect(codex.reply(9)).toEqual({ id: 9, result: { answers: { q1: { answers: ["auth"] } } } });
  await untilStatus(id, "running");
});

test("Stop cancels an open card and interrupts the turn; a withdrawn request closes its card unanswered", async () => {
  const { id, codex } = await idleCodexSession();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  await untilStatus(id, "running");
  const t = { threadId: "thread-1", turnId: "turn-1" };
  codex.ask(1, "item/commandExecution/requestApproval", { ...t, itemId: "c1", startedAtMs: 1, command: "sleep 100" });
  await untilStatus(id, "awaiting_input");
  expect((await api(`/api/agent/chat/${id}/interrupt`, "POST")).status).toBe(200);
  expect(codex.reply(1)).toEqual({ id: 1, result: { decision: "cancel" } });
  expect(codex.sent("turn/interrupt")!.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
  codex.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null, durationMs: 5 } });
  const done = await untilStatus(id, "idle");
  expect(done.events.find((e) => e.kind === "permission_resolved")).toMatchObject({ behavior: "deny", via: "interrupt" });
  expect(done.events.find((e) => e.kind === "result")).toMatchObject({ subtype: "interrupted", isError: false });

  // Codex withdraws a request of its own: the card closes, nothing is sent.
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "again" });
  await untilStatus(id, "running");
  codex.ask(2, "item/commandExecution/requestApproval", { ...t, turnId: "turn-2", itemId: "c2", startedAtMs: 2, command: "ls" });
  await untilStatus(id, "awaiting_input");
  codex.notify("serverRequest/resolved", { threadId: "thread-1", requestId: 2 });
  const back = await untilStatus(id, "running");
  expect(codex.reply(2)).toBeUndefined();
  expect(back.events.filter((e) => e.kind === "permission_resolved").at(-1)).toMatchObject({ via: "interrupt" });
});

test("the permission mode is Codex's policy on the next turn, and a change mid-turn says so", async () => {
  const { id, codex } = await idleCodexSession("plan");
  expect(codex.sent("thread/start")!.params).toMatchObject({ approvalPolicy: "on-request", sandbox: "read-only" });
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  await untilStatus(id, "running");
  const mode = await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "bypassPermissions" });
  expect(mode.status).toBe(200);
  const changed = await until(() => snapshot(id), (s) => s.events.some((e) => e.kind === "mode"));
  expect(changed.meta.permissionMode).toBe("bypassPermissions");
  expect(noteTexts(changed).some((t) => t.includes("applies from the next turn"))).toBe(true);
  codex.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null, durationMs: 5 } });
  await untilStatus(id, "idle");
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "now" });
  const second = codex.allSent("turn/start").at(-1)!;
  expect(second.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
});

test("an MCP elicitation is cancelled rather than left hanging", async () => {
  const { id, codex } = await idleCodexSession();
  codex.ask(5, "mcpServer/elicitation/request", { threadId: "thread-1", turnId: null, serverName: "jira", mode: "form", message: "Token?" });
  const seen = await until(
    () => snapshot(id),
    (s) => s.events.some((e) => e.kind === "note" && /dismissed/.test((e as { text: string }).text)),
  );
  expect(seen.meta.status).toBe("idle");
  expect(codex.reply(5)).toEqual({ id: 5, result: { action: "cancel", content: null, _meta: null } });
});

test("a thread that will not start is a failed session, with Codex's words", async () => {
  refuseThread = true;
  const res = await api("/api/agent/chat", "POST", { name: "x", agent: "codex" });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  const ended = await untilStatus(meta.id, "error");
  const note = ended.events.filter((e) => e.kind === "note").at(-1) as { text: string; code: string };
  expect(note.code).toBe("spawn_failed");
  expect(note.text).toContain("Could not start Codex: no auth");
  expect(fakes.at(-1)!.killed).toBe(true);
});

test("codex exiting on its own ends the session, with its last words on a failure", async () => {
  const { id, codex } = await idleCodexSession();
  codex.stderr("error: config.toml is invalid");
  codex.exit(1);
  const ended = await untilStatus(id, "error");
  const note = ended.events.filter((e) => e.kind === "note").at(-1) as { text: string };
  expect(note.text).toContain("Codex exited with code 1.");
  expect(note.text).toContain("config.toml is invalid");
});

test("a codex that never starts is reported as a failed session", async () => {
  const res = await api("/api/agent/chat", "POST", { name: "x", agent: "codex" });
  const meta = (await res.json()) as ChatSessionMeta;
  fakes.at(-1)!.exit(null, new Error("spawn codex ENOENT"));
  const ended = await untilStatus(meta.id, "error");
  const note = ended.events.filter((e) => e.kind === "note").at(-1) as { text: string; code: string };
  expect(note.code).toBe("spawn_failed");
  expect(note.text).toContain("Could not start Codex: spawn codex ENOENT");
});

// Codex is one of the agents "Start session" offers, and picking it opens
// the generated prompt in the pane as Codex's first turn.
test("Start session can open the generated prompt in a codex pane session", async () => {
  const code = join(root, "code");
  await mkdir(code);
  await writeFile(join(data, PROJECT_SETTINGS_FILE), JSON.stringify({ "code-repo": "../code" }));
  const res = await api("/api/agent/session", "POST", {
    name: "implement quotes",
    files: [{ fileName: "specs/quote.feature.md" }],
    target: "codex",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; target: string };
  expect(body.target).toBe("codex");
  const codex = fakes.at(-1)!;
  // The session runs in the code repo, and the thread is named after it.
  expect(codex.options.cwd).toBe(code);
  const snap = await until(() => snapshot(body.id), (s) => codex.sent("turn/start") !== undefined);
  expect(codex.sent("thread/name/set")!.params).toMatchObject({ name: "implement quotes" });
  const input = (codex.sent("turn/start")!.params as { input: { text: string }[] }).input[0]!.text;
  expect(input).toContain("SpecDriven code gen session: implement quotes");
  expect(input).toContain("## Spec: specs/quote.feature.md");
  expect(input).toContain("edit the code, not the specifications");
  expect(snap.meta.agent).toBe("codex");
  expect(snap.events.some((e) => e.kind === "user")).toBe(true);
  expect(snap.meta.status).toBe("running");
});

test("an unknown agent is refused, and Codex needs its CLI", async () => {
  const bad = await api("/api/agent/chat", "POST", { name: "x", agent: "nope" });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("agent must be codex");

  setCodexAvailability(() => false);
  const gone = await api("/api/agent/chat", "POST", { name: "x", agent: "codex" });
  expect(gone.status).toBe(502);
  expect((await gone.json()).error).toContain("Codex CLI not found");
  // The state says which agents this machine can run.
  const state = (await (await api("/api/state")).json()) as { canRunCodex: boolean };
  expect(state.canRunCodex).toBe(false);
});
