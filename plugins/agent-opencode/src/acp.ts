// OpenCode in the coding agent pane (specs/agents/opencode.feature.md in the
// specs repo): `opencode acp` speaks the Agent Client Protocol
// (https://agentclientprotocol.com) — JSON-RPC 2.0, one message per line on
// stdin/stdout. The client asks (`initialize`, `session/new`,
// `session/prompt`, `session/set_config_option`), OpenCode streams
// `session/update` notifications back and asks the client in turn
// (`session/request_permission`). This module is the client and the
// translator: OpenCode's updates become the ChatEventBody the pane already
// renders for Claude, so the transcript, the event log and the browser
// stream are shared.
//
// Framing is strict JSONL: records split on "\n" only, a trailing "\r"
// stripped (the app's jsonlReader). Node's readline also splits on
// U+2028/U+2029, which are legal inside JSON strings.
//
// Node APIs only (src/server/run.ts in the app): this module also runs
// under Electron.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { jsonlReader } from "@specdriven/host";
import type { AgentOutput, AssistantBlock, EffortLevel, SlashCommandInfo } from "@specdriven/host";

// --- The subprocess ---------------------------------------------------------

/** The handle the client keeps on a running `opencode` child. */
export interface OpencodeProcess {
  /** Write to stdin; a dead pipe is not an error worth throwing. */
  write(text: string): void;
  /** Close stdin. */
  end(): void;
  kill(): void;
}

export interface OpencodeSpawnOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  /** The process is gone: an exit code, or an Error when it never started. */
  onExit: (code: number | null, error?: Error) => void;
}

export type OpencodeSpawn = (options: OpencodeSpawnOptions) => OpencodeProcess;

const nodeSpawn: OpencodeSpawn = (o) => {
  const child = spawn(o.bin, o.args, {
    cwd: o.cwd,
    env: o.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = new StringDecoder("utf8");
  const err = new StringDecoder("utf8");
  child.stdout.on("data", (chunk: Buffer) => o.onStdout(out.write(chunk)));
  child.stderr.on("data", (chunk: Buffer) => o.onStderr(err.write(chunk)));
  // A broken pipe after OpenCode has gone is not news; the exit handler has it.
  child.stdin.on("error", () => {});
  child.on("error", (e: Error) => o.onExit(null, e));
  child.on("close", (code) => o.onExit(code));
  return {
    write: (text) => {
      try {
        child.stdin.write(text);
      } catch {
        // Gone; onExit says so.
      }
    },
    end: () => {
      try {
        child.stdin.end();
      } catch {
        // Gone already.
      }
    },
    kill: () => child.kill(),
  };
};

// Injection seam: tests drive a fake OpenCode and never spawn one; null
// restores the real subprocess. The one-shot runs (src/oneShot.ts) use it too.
let spawner: OpencodeSpawn | null = null;

export function setOpencodeSpawn(fn: OpencodeSpawn | null): OpencodeSpawn | null {
  const previous = spawner;
  spawner = fn;
  return previous;
}

export function opencodeSpawner(): OpencodeSpawn {
  return spawner ?? nodeSpawn;
}

// --- JSON-RPC over the pipe ---------------------------------------------------

export type RpcId = string | number;
export type AcpParams = Record<string, unknown>;

export type RpcResult = { ok: true; result: AcpParams } | { ok: false; error: string; code?: number };

/** How long a startup call (initialize, session/new) may take before it counts as failed. */
export const ACP_REQUEST_TIMEOUT_MS = 60_000;

/** Who the client is, in `initialize`. */
export const ACP_CLIENT_INFO = { name: "specdriven", title: "SpecDriven", version: "1" };

/** The protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

export interface AcpClientOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  onNotification: (method: string, params: AcpParams) => void;
  /** OpenCode asks; answer with respond or respondError. */
  onRequest: (id: RpcId, method: string, params: AcpParams) => void;
  onStderr: (line: string) => void;
  onExit: (code: number | null, error?: Error) => void;
  spawn?: OpencodeSpawn;
}

/**
 * A live `opencode acp`. Requests go out with an id and their answer comes
 * back through `request`; notifications and OpenCode's own requests go to
 * the caller.
 */
export class AcpClient {
  private readonly proc: OpencodeProcess;
  private readonly pending = new Map<string, (result: RpcResult) => void>();
  private counter = 0;
  private done = false;

  constructor(private readonly options: AcpClientOptions) {
    const readStdout = jsonlReader((line) => this.receive(line));
    const readStderr = jsonlReader((line) => options.onStderr(line));
    this.proc = (options.spawn ?? opencodeSpawner())({
      bin: options.bin,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      onStdout: readStdout,
      onStderr: readStderr,
      onExit: (code, error) => {
        this.done = true;
        for (const resolve of this.pending.values()) resolve({ ok: false, error: "OpenCode exited" });
        this.pending.clear();
        options.onExit(code, error);
      },
    });
  }

  get closed(): boolean {
    return this.done;
  }

  private receive(line: string): void {
    let message: AcpParams;
    try {
      message = JSON.parse(line) as AcpParams;
    } catch {
      // Not JSON: OpenCode talking to a human. Ignore it.
      return;
    }
    if (!message || typeof message !== "object") return;
    const method = typeof message.method === "string" ? message.method : null;
    const hasId = typeof message.id === "string" || typeof message.id === "number";
    if (method && hasId) {
      this.options.onRequest(message.id as RpcId, method, record(message.params) ?? {});
      return;
    }
    if (method) {
      this.options.onNotification(method, record(message.params) ?? {});
      return;
    }
    if (!hasId) return;
    const resolve = this.pending.get(String(message.id));
    if (!resolve) return;
    this.pending.delete(String(message.id));
    const error = record(message.error);
    if (error) {
      resolve({ ok: false, error: rpcErrorText(error), ...(typeof error.code === "number" ? { code: error.code } : {}) });
    } else {
      resolve({ ok: true, result: record(message.result) ?? {} });
    }
  }

  private write(message: AcpParams): void {
    if (this.done) return;
    this.proc.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  /** Ask OpenCode; no timeout (`0`) for a call that lasts as long as it lasts — a turn. */
  request(method: string, params: AcpParams, timeoutMs = ACP_REQUEST_TIMEOUT_MS): Promise<RpcResult> {
    if (this.done) return Promise.resolve({ ok: false, error: "OpenCode exited" });
    const id = ++this.counter;
    return new Promise<RpcResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(String(id));
          resolve({ ok: false, error: `OpenCode did not answer ${method}` });
        }, timeoutMs);
        // A pending call must not hold the process open on shutdown.
        (timer as { unref?: () => void }).unref?.();
      }
      this.pending.set(String(id), (result) => {
        if (timer) clearTimeout(timer);
        resolve(result);
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: AcpParams): void {
    this.write({ method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, message: string, code = -32603): void {
    this.write({ id, error: { code, message } });
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.proc.kill();
  }
}

/** A JSON-RPC error as a person reads it: its message, and the detail OpenCode put in `data`. */
function rpcErrorText(error: AcpParams): string {
  const message = text(error.message) ?? "OpenCode refused the request";
  const data = error.data;
  const detail = typeof data === "string" ? data : text(record(data)?.message);
  return detail && detail !== message ? `${message}: ${detail}` : message;
}

// --- Small readers ------------------------------------------------------------

export function record(value: unknown): AcpParams | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AcpParams) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --- Session config: model, effort, mode ---------------------------------------

/** One of the session's select options, as `session/new` and `config_option_update` list them. */
export interface AcpSelect {
  /** The option's id, for `session/set_config_option`. */
  id: string;
  current: string | null;
  values: { value: string; name: string }[];
}

export interface AcpConfig {
  model: AcpSelect | null;
  effort: AcpSelect | null;
  mode: AcpSelect | null;
}

/** The `configOptions` list → the three the pane cares about, by category (else by id). */
export function acpConfig(options: unknown): AcpConfig {
  const config: AcpConfig = { model: null, effort: null, mode: null };
  if (!Array.isArray(options)) return config;
  for (const entry of options) {
    const o = record(entry);
    const id = o ? text(o.id) : null;
    if (!o || !id) continue;
    const category = text(o.category);
    const slot: keyof AcpConfig | null =
      category === "model" || id === "model"
        ? "model"
        : category === "thought_level" || id === "effort"
          ? "effort"
          : category === "mode" || id === "mode"
            ? "mode"
            : null;
    if (!slot) continue;
    const values: AcpSelect["values"] = [];
    for (const v of Array.isArray(o.options) ? o.options : []) {
      const r = record(v);
      const value = r ? text(r.value) : null;
      if (value) values.push({ value, name: (r && text(r.name)) ?? value });
    }
    config[slot] = { id, current: text(o.currentValue), values };
  }
  return config;
}

/** OpenCode's effort value → the pane's level; "default" and the rest are none. */
export function effortFromAcp(value: string | null | undefined): EffortLevel | undefined {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return undefined;
  }
}

/** The pane's level (null: OpenCode's default) → the value OpenCode offers for it, or null when it offers none. */
export function effortToAcp(level: EffortLevel | null, effort: AcpSelect): string | null {
  const offered = (value: string) => effort.values.some((v) => v.value === value);
  if (level === null) return offered("default") ? "default" : null;
  if (offered(level)) return level;
  // OpenCode's top level is "xhigh"; Claude Code's "max" means the top.
  if (level === "max" && offered("xhigh")) return "xhigh";
  return null;
}

/** `available_commands_update` → the "/" popup's entries. */
export function acpCommands(list: unknown): SlashCommandInfo[] {
  if (!Array.isArray(list)) return [];
  const commands: SlashCommandInfo[] = [];
  for (const entry of list) {
    const c = record(entry);
    const name = c ? text(c.name) : null;
    if (!c || !name) continue;
    const input = record(c.input);
    commands.push({ name, description: text(c.description) ?? "", argumentHint: (input && text(input.hint)) ?? "" });
  }
  return commands;
}

// --- Tools as the pane names them ------------------------------------------------

/** What a tool row and a permission card show: Claude's tool names where one fits. */
export interface PaneTool {
  name: string;
  input: Record<string, unknown>;
}

/** The file a tool call is about: its input's path, else its first location. */
function toolPath(input: AcpParams, locations: unknown): string | null {
  const own = text(input.filePath) ?? text(input.file_path) ?? text(input.path);
  if (own) return own;
  if (Array.isArray(locations)) {
    const first = record(locations[0]);
    if (first) return text(first.path);
  }
  return null;
}

/**
 * An ACP tool call → the pane's tool: `execute` is Bash, `edit` is Edit (or
 * Write, for OpenCode's write tool), `read` is Read, `search` is Grep or
 * Glob, `fetch` is WebFetch — the names the pane has icons and one-line
 * summaries for. Anything else keeps OpenCode's own name and input.
 */
export function paneTool(call: { kind?: unknown; name?: unknown; title?: unknown; rawInput?: unknown; locations?: unknown }): PaneTool {
  const kind = text(call.kind) ?? "other";
  const own = text(call.name) ?? "";
  const title = text(call.title) ?? "";
  const input: Record<string, unknown> = { ...(record(call.rawInput) ?? {}) };
  const path = toolPath(input, call.locations);
  const withPath = () => (path ? { ...input, file_path: path } : input);
  switch (kind) {
    case "execute": {
      const command = text(input.command) ?? (title && title !== own ? title : "");
      return { name: "Bash", input: { ...input, command } };
    }
    case "edit":
      return { name: own === "write" ? "Write" : "Edit", input: withPath() };
    case "delete":
    case "move":
      return { name: "Edit", input: withPath() };
    case "read":
      return { name: "Read", input: withPath() };
    case "search": {
      const pattern = text(input.pattern) ?? text(input.query) ?? title;
      return { name: own === "glob" ? "Glob" : "Grep", input: { ...input, pattern } };
    }
    case "fetch": {
      if (own === "websearch" || own === "web_search") {
        return { name: "WebSearch", input: { ...input, query: text(input.query) ?? title } };
      }
      return { name: "WebFetch", input: { ...input, url: text(input.url) ?? title } };
    }
    default: {
      if (own === "task") return { name: "Task", input };
      return { name: own || title || "tool", input };
    }
  }
}

/** A tool call's content (text, diffs, terminals) as the one string the pane shows. */
export function flattenToolContent(content: unknown, rawOutput?: unknown): string {
  const parts: string[] = [];
  for (const entry of Array.isArray(content) ? content : []) {
    const c = record(entry);
    if (!c) continue;
    if (c.type === "content") {
      const inner = record(c.content);
      if (!inner) continue;
      if (inner.type === "text") parts.push(text(inner.text) ?? "");
      else parts.push(`[${text(inner.type) ?? "content"}]`);
    } else if (c.type === "diff") {
      const path = text(c.path) ?? "a file";
      parts.push(c.oldText === null || c.oldText === undefined ? `Created ${path}` : `Changed ${path}`);
    } else if (c.type === "terminal") {
      parts.push("[terminal]");
    }
  }
  const joined = parts.filter(Boolean).join("\n");
  if (joined) return joined;
  const out = record(rawOutput);
  return (out && (text(out.output) ?? text(out.error))) ?? "";
}

// --- OpenCode's updates → the pane's events ---------------------------------------

/** A tool call between its announcement and its result. */
interface ToolState {
  kind: unknown;
  name: unknown;
  title: unknown;
  rawInput: AcpParams;
  locations: unknown;
  /** The row as the log last has it (the pane's tool, as JSON); null before it is shown. */
  shown: string | null;
}

/**
 * What a turn has produced so far. OpenCode's text arrives in chunks under
 * a message id and its tool calls in updates under a call id; the pane
 * wants a finished `assistant` message per message and one tool_use per
 * call, so both are held here until they are whole.
 */
export interface AcpStreamContext {
  /** The assistant message streaming now: its id in the pane, OpenCode's id for it, and its text so far. */
  message: { id: string; source: string; text: string } | null;
  /** Assistant messages seen, for ids OpenCode did not give. */
  messages: number;
  /** How many pieces each of OpenCode's message ids has had this turn: text
      that goes on under the same id after a tool call is a piece of its own
      in the pane, below the tool's row, not more of the piece above it. */
  pieces: Map<string, number>;
  tools: Map<string, ToolState>;
  /** Epoch ms the current turn started at, for the turn footer's duration. */
  turnStartedAt: number | null;
  /** The session's cost as OpenCode last reported it (cumulative), and at the turn's start. */
  cost: number;
  costAtTurnStart: number;
  /** Cards the user declined this turn. */
  denials: number;
  /** What went wrong this turn — the turn footer's error text. */
  errors: string[];
}

export function newAcpStream(): AcpStreamContext {
  return {
    message: null,
    messages: 0,
    pieces: new Map(),
    tools: new Map(),
    turnStartedAt: null,
    cost: 0,
    costAtTurnStart: 0,
    denials: 0,
    errors: [],
  };
}

/** The streaming message, finished: its text as one `assistant` event. */
function flushMessage(ctx: { turn: number }, stream: AcpStreamContext): AgentOutput[] {
  const message = stream.message;
  stream.message = null;
  if (!message || !message.text) return [];
  return [
    {
      kind: "assistant",
      messageId: message.id,
      turn: ctx.turn,
      blocks: [{ type: "text", text: message.text }],
      parentToolUseId: null,
    },
  ];
}

/** A tool call's row: its tool_use block — again when what it shows has
    changed, which the pane takes as the same row, updated. */
function showTool(id: string, tool: ToolState, ctx: { turn: number }): AgentOutput[] {
  const pane = paneTool(tool);
  const key = JSON.stringify(pane);
  if (tool.shown === key) return [];
  tool.shown = key;
  const block: AssistantBlock = { type: "tool_use", id, name: pane.name, input: pane.input };
  return [{ kind: "assistant", messageId: `tool-${id}`, turn: ctx.turn, blocks: [block], parentToolUseId: null }];
}

/** What an update says of a tool call, kept: OpenCode announces a call
    ("pending") before its input is whole, and fills it in as it starts. */
function mergeTool(update: AcpParams, stream: AcpStreamContext): { id: string; tool: ToolState } | null {
  const id = text(update.toolCallId);
  if (!id) return null;
  let tool = stream.tools.get(id);
  if (!tool) {
    tool = { kind: null, name: null, title: null, rawInput: {}, locations: null, shown: null };
    stream.tools.set(id, tool);
  }
  if (update.kind !== undefined) tool.kind = update.kind;
  if (update.name !== undefined) tool.name = update.name;
  if (update.title !== undefined) tool.title = update.title;
  if (Array.isArray(update.locations) && update.locations.length > 0) tool.locations = update.locations;
  const input = record(update.rawInput);
  if (input && Object.keys(input).length > 0) tool.rawInput = input;
  return { id, tool };
}

/**
 * One `session/update` → the pane's events. Pure apart from `stream`. The
 * updates the session itself handles (commands, config, usage) and the
 * ones the pane has no use for (thoughts, plans, replays) map to nothing.
 */
export function mapAcpUpdate(
  update: AcpParams,
  ctx: { turn: number; now?: () => number },
  stream: AcpStreamContext,
): AgentOutput[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = record(update.content);
      const chunk = content && content.type === "text" ? (text(content.text) ?? "") : "";
      if (!chunk) return [];
      const id = text(update.messageId);
      const events: AgentOutput[] = [];
      if (stream.message && id && stream.message.source !== id) events.push(...flushMessage(ctx, stream));
      if (!stream.message) {
        stream.messages += 1;
        const source = id ?? `opencode-${stream.messages}`;
        const piece = (stream.pieces.get(source) ?? 0) + 1;
        stream.pieces.set(source, piece);
        stream.message = { id: piece === 1 ? source : `${source}#${piece}`, source, text: "" };
      }
      stream.message.text += chunk;
      events.push({ kind: "text_delta", messageId: stream.message.id, index: 0, text: chunk });
      return events;
    }
    case "tool_call":
    case "tool_call_update": {
      const merged = mergeTool(update, stream);
      if (!merged) return [];
      const { id, tool } = merged;
      const events = flushMessage(ctx, stream);
      // A call's status is "pending" until it says otherwise (ACP), and a
      // pending call's input is not whole: its row waits for it to start.
      const status = text(update.status) ?? (update.sessionUpdate === "tool_call" ? "pending" : null);
      const finished = status === "completed" || status === "failed";
      if (status === "in_progress" || finished || tool.shown !== null) events.push(...showTool(id, tool, ctx));
      if (finished) {
        stream.tools.delete(id);
        events.push({
          kind: "tool_result",
          toolUseId: id,
          content: flattenToolContent(update.content, update.rawOutput),
          isError: status === "failed",
          parentToolUseId: null,
        });
      }
      return events;
    }
    default:
      return [];
  }
}

/** The tool call a permission request is about, once its row is in the log. */
export function showToolForPermission(
  toolCall: AcpParams,
  ctx: { turn: number },
  stream: AcpStreamContext,
): AgentOutput[] {
  const merged = mergeTool(toolCall, stream);
  if (!merged) return [];
  return [...flushMessage(ctx, stream), ...showTool(merged.id, merged.tool, ctx)];
}

/** `usage_update` → the context count, and the session's cost so far. */
export function acpUsage(update: AcpParams, stream: AcpStreamContext): { used: number; size: number | null } | null {
  const cost = record(update.cost);
  const amount = cost ? number(cost.amount) : null;
  if (amount !== null && (text(cost?.currency) ?? "USD") === "USD") stream.cost = amount;
  const used = number(update.used);
  if (used === null) return null;
  return { used, size: number(update.size) };
}

/** A turn goes out: its clock starts, unless one is running (a second prompt mid-turn). */
export function startAcpTurn(stream: AcpStreamContext, now: () => number = Date.now): void {
  if (stream.turnStartedAt === null) stream.turnStartedAt = now();
}

/** The `session/prompt` answer (or its error) → the rest of the turn and its footer. */
export function finishAcpTurn(
  outcome: { stopReason: string } | { error: string },
  ctx: { turn: number; now?: () => number },
  stream: AcpStreamContext,
): AgentOutput[] {
  const now = ctx.now ?? Date.now;
  const events = flushMessage(ctx, stream);
  // A call that never finished (a Stop mid-call) gets its row, so the pane
  // does not hold it open.
  for (const [id, tool] of stream.tools) {
    events.push(...showTool(id, tool, ctx));
    events.push({ kind: "tool_result", toolUseId: id, content: "Stopped", isError: true, parentToolUseId: null });
  }
  stream.tools.clear();
  stream.pieces.clear();
  const errors = [...stream.errors];
  let subtype = "success";
  if ("error" in outcome) {
    errors.push(outcome.error);
    events.push({ kind: "note", level: "error", code: "api", text: outcome.error });
    subtype = "error";
  } else if (outcome.stopReason === "cancelled") {
    subtype = "interrupted";
  } else if (outcome.stopReason === "refusal") {
    errors.push("OpenCode's model refused to go on");
    subtype = "error";
  } else if (outcome.stopReason === "max_tokens" || outcome.stopReason === "max_turn_requests") {
    errors.push(`OpenCode stopped: ${outcome.stopReason.replace(/_/g, " ")}`);
    subtype = "error";
  } else if (errors.length > 0) {
    subtype = "error";
  }
  const startedAt = stream.turnStartedAt;
  const cost = stream.cost - stream.costAtTurnStart;
  const denials = stream.denials;
  stream.turnStartedAt = null;
  stream.costAtTurnStart = stream.cost;
  stream.errors = [];
  stream.denials = 0;
  events.push({
    kind: "result",
    turn: ctx.turn,
    subtype,
    isError: subtype === "error",
    costUsd: cost > 0 ? cost : null,
    durationMs: startedAt === null ? 0 : Math.max(0, now() - startedAt),
    numTurns: 1,
    ...(errors.length > 0 ? { text: errors.join("\n") } : {}),
    denials,
  });
  return events;
}
