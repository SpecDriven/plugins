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

// src/acp.ts
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
function opencodeSpawner() {
  return spawner ?? nodeSpawn;
}
var ACP_REQUEST_TIMEOUT_MS = 60000;
var ACP_CLIENT_INFO = { name: "specdriven", title: "SpecDriven", version: "1" };
var ACP_PROTOCOL_VERSION = 1;

class AcpClient {
  options;
  proc;
  pending = new Map;
  counter = 0;
  done = false;
  constructor(options) {
    this.options = options;
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
        for (const resolve of this.pending.values())
          resolve({ ok: false, error: "OpenCode exited" });
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
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object")
      return;
    const method = typeof message.method === "string" ? message.method : null;
    const hasId = typeof message.id === "string" || typeof message.id === "number";
    if (method && hasId) {
      this.options.onRequest(message.id, method, record(message.params) ?? {});
      return;
    }
    if (method) {
      this.options.onNotification(method, record(message.params) ?? {});
      return;
    }
    if (!hasId)
      return;
    const resolve = this.pending.get(String(message.id));
    if (!resolve)
      return;
    this.pending.delete(String(message.id));
    const error = record(message.error);
    if (error) {
      resolve({ ok: false, error: rpcErrorText(error), ...typeof error.code === "number" ? { code: error.code } : {} });
    } else {
      resolve({ ok: true, result: record(message.result) ?? {} });
    }
  }
  write(message) {
    if (this.done)
      return;
    this.proc.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + `
`);
  }
  request(method, params, timeoutMs = ACP_REQUEST_TIMEOUT_MS) {
    if (this.done)
      return Promise.resolve({ ok: false, error: "OpenCode exited" });
    const id = ++this.counter;
    return new Promise((resolve) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(String(id));
          resolve({ ok: false, error: `OpenCode did not answer ${method}` });
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(String(id), (result) => {
        if (timer)
          clearTimeout(timer);
        resolve(result);
      });
      this.write({ id, method, params });
    });
  }
  notify(method, params) {
    this.write({ method, params });
  }
  respond(id, result) {
    this.write({ id, result });
  }
  respondError(id, message, code = -32603) {
    this.write({ id, error: { code, message } });
  }
  close() {
    if (this.done)
      return;
    this.done = true;
    this.proc.kill();
  }
}
function rpcErrorText(error) {
  const message = text(error.message) ?? "OpenCode refused the request";
  const data = error.data;
  const detail = typeof data === "string" ? data : text(record(data)?.message);
  return detail && detail !== message ? `${message}: ${detail}` : message;
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
function acpConfig(options) {
  const config = { model: null, effort: null, mode: null };
  if (!Array.isArray(options))
    return config;
  for (const entry of options) {
    const o = record(entry);
    const id = o ? text(o.id) : null;
    if (!o || !id)
      continue;
    const category = text(o.category);
    const slot = category === "model" || id === "model" ? "model" : category === "thought_level" || id === "effort" ? "effort" : category === "mode" || id === "mode" ? "mode" : null;
    if (!slot)
      continue;
    const values = [];
    for (const v of Array.isArray(o.options) ? o.options : []) {
      const r = record(v);
      const value = r ? text(r.value) : null;
      if (value)
        values.push({ value, name: (r && text(r.name)) ?? value });
    }
    config[slot] = { id, current: text(o.currentValue), values };
  }
  return config;
}
function effortFromAcp(value) {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return;
  }
}
function effortToAcp(level, effort) {
  const offered = (value) => effort.values.some((v) => v.value === value);
  if (level === null)
    return offered("default") ? "default" : null;
  if (offered(level))
    return level;
  if (level === "max" && offered("xhigh"))
    return "xhigh";
  return null;
}
function acpCommands(list) {
  if (!Array.isArray(list))
    return [];
  const commands = [];
  for (const entry of list) {
    const c = record(entry);
    const name = c ? text(c.name) : null;
    if (!c || !name)
      continue;
    const input = record(c.input);
    commands.push({ name, description: text(c.description) ?? "", argumentHint: (input && text(input.hint)) ?? "" });
  }
  return commands;
}
function toolPath(input, locations) {
  const own = text(input.filePath) ?? text(input.file_path) ?? text(input.path);
  if (own)
    return own;
  if (Array.isArray(locations)) {
    const first = record(locations[0]);
    if (first)
      return text(first.path);
  }
  return null;
}
function paneTool(call) {
  const kind = text(call.kind) ?? "other";
  const own = text(call.name) ?? "";
  const title = text(call.title) ?? "";
  const input = { ...record(call.rawInput) ?? {} };
  const path = toolPath(input, call.locations);
  const withPath = () => path ? { ...input, file_path: path } : input;
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
      if (own === "task")
        return { name: "Task", input };
      return { name: own || title || "tool", input };
    }
  }
}
function flattenToolContent(content, rawOutput) {
  const parts = [];
  for (const entry of Array.isArray(content) ? content : []) {
    const c = record(entry);
    if (!c)
      continue;
    if (c.type === "content") {
      const inner = record(c.content);
      if (!inner)
        continue;
      if (inner.type === "text")
        parts.push(text(inner.text) ?? "");
      else
        parts.push(`[${text(inner.type) ?? "content"}]`);
    } else if (c.type === "diff") {
      const path = text(c.path) ?? "a file";
      parts.push(c.oldText === null || c.oldText === undefined ? `Created ${path}` : `Changed ${path}`);
    } else if (c.type === "terminal") {
      parts.push("[terminal]");
    }
  }
  const joined = parts.filter(Boolean).join(`
`);
  if (joined)
    return joined;
  const out = record(rawOutput);
  return (out && (text(out.output) ?? text(out.error))) ?? "";
}
function newAcpStream() {
  return {
    message: null,
    messages: 0,
    pieces: new Map,
    tools: new Map,
    turnStartedAt: null,
    cost: 0,
    costAtTurnStart: 0,
    denials: 0,
    errors: []
  };
}
function flushMessage(ctx, stream) {
  const message = stream.message;
  stream.message = null;
  if (!message || !message.text)
    return [];
  return [
    {
      kind: "assistant",
      messageId: message.id,
      turn: ctx.turn,
      blocks: [{ type: "text", text: message.text }],
      parentToolUseId: null
    }
  ];
}
function showTool(id, tool, ctx) {
  const pane = paneTool(tool);
  const key = JSON.stringify(pane);
  if (tool.shown === key)
    return [];
  tool.shown = key;
  const block = { type: "tool_use", id, name: pane.name, input: pane.input };
  return [{ kind: "assistant", messageId: `tool-${id}`, turn: ctx.turn, blocks: [block], parentToolUseId: null }];
}
function mergeTool(update, stream) {
  const id = text(update.toolCallId);
  if (!id)
    return null;
  let tool = stream.tools.get(id);
  if (!tool) {
    tool = { kind: null, name: null, title: null, rawInput: {}, locations: null, shown: null };
    stream.tools.set(id, tool);
  }
  if (update.kind !== undefined)
    tool.kind = update.kind;
  if (update.name !== undefined)
    tool.name = update.name;
  if (update.title !== undefined)
    tool.title = update.title;
  if (Array.isArray(update.locations) && update.locations.length > 0)
    tool.locations = update.locations;
  const input = record(update.rawInput);
  if (input && Object.keys(input).length > 0)
    tool.rawInput = input;
  return { id, tool };
}
function mapAcpUpdate(update, ctx, stream) {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = record(update.content);
      const chunk = content && content.type === "text" ? text(content.text) ?? "" : "";
      if (!chunk)
        return [];
      const id = text(update.messageId);
      const events = [];
      if (stream.message && id && stream.message.source !== id)
        events.push(...flushMessage(ctx, stream));
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
      if (!merged)
        return [];
      const { id, tool } = merged;
      const events = flushMessage(ctx, stream);
      const status = text(update.status) ?? (update.sessionUpdate === "tool_call" ? "pending" : null);
      const finished = status === "completed" || status === "failed";
      if (status === "in_progress" || finished || tool.shown !== null)
        events.push(...showTool(id, tool, ctx));
      if (finished) {
        stream.tools.delete(id);
        events.push({
          kind: "tool_result",
          toolUseId: id,
          content: flattenToolContent(update.content, update.rawOutput),
          isError: status === "failed",
          parentToolUseId: null
        });
      }
      return events;
    }
    default:
      return [];
  }
}
function showToolForPermission(toolCall, ctx, stream) {
  const merged = mergeTool(toolCall, stream);
  if (!merged)
    return [];
  return [...flushMessage(ctx, stream), ...showTool(merged.id, merged.tool, ctx)];
}
function acpUsage(update, stream) {
  const cost = record(update.cost);
  const amount = cost ? number(cost.amount) : null;
  if (amount !== null && (text(cost?.currency) ?? "USD") === "USD")
    stream.cost = amount;
  const used = number(update.used);
  if (used === null)
    return null;
  return { used, size: number(update.size) };
}
function startAcpTurn(stream, now = Date.now) {
  if (stream.turnStartedAt === null)
    stream.turnStartedAt = now();
}
function finishAcpTurn(outcome, ctx, stream) {
  const now = ctx.now ?? Date.now;
  const events = flushMessage(ctx, stream);
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
    ...errors.length > 0 ? { text: errors.join(`
`) } : {},
    denials
  });
  return events;
}

// src/cli.ts
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var OPENCODE_BIN = "opencode";
function installerPath(home = homedir()) {
  return join(home, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : OPENCODE_BIN);
}
function findOpencode(home = homedir()) {
  const onPath = which(OPENCODE_BIN);
  if (onPath)
    return onPath;
  const installed = installerPath(home);
  try {
    accessSync(installed, constants.X_OK);
    return installed;
  } catch {
    return null;
  }
}
var probe = null;
function opencodeAvailable() {
  return probe ? probe() : findOpencode() !== null;
}
function opencodePath() {
  return findOpencode() ?? OPENCODE_BIN;
}

// src/config.ts
var ASKED = [
  { key: "edit", action: "edit" },
  { key: "bash", action: "shell" },
  { key: "webfetch", action: "webfetch" }
];
function parseResolvedAgents(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed))
    return null;
  const agents2 = [];
  for (const entry of parsed) {
    const a = entry;
    if (!a || typeof a.id !== "string" || !Array.isArray(a.permissions))
      continue;
    const rules = [];
    for (const rule of a.permissions) {
      const r = rule;
      if (r && typeof r.action === "string" && typeof r.resource === "string" && typeof r.effect === "string") {
        rules.push({ action: r.action, resource: r.resource, effect: r.effect });
      }
    }
    agents2.push({ id: a.id, rules });
  }
  return agents2.length > 0 ? agents2 : null;
}
var readWithCli = async (cwd, env) => {
  const res = await run(opencodePath(), ["debug", "agents", "--standalone"], { cwd, env });
  return res.exitCode === 0 ? parseResolvedAgents(res.stdout) : null;
};
var reader = null;
function resolvedAgents(cwd, env = process.env) {
  return (reader ?? readWithCli)(cwd, env).catch(() => null);
}
function askingRules(rules, action) {
  const out = { "*": "ask" };
  for (const rule of rules) {
    if (rule.action !== action && rule.action !== "*")
      continue;
    delete out[rule.resource];
    out[rule.resource] = rule.effect === "allow" ? "ask" : rule.effect;
  }
  return out;
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}
function sessionConfigContent(existing, agents2 = null) {
  let base = {};
  if (existing?.trim()) {
    try {
      base = object(JSON.parse(existing));
    } catch {}
  }
  const permission = object(base.permission);
  for (const { key } of ASKED) {
    if (permission[key] !== "deny")
      permission[key] = "ask";
  }
  const config = { ...base, permission };
  if (agents2) {
    const agent = object(base.agent);
    for (const { id, rules } of agents2) {
      const own = object(agent[id]);
      const ownPermission = object(own.permission);
      for (const { key, action } of ASKED)
        ownPermission[key] = askingRules(rules, action);
      agent[id] = { ...own, permission: ownPermission };
    }
    config.agent = agent;
  }
  return JSON.stringify(config);
}
async function sessionEnv(cwd, env = process.env) {
  const agents2 = await resolvedAgents(cwd, env);
  return { ...env, OPENCODE_CONFIG_CONTENT: sessionConfigContent(env.OPENCODE_CONFIG_CONTENT, agents2) };
}

// src/models.ts
import { readFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var OPENCODE_MODELS_FILE = ".specdriven/opencode-models.json";
var MENU_SIZE = 20;
var CATALOG_TTL_MS = 60000;
function parseModels(stdout) {
  return stdout.split(`
`).map((line) => line.trim()).filter((line) => /^[^\s/]+\/\S+$/.test(line));
}
var listWithCli = async () => {
  const bin = opencodePath();
  const alone = await run(bin, ["models", "--standalone"], { cwd: homedir2() });
  if (alone.exitCode === 0)
    return parseModels(alone.stdout);
  const res = await run(bin, ["models"], { cwd: homedir2() });
  return res.exitCode === 0 ? parseModels(res.stdout) : [];
};
var lister = null;
var cached = null;
async function opencodeModels() {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS)
    return cached.models;
  const models = await (lister ?? listWithCli)().catch(() => []);
  if (models.length > 0)
    cached = { at: Date.now(), models };
  return models;
}
function opencodeStateDir(env = process.env) {
  const base = env.XDG_STATE_HOME?.trim() || join2(homedir2(), ".local", "state");
  return join2(base, "opencode");
}
async function recentModels(stateDir = opencodeStateDir()) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join2(stateDir, "model.json"), "utf8"));
  } catch {
    return [];
  }
  const recent = parsed?.recent;
  if (!Array.isArray(recent))
    return [];
  const out = [];
  for (const entry of recent) {
    const e = entry;
    if (typeof e?.providerID === "string" && typeof e.modelID === "string")
      out.push(`${e.providerID}/${e.modelID}`);
  }
  return out;
}
async function listedModels(dataDir) {
  if (!dataDir)
    return [];
  let list;
  try {
    list = JSON.parse(await readFile(join2(dataDir, OPENCODE_MODELS_FILE), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(list))
    return [];
  return list.map(normalizeModel).filter((m2) => m2 !== null);
}
function row(value) {
  return { value, displayName: value };
}
function modelMenu(input) {
  if (input.listed.length > 0)
    return [...new Set(input.listed)].map(row);
  const known = new Set(input.catalog);
  const picks = [];
  const add = (m2) => {
    if (m2 && !picks.includes(m2) && (known.size === 0 || known.has(m2)))
      picks.push(m2);
  };
  add(input.defaultModel);
  for (const m2 of input.recent)
    add(m2);
  if (picks.length <= (input.defaultModel ? 1 : 0))
    for (const m2 of input.catalog)
      add(m2);
  return picks.slice(0, MENU_SIZE).map(row);
}

// src/oneShot.ts
var STDERR_TAIL = 5;
function runArgs(model) {
  return ["run", "--standalone", "--format", "json", "--agent", "plan", "--archived", ...model ? ["-m", model] : []];
}
function oneShotMessage(req) {
  const parts = [req.systemPrompt, req.prompt];
  if (req.schema) {
    parts.push(`Answer with one JSON value and nothing else — no prose, no code fence — that fits this JSON schema:
${JSON.stringify(req.schema)}`);
  }
  return parts.filter((p) => p.trim()).join(`

`);
}
function parseAnswer(text2) {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text2.trim());
  try {
    return JSON.parse(fenced ? fenced[1] : text2);
  } catch {
    return;
  }
}
async function opencodeOneShot(req) {
  if (req.signal?.aborted)
    return { text: "OpenCode was stopped", isError: true };
  return new Promise((resolve) => {
    const texts = [];
    const errors = [];
    let stderr = [];
    let killed = null;
    let settled = false;
    const readStdout = jsonlReader((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "text") {
        const part = record(event.part);
        if (part && typeof part.text === "string")
          texts.push(part.text);
      } else if (event.type === "error") {
        const error = record(event.error);
        const message = error && typeof error.message === "string" ? error.message : null;
        errors.push(message ?? "OpenCode failed");
      }
    });
    const readStderr = jsonlReader((line) => {
      stderr = [...stderr, line].slice(-STDERR_TAIL);
    });
    let timer;
    let proc = null;
    const onAbort = () => {
      killed = "abort";
      proc?.kill();
    };
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const child = opencodeSpawner()({
      bin: opencodePath(),
      args: runArgs(req.model),
      cwd: req.cwd,
      env: process.env,
      onStdout: readStdout,
      onStderr: readStderr,
      onExit: (code, error) => {
        const tail = stderr.join(`
`);
        if (error)
          return finish({ text: `Could not start OpenCode: ${error.message}${tail ? `
${tail}` : ""}`, isError: true });
        if (killed === "timeout")
          return finish({ text: "OpenCode did not answer in time", isError: true });
        if (killed === "abort")
          return finish({ text: "OpenCode was stopped", isError: true });
        const text2 = texts.join("").trim();
        if (errors.length > 0 && !text2)
          return finish({ text: errors.at(-1), isError: true });
        if (code !== 0 && code !== null && !text2) {
          return finish({ text: tail || `OpenCode exited with code ${code}`, isError: true });
        }
        if (!text2)
          return finish({ text: tail || "OpenCode gave no answer", isError: true });
        finish({ text: text2, ...req.schema ? { structured: parseAnswer(text2) } : {}, isError: false });
      }
    });
    proc = child;
    child.write(oneShotMessage(req));
    child.end();
    if (settled)
      return;
    timer = setTimeout(() => {
      killed = "timeout";
      child.kill();
    }, req.timeoutMs);
    req.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// src/provider.ts
var OPENCODE_MISSING = "OpenCode CLI not found — install the `opencode` command (https://opencode.ai)";
var OPENCODE_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
var str = (value) => typeof value === "string" ? value : null;
async function readDefaults(settings) {
  const own = settings ? await settings.read().catch(() => ({})) : {};
  const model = str(own.defaultModel);
  const effort = effortFromAcp(str(own.defaultEffort));
  return { defaultModel: model && model.trim() ? model : null, defaultEffort: effort ?? null };
}
function acpMcpServer(server) {
  return {
    name: server.name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([name, value]) => ({ name, value }))
  };
}
function opencodeRule(toolName) {
  return { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "opencode" };
}
var EDIT_KINDS = new Set(["edit", "delete", "move"]);
var DENIED_DEFAULT = "Denied in SpecDriven";
function optionOf(options, kind) {
  if (!Array.isArray(options))
    return null;
  for (const entry of options) {
    const o = record(entry);
    if (o && o.kind === kind && typeof o.optionId === "string")
      return o.optionId;
  }
  return null;
}
function cardTitle(kind, toolName) {
  switch (kind) {
    case "execute":
      return "OpenCode wants to run a command";
    case "edit":
    case "delete":
    case "move":
      return "OpenCode wants to change files";
    case "fetch":
      return "OpenCode wants to fetch from the web";
    default:
      return `OpenCode wants to use ${toolName}`;
  }
}

class OpencodeSession {
  host;
  cwd;
  client = null;
  stream = newAcpStream();
  requests = new Map;
  stderrTail = [];
  sessionId = null;
  config = { model: null, effort: null, mode: null };
  ownModel = null;
  mode;
  refusal = null;
  stopped = false;
  commands = null;
  isReady = false;
  lastCount = null;
  constructor(host, cwd, mode) {
    this.host = host;
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
    this.host.failed(tail ? `Could not start OpenCode: ${why}
${tail}` : `Could not start OpenCode: ${why}`, "spawn_failed");
  }
  async setOption(select, value) {
    if (!select)
      return { ok: false, error: "OpenCode offers no such setting" };
    if (select.current === value)
      return { ok: true };
    const res = await this.client.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId: select.id,
      value
    });
    if (!res.ok)
      return { ok: false, error: res.error };
    this.config = { ...this.config, ...this.configFrom(res.result.configOptions) };
    return { ok: true };
  }
  configFrom(options) {
    const next = acpConfig(options);
    const out = {};
    if (next.model)
      out.model = next.model;
    if (next.effort)
      out.effort = next.effort;
    if (next.mode)
      out.mode = next.mode;
    return out;
  }
  async applyMode(mode) {
    const mode_ = this.config.mode;
    if (!mode_)
      return mode === "plan" ? { ok: false, error: "OpenCode offers no Plan agent here" } : { ok: true };
    const want = mode === "plan" ? "plan" : "build";
    if (!mode_.values.some((v) => v.value === want)) {
      return mode === "plan" ? { ok: false, error: "OpenCode offers no Plan agent here" } : { ok: true };
    }
    return this.setOption(mode_, want);
  }
  async ready(opts) {
    const client = this.client;
    const init = await client.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: ACP_CLIENT_INFO
    });
    if (this.final)
      return;
    if (!init.ok)
      return this.failed(init.error);
    const agentInfo = record(init.result.agentInfo);
    const version = agentInfo ? str(agentInfo.version) : null;
    const created = await client.request("session/new", {
      cwd: this.cwd,
      mcpServers: (opts.mcpServers ?? []).map(acpMcpServer)
    });
    if (this.final)
      return;
    if (!created.ok)
      return this.failed(created.error);
    const sessionId = str(created.result.sessionId);
    if (!sessionId)
      return this.failed("session/new answered without a session id");
    this.sessionId = sessionId;
    this.config = acpConfig(created.result.configOptions);
    this.ownModel = this.config.model?.current ?? null;
    if (opts.model) {
      const set = await this.setOption(this.config.model, opts.model);
      if (!set.ok)
        this.host.note("error", "api", `OpenCode could not switch to ${opts.model}: ${set.error}`);
    }
    if (opts.effort && this.config.effort) {
      const value = effortToAcp(opts.effort, this.config.effort);
      const set = value ? await this.setOption(this.config.effort, value) : { ok: false, error: "not offered" };
      if (!set.ok)
        this.host.note("info", "api", `This model takes no ${opts.effort} effort; OpenCode's default stands.`);
    }
    const moded = await this.applyMode(this.mode);
    if (!moded.ok)
      this.host.note("error", "api", moded.error);
    if (this.final)
      return;
    const model = this.config.model?.current ?? null;
    const effort = effortFromAcp(this.config.effort?.current);
    this.host.note("info", "init", `OpenCode${version ? ` ${version}` : ""} · ${model ?? "no model"} · ${this.cwd}`);
    this.isReady = true;
    this.host.ready({
      agentSessionId: sessionId,
      ...model ? { model } : {},
      ...effort ? { effort } : {},
      ...this.commands ? { commands: this.commands } : {}
    });
    if (opts.prompt || opts.images?.length) {
      try {
        await this.send(opts.prompt ?? "", opts.images);
      } catch (e) {
        this.host.note("error", "api", e.message);
        this.host.turnEnded();
      }
    }
  }
  async send(text2, images) {
    if (!this.sessionId || this.final)
      throw new Error("OpenCode is not ready");
    const prompt = [];
    if (text2)
      prompt.push({ type: "text", text: text2 });
    for (const image of images ?? [])
      prompt.push({ type: "image", data: image.data, mimeType: image.mediaType });
    if (prompt.length === 0)
      prompt.push({ type: "text", text: "" });
    this.host.turnStarted();
    startAcpTurn(this.stream);
    this.refusal = null;
    this.stopped = false;
    this.prompt(prompt);
  }
  prompt(prompt) {
    this.client.request("session/prompt", { sessionId: this.sessionId, prompt }, 0).then((res) => {
      if (this.final)
        return;
      const stopReason = res.ok ? str(res.result.stopReason) ?? "end_turn" : null;
      const refusal = this.refusal;
      this.refusal = null;
      if (stopReason === "cancelled" && refusal && !this.stopped) {
        this.prompt([{ type: "text", text: `The user declined that, saying: ${refusal}` }]);
        return;
      }
      const outcome = res.ok ? { stopReason } : { error: res.error };
      for (const body of finishAcpTurn(outcome, { turn: this.host.turn() }, this.stream))
        this.host.emit(body);
      this.host.turnEnded();
    });
  }
  async interrupt() {
    if (!this.sessionId || !this.client)
      return;
    this.stopped = true;
    for (const pending of this.requests.values())
      pending.abort();
    this.client.notify("session/cancel", { sessionId: this.sessionId });
  }
  async setPermissionMode(mode) {
    if (this.host.status() === "starting")
      throw new AgentError(409, "OpenCode is still starting");
    const moded = await this.applyMode(mode);
    if (!moded.ok)
      throw new AgentError(409, moded.error);
    this.mode = mode;
  }
  async setModel(model) {
    if (!this.sessionId)
      throw new AgentError(409, "OpenCode is still starting");
    const target = model ?? this.ownModel;
    if (!target)
      throw new AgentError(409, "OpenCode named no default model");
    const set = await this.setOption(this.config.model, target);
    if (!set.ok)
      throw new AgentError(400, `OpenCode could not switch to ${target}: ${set.error}`);
  }
  async setEffort(effort) {
    if (!this.sessionId)
      throw new AgentError(409, "OpenCode is still starting");
    const select = this.config.effort;
    if (!select)
      throw new AgentError(409, "This model takes no effort setting");
    const value = effortToAcp(effort, select);
    if (!value) {
      const offered = select.values.map((v) => v.value).join(", ");
      throw new AgentError(400, `This model takes no ${effort ?? "default"} effort (it offers ${offered || "none"})`);
    }
    const set = await this.setOption(select, value);
    if (!set.ok)
      throw new AgentError(400, `OpenCode could not set the effort: ${set.error}`);
  }
  close() {
    this.client?.close();
  }
  notification(method, params) {
    if (this.final || method !== "session/update")
      return;
    const update = record(params.update);
    if (!update)
      return;
    switch (update.sessionUpdate) {
      case "available_commands_update": {
        this.commands = acpCommands(update.availableCommands);
        if (this.isReady)
          this.host.update({ commands: this.commands });
        return;
      }
      case "config_option_update": {
        this.config = { ...this.config, ...this.configFrom(update.configOptions) };
        return;
      }
      case "usage_update": {
        const usage = acpUsage(update, this.stream);
        if (!usage || usage.used === this.lastCount)
          return;
        this.lastCount = usage.used;
        const model = this.config.model?.current;
        this.host.context({
          totalTokens: usage.used,
          maxTokens: usage.size,
          detail: "measured",
          ...model ? { model } : {}
        });
        return;
      }
      default:
        for (const body of mapAcpUpdate(update, { turn: this.host.turn() }, this.stream))
          this.host.emit(body);
    }
  }
  request(id, method, params) {
    const client = this.client;
    if (method !== "session/request_permission") {
      client.respondError(id, `${method} is not supported by SpecDriven`, -32601);
      return;
    }
    if (this.final) {
      client.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const toolCall = record(params.toolCall) ?? {};
    const options = params.options;
    const once = optionOf(options, "allow_once");
    const always = optionOf(options, "allow_always");
    const reject = optionOf(options, "reject_once") ?? optionOf(options, "reject_always");
    const select = (optionId) => client.respond(id, { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    for (const body of showToolForPermission(toolCall, { turn: this.host.turn() }, this.stream))
      this.host.emit(body);
    const kind = toolCall.kind;
    if (once && (this.mode === "bypassPermissions" || this.mode === "acceptEdits" && EDIT_KINDS.has(kind))) {
      select(once);
      return;
    }
    const pane = paneTool(toolCall);
    const key = String(id);
    const withdrawn = new AbortController;
    this.requests.set(key, withdrawn);
    this.host.requestPermission({
      toolName: pane.name,
      input: pane.input,
      suggestions: always ? [opencodeRule(pane.name)] : [],
      title: cardTitle(kind, pane.name),
      signal: withdrawn.signal
    }).then(({ decision, via }) => {
      this.requests.delete(key);
      this.answer(decision, via, { once, always, reject }, select);
    });
  }
  answer(decision, via, options, select) {
    if (decision.behavior === "allow") {
      select(decision.remember && options.always ? options.always : options.once ?? options.always);
      return;
    }
    if (via !== "user") {
      select(null);
      return;
    }
    this.stream.denials += 1;
    if (decision.message && decision.message !== DENIED_DEFAULT)
      this.refusal = decision.message;
    else
      this.host.note("info", "api", "OpenCode stops its turn when a request is denied.");
    select(options.reject);
  }
  exited(code, error) {
    if (this.final)
      return;
    const tail = this.stderrTail.join(`
`);
    const detail = (text2) => tail ? `${text2}
${tail}` : text2;
    if (error)
      return this.host.failed(detail(`Could not start OpenCode: ${error.message}`), "spawn_failed");
    if (code === 0 || code === null)
      return this.host.ended("OpenCode exited.");
    this.host.failed(detail(`OpenCode exited with code ${code}.`));
  }
}
function createOpencodeProvider(options = {}) {
  const settings = options.settings ?? null;
  return {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode, any model it is signed in to, with permission cards for edits and commands",
    rank: 25,
    cli: OPENCODE_BIN,
    available: opencodeAvailable,
    missingMessage: OPENCODE_MISSING,
    capabilities: {
      permissionModes: OPENCODE_MODES,
      canInterrupt: true,
      canChangeModeMidSession: true,
      hasAccount: false,
      rememberPermissions: "rule",
      oneShot: true,
      canChangeModelMidSession: true,
      effort: true,
      images: true,
      contextUsage: "totals"
    },
    defaultPermissionMode: "default",
    loginHint: {
      text: "OpenCode has no credentials for this model here: run the command in a terminal, then start a new session.",
      command: "opencode auth login"
    },
    async start(opts) {
      const [defaults, env] = await Promise.all([readDefaults(settings), sessionEnv(opts.cwd)]);
      const session = new OpencodeSession(opts.host, opts.cwd, opts.permissionMode);
      session.client = new AcpClient({
        bin: opencodePath(),
        args: ["acp"],
        cwd: opts.cwd,
        env,
        onNotification: (method, params) => session.notification(method, params),
        onRequest: (id, method, params) => session.request(id, method, params),
        onStderr: session.stderr,
        onExit: (code, error) => session.exited(code, error)
      });
      opts.signal.addEventListener("abort", () => session.close(), { once: true });
      const model = opts.model ?? defaults.defaultModel ?? undefined;
      const effort = opts.effort ?? defaults.defaultEffort ?? undefined;
      session.ready({
        ...opts.prompt ? { prompt: opts.prompt } : {},
        ...opts.images?.length ? { images: opts.images } : {},
        ...model ? { model } : {},
        ...effort ? { effort } : {},
        ...opts.mcpServers?.length ? { mcpServers: opts.mcpServers } : {}
      });
      return session;
    },
    async choices(ctx) {
      const defaults = await readDefaults(settings);
      const [catalog, listed, recent] = await Promise.all([opencodeModels(), listedModels(ctx.dataRepo), recentModels()]);
      return {
        models: modelMenu({ catalog, listed, recent, defaultModel: defaults.defaultModel }),
        model: defaults.defaultModel,
        effort: defaults.defaultEffort
      };
    },
    async setDefaults(patch) {
      if (!settings)
        throw new AgentError(409, "OpenCode keeps no defaults here");
      const section = {};
      if (patch.model !== undefined)
        section.defaultModel = patch.model;
      if (patch.effort !== undefined)
        section.defaultEffort = patch.effort;
      if (Object.keys(section).length > 0)
        await settings.write(section);
    },
    async reportedModels() {
      const models = await opencodeModels();
      return models.length > 0 ? models : null;
    },
    oneShot: opencodeOneShot
  };
}

// src/host.ts
var plugin = {
  name: "agent-opencode",
  inject: ["agents"],
  apply(ctx, config) {
    const agents2 = ctx.need("agents");
    const provider = createOpencodeProvider({ settings: config.settings });
    ctx.effect(() => agents2.register(provider));
  }
};
var host_default2 = plugin;
export {
  host_default2 as default
};

//# debugId=6F1F38BD5D7261DB64756E2164756E21
//# sourceMappingURL=host.js.map
