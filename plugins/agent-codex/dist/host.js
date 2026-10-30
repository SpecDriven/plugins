// specdriven-shim:@specdriven/host
var m = globalThis.__specdriven?.modules?.["@specdriven/host"];
if (!m)
  throw new Error("SpecDriven did not publish @specdriven/host for plugins");
var host_default = m.default ?? m;
var A = m.A;
var AgentError = m.AgentError;
var HOSTED_REFUSAL = m.HOSTED_REFUSAL;
var agents = m.agents;
var commitAndPush = m.commitAndPush;
var createFeature = m.createFeature;
var createFileDoc = m.createFileDoc;
var fileDocDirRel = m.fileDocDirRel;
var fileExists = m.fileExists;
var getLogger = m.getLogger;
var hasFileDoc = m.hasFileDoc;
var isDemoMode = m.isDemoMode;
var isHostedMode = m.isHostedMode;
var json = m.json;
var jsonlReader = m.jsonlReader;
var listFileDocs = m.listFileDocs;
var loadFileDoc = m.loadFileDoc;
var newFileDoc = m.newFileDoc;
var normalizePermissionMode = m.normalizePermissionMode;
var readTextFile = m.readTextFile;
var removeAndPush = m.removeAndPush;
var removeFileDoc = m.removeFileDoc;
var run = m.run;
var saveFileDoc = m.saveFileDoc;
var sessionWorkDir = m.sessionWorkDir;
var slugify = m.slugify;
var titleFromFileName = m.titleFromFileName;
var which = m.which;
var withSpan = m.withSpan;
var writeTextFile = m.writeTextFile;

// src/cli.ts
var CODEX_BIN = "codex";
var probe = null;
function codexAvailable() {
  return probe ? probe() : which(CODEX_BIN) !== null;
}

// src/oneShot.ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// src/codexChat.ts
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
var nodeSpawn = (o) => {
  const child = spawn(o.bin, o.args, {
    cwd: o.cwd,
    env: o.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const out = new StringDecoder("utf8");
  const err = new StringDecoder("utf8");
  child.stdout.on("data", (chunk) => o.onStdout(out.write(chunk)));
  child.stderr.on("data", (chunk) => o.onStderr(err.write(chunk)));
  child.stdin.on("error", () => {});
  child.on("error", (e) => o.onExit(null, e));
  child.on("close", (code) => o.onExit(code));
  return {
    write: (text) => {
      try {
        child.stdin.write(text);
      } catch {}
    },
    end: () => {
      try {
        child.stdin.end();
      } catch {}
    },
    kill: () => child.kill()
  };
};
var spawner = null;
function codexSpawner() {
  return spawner ?? nodeSpawn;
}
var CODEX_REQUEST_TIMEOUT_MS = 20000;
var CODEX_CLIENT_INFO = { name: "specdriven", title: "SpecDriven", version: "0" };

class CodexClient {
  proc;
  pending = new Map;
  options;
  counter = 0;
  done = false;
  constructor(options) {
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
      }
    });
  }
  get closed() {
    return this.done;
  }
  receive(line) {
    let message;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      message = parsed;
    } catch {
      return;
    }
    const id = message.id;
    const hasId = typeof id === "string" || typeof id === "number";
    const method = typeof message.method === "string" ? message.method : null;
    const params = record(message.params) ?? {};
    if (method !== null && hasId) {
      this.options.onServerRequest(id, method, params);
      return;
    }
    if (method !== null) {
      this.options.onNotification(method, params);
      return;
    }
    if (!hasId)
      return;
    const resolve = this.pending.get(String(id));
    if (!resolve)
      return;
    this.pending.delete(String(id));
    if (message.error !== undefined && message.error !== null) {
      const error = record(message.error);
      resolve({ ok: false, error: (error && text(error.message)) ?? JSON.stringify(message.error) });
      return;
    }
    resolve({ ok: true, result: record(message.result) ?? {} });
  }
  write(message) {
    if (this.done)
      return;
    this.proc.write(JSON.stringify(message) + `
`);
  }
  request(method, params = {}, timeoutMs = CODEX_REQUEST_TIMEOUT_MS) {
    if (this.done)
      return Promise.resolve({ ok: false, error: "Codex exited" });
    const id = `sd-${++this.counter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Codex did not answer ${method}` });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.write({ id, method, params });
    });
  }
  respond(id, result) {
    this.write({ id, result });
  }
  respondError(id, message, code = -32601) {
    this.write({ id, error: { code, message } });
  }
  close() {
    if (this.done)
      return;
    this.done = true;
    this.proc.kill();
  }
}
function codexPolicy(mode) {
  switch (mode) {
    case "acceptEdits":
      return { approvalPolicy: "on-failure", sandbox: "workspace-write" };
    case "plan":
      return { approvalPolicy: "on-request", sandbox: "read-only" };
    case "bypassPermissions":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
}
function codexSandboxPolicy(sandbox) {
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
        excludeSlashTmp: false
      };
  }
}
function codexThreadInfo(data) {
  const thread = record(data?.thread);
  const threadId = thread ? text(thread.id) : null;
  const model = data ? text(data.model) : null;
  const cliVersion = thread ? text(thread.cliVersion) : null;
  return {
    ...threadId ? { threadId } : {},
    ...model ? { model } : {},
    ...cliVersion ? { cliVersion } : {}
  };
}
function codexTextInput(textValue) {
  return [{ type: "text", text: textValue, text_elements: [] }];
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text(value) {
  return typeof value === "string" ? value : null;
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
var CODEX_TOOL = {
  command: "Bash",
  fileChange: "Edit",
  webSearch: "WebSearch",
  imageView: "Read"
};
function fileChangeLine(change) {
  const kind = record(change.kind);
  const verb = kind ? text(kind.type) ?? "update" : "update";
  const path = text(change.path) ?? "";
  const moved = kind ? text(kind.move_path) : null;
  return moved ? `${verb} ${path} → ${moved}` : `${verb} ${path}`;
}
function codexToolUse(item) {
  const id = text(item.id) ?? "";
  switch (item.type) {
    case "commandExecution":
      return {
        type: "tool_use",
        id,
        name: CODEX_TOOL.command,
        input: { command: text(item.command) ?? "", ...text(item.cwd) ? { cwd: item.cwd } : {} }
      };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes.map((c) => record(c)).filter((c) => c !== null);
      return {
        type: "tool_use",
        id,
        name: CODEX_TOOL.fileChange,
        input: {
          file_path: files.map(fileChangeLine).join(", "),
          files: files.map(fileChangeLine)
        }
      };
    }
    case "mcpToolCall":
      return {
        type: "tool_use",
        id,
        name: `${text(item.server) ?? "mcp"}/${text(item.tool) ?? "tool"}`,
        input: item.arguments ?? {}
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
function flattenContent(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return content === undefined || content === null ? "" : JSON.stringify(content);
  return content.map((part) => {
    if (typeof part === "string")
      return part;
    const p = record(part);
    if (!p)
      return "";
    if (p.type === "text")
      return text(p.text) ?? "";
    return `[${text(p.type) ?? "content"}]`;
  }).filter(Boolean).join(`
`);
}
function codexToolResult(item) {
  const id = text(item.id) ?? "";
  const status = text(item.status);
  const failed = status === "failed";
  const declined = status === "declined";
  const base = { kind: "tool_result", toolUseId: id, parentToolUseId: null };
  switch (item.type) {
    case "commandExecution": {
      const output = text(item.aggregatedOutput) ?? "";
      const exit = number(item.exitCode);
      const tail = declined ? "Declined." : exit !== null && exit !== 0 ? `[exit code ${exit}]` : "";
      const content = [output.trimEnd(), tail].filter(Boolean).join(`
`);
      return { ...base, content, isError: failed || declined };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const parts = changes.map((c) => record(c)).filter((c) => c !== null).map((c) => {
        const diff = text(c.diff)?.trimEnd();
        return diff ? `${fileChangeLine(c)}
${diff}` : fileChangeLine(c);
      });
      if (declined)
        parts.push("Declined.");
      return { ...base, content: parts.join(`

`), isError: failed || declined };
    }
    case "mcpToolCall": {
      const result = record(item.result);
      const error = record(item.error);
      const content = error ? text(error.message) ?? "failed" : flattenContent(result?.content);
      return { ...base, content, isError: failed || error !== null };
    }
    case "dynamicToolCall": {
      const items = Array.isArray(item.contentItems) ? item.contentItems : [];
      const content = items.map((c) => record(c)).map((c) => c && c.type === "inputText" ? text(c.text) ?? "" : c ? `[${text(c.type) ?? "content"}]` : "").filter(Boolean).join(`
`);
      return { ...base, content, isError: failed || item.success === false };
    }
    case "webSearch":
    case "imageView":
      return { ...base, content: "", isError: false };
    default:
      return null;
  }
}
function newCodexStream() {
  return { turnId: null, turnStartedAt: null, errors: [], denials: 0, items: new Map };
}
function unwrapErrorMessage(message) {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{"))
    return message;
  try {
    const body = record(JSON.parse(trimmed));
    const inner = body ? record(body.error) : null;
    return (inner && text(inner.message)) ?? (body && text(body.message)) ?? message;
  } catch {
    return message;
  }
}
function turnErrorText(error) {
  if (!error)
    return null;
  const message = unwrapErrorMessage(text(error.message) ?? "");
  const details = text(error.additionalDetails) ?? "";
  const info = error.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : null;
  const head = code && code !== "other" && !message.toLowerCase().includes(code.toLowerCase()) ? `${message} (${code})` : message;
  const line = details && details !== message ? `${head}
${details}` : head;
  return line.trim() || null;
}
function mapCodexNotification(method, params, ctx, stream) {
  const now = ctx.now ?? Date.now;
  switch (method) {
    case "turn/started": {
      const turn = record(params.turn);
      stream.turnId = turn ? text(turn.id) : null;
      if (stream.turnStartedAt === null)
        stream.turnStartedAt = now();
      return [];
    }
    case "item/started": {
      const item = record(params.item);
      const id = item ? text(item.id) : null;
      if (!item || !id)
        return [];
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
      if (!id || !chunk)
        return [];
      return [{ kind: "text_delta", messageId: id, index: 0, text: chunk }];
    }
    case "item/completed": {
      const item = record(params.item);
      const id = item ? text(item.id) : null;
      if (!item || !id)
        return [];
      const events = [];
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
              parentToolUseId: null
            });
          }
          return events;
        }
        case "contextCompaction":
          return [{ kind: "note", level: "info", code: "compact", text: "Context compacted." }];
        case "exitedReviewMode": {
          const review = text(item.review) ?? "";
          return review ? [{ kind: "assistant", messageId: id, turn: ctx.turn, blocks: [{ type: "text", text: review }], parentToolUseId: null }] : [];
        }
        default:
          return events;
      }
    }
    case "turn/completed": {
      const turn = record(params.turn);
      const status = turn ? text(turn.status) : null;
      const startedAt = stream.turnStartedAt;
      const denials = stream.denials;
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
          costUsd: null,
          durationMs: reported ?? (startedAt === null ? 0 : Math.max(0, now() - startedAt)),
          numTurns: 1,
          ...failed && errors.length > 0 ? { text: errors.join(`
`) } : {},
          denials
        }
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
      if (!summary)
        return [];
      return [
        {
          kind: "note",
          level: "info",
          code: "api",
          text: `Codex config: ${summary}${details ? ` — ${details}` : ""}`
        }
      ];
    }
    case "model/rerouted": {
      const to = text(params.toModel);
      return to ? [{ kind: "note", level: "info", code: "api", text: `Codex switched to ${to}.` }] : [];
    }
    default:
      return [];
  }
}
function codexQuestions(params) {
  const list = Array.isArray(params.questions) ? params.questions : [];
  const out = [];
  for (const entry of list) {
    const q = record(entry);
    if (!q)
      continue;
    const id = text(q.id) ?? "";
    const questionText = text(q.question) ?? "";
    if (!id || !questionText)
      continue;
    const options = Array.isArray(q.options) ? q.options : [];
    out.push({
      id,
      question: {
        question: questionText,
        header: text(q.header) ?? "",
        options: options.map((o) => record(o)).filter((o) => o !== null).map((o) => ({ label: text(o.label) ?? "", description: text(o.description) ?? "" })),
        multiSelect: false
      }
    });
  }
  return out;
}
function codexAnswers(questions, answers) {
  const given = record(answers) ?? {};
  const out = {};
  for (const { id, question } of questions) {
    const value = text(given[question.question]) ?? "";
    out[id] = { answers: value ? [value] : [] };
  }
  return { answers: out };
}

// src/oneShot.ts
var KILL_GRACE_MS = 3000;
var STDERR_TAIL = 5;
function codexExecArgs(cwd, outFile, schemaFile, model) {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-C",
    cwd,
    "--color",
    "never",
    "--json",
    ...model ? ["-m", model] : [],
    ...schemaFile ? ["--output-schema", schemaFile] : [],
    "-o",
    outFile,
    "-"
  ];
}
function strictSchema(schema) {
  if (Array.isArray(schema))
    return schema.map(strictSchema);
  if (!schema || typeof schema !== "object")
    return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = key === "properties" && value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strictSchema(v)])) : strictSchema(value);
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}
function codexExecPrompt(req) {
  return `${req.systemPrompt}

${req.prompt}`;
}
function eventError(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object")
    return null;
  if (event.type === "error" && typeof event.message === "string")
    return event.message;
  if (event.type === "turn.failed" && typeof event.error?.message === "string")
    return event.error.message;
  return null;
}
function readableError(raw) {
  let text2 = raw;
  for (let i = 0;i < 4; i++) {
    try {
      const parsed = JSON.parse(text2);
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner !== "string")
        break;
      text2 = inner;
    } catch {
      break;
    }
  }
  return text2.length > 400 ? `${text2.slice(0, 400)}…` : text2;
}
async function codexOneShot(req) {
  if (req.signal?.aborted)
    return { text: "Codex was stopped", isError: true };
  const dir = await mkdtemp(join(tmpdir(), "specdriven-codex-oneshot-"));
  try {
    const outFile = join(dir, "last-message.txt");
    let schemaFile = null;
    if (req.schema) {
      schemaFile = join(dir, "schema.json");
      await writeFile(schemaFile, JSON.stringify(strictSchema(req.schema)), "utf8");
    }
    const outcome = await runExec(req, codexExecArgs(req.cwd, outFile, schemaFile, req.model));
    if (outcome.error) {
      return { text: withTail(`Could not start Codex: ${outcome.error.message}`, outcome.stderrTail), isError: true };
    }
    if (outcome.killed === "timeout")
      return { text: "Codex did not answer in time", isError: true };
    if (outcome.killed === "abort")
      return { text: "Codex was stopped", isError: true };
    const reported = outcome.errors.length ? readableError(outcome.errors[outcome.errors.length - 1]) : "";
    if (outcome.code !== 0) {
      return { text: reported || outcome.stderrTail || `Codex exited with code ${outcome.code}`, isError: true };
    }
    const text2 = (await readFile(outFile, "utf8").catch(() => "")).trim();
    if (!text2)
      return { text: reported || outcome.stderrTail || "Codex gave no answer", isError: true };
    return { text: text2, ...req.schema ? { structured: parseJson(text2) } : {}, isError: false };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function withTail(text2, tail) {
  return tail ? `${text2}
${tail}` : text2;
}
function parseJson(text2) {
  try {
    return JSON.parse(text2);
  } catch {
    return;
  }
}
function runExec(req, args) {
  return new Promise((resolve) => {
    let stderr = [];
    let stderrRest = "";
    const errors = [];
    let stdoutRest = "";
    let killed = null;
    let settled = false;
    let grace = null;
    let timer = null;
    const finish = (code, error) => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      if (grace)
        clearTimeout(grace);
      req.signal?.removeEventListener("abort", onAbort);
      const tail = [...stderr, stderrRest].filter((line) => line.trim()).slice(-STDERR_TAIL);
      const last = eventError(stdoutRest);
      if (last)
        errors.push(last);
      resolve({ code, ...error ? { error } : {}, killed, stderrTail: tail.join(`
`).trim(), errors });
    };
    const child = codexSpawner()({
      bin: which(CODEX_BIN) ?? CODEX_BIN,
      args,
      cwd: req.cwd,
      env: process.env,
      onStdout: (chunk) => {
        const lines = (stdoutRest + chunk).split(`
`);
        stdoutRest = lines.pop() ?? "";
        for (const line of lines) {
          const message = eventError(line);
          if (message)
            errors.push(message);
        }
      },
      onStderr: (chunk) => {
        const lines = (stderrRest + chunk).split(`
`);
        stderrRest = lines.pop() ?? "";
        stderr = [...stderr, ...lines].slice(-STDERR_TAIL);
      },
      onExit: finish
    });
    const kill = (why) => {
      if (settled || killed)
        return;
      killed = why;
      child.kill();
      grace = setTimeout(() => finish(null), KILL_GRACE_MS);
    };
    const onAbort = () => kill("abort");
    if (settled)
      return;
    timer = setTimeout(() => kill("timeout"), req.timeoutMs);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    child.write(codexExecPrompt(req));
    child.end();
  });
}

// src/provider.ts
var CODEX_MISSING = "Codex CLI not found — install the `codex` command (npm i -g @openai/codex)";
var str = (value) => typeof value === "string" ? value : null;
var rec = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
function sessionRule(toolName, ruleContent) {
  return {
    type: "addRules",
    rules: [{ toolName, ...ruleContent ? { ruleContent } : {} }],
    behavior: "allow",
    destination: "session"
  };
}
var DENIED_DEFAULT = "Denied in SpecDriven";

class CodexSession {
  host;
  name;
  cwd;
  client = null;
  stream = newCodexStream();
  requests = new Map;
  stderrTail = [];
  threadId = null;
  mode;
  constructor(host, name, cwd, mode) {
    this.host = host;
    this.name = name;
    this.cwd = cwd;
    this.mode = mode;
  }
  get final() {
    return this.host.status() === "ended" || this.host.status() === "error";
  }
  stderr = (line) => {
    this.stderrTail = [...this.stderrTail, line].slice(-5);
  };
  failed(why) {
    const tail = this.stderrTail.join(`
`);
    this.host.failed(tail ? `Could not start Codex: ${why}
${tail}` : `Could not start Codex: ${why}`, "spawn_failed");
  }
  async ready(prompt) {
    const client = this.client;
    const init = await client.request("initialize", {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    if (this.final)
      return;
    if (!init.ok)
      return this.failed(init.error);
    const policy = codexPolicy(this.mode);
    const started = await client.request("thread/start", {
      cwd: this.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox
    });
    if (this.final)
      return;
    if (!started.ok)
      return this.failed(started.error);
    const info = codexThreadInfo(started.result);
    if (!info.threadId)
      return this.failed("thread/start answered without a thread id");
    this.threadId = info.threadId;
    this.host.note("info", "init", `Codex${info.cliVersion ? ` ${info.cliVersion}` : ""} · ${info.model ?? "no model"} · ${this.cwd}`);
    this.host.note("info", "init", "Permission modes map onto Codex's approval policy and sandbox; a change applies from the next turn.");
    client.request("thread/name/set", { threadId: info.threadId, name: this.name });
    this.host.ready({ agentSessionId: info.threadId, ...info.model ? { model: info.model } : {} });
    if (prompt) {
      try {
        await this.send(prompt);
      } catch (e) {
        this.host.note("error", "api", e.message);
        this.host.turnEnded();
      }
    }
  }
  async send(text2) {
    const client = this.client;
    if (!this.threadId || this.final)
      return;
    const policy = codexPolicy(this.mode);
    const res = await client.request("turn/start", {
      threadId: this.threadId,
      input: codexTextInput(text2),
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: codexSandboxPolicy(policy.sandbox)
    });
    if (this.final)
      return;
    if (!res.ok)
      throw new Error(`Codex refused the turn: ${res.error}`);
    const turn = rec(res.result.turn);
    const turnId = turn ? str(turn.id) : null;
    if (turnId && this.stream.turnId === null)
      this.stream.turnId = turnId;
  }
  async interrupt() {
    const turnId = this.stream.turnId;
    if (this.threadId && turnId && this.client) {
      await this.client.request("turn/interrupt", { threadId: this.threadId, turnId });
    }
  }
  async setPermissionMode(mode) {
    if (this.host.status() === "starting")
      throw new AgentError(409, "Codex is still starting");
    this.mode = mode;
    if (this.host.busy())
      this.host.note("info", "api", "The new mode applies from the next turn.");
  }
  close() {
    this.client?.close();
  }
  notification(method, params) {
    if (this.final)
      return;
    if (method === "turn/started")
      this.host.turnStarted();
    if (method === "serverRequest/resolved") {
      const key = String(params.requestId);
      const pending = this.requests.get(key);
      if (pending) {
        this.requests.delete(key);
        pending.abort();
      }
      return;
    }
    for (const body of mapCodexNotification(method, params, { turn: this.host.turn() }, this.stream)) {
      this.host.emit(body);
    }
    if (method === "turn/completed")
      this.host.turnEnded();
  }
  steer(text2) {
    const turnId = this.stream.turnId;
    if (!this.threadId || !turnId || !this.client)
      return;
    this.client.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: turnId,
      input: codexTextInput(text2)
    });
  }
  ask(rpcId, ask) {
    const client = this.client;
    const key = String(rpcId);
    const withdrawn = new AbortController;
    this.requests.set(key, withdrawn);
    this.host.requestPermission({
      toolName: ask.toolName,
      input: ask.input,
      suggestions: ask.suggestions,
      ...ask.title ? { title: ask.title } : {},
      signal: withdrawn.signal
    }).then(({ decision, via }) => {
      if (!this.requests.delete(key))
        return;
      if (decision.behavior === "deny" && via === "user")
        this.stream.denials += 1;
      const reply = ask.answer(decision, via);
      if (reply === null) {
        client.respondError(rpcId, decision.behavior === "deny" ? decision.message : "Not answered", -32000);
      } else {
        client.respond(rpcId, reply);
      }
      if (decision.behavior === "deny" && via === "user" && decision.message !== DENIED_DEFAULT) {
        this.steer(`The user declined that, saying: ${decision.message}`);
      }
    });
  }
  request(id, method, params) {
    const client = this.client;
    if (this.final) {
      client.respondError(id, "The session has ended", -32000);
      return;
    }
    const reason = str(params.reason);
    const item = this.stream.items.get(str(params.itemId) ?? "");
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = str(params.command) ?? (item ? str(item.command) : null) ?? "";
        const cwd = str(params.cwd) ?? (item ? str(item.cwd) : null);
        const amendment = Array.isArray(params.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment : null;
        this.ask(id, {
          toolName: CODEX_TOOL.command,
          input: { command, ...cwd ? { cwd } : {}, ...reason ? { reason } : {} },
          suggestions: [sessionRule(CODEX_TOOL.command, command)],
          title: "Codex wants to run a command",
          answer: (decision, via) => {
            if (decision.behavior !== "allow")
              return { decision: via === "user" ? "decline" : "cancel" };
            if (!decision.remember)
              return { decision: "accept" };
            return {
              decision: amendment ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } : "acceptForSession"
            };
          }
        });
        return;
      }
      case "item/fileChange/requestApproval": {
        const changes = item && Array.isArray(item.changes) ? item.changes : [];
        const files = changes.map((c) => rec(c)).filter((c) => c !== null).map(fileChangeLine);
        const grantRoot = str(params.grantRoot);
        this.ask(id, {
          toolName: CODEX_TOOL.fileChange,
          input: {
            file_path: files.join(", "),
            files,
            ...reason ? { reason } : {},
            ...grantRoot ? { grantRoot } : {}
          },
          suggestions: [sessionRule(CODEX_TOOL.fileChange, files.join(", "))],
          title: "Codex wants to change files",
          answer: (decision, via) => {
            if (decision.behavior !== "allow")
              return { decision: via === "user" ? "decline" : "cancel" };
            return { decision: decision.remember ? "acceptForSession" : "accept" };
          }
        });
        return;
      }
      case "item/tool/requestUserInput": {
        const questions = codexQuestions(params);
        if (questions.length === 0) {
          client.respond(id, { answers: {} });
          return;
        }
        this.ask(id, {
          toolName: "AskUserQuestion",
          input: { questions: questions.map((q) => q.question) },
          suggestions: [],
          answer: (decision) => decision.behavior === "allow" ? codexAnswers(questions, rec(decision.updatedInput)?.answers) : null
        });
        return;
      }
      case "item/permissions/requestApproval": {
        const requested = rec(params.permissions) ?? {};
        const network = rec(requested.network);
        const fileSystem = rec(requested.fileSystem);
        this.ask(id, {
          toolName: "Permissions",
          input: { ...reason ? { reason } : {}, permissions: requested },
          suggestions: [sessionRule("Permissions", reason ?? "")],
          title: "Codex asks for more permissions",
          answer: (decision) => decision.behavior === "allow" ? {
            permissions: { ...network ? { network } : {}, ...fileSystem ? { fileSystem } : {} },
            scope: decision.remember ? "session" : "turn"
          } : null
        });
        return;
      }
      case "mcpServer/elicitation/request": {
        client.respond(id, { action: "cancel", content: null, _meta: null });
        this.host.note("info", "api", `An MCP server (${str(params.serverName) ?? "unknown"}) asked for input the pane cannot show — dismissed.`);
        return;
      }
      default:
        client.respondError(id, `${method} is not supported by SpecDriven`);
    }
  }
  exited(code, error) {
    if (this.final)
      return;
    const tail = this.stderrTail.join(`
`);
    const detail = (text2) => tail ? `${text2}
${tail}` : text2;
    if (error)
      return this.host.failed(detail(`Could not start Codex: ${error.message}`), "spawn_failed");
    if (code === 0 || code === null)
      return this.host.ended("Codex exited.");
    this.host.failed(detail(`Codex exited with code ${code}.`));
  }
}
var codexProvider = {
  id: "codex",
  label: "Codex",
  description: "OpenAI's Codex CLI, with permission cards for commands and file changes",
  rank: 20,
  cli: CODEX_BIN,
  available: codexAvailable,
  missingMessage: CODEX_MISSING,
  capabilities: {
    permissionModes: ["auto", "default", "acceptEdits", "plan", "bypassPermissions"],
    canInterrupt: true,
    canChangeModeMidSession: true,
    hasAccount: false,
    rememberPermissions: "session",
    oneShot: true
  },
  defaultPermissionMode: "default",
  loginHint: {
    text: "The Codex CLI is not signed in on this machine: run the command in a terminal, then start a new session.",
    command: "codex login"
  },
  async start(opts) {
    const session = new CodexSession(opts.host, opts.name, opts.cwd, opts.permissionMode);
    session.client = new CodexClient({
      cwd: opts.cwd,
      onNotification: (method, params) => session.notification(method, params),
      onServerRequest: (id, method, params) => session.request(id, method, params),
      onStderr: session.stderr,
      onExit: (code, error) => session.exited(code, error)
    });
    opts.signal.addEventListener("abort", () => session.close(), { once: true });
    session.ready(opts.prompt);
    return session;
  },
  oneShot: codexOneShot
};

// src/host.ts
var plugin = {
  name: "agent-codex",
  inject: ["agents"],
  apply(ctx) {
    const agents2 = ctx.need("agents");
    ctx.effect(() => agents2.register(codexProvider));
  }
};
var host_default2 = plugin;
export {
  host_default2 as default
};

//# debugId=121825FB8A1B868264756E2164756E21
//# sourceMappingURL=host.js.map
