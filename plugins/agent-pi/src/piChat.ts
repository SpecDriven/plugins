// Pi in the coding agent pane (specs/agents/integration-with-pi-dev-agent.feature.md):
// pi.dev's terminal coding agent, driven over its RPC mode. `pi --mode rpc`
// speaks JSON lines on stdin/stdout: commands in ({"type":"prompt",…}), a
// `response` per command that carries an `id`, and a stream of events out.
// This module is the client and the translator — pi's events become the same
// ChatEventBody the pane already renders for Claude (src/server/agentChat.ts),
// so the transcript, the event log and the browser stream are shared.
//
// Framing is strict JSONL: records are split on "\n" only, with a trailing
// "\r" stripped. Node's readline also splits on U+2028/U+2029, which are
// legal inside JSON strings, so it must not be used here.
//
// Node APIs only (src/server/run.ts): this module also runs under Electron.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { jsonlReader, which } from "@specdriven/host";
import type { AgentOutput, SlashCommandInfo } from "@specdriven/host";
import { PI_BIN } from "./cli";

export { jsonlReader };

// --- The subprocess ---------------------------------------------------------

/** The handle the client keeps on a running `pi --mode rpc`. */
export interface PiProcess {
  /** Write one framed command; a dead pipe is not an error worth throwing. */
  write(text: string): void;
  kill(): void;
}

export interface PiSpawnOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  /** The process is gone: an exit code, or an Error when it never started. */
  onExit: (code: number | null, error?: Error) => void;
}

export type PiSpawn = (options: PiSpawnOptions) => PiProcess;

const nodeSpawn: PiSpawn = (o) => {
  const child = spawn(o.bin, o.args, {
    cwd: o.cwd,
    env: o.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = new StringDecoder("utf8");
  const err = new StringDecoder("utf8");
  child.stdout.on("data", (chunk: Buffer) => o.onStdout(out.write(chunk)));
  child.stderr.on("data", (chunk: Buffer) => o.onStderr(err.write(chunk)));
  // A broken pipe after pi has gone is not news; the exit handler has it.
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
    kill: () => child.kill(),
  };
};

// Injection seam (the setQueryFactory pattern of agentChat.ts): tests drive a
// fake pi and never spawn one; null restores the real subprocess.
let spawner: PiSpawn | null = null;

export function setPiSpawn(fn: PiSpawn | null): PiSpawn | null {
  const previous = spawner;
  spawner = fn;
  return previous;
}

// --- The client -------------------------------------------------------------

/** One line off pi's stdout: an event, a command response, or extension UI. */
export type PiEvent = Record<string, unknown>;

export interface PiResponse {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/** Extension dialogs block pi until they are answered; the pane shows none. */
const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

/** A command with no answer within this is treated as failed, not hung. */
export const PI_REQUEST_TIMEOUT_MS = 20000;

export interface PiClientOptions {
  cwd: string;
  /** The session's display name — pi's own `--name`. */
  name: string;
  onEvent: (event: PiEvent) => void;
  onStderr: (line: string) => void;
  onExit: (code: number | null, error?: Error) => void;
  env?: Record<string, string | undefined>;
  spawn?: PiSpawn;
}

/**
 * A live `pi --mode rpc`. Commands go out with an id and their `response`
 * comes back through `request`; everything else is an event for the caller.
 */
export class PiClient {
  private readonly proc: PiProcess;
  private readonly pending = new Map<string, (response: PiResponse) => void>();
  private readonly onEvent: (event: PiEvent) => void;
  private counter = 0;
  private done = false;

  constructor(options: PiClientOptions) {
    this.onEvent = options.onEvent;
    const readStdout = jsonlReader((line) => this.receive(line));
    const readStderr = jsonlReader((line) => options.onStderr(line));
    const spawnFn = options.spawn ?? spawner ?? nodeSpawn;
    this.proc = spawnFn({
      bin: which(PI_BIN) ?? PI_BIN,
      args: ["--mode", "rpc", "--name", options.name],
      cwd: options.cwd,
      env: options.env ?? process.env,
      onStdout: readStdout,
      onStderr: readStderr,
      onExit: (code, error) => {
        this.done = true;
        for (const resolve of this.pending.values()) {
          resolve({ success: false, error: "pi exited" });
        }
        this.pending.clear();
        options.onExit(code, error);
      },
    });
  }

  get closed(): boolean {
    return this.done;
  }

  private receive(line: string): void {
    let message: PiEvent;
    try {
      message = JSON.parse(line) as PiEvent;
    } catch {
      // A line that is not JSON is pi talking to a human; ignore it.
      return;
    }
    if (message.type === "response") {
      const resolve = this.pending.get(String(message.id));
      if (resolve) {
        this.pending.delete(String(message.id));
        resolve({
          success: message.success === true,
          ...(typeof message.error === "string" ? { error: message.error } : {}),
          ...(message.data && typeof message.data === "object"
            ? { data: message.data as Record<string, unknown> }
            : {}),
        });
      }
      return;
    }
    // A dialog from an extension blocks pi until it is answered, and the pane
    // has nothing to show it in — cancel it, and let the caller say so.
    if (message.type === "extension_ui_request" && DIALOG_METHODS.has(String(message.method))) {
      this.send({ type: "extension_ui_response", id: message.id, cancelled: true });
    }
    this.onEvent(message);
  }

  /** Fire one command and forget it. */
  send(command: Record<string, unknown>): void {
    if (this.done) return;
    this.proc.write(JSON.stringify(command) + "\n");
  }

  /** Fire one command and wait for its `response`. */
  request(
    command: Record<string, unknown>,
    timeoutMs = PI_REQUEST_TIMEOUT_MS,
  ): Promise<PiResponse> {
    if (this.done) return Promise.resolve({ success: false, error: "pi exited" });
    const id = `sd-${++this.counter}`;
    return new Promise<PiResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ success: false, error: "pi did not answer" });
      }, timeoutMs);
      // A pending command must not hold the process open on shutdown.
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.send({ ...command, id });
    });
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.proc.kill();
  }
}

// --- pi's events → the pane's events ----------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The cost of one message: `usage.cost.total`, when the provider reports it. */
function costOf(usage: unknown): number {
  const cost = record(record(usage)?.cost);
  return number(cost?.total) ?? 0;
}

/** A tool result's content blocks as the one string the pane shows. */
export function flattenPiContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const p = record(part);
      if (!p) return "";
      if (p.type === "text") return text(p.text) ?? "";
      return `[${text(p.type) ?? "content"}]`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * What a turn has produced so far. Pi's messages carry no id, so the pane's
 * message ids are made here — one per assistant message — and the deltas of
 * a message find it through `messageId`.
 */
export interface PiStreamContext {
  messageId: string | null;
  messages: number;
  /** Epoch ms the current turn started at, for the turn footer's duration. */
  turnStartedAt: number | null;
  costUsd: number;
  /** What went wrong this turn — the turn footer's error text. */
  errors: string[];
}

export function newPiStream(): PiStreamContext {
  return { messageId: null, messages: 0, turnStartedAt: null, costUsd: 0, errors: [] };
}

/** The assistant message's blocks, in pi's shape (`toolCall`, `thinking`). */
function assistantBlocks(content: unknown): Extract<AgentOutput, { kind: "assistant" }>["blocks"] {
  const blocks: Extract<AgentOutput, { kind: "assistant" }>["blocks"] = [];
  if (typeof content === "string") {
    if (content) blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const part of content) {
    const p = record(part);
    if (!p) continue;
    if (p.type === "text") {
      const value = text(p.text) ?? "";
      if (value) blocks.push({ type: "text", text: value });
    } else if (p.type === "toolCall") {
      blocks.push({
        type: "tool_use",
        id: text(p.id) ?? "",
        name: text(p.name) ?? "",
        input: p.arguments ?? {},
      });
    }
    // `thinking` is pi's own reasoning trace; the pane does not show it.
  }
  return blocks;
}

/**
 * One pi RPC event → the pane's events. Pure apart from `stream`, which
 * carries what pi leaves to the client: message ids, the turn's clock, its
 * cost and its errors. Events the pane has no use for map to nothing.
 */
export function mapPiEvent(
  event: PiEvent,
  ctx: { turn: number; now?: () => number },
  stream: PiStreamContext,
): AgentOutput[] {
  const now = ctx.now ?? Date.now;
  switch (event.type) {
    case "agent_start": {
      if (stream.turnStartedAt === null) stream.turnStartedAt = now();
      return [];
    }
    case "message_start": {
      const message = record(event.message);
      if (message?.role !== "assistant") return [];
      stream.messages += 1;
      stream.messageId = `pi-${stream.messages}`;
      return [];
    }
    case "message_update": {
      const delta = record(event.assistantMessageEvent);
      if (!delta || delta.type !== "text_delta") return [];
      const chunk = text(delta.delta) ?? "";
      if (!chunk) return [];
      if (stream.messageId === null) {
        stream.messages += 1;
        stream.messageId = `pi-${stream.messages}`;
      }
      return [
        {
          kind: "text_delta",
          messageId: stream.messageId,
          index: number(delta.contentIndex) ?? 0,
          text: chunk,
        },
      ];
    }
    case "message_end": {
      const message = record(event.message);
      if (message?.role !== "assistant") return [];
      stream.costUsd += costOf(message.usage);
      const events: AgentOutput[] = [];
      const blocks = assistantBlocks(message.content);
      if (blocks.length > 0) {
        events.push({
          kind: "assistant",
          messageId: stream.messageId ?? `pi-${++stream.messages}`,
          turn: ctx.turn,
          blocks,
          parentToolUseId: null,
        });
      }
      if (message.stopReason === "error") {
        const detail = text(message.errorMessage) ?? "Pi could not finish the reply";
        stream.errors.push(detail);
        events.push({ kind: "note", level: "error", code: "api", text: detail });
      }
      stream.messageId = null;
      return events;
    }
    case "tool_execution_end": {
      const result = record(event.result);
      return [
        {
          kind: "tool_result",
          toolUseId: text(event.toolCallId) ?? "",
          content: flattenPiContent(result?.content),
          isError: event.isError === true,
          parentToolUseId: null,
        },
      ];
    }
    case "agent_settled": {
      const startedAt = stream.turnStartedAt;
      const errors = stream.errors;
      const costUsd = stream.costUsd;
      stream.turnStartedAt = null;
      stream.errors = [];
      stream.costUsd = 0;
      stream.messageId = null;
      return [
        {
          kind: "result",
          turn: ctx.turn,
          subtype: errors.length > 0 ? "error" : "success",
          isError: errors.length > 0,
          costUsd: costUsd > 0 ? costUsd : null,
          durationMs: startedAt === null ? 0 : Math.max(0, now() - startedAt),
          numTurns: 1,
          ...(errors.length > 0 ? { text: errors.join("\n") } : {}),
          denials: 0,
        },
      ];
    }
    case "compaction_start":
      return [{ kind: "note", level: "info", code: "compact", text: "Compacting the context…" }];
    case "compaction_end":
      return [{ kind: "note", level: "info", code: "compact", text: "Context compacted." }];
    case "auto_retry_start": {
      const why = text(event.error) ?? "a transient error";
      return [{ kind: "note", level: "info", code: "api", text: `Retrying after ${why}…` }];
    }
    case "extension_error": {
      const detail = text(event.error) ?? "An extension failed";
      stream.errors.push(detail);
      return [{ kind: "note", level: "error", code: "api", text: `Pi extension: ${detail}` }];
    }
    case "extension_ui_request": {
      const method = text(event.method) ?? "";
      if (method === "notify") {
        const level = event.notifyType === "error" ? "error" : "info";
        return [
          {
            kind: "note",
            level,
            code: "api",
            text: `Pi: ${text(event.message) ?? ""}`.trimEnd(),
          },
        ];
      }
      if (DIALOG_METHODS.has(method)) {
        return [
          {
            kind: "note",
            level: "info",
            code: "api",
            text: `A Pi extension asked for input the pane cannot show (${method}) — dismissed.`,
          },
        ];
      }
      // setStatus, setWidget, setTitle, set_editor_text: TUI decoration.
      return [];
    }
    default:
      return [];
  }
}

/** `get_commands` data → the "/" popup's entries. */
export function piCommands(data: Record<string, unknown> | undefined): SlashCommandInfo[] {
  const list = data?.commands;
  if (!Array.isArray(list)) return [];
  const commands: SlashCommandInfo[] = [];
  for (const entry of list) {
    const c = record(entry);
    const name = c ? text(c.name) : null;
    if (!name) continue;
    commands.push({
      name,
      description: (c && text(c.description)) ?? "",
      argumentHint: "",
    });
  }
  return commands;
}

/** `get_state` data → what the pane's header shows: the model and pi's id. */
export function piState(data: Record<string, unknown> | undefined): {
  model?: string;
  sessionId?: string;
} {
  const model = record(data?.model);
  const name = model ? (text(model.name) ?? text(model.id)) : null;
  const sessionId = data ? text(data.sessionId) : null;
  return { ...(name ? { model: name } : {}), ...(sessionId ? { sessionId } : {}) };
}
