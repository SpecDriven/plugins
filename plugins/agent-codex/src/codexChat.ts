// Codex in the coding agent pane: OpenAI's Codex CLI, driven over its
// app-server protocol. `codex app-server` speaks JSON-RPC-shaped lines on
// stdin/stdout — requests out ({"id","method","params"}), a response per
// request ({"id","result"} or {"id","error"}), notifications in
// ({"method","params"}) and, unlike pi, requests *from* the server
// ({"id","method","params"}) that block a turn until the client answers:
// the approvals for a command, a file change, a question for the user.
// This module is the client and the translator — Codex's notifications
// become the same ChatEventBody the pane renders for Claude and Pi
// (src/server/agentChat.ts), so the transcript, the event log, the browser
// stream and the session record are shared. The server requests are
// answered in agentChat.ts, where the pane's pending-permission map lives.
//
// The protocol was read out of `codex app-server generate-ts` for Codex CLI
// 0.141 — the v2 methods (thread/start, turn/start, item/*) — not from
// docs, so it is version-coupled. Framing is strict JSONL (src/server/
// piChat.ts jsonlReader): split on "\n" only, never a generic line reader.
//
// Node APIs only (src/server/run.ts): this module also runs under Electron.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { jsonlReader, which } from "@specdriven/host";
import type { AgentOutput, AssistantBlock, PermissionMode } from "@specdriven/host";
import { CODEX_BIN } from "./cli";

// --- The subprocess ---------------------------------------------------------

/** The handle the client keeps on a running `codex app-server`. */
export interface CodexProcess {
  /** Write one framed message; a dead pipe is not an error worth throwing. */
  write(text: string): void;
  kill(): void;
}

export interface CodexSpawnOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  /** The process is gone: an exit code, or an Error when it never started. */
  onExit: (code: number | null, error?: Error) => void;
}

export type CodexSpawn = (options: CodexSpawnOptions) => CodexProcess;

const nodeSpawn: CodexSpawn = (o) => {
  const child = spawn(o.bin, o.args, {
    cwd: o.cwd,
    env: o.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = new StringDecoder("utf8");
  const err = new StringDecoder("utf8");
  child.stdout.on("data", (chunk: Buffer) => o.onStdout(out.write(chunk)));
  child.stderr.on("data", (chunk: Buffer) => o.onStderr(err.write(chunk)));
  // A broken pipe after Codex has gone is not news; the exit handler has it.
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

// Injection seam (the setPiSpawn pattern): tests drive a fake Codex and never
// spawn one; null restores the real subprocess.
let spawner: CodexSpawn | null = null;

export function setCodexSpawn(fn: CodexSpawn | null): CodexSpawn | null {
  const previous = spawner;
  spawner = fn;
  return previous;
}

// --- The client -------------------------------------------------------------

export type RpcId = string | number;
export type CodexParams = Record<string, unknown>;

/** The answer to one of our requests: its result, or the server's words. */
export type CodexResponse =
  | { ok: true; result: CodexParams }
  | { ok: false; error: string };

/** A request with no answer within this is treated as failed, not hung. */
export const CODEX_REQUEST_TIMEOUT_MS = 20000;

/** What the client tells Codex it is. */
export const CODEX_CLIENT_INFO = { name: "specdriven", title: "SpecDriven", version: "0" };

export interface CodexClientOptions {
  cwd: string;
  onNotification: (method: string, params: CodexParams) => void;
  /** A request from Codex; the caller must answer it through `respond`. */
  onServerRequest: (id: RpcId, method: string, params: CodexParams) => void;
  onStderr: (line: string) => void;
  onExit: (code: number | null, error?: Error) => void;
  env?: Record<string, string | undefined>;
  spawn?: CodexSpawn;
}

/**
 * A live `codex app-server`. Requests go out with an id and their response
 * comes back through `request`; notifications and server requests go to the
 * caller.
 */
export class CodexClient {
  private readonly proc: CodexProcess;
  private readonly pending = new Map<string, (response: CodexResponse) => void>();
  private readonly options: CodexClientOptions;
  private counter = 0;
  private done = false;

  constructor(options: CodexClientOptions) {
    this.options = options;
    const readStdout = jsonlReader((line) => this.receive(line));
    const readStderr = jsonlReader((line) => options.onStderr(line));
    const spawnFn = options.spawn ?? spawner ?? nodeSpawn;
    this.proc = spawnFn({
      bin: which(CODEX_BIN) ?? CODEX_BIN,
      args: ["app-server"],
      cwd: options.cwd,
      env: options.env ?? process.env,
      onStdout: readStdout,
      onStderr: readStderr,
      onExit: (code, error) => {
        this.done = true;
        for (const resolve of this.pending.values()) {
          resolve({ ok: false, error: "Codex exited" });
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
    let message: CodexParams;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as CodexParams;
    } catch {
      // A line that is not JSON is Codex talking to a human; ignore it.
      return;
    }
    const id = message.id;
    const hasId = typeof id === "string" || typeof id === "number";
    const method = typeof message.method === "string" ? message.method : null;
    const params = record(message.params) ?? {};
    if (method !== null && hasId) {
      this.options.onServerRequest(id as RpcId, method, params);
      return;
    }
    if (method !== null) {
      this.options.onNotification(method, params);
      return;
    }
    if (!hasId) return;
    const resolve = this.pending.get(String(id));
    if (!resolve) return;
    this.pending.delete(String(id));
    if (message.error !== undefined && message.error !== null) {
      const error = record(message.error);
      resolve({ ok: false, error: (error && text(error.message)) ?? JSON.stringify(message.error) });
      return;
    }
    resolve({ ok: true, result: record(message.result) ?? {} });
  }

  private write(message: CodexParams): void {
    if (this.done) return;
    this.proc.write(JSON.stringify(message) + "\n");
  }

  /** Fire one request and wait for its response. */
  request(
    method: string,
    params: CodexParams = {},
    timeoutMs = CODEX_REQUEST_TIMEOUT_MS,
  ): Promise<CodexResponse> {
    if (this.done) return Promise.resolve({ ok: false, error: "Codex exited" });
    const id = `sd-${++this.counter}`;
    return new Promise<CodexResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Codex did not answer ${method}` });
      }, timeoutMs);
      // A pending request must not hold the process open on shutdown.
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.write({ id, method, params });
    });
  }

  /** Answer one of the server's requests. */
  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  /** Refuse one of the server's requests; Codex reads it as a failure. */
  respondError(id: RpcId, message: string, code = -32601): void {
    this.write({ id, error: { code, message } });
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.proc.kill();
  }
}

// --- Permission modes → Codex's policies ------------------------------------
//
// Codex has no permission modes but two knobs: an approval policy (when it
// asks) and a sandbox (what a command may touch without asking). The pane's
// modes map onto them so the same select serves every agent.

export interface CodexPolicy {
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export function codexPolicy(mode: PermissionMode): CodexPolicy {
  switch (mode) {
    case "acceptEdits":
      // Edits inside the workspace never ask anyway; only a command that
      // fails in the sandbox does.
      return { approvalPolicy: "on-failure", sandbox: "workspace-write" };
    case "plan":
      // Nothing is written without asking.
      return { approvalPolicy: "on-request", sandbox: "read-only" };
    case "bypassPermissions":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    default:
      // "default" and "auto": Codex has no classifier, so both ask on request.
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
}

/** The `sandboxPolicy` a turn/start override wants, for a sandbox mode. */
export function codexSandboxPolicy(sandbox: CodexPolicy["sandbox"]): CodexParams {
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

/** `thread/start`'s answer → what the pane's header shows: the model, the
    thread id (Codex's own session id) and the CLI's version. */
export function codexThreadInfo(data: CodexParams | undefined): {
  threadId?: string;
  model?: string;
  cliVersion?: string;
} {
  const thread = record(data?.thread);
  const threadId = thread ? text(thread.id) : null;
  const model = data ? text(data.model) : null;
  const cliVersion = thread ? text(thread.cliVersion) : null;
  return {
    ...(threadId ? { threadId } : {}),
    ...(model ? { model } : {}),
    ...(cliVersion ? { cliVersion } : {}),
  };
}

/** The `input` of a turn/start or turn/steer: one text item. */
export function codexTextInput(textValue: string): CodexParams[] {
  return [{ type: "text", text: textValue, text_elements: [] }];
}

// --- Codex's notifications → the pane's events ------------------------------

function record(value: unknown): CodexParams | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CodexParams)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The names the pane knows Codex's tool items by — its icons and summaries
    are keyed on Claude Code's tool names (src/frontend/agentChat.ts). */
export const CODEX_TOOL = {
  command: "Bash",
  fileChange: "Edit",
  webSearch: "WebSearch",
  imageView: "Read",
} as const;

/** One file of a fileChange item, as the tool row and the card list it. */
export function fileChangeLine(change: CodexParams): string {
  const kind = record(change.kind);
  const verb = kind ? (text(kind.type) ?? "update") : "update";
  const path = text(change.path) ?? "";
  const moved = kind ? text(kind.move_path) : null;
  return moved ? `${verb} ${path} → ${moved}` : `${verb} ${path}`;
}

/** The tool_use block a started item is shown as, or null for items that
    are not tools (messages, reasoning, plans). */
export function codexToolUse(item: CodexParams): Extract<AssistantBlock, { type: "tool_use" }> | null {
  const id = text(item.id) ?? "";
  switch (item.type) {
    case "commandExecution":
      return {
        type: "tool_use",
        id,
        name: CODEX_TOOL.command,
        input: { command: text(item.command) ?? "", ...(text(item.cwd) ? { cwd: item.cwd } : {}) },
      };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes.map((c) => record(c)).filter((c): c is CodexParams => c !== null);
      return {
        type: "tool_use",
        id,
        name: CODEX_TOOL.fileChange,
        input: {
          file_path: files.map(fileChangeLine).join(", "),
          files: files.map(fileChangeLine),
        },
      };
    }
    case "mcpToolCall":
      return {
        type: "tool_use",
        id,
        name: `${text(item.server) ?? "mcp"}/${text(item.tool) ?? "tool"}`,
        input: item.arguments ?? {},
      };
    case "dynamicToolCall":
      return { type: "tool_use", id, name: text(item.tool) ?? "tool", input: item.arguments ?? {} };
    case "webSearch":
      return { type: "tool_use", id, name: CODEX_TOOL.webSearch, input: { query: text(item.query) ?? "" } };
    case "imageView":
      return { type: "tool_use", id, name: CODEX_TOOL.imageView, input: { file_path: text(item.path) ?? "" } };
    default:
      return null;
  }
}

/** An MCP result's content blocks as the one string the pane shows. */
function flattenContent(content: unknown): string {
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

/** The tool_result a completed item is shown as, or null for non-tools. */
export function codexToolResult(item: CodexParams): Extract<AgentOutput, { kind: "tool_result" }> | null {
  const id = text(item.id) ?? "";
  const status = text(item.status);
  const failed = status === "failed";
  const declined = status === "declined";
  const base = { kind: "tool_result" as const, toolUseId: id, parentToolUseId: null };
  switch (item.type) {
    case "commandExecution": {
      const output = text(item.aggregatedOutput) ?? "";
      const exit = number(item.exitCode);
      const tail = declined ? "Declined." : exit !== null && exit !== 0 ? `[exit code ${exit}]` : "";
      const content = [output.trimEnd(), tail].filter(Boolean).join("\n");
      return { ...base, content, isError: failed || declined };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const parts = changes
        .map((c) => record(c))
        .filter((c): c is CodexParams => c !== null)
        .map((c) => {
          const diff = text(c.diff)?.trimEnd();
          return diff ? `${fileChangeLine(c)}\n${diff}` : fileChangeLine(c);
        });
      if (declined) parts.push("Declined.");
      return { ...base, content: parts.join("\n\n"), isError: failed || declined };
    }
    case "mcpToolCall": {
      const result = record(item.result);
      const error = record(item.error);
      const content = error ? (text(error.message) ?? "failed") : flattenContent(result?.content);
      return { ...base, content, isError: failed || error !== null };
    }
    case "dynamicToolCall": {
      const items = Array.isArray(item.contentItems) ? item.contentItems : [];
      const content = items
        .map((c) => record(c))
        .map((c) => (c && c.type === "inputText" ? (text(c.text) ?? "") : c ? `[${text(c.type) ?? "content"}]` : ""))
        .filter(Boolean)
        .join("\n");
      return { ...base, content, isError: failed || item.success === false };
    }
    case "webSearch":
    case "imageView":
      return { ...base, content: "", isError: false };
    default:
      return null;
  }
}

/**
 * What a turn has produced so far. Codex names its items, so the pane's
 * message ids are the item ids; what the client keeps is the turn's id (an
 * interrupt needs it), its clock, its errors, and the items in flight (a
 * file change's approval card lists the files its item named).
 */
export interface CodexStreamContext {
  /** The active turn's id, from turn/started, until turn/completed. */
  turnId: string | null;
  /** Epoch ms the current turn started at, for the turn footer's duration. */
  turnStartedAt: number | null;
  /** What went wrong this turn — the turn footer's error text. */
  errors: string[];
  /** Approvals the user declined this turn. */
  denials: number;
  /** Items started and not yet completed, by id. */
  items: Map<string, CodexParams>;
}

export function newCodexStream(): CodexStreamContext {
  return { turnId: null, turnStartedAt: null, errors: [], denials: 0, items: new Map() };
}

/**
 * An upstream API error reaches Codex's `message` as the raw response body
 * (`{"error":{"message":"…"}}`); the words inside are what a reader wants.
 */
export function unwrapErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return message;
  try {
    const body = record(JSON.parse(trimmed));
    const inner = body ? record(body.error) : null;
    return (inner && text(inner.message)) ?? (body && text(body.message)) ?? message;
  } catch {
    return message;
  }
}

/** A turn's error as one line: the message, then the details when they add something. */
function turnErrorText(error: CodexParams | null): string | null {
  if (!error) return null;
  const message = unwrapErrorMessage(text(error.message) ?? "");
  const details = text(error.additionalDetails) ?? "";
  const info = error.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : null;
  const head = code && code !== "other" && !message.toLowerCase().includes(code.toLowerCase()) ? `${message} (${code})` : message;
  const line = details && details !== message ? `${head}\n${details}` : head;
  return line.trim() || null;
}

/**
 * One Codex notification → the pane's events. Pure apart from `stream`,
 * which carries what Codex leaves to the client. Notifications the pane has
 * no use for map to nothing.
 */
export function mapCodexNotification(
  method: string,
  params: CodexParams,
  ctx: { turn: number; now?: () => number },
  stream: CodexStreamContext,
): AgentOutput[] {
  const now = ctx.now ?? Date.now;
  switch (method) {
    case "turn/started": {
      const turn = record(params.turn);
      stream.turnId = turn ? text(turn.id) : null;
      if (stream.turnStartedAt === null) stream.turnStartedAt = now();
      return [];
    }
    case "item/started": {
      const item = record(params.item);
      const id = item ? text(item.id) : null;
      if (!item || !id) return [];
      stream.items.set(id, item);
      const tool = codexToolUse(item);
      if (tool) {
        return [{ kind: "assistant", messageId: id, turn: ctx.turn, blocks: [tool], parentToolUseId: null }];
      }
      if (item.type === "contextCompaction") {
        return [{ kind: "note", level: "info", code: "compact", text: "Compacting the context…" }];
      }
      if (item.type === "enteredReviewMode") {
        return [{ kind: "note", level: "info", code: "api", text: "Codex is reviewing the code." }];
      }
      return [];
    }
    case "item/agentMessage/delta": {
      const id = text(params.itemId);
      const chunk = text(params.delta) ?? "";
      if (!id || !chunk) return [];
      return [{ kind: "text_delta", messageId: id, index: 0, text: chunk }];
    }
    case "item/completed": {
      const item = record(params.item);
      const id = item ? text(item.id) : null;
      if (!item || !id) return [];
      const events: AgentOutput[] = [];
      // Every item starts before it completes; if this one did not (a
      // replay, an older Codex), the tool row still needs its call.
      const tool = codexToolUse(item);
      if (tool && !stream.items.has(id)) {
        events.push({ kind: "assistant", messageId: id, turn: ctx.turn, blocks: [tool], parentToolUseId: null });
      }
      stream.items.delete(id);
      const result = codexToolResult(item);
      if (result) {
        events.push(result);
        return events;
      }
      switch (item.type) {
        case "agentMessage":
        case "plan": {
          const value = text(item.text) ?? "";
          if (value) {
            events.push({
              kind: "assistant",
              messageId: id,
              turn: ctx.turn,
              blocks: [{ type: "text", text: value }],
              parentToolUseId: null,
            });
          }
          return events;
        }
        case "contextCompaction":
          return [{ kind: "note", level: "info", code: "compact", text: "Context compacted." }];
        case "exitedReviewMode": {
          const review = text(item.review) ?? "";
          return review
            ? [{ kind: "assistant", messageId: id, turn: ctx.turn, blocks: [{ type: "text", text: review }], parentToolUseId: null }]
            : [];
        }
        default:
          // reasoning, userMessage, hookPrompt, sub-agent traffic: not shown.
          return events;
      }
    }
    case "turn/completed": {
      const turn = record(params.turn);
      const status = turn ? text(turn.status) : null;
      const startedAt = stream.turnStartedAt;
      const denials = stream.denials;
      // The footer repeats the turn's error only when no note said it already.
      const failedText = turnErrorText(turn ? record(turn.error) : null);
      const errors = failedText && !stream.errors.includes(failedText) ? [failedText] : [];
      const failed = status === "failed";
      const reported = number(turn?.durationMs);
      stream.turnId = null;
      stream.turnStartedAt = null;
      stream.errors = [];
      stream.denials = 0;
      stream.items.clear();
      return [
        {
          kind: "result",
          turn: ctx.turn,
          subtype: failed ? "error" : status === "interrupted" ? "interrupted" : "success",
          isError: failed,
          // Codex reports tokens, not dollars.
          costUsd: null,
          durationMs: reported ?? (startedAt === null ? 0 : Math.max(0, now() - startedAt)),
          numTurns: 1,
          ...(failed && errors.length > 0 ? { text: errors.join("\n") } : {}),
          denials,
        },
      ];
    }
    case "error": {
      const detail = turnErrorText(record(params.error)) ?? "Codex could not finish the turn";
      if (params.willRetry === true) {
        return [{ kind: "note", level: "info", code: "api", text: `Retrying after ${detail}…` }];
      }
      stream.errors.push(detail);
      return [{ kind: "note", level: "error", code: "api", text: detail }];
    }
    case "warning":
    case "guardianWarning": {
      const message = text(params.message);
      return message ? [{ kind: "note", level: "info", code: "api", text: `Codex: ${message}` }] : [];
    }
    case "configWarning": {
      const summary = text(params.summary);
      const details = text(params.details);
      if (!summary) return [];
      return [
        {
          kind: "note",
          level: "info",
          code: "api",
          text: `Codex config: ${summary}${details ? ` — ${details}` : ""}`,
        },
      ];
    }
    case "model/rerouted": {
      const to = text(params.toModel);
      return to
        ? [{ kind: "note", level: "info", code: "api", text: `Codex switched to ${to}.` }]
        : [];
    }
    default:
      // thread/status, token usage, reasoning deltas, command output deltas,
      // MCP startup, account and rate-limit chatter: nothing to show.
      return [];
  }
}

// --- Codex's questions → the pane's question card ---------------------------

/** The pane's question shape (src/frontend/agentChat.ts Question). */
export interface PaneQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** `item/tool/requestUserInput` questions → the card's, keeping each id. */
export function codexQuestions(params: CodexParams): { id: string; question: PaneQuestion }[] {
  const list = Array.isArray(params.questions) ? params.questions : [];
  const out: { id: string; question: PaneQuestion }[] = [];
  for (const entry of list) {
    const q = record(entry);
    if (!q) continue;
    const id = text(q.id) ?? "";
    const questionText = text(q.question) ?? "";
    if (!id || !questionText) continue;
    const options = Array.isArray(q.options) ? q.options : [];
    out.push({
      id,
      question: {
        question: questionText,
        header: text(q.header) ?? "",
        options: options
          .map((o) => record(o))
          .filter((o): o is CodexParams => o !== null)
          .map((o) => ({ label: text(o.label) ?? "", description: text(o.description) ?? "" })),
        multiSelect: false,
      },
    });
  }
  return out;
}

/** The card's answers (keyed by question text) → Codex's (keyed by id). */
export function codexAnswers(
  questions: { id: string; question: PaneQuestion }[],
  answers: unknown,
): CodexParams {
  const given = record(answers) ?? {};
  const out: Record<string, { answers: string[] }> = {};
  for (const { id, question } of questions) {
    const value = text(given[question.question]) ?? "";
    out[id] = { answers: value ? [value] : [] };
  }
  return { answers: out };
}
