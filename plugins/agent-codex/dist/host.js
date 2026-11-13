// plugins/agent-codex/src/host.ts
import { homedir as homedir2 } from "node:os";

// specdriven-shim:@specdriven/host
var m = globalThis.__specdriven?.modules?.["@specdriven/host"];
if (!m)
  throw new Error("SpecDriven did not publish @specdriven/host for plugins");
var host_default = m.default ?? m;
var A = m.A;
var AgentError = m.AgentError;
var EFFORT_LEVELS = m.EFFORT_LEVELS;
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
var normalizeEffort = m.normalizeEffort;
var normalizeModel = m.normalizeModel;
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

// plugins/agent-codex/src/auth.ts
import { spawn as nodeSpawn2 } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// plugins/agent-codex/src/cli.ts
var CODEX_BIN = "codex";
var probe = null;
function codexAvailable() {
  return probe ? probe() : which(CODEX_BIN) !== null;
}

// plugins/agent-codex/src/codexChat.ts
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
      args: ["app-server", ...options.extraArgs ?? []],
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
function codexTextInput(textValue, imagePaths = []) {
  const images = imagePaths.map((path) => ({ type: "localImage", path }));
  if (images.length > 0 && !textValue.trim())
    return images;
  return [...images, { type: "text", text: textValue, text_elements: [] }];
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
function codexContextUsage(params) {
  const usage = record(params.tokenUsage);
  const total = number(record(usage?.last)?.totalTokens);
  if (total === null)
    return null;
  const window = number(usage?.modelContextWindow);
  return { totalTokens: total, maxTokens: window !== null && window > 0 ? window : null, detail: "estimate" };
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

// plugins/agent-codex/src/mcpConfig.ts
function tomlString(value) {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\u0000-\u001f\u007f]/g, (c) => {
    const named = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
    return named[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;
  });
  return `"${escaped}"`;
}
function tomlKey(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}
function tomlServer(server) {
  const env = Object.entries(server.env).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  const parts = [
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
    ...env.length ? [`env = { ${env.join(", ")} }`] : []
  ];
  return `{ ${parts.join(", ")} }`;
}
function codexMcpArgs(servers) {
  return servers.flatMap((s) => ["-c", `mcp_servers.${tomlKey(s.name)}=${tomlServer(s)}`]);
}

// plugins/agent-codex/src/settings.ts
var CODEX_AUTH_MODES = ["login", "api"];
var OPENAI_API_URL = "https://api.openai.com/v1";
var DEFAULT_SETTINGS = { codexAuth: null, codexApiUrl: null, defaultModel: null };
var MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/;
function normalizeModel2(value) {
  if (typeof value !== "string")
    return null;
  const model = value.trim();
  return MODEL_ID.test(model) ? model : null;
}
function normalizeCodexAuth(value) {
  return CODEX_AUTH_MODES.includes(value) ? value : null;
}
function normalizeCodexApiUrl(value) {
  if (typeof value !== "string")
    return null;
  const url = value.trim().replace(/\/+$/, "");
  if (!url)
    return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
function codexSettingsOf(section) {
  return {
    codexAuth: normalizeCodexAuth(section.codexAuth),
    codexApiUrl: normalizeCodexApiUrl(section.codexApiUrl),
    defaultModel: normalizeModel2(section.defaultModel)
  };
}
function codexSettingsPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { error: "a settings object is required" };
  const b = body;
  const patch = {};
  if (b.codexAuth !== undefined) {
    if (b.codexAuth === null)
      patch.codexAuth = null;
    else {
      const mode = normalizeCodexAuth(b.codexAuth);
      if (!mode)
        return { error: "codexAuth must be login, api or null" };
      patch.codexAuth = mode;
    }
  }
  if (b.codexApiUrl !== undefined) {
    if (b.codexApiUrl !== null && typeof b.codexApiUrl !== "string") {
      return { error: "codexApiUrl must be a string or null" };
    }
    const typed = (b.codexApiUrl ?? "").trim();
    const url = normalizeCodexApiUrl(typed);
    if (typed && !url)
      return { error: "codexApiUrl must be an http:// or https:// url" };
    patch.codexApiUrl = url;
  }
  if (b.defaultModel !== undefined) {
    if (b.defaultModel !== null && typeof b.defaultModel !== "string") {
      return { error: "defaultModel must be a string or null" };
    }
    const model = (b.defaultModel ?? "").trim();
    if (model && !normalizeModel2(model))
      return { error: "Enter a model id, with no spaces" };
    patch.defaultModel = model || null;
  }
  if (Object.keys(patch).length === 0)
    return { error: "codexAuth, codexApiUrl or defaultModel is required" };
  return { patch };
}

// plugins/agent-codex/src/auth.ts
var log = getLogger("agent-codex");

class CodexAuthError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex");
}
function tomlValue(raw) {
  const value = raw.trim();
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (basic) {
    try {
      return JSON.parse(`"${basic[1]}"`);
    } catch {
      return basic[1];
    }
  }
  const literal = /^'([^']*)'/.exec(value);
  return literal ? literal[1] : null;
}
function readCodexConfig(text2) {
  const config = { modelProvider: null, openaiBaseUrl: null, forcedLoginMethod: null, providers: {} };
  let table = "";
  for (const line of text2.split(`
`)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#"))
      continue;
    const header = /^\[([^\]]+)\]/.exec(trimmed);
    if (header) {
      const provider = /^model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/.exec(header[1].trim());
      table = provider ? provider[1] ?? provider[2] ?? provider[3] : null;
      if (table && !config.providers[table])
        config.providers[table] = { baseUrl: null, envKey: null };
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!pair || table === null)
      continue;
    const value = tomlValue(pair[2]);
    if (value === null)
      continue;
    if (table === "") {
      if (pair[1] === "model_provider")
        config.modelProvider = value;
      if (pair[1] === "openai_base_url")
        config.openaiBaseUrl = value;
      if (pair[1] === "forced_login_method")
        config.forcedLoginMethod = value;
    } else {
      const provider = config.providers[table];
      if (pair[1] === "base_url")
        provider.baseUrl = value;
      if (pair[1] === "env_key")
        provider.envKey = value;
    }
  }
  return config;
}
async function detectCodexApi(env = process.env, home = codexHome(env)) {
  const found = { url: null, urlSource: null, key: null, keySource: null, requiresApiKey: false };
  const configFile = join(home, "config.toml");
  let envKey = null;
  try {
    const config = readCodexConfig(await readFile(configFile, "utf8"));
    const provider = config.modelProvider ? config.providers[config.modelProvider] : undefined;
    const url = normalizeCodexApiUrl(provider?.baseUrl ?? (provider ? null : config.openaiBaseUrl));
    if (url) {
      found.url = url;
      found.urlSource = configFile;
    }
    envKey = provider?.envKey ?? null;
    found.requiresApiKey = config.forcedLoginMethod === "api";
  } catch {}
  if (envKey && env[envKey]) {
    found.key = env[envKey];
    found.keySource = "environment";
    return found;
  }
  const authFile = join(home, "auth.json");
  try {
    const key = JSON.parse(await readFile(authFile, "utf8"))?.OPENAI_API_KEY;
    if (typeof key === "string" && key) {
      found.key = key;
      found.keySource = authFile;
    }
  } catch {}
  return found;
}
async function effectiveCodexAuth(own, storedKey, env = process.env) {
  const detected = await detectCodexApi(env);
  const chosen = normalizeCodexAuth(own.codexAuth);
  const mode = chosen ?? (detected.url || detected.key ? "api" : "login");
  const storedUrl = normalizeCodexApiUrl(own.codexApiUrl);
  const key = storedKey ?? detected.key;
  const url = storedUrl ?? detected.url ?? (key ? OPENAI_API_URL : null);
  return {
    mode,
    inferred: chosen === null,
    api: mode === "api" && url ? { url, key } : null,
    url,
    own: storedUrl !== null || storedKey !== null,
    detected,
    storedUrl,
    storedKey: storedKey !== null
  };
}
var API_PROVIDER = "specdriven";
var API_KEY_ENV = "SPECDRIVEN_CODEX_API_KEY";
var LOGIN_SETS_ASIDE = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", API_KEY_ENV];
var ACCOUNT_ARGS = ["-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"'];
function plainLaunch(env = process.env) {
  return { mode: "api", env, args: [], apiBaseUrl: undefined };
}
function launchFor(auth, chatgpt, env = process.env) {
  const processEnv = { ...env };
  if (auth.mode === "login") {
    if (!chatgpt)
      throw new CodexAuthError(NOT_SIGNED_IN, 502);
    for (const name of LOGIN_SETS_ASIDE)
      delete processEnv[name];
    return { mode: "login", env: processEnv, args: [...ACCOUNT_ARGS], apiBaseUrl: undefined };
  }
  delete processEnv[API_KEY_ENV];
  if (!auth.api || !auth.own) {
    return { mode: "api", env: processEnv, args: [], apiBaseUrl: auth.api?.url };
  }
  const { url, key } = auth.api;
  if (key)
    processEnv[API_KEY_ENV] = key;
  const provider = [
    `name = ${tomlString("API")}`,
    `base_url = ${tomlString(url)}`,
    'wire_api = "responses"',
    ...key ? [`env_key = ${tomlString(API_KEY_ENV)}`] : []
  ];
  return {
    mode: "api",
    env: processEnv,
    args: [
      "-c",
      `model_provider=${tomlString(API_PROVIDER)}`,
      "-c",
      `model_providers.${API_PROVIDER}={ ${provider.join(", ")} }`,
      ...chatgpt ? ["-c", 'forced_login_method="chatgpt"'] : []
    ],
    apiBaseUrl: url
  };
}
var NOT_SIGNED_IN = "Codex is not signed in to a ChatGPT account — sign in in Settings → Codex, or choose the API there";
var codexBin = () => which(CODEX_BIN);
var statusProbe = null;
async function loginStatus(runner = run, bin = codexBin()) {
  if (statusProbe && runner === run)
    return statusProbe();
  if (!bin)
    return { loggedIn: false, method: "missing", email: null };
  const result = await runner(bin, [...ACCOUNT_ARGS, "login", "status"], { env: process.env });
  const said = `${result.stdout}
${result.stderr}`;
  const loggedIn = result.exitCode === 0 && /chatgpt/i.test(said);
  log.debug("codex login status", { exit: result.exitCode, loggedIn });
  return { loggedIn, method: loggedIn ? "chatgpt" : "none", email: null };
}
var ACCOUNT_TIMEOUT_MS = 8000;
async function accountEmail(cwd = process.cwd()) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (email) => {
      if (settled)
        return;
      settled = true;
      client.close();
      resolve(email);
    };
    const client = new CodexClient({
      cwd,
      extraArgs: [...ACCOUNT_ARGS],
      onNotification: () => {},
      onServerRequest: (id) => client.respondError(id, "not supported"),
      onStderr: () => {},
      onExit: () => done(null)
    });
    (async () => {
      const init = await client.request("initialize", { clientInfo: CODEX_CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }, ACCOUNT_TIMEOUT_MS);
      if (!init.ok)
        return done(null);
      const read = await client.request("account/read", {}, ACCOUNT_TIMEOUT_MS);
      const account = read.ok ? read.result.account : null;
      done(account && account.type === "chatgpt" && typeof account.email === "string" && account.email ? account.email : null);
    })();
  });
}
var flow = null;
var signInListeners = new Set;
function onSignInChange(fn) {
  signInListeners.add(fn);
  return () => {
    signInListeners.delete(fn);
  };
}
function signInChanged() {
  for (const fn of [...signInListeners]) {
    try {
      fn();
    } catch (e) {
      console.error(`[agent-codex] sign-in listener: ${e.message}`);
    }
  }
}
var LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
var LOGIN_POLL_MS = 2000;
var URL_WAIT_MS = 1500;
function publicState(f) {
  return { inProgress: f.inProgress, url: f.url, done: f.done, error: f.error };
}
function loginState() {
  return flow ? publicState(flow) : null;
}
var CANCELLED = "Sign-in cancelled";
function finish(f, error) {
  if (!f.inProgress)
    return;
  f.inProgress = false;
  f.done = error === null;
  f.error = error;
  if (error === null)
    log.info("sign-in done");
  else if (error === CANCELLED)
    log.info("sign-in cancelled");
  else
    log.warn("sign-in ended without a login", { error, output: f.output.slice(-3).join(" | ") });
  if (f.timer)
    clearTimeout(f.timer);
  if (f.poll)
    clearTimeout(f.poll);
  f.timer = null;
  f.poll = null;
  const child = f.child;
  f.child = null;
  if (child && child.exitCode === null)
    child.kill();
  for (const wake of f.urlWaiters.splice(0))
    wake();
  if (error === null)
    signInChanged();
}
async function startLogin(deps = {}) {
  if (flow?.inProgress)
    throw new CodexAuthError("A sign-in is already in progress", 409);
  const codex = (deps.executable ?? codexBin)();
  if (!codex)
    throw new CodexAuthError("The Codex CLI is not installed — install the codex command, then sign in", 502);
  const status = deps.status ?? (() => loginStatus());
  const f = { inProgress: true, url: null, done: false, error: null, child: null, output: [], timer: null, poll: null, urlWaiters: [] };
  flow = f;
  let child;
  try {
    child = (deps.spawn ?? nodeSpawn2)(codex, [...ACCOUNT_ARGS, "login"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    finish(f, `Could not start the Codex CLI: ${e.message}`);
    return publicState(f);
  }
  f.child = child;
  log.info("sign-in started", { codex, pid: child.pid ?? "?" });
  const onData = (data) => {
    const text2 = String(data);
    const lines = text2.split(`
`).map((l) => l.trim()).filter(Boolean);
    f.output = [...f.output, ...lines].slice(-20);
    if (!f.url) {
      const match = /https:\/\/[^\s'"<>)\]]+/.exec(text2);
      if (match) {
        f.url = match[0].replace(/[.,;]+$/, "");
        for (const wake of f.urlWaiters.splice(0))
          wake();
      }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => finish(f, `Could not start the Codex CLI: ${e.message}`));
  child.on("exit", (code) => {
    if (!f.inProgress)
      return;
    status().then((s) => {
      if (!f.inProgress)
        return;
      if (s.loggedIn)
        finish(f, null);
      else
        finish(f, `Sign-in ended without a login (exit ${code ?? "?"})${f.output.length ? `: ${f.output.slice(-2).join(" ")}` : ""}`);
    }, (e) => finish(f, `Sign-in ended, but asking who is signed in failed: ${e.message}`));
  });
  const pollMs = deps.pollMs ?? LOGIN_POLL_MS;
  const check = async () => {
    if (!f.inProgress)
      return;
    try {
      if ((await status()).loggedIn)
        return finish(f, null);
    } catch {}
    if (f.inProgress)
      f.poll = setTimeout(() => void check(), pollMs);
  };
  f.poll = setTimeout(() => void check(), pollMs);
  f.timer = setTimeout(() => finish(f, "Sign-in timed out — try again"), deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
  await new Promise((resolve) => {
    if (f.url || !f.inProgress)
      return resolve();
    f.urlWaiters.push(resolve);
    setTimeout(resolve, deps.urlWaitMs ?? URL_WAIT_MS);
  });
  return publicState(f);
}
function cancelLogin() {
  if (flow?.inProgress)
    finish(flow, CANCELLED);
  return loginState();
}
async function logout(runner = run, bin = codexBin()) {
  cancelLogin();
  if (!bin)
    throw new CodexAuthError("The Codex CLI is not installed", 502);
  if (!(await loginStatus(runner, bin)).loggedIn)
    throw new CodexAuthError("No ChatGPT account is signed in", 409);
  const result = await runner(bin, ["logout"], { env: process.env });
  if (result.exitCode !== 0) {
    throw new CodexAuthError(`Could not sign out: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`, 502);
  }
  log.info("signed out");
  signInChanged();
}
var SENDABLE_KEY = /^[\x21-\x7e]+$/;
var UNSENDABLE_KEY = "The API key has characters a request cannot carry — a space, a line break or a letter outside ASCII";
function withoutKey(message, key) {
  return key ? message.split(key).join("[key]") : message;
}
function modelsUrl(url) {
  return new URL("models", url.endsWith("/") ? url : `${url}/`);
}
async function checkApi(url, key, fetchFn = fetch, timeoutMs = 5000) {
  let target;
  try {
    target = modelsUrl(url);
  } catch {
    return { result: "unreachable", detail: "Not a url" };
  }
  if (key && !SENDABLE_KEY.test(key))
    return { result: "unauthorized", detail: UNSENDABLE_KEY };
  try {
    const res = await fetchFn(target, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.ok)
      return { result: "ok", detail: key ? "Reachable, and the key was accepted" : "Reachable" };
    if (res.status === 401 || res.status === 403) {
      return { result: "unauthorized", detail: key ? `The API refused the key (HTTP ${res.status})` : `The API wants a key (HTTP ${res.status})` };
    }
    return { result: "unexpected", detail: `Reachable, but it answered HTTP ${res.status}` };
  } catch (e) {
    const message = e.name === "TimeoutError" ? "no answer in time" : withoutKey(e.message, key);
    return { result: "unreachable", detail: `Could not reach ${target.origin}: ${message}` };
  }
}

// plugins/agent-codex/src/models.ts
import { readFile as readFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
var API_MODELS_TIMEOUT_MS = 1e4;
var MAX_MODELS = 200;
function apiModelsOf(rows) {
  const models = [];
  if (!Array.isArray(rows))
    return models;
  for (const row of rows) {
    const value = normalizeModel2(row?.id);
    if (!value || models.some((m2) => m2.value === value))
      continue;
    const name = typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : value;
    models.push({ value, displayName: name, description: "" });
    if (models.length === MAX_MODELS)
      break;
  }
  return models;
}
async function fetchApiModels(url, key, fetchFn = fetch, timeoutMs = API_MODELS_TIMEOUT_MS) {
  if (key && !SENDABLE_KEY.test(key))
    throw new Error(UNSENDABLE_KEY);
  const res = await fetchFn(modelsUrl(url), {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(timeoutMs)
  }).catch((e) => {
    throw new Error(e.name === "TimeoutError" ? "The API did not list its models in time" : withoutKey(e.message, key));
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(key ? `The API refused the key (HTTP ${res.status})` : `The API wants a key (HTTP ${res.status})`);
  }
  if (!res.ok)
    throw new Error(`The API answered HTTP ${res.status} to /models`);
  const body = await res.json().catch(() => null);
  return apiModelsOf(Array.isArray(body) ? body : body?.data);
}
function accountModelsOf(rows) {
  const models = [];
  if (!Array.isArray(rows))
    return models;
  for (const row of rows) {
    const value = normalizeModel2(row?.model ?? row?.id);
    if (!value || row.hidden === true || models.some((m2) => m2.value === value))
      continue;
    models.push({
      value,
      displayName: typeof row.displayName === "string" && row.displayName ? row.displayName : value,
      description: typeof row.description === "string" ? row.description : ""
    });
  }
  return models;
}
var ACCOUNT_MODELS_TIMEOUT_MS = 15000;
async function fetchAccountModels(cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (models, error) => {
      if (settled)
        return;
      settled = true;
      client.close();
      if (models)
        resolve(models);
      else
        reject(new Error(error ?? "Codex did not list its models"));
    };
    const client = new CodexClient({
      cwd,
      extraArgs: [...ACCOUNT_ARGS],
      onNotification: () => {},
      onServerRequest: (id) => client.respondError(id, "not supported"),
      onStderr: () => {},
      onExit: (_code, error) => done(null, error ? `Could not start Codex: ${error.message}` : "Codex exited before listing its models")
    });
    (async () => {
      const init = await client.request("initialize", { clientInfo: CODEX_CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }, ACCOUNT_MODELS_TIMEOUT_MS);
      if (!init.ok)
        return done(null, init.error);
      const listed = await client.request("model/list", {}, ACCOUNT_MODELS_TIMEOUT_MS);
      if (!listed.ok)
        return done(null, listed.error);
      done(accountModelsOf(listed.result.data));
    })();
  });
}
var MODELS_TTL_MS = 10 * 60000;
var cached = null;
var pending = null;
async function offeredModels(ask, key, now = Date.now()) {
  if (cached && cached.key === key && now - cached.at < MODELS_TTL_MS)
    return cached.models;
  if (pending?.key !== key) {
    const mine = { key, asking: Promise.resolve([]) };
    mine.asking = ask().then((models) => {
      if (pending === mine)
        cached = { key, models, at: Date.now() };
      return models;
    }).finally(() => {
      if (pending === mine)
        pending = null;
    });
    pending = mine;
  }
  return pending.asking;
}
function forgetModels() {
  cached = null;
  pending = null;
}
var CODEX_MODELS_FILE = ".specdriven/codex-models.json";
var AGENT_MODELS_FILE = ".specdriven/agent-models.json";
async function readJson(path) {
  return JSON.parse(await readFile2(path, "utf8"));
}
async function listedCodexModels(dataDir) {
  if (!dataDir)
    return [];
  let list;
  try {
    list = await readJson(join2(dataDir, CODEX_MODELS_FILE));
  } catch (e) {
    if (e.code !== "ENOENT")
      return [];
    try {
      list = (await readJson(join2(dataDir, AGENT_MODELS_FILE)))?.codex;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list))
    return [];
  return list.map(normalizeModel2).filter((m2) => m2 !== null);
}

// plugins/agent-codex/src/modelMenu.ts
function narrowModels(all, listed) {
  if (listed.length === 0)
    return [...all];
  return listed.map((name) => all.find((m2) => m2.value === name) ?? { value: name, displayName: name, description: "" });
}

// plugins/agent-codex/src/oneShot.ts
import { mkdtemp, readFile as readFile3, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var KILL_GRACE_MS = 3000;
var STDERR_TAIL = 5;
function codexExecArgs(cwd, outFile, schemaFile, model, overrides = []) {
  return [
    "exec",
    ...overrides,
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
async function codexOneShot(req, launch) {
  if (req.signal?.aborted)
    return { text: "Codex was stopped", isError: true };
  const dir = await mkdtemp(join3(tmpdir(), "specdriven-codex-oneshot-"));
  try {
    const outFile = join3(dir, "last-message.txt");
    let schemaFile = null;
    if (req.schema) {
      schemaFile = join3(dir, "schema.json");
      await writeFile(schemaFile, JSON.stringify(strictSchema(req.schema)), "utf8");
    }
    const model = req.model ?? launch?.model ?? undefined;
    const outcome = await runExec(req, codexExecArgs(req.cwd, outFile, schemaFile, model, launch?.args), launch?.env ?? process.env);
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
    const text2 = (await readFile3(outFile, "utf8").catch(() => "")).trim();
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
function runExec(req, args, env) {
  return new Promise((resolve) => {
    let stderr = [];
    let stderrRest = "";
    const errors = [];
    let stdoutRest = "";
    let killed = null;
    let settled = false;
    let grace = null;
    let timer = null;
    const finish2 = (code, error) => {
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
      env,
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
      onExit: finish2
    });
    const kill = (why) => {
      if (settled || killed)
        return;
      killed = why;
      child.kill();
      grace = setTimeout(() => finish2(null), KILL_GRACE_MS);
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

// plugins/agent-codex/src/provider.ts
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
var LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;
function describeSignIn(choice) {
  if (choice.mode === "api") {
    let endpoint;
    try {
      endpoint = choice.apiUrl ? new URL(choice.apiUrl) : undefined;
    } catch {}
    if (!endpoint)
      return { billing: "api", label: "API", detail: "API · as Codex's own config has it" };
    const label = LOCAL_HOSTS.test(endpoint.hostname) ? "LOCAL" : endpoint.hostname;
    return { billing: "api", label: `API:${label}`, detail: `API calls go to ${endpoint.host}` };
  }
  if (choice.login?.loggedIn) {
    const who = choice.login.email ? ` · ${choice.login.email}` : "";
    return { billing: "plan", label: "ChatGPT account", detail: `ChatGPT account${who}` };
  }
  return { billing: "none", label: "Not logged in", detail: "Sign in with your ChatGPT account in Settings → Codex." };
}

class CodexSession {
  host;
  name;
  cwd;
  startModel;
  account;
  client = null;
  stream = newCodexStream();
  requests = new Map;
  stderrTail = [];
  threadId = null;
  mode;
  model = null;
  lastCount = null;
  nextModel = null;
  constructor(host, name, cwd, mode, startModel = null, account = null) {
    this.host = host;
    this.name = name;
    this.cwd = cwd;
    this.startModel = startModel;
    this.account = account;
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
  async ready(prompt, images) {
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
      sandbox: policy.sandbox,
      ...this.startModel ? { model: this.startModel } : {}
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
    this.model = info.model ?? null;
    this.host.ready({
      agentSessionId: info.threadId,
      ...info.model ? { model: info.model } : {},
      ...this.account ? { account: this.account } : {}
    });
    if (prompt || images?.length) {
      try {
        await this.send(prompt ?? "", images);
      } catch (e) {
        this.host.note("error", "api", e.message);
        this.host.turnEnded();
      }
    }
  }
  async send(text2, images) {
    const client = this.client;
    if (!this.threadId || this.final)
      return;
    const policy = codexPolicy(this.mode);
    const res = await client.request("turn/start", {
      threadId: this.threadId,
      input: codexTextInput(text2, images?.map((image) => image.path)),
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: codexSandboxPolicy(policy.sandbox),
      ...this.nextModel ? { model: this.nextModel } : {}
    });
    if (this.final)
      return;
    if (!res.ok)
      throw new Error(`Codex refused the turn: ${res.error}`);
    if (this.nextModel) {
      this.model = this.nextModel;
      this.nextModel = null;
    }
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
  async setModel(model) {
    if (this.host.status() === "starting")
      throw new AgentError(409, "Codex is still starting");
    const next = model ?? this.startModel;
    this.nextModel = next && next !== this.model ? next : null;
    if (this.host.busy())
      this.host.note("info", "api", "The new model applies from the next turn.");
  }
  close() {
    this.client?.close();
  }
  notification(method, params) {
    if (this.final)
      return;
    if (method === "thread/tokenUsage/updated") {
      const usage = codexContextUsage(params);
      if (!usage || usage.totalTokens === this.lastCount)
        return;
      this.lastCount = usage.totalTokens;
      this.host.context?.({ ...usage, ...this.model ? { model: this.model } : {} });
      return;
    }
    if (method === "turn/started")
      this.host.turnStarted();
    if (method === "serverRequest/resolved") {
      const key = String(params.requestId);
      const pending2 = this.requests.get(key);
      if (pending2) {
        this.requests.delete(key);
        pending2.abort();
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
function createCodexProvider(options = {}) {
  const settings = options.settings ?? (async () => DEFAULT_SETTINGS);
  const listedModels = options.listedModels ?? (async () => []);
  const offered = async () => await options.offeredModels?.().catch(() => []) ?? [];
  const launch = async () => {
    if (!options.launch)
      return plainLaunch();
    try {
      return await options.launch();
    } catch (e) {
      if (e instanceof CodexAuthError)
        throw new AgentError(e.status, e.message);
      throw e;
    }
  };
  const defaultModel = async () => {
    const [own, listed] = [await settings(), await listedModels()];
    if (own.defaultModel && (listed.length === 0 || listed.includes(own.defaultModel)))
      return own.defaultModel;
    return listed[0] ?? null;
  };
  const menus = options.offeredModels !== undefined;
  return {
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
      hasAccount: options.signIn !== undefined,
      rememberPermissions: "session",
      oneShot: true,
      ...menus ? { canChangeModelMidSession: true } : {},
      images: true,
      contextUsage: "totals"
    },
    defaultPermissionMode: "default",
    loginHint: {
      text: "Codex is not signed in on this machine: sign in with your ChatGPT account, or enter the API's address and key, in Settings → Codex."
    },
    async start(opts) {
      const run2 = await launch();
      const account = await options.signIn?.().catch(() => {
        return;
      });
      const model = opts.model ?? (menus ? await defaultModel() : null);
      const session = new CodexSession(opts.host, opts.name, opts.cwd, opts.permissionMode, model, account ?? null);
      const extraArgs = [...run2.args, ...opts.mcpServers?.length ? codexMcpArgs(opts.mcpServers) : []];
      session.client = new CodexClient({
        cwd: opts.cwd,
        ...extraArgs.length ? { extraArgs } : {},
        ...options.launch ? { env: run2.env } : {},
        onNotification: (method, params) => session.notification(method, params),
        onServerRequest: (id, method, params) => session.request(id, method, params),
        onStderr: session.stderr,
        onExit: (code, error) => session.exited(code, error)
      });
      opts.signal.addEventListener("abort", () => session.close(), { once: true });
      session.ready(opts.prompt, opts.images);
      return session;
    },
    oneShot: options.launch ? async (req) => {
      let run2;
      try {
        run2 = await launch();
      } catch (e) {
        return { text: e.message, isError: true };
      }
      return codexOneShot(req, { args: run2.args, env: run2.env, model: await defaultModel() });
    } : codexOneShot,
    ...menus ? {
      async choices() {
        const models = narrowModels(await offered(), await listedModels()).map((m2) => ({
          value: m2.value,
          displayName: m2.displayName,
          ...m2.description ? { description: m2.description } : {}
        }));
        const account = await options.signIn?.().catch(() => {
          return;
        });
        return { models, model: await defaultModel(), effort: null, ...account ? { account } : {} };
      },
      async setDefaults(patch) {
        if (patch.model === undefined)
          return;
        if (!options.saveSettings)
          throw new AgentError(409, "Codex keeps no defaults here");
        await options.saveSettings({ defaultModel: patch.model });
      },
      async reportedModels() {
        const models = await offered();
        return models.length > 0 ? models.map((m2) => m2.value) : null;
      }
    } : {}
  };
}
var codexProvider = createCodexProvider();

// plugins/agent-codex/src/host.ts
var DEMO_REFUSAL = "Codex sign-in is disabled in demo mode";
var SIGN_IN_TTL_MS = 30000;
var KEY_STORE = "key";
var guarded = (handler) => (req, params) => {
  if (isHostedMode())
    return json({ error: HOSTED_REFUSAL }, 403);
  if (isDemoMode())
    return json({ error: DEMO_REFUSAL }, 403);
  return handler(req, params);
};
function tilde(path) {
  const home = homedir2();
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
function codexAuthView(auth, login, own) {
  return {
    mode: auth.mode,
    inferred: auth.inferred,
    cliAvailable: codexAvailable(),
    login,
    api: {
      url: auth.url,
      storedUrl: auth.storedUrl,
      storedKey: auth.storedKey,
      hasKey: auth.storedKey || auth.detected.key !== null,
      detected: {
        url: auth.detected.url,
        urlSource: tilde(auth.detected.urlSource),
        hasKey: auth.detected.key !== null,
        keySource: tilde(auth.detected.keySource),
        requiresApiKey: auth.detected.requiresApiKey
      }
    },
    defaultModel: own.defaultModel,
    signIn: loginState()
  };
}
var log2 = getLogger("agent-codex");
var codexFailure = (what, e) => {
  const status = e instanceof CodexAuthError ? e.status : 502;
  log2.warn(`${what} refused`, { status, error: e.message });
  return json({ error: e.message }, status);
};
async function storedKey(secrets) {
  return (await secrets.load())?.key ?? null;
}
var plugin = {
  name: "agent-codex",
  inject: ["routes", "agents", "data"],
  async apply(ctx, config) {
    const agents2 = ctx.need("agents");
    const routes = ctx.need("routes");
    const data = ctx.need("data");
    const secrets = config.secrets(KEY_STORE);
    const settings = async () => codexSettingsOf(await config.settings.read());
    const effective = async () => effectiveCodexAuth(await settings(), await storedKey(secrets));
    let signedIn = null;
    let signedInAt = -Infinity;
    let signInAge = 0;
    const chatgptLogin = async (fresh = false, wait = true) => {
      if (!fresh && signedIn && Date.now() - signedInAt < SIGN_IN_TTL_MS)
        return signedIn;
      const age = signInAge;
      const status = await loginStatus();
      signedIn = status;
      signedInAt = Date.now();
      if (!status.loggedIn || status.email)
        return status;
      const asking = accountEmail().catch(() => null).then((email) => {
        const named = { ...status, email };
        if (age === signInAge)
          signedIn = named;
        return named;
      });
      return wait ? asking : status;
    };
    const offeredModels2 = async () => {
      const auth = await effective();
      if (auth.mode === "login") {
        if (!(await chatgptLogin()).loggedIn)
          return [];
        return offeredModels(() => fetchAccountModels(), "login");
      }
      if (!auth.api)
        return [];
      const { url, key } = auth.api;
      return offeredModels(() => fetchApiModels(url, key), `api
${url}
${key ?? ""}`);
    };
    const currentSignIn = async () => {
      const auth = await effective();
      if (auth.mode === "api")
        return describeSignIn({ mode: "api", apiUrl: auth.api?.url ?? null, login: null });
      return describeSignIn({ mode: "login", apiUrl: null, login: await chatgptLogin(false, false) });
    };
    ctx.effect(() => agents2.register(createCodexProvider({
      settings,
      launch: async () => launchFor(await effective(), (await loginStatus()).loggedIn),
      signIn: currentSignIn,
      listedModels: async () => listedCodexModels(await data.dir().catch(() => null)),
      offeredModels: offeredModels2,
      saveSettings: async (patch) => {
        const parsed = codexSettingsPatch(patch);
        if ("error" in parsed)
          throw new AgentError(400, parsed.error);
        await config.settings.write(parsed.patch);
      }
    })));
    const signInChanged2 = () => {
      forgetModels();
      signedIn = null;
      signedInAt = -Infinity;
      signInAge += 1;
      agents2.changed?.("codex");
    };
    ctx.effect(() => onSignInChange(signInChanged2));
    const answer = async (fresh = false) => json(codexAuthView(await effective(), await chatgptLogin(fresh), await settings()));
    const getAuth = () => answer();
    const postKey = async (req) => {
      const body = await req.json().catch(() => ({}));
      if (typeof body.key !== "string" || !body.key.trim() || body.key.length > 1024) {
        return json({ error: "Paste the API key" }, 400);
      }
      if (!SENDABLE_KEY.test(body.key.trim())) {
        return json({ error: "A key is letters, digits and punctuation, with no spaces or line breaks" }, 400);
      }
      await secrets.save({ key: body.key.trim() });
      signInChanged2();
      return answer();
    };
    const deleteKey = async () => {
      await secrets.clear();
      signInChanged2();
      return answer();
    };
    const postApiDetect = async () => {
      const detected = await detectCodexApi();
      if (!detected.url && !detected.key)
        return json({ error: "No API found in Codex's own config" }, 404);
      if (detected.url)
        await config.settings.write({ codexApiUrl: detected.url });
      if (detected.key)
        await secrets.save({ key: detected.key });
      signInChanged2();
      return answer();
    };
    const postApiCheck = async (req) => {
      const body = await req.json().catch(() => ({}));
      const auth = await effective();
      const typed = typeof body.url === "string" ? codexSettingsPatch({ codexApiUrl: body.url }) : null;
      const url = (typed && "patch" in typed ? typed.patch.codexApiUrl : null) || auth.url;
      if (!url)
        return json({ error: "Enter the API's address first" }, 400);
      const key = await storedKey(secrets) ?? auth.detected.key;
      forgetModels();
      return json({ url, ...await checkApi(url, key) });
    };
    const postLogin = async () => {
      try {
        return json({ signIn: await startLogin() });
      } catch (e) {
        return codexFailure("sign-in", e);
      }
    };
    const getLogin = async () => json({ signIn: loginState(), login: await chatgptLogin(true) });
    const deleteLogin = () => json({ signIn: cancelLogin() });
    const postLogout = async () => {
      try {
        await logout();
      } catch (e) {
        return codexFailure("sign-out", e);
      }
      return answer(true);
    };
    const postLoginCheck = async () => {
      forgetModels();
      const login = await chatgptLogin(true);
      if (!login.loggedIn)
        return json({ login, models: [], error: null });
      try {
        return json({ login, models: await offeredModels2(), error: null });
      } catch (e) {
        return json({ login, models: [], error: e.message });
      }
    };
    const getModels = async () => {
      try {
        return json({ models: await offeredModels2() });
      } catch (e) {
        return json({ models: [], error: e.message }, 502);
      }
    };
    const getSettings = async () => json(await settings());
    const putSettings = async (req) => {
      const parsed = codexSettingsPatch(await req.json().catch(() => null));
      if ("error" in parsed)
        return json({ error: parsed.error }, 400);
      await config.settings.write(parsed.patch);
      if ("codexAuth" in parsed.patch || "codexApiUrl" in parsed.patch)
        signInChanged2();
      return json(await settings());
    };
    const add = (method, pattern, handler) => ctx.effect(() => routes.add(method, pattern, guarded(handler)));
    add("GET", "/api/codex/auth", getAuth);
    add("POST", "/api/codex/key", postKey);
    add("DELETE", "/api/codex/key", deleteKey);
    add("POST", "/api/codex/api/detect", postApiDetect);
    add("POST", "/api/codex/api/check", postApiCheck);
    add("POST", "/api/codex/login", postLogin);
    add("GET", "/api/codex/login", getLogin);
    add("DELETE", "/api/codex/login", deleteLogin);
    add("POST", "/api/codex/logout", postLogout);
    add("POST", "/api/codex/login/check", postLoginCheck);
    add("GET", "/api/codex/models", getModels);
    add("GET", "/api/codex/settings", getSettings);
    add("PUT", "/api/codex/settings", putSettings);
  }
};
var host_default2 = plugin;
export {
  host_default2 as default,
  KEY_STORE,
  DEMO_REFUSAL
};

//# debugId=D1CB85A2EA45147964756E2164756E21
//# sourceMappingURL=host.js.map
