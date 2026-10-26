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

// ../../../../plugins/plugins/agent-pi/src/cli.ts
var PI_BIN = "pi";
var probe = null;
function piAvailable() {
  return probe ? probe() : which(PI_BIN) !== null;
}

// ../../../../plugins/plugins/agent-pi/src/piChat.ts
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
    kill: () => child.kill()
  };
};
var spawner = null;
var DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
var PI_REQUEST_TIMEOUT_MS = 20000;

class PiClient {
  proc;
  pending = new Map;
  onEvent;
  counter = 0;
  done = false;
  constructor(options) {
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
    if (message.type === "response") {
      const resolve = this.pending.get(String(message.id));
      if (resolve) {
        this.pending.delete(String(message.id));
        resolve({
          success: message.success === true,
          ...typeof message.error === "string" ? { error: message.error } : {},
          ...message.data && typeof message.data === "object" ? { data: message.data } : {}
        });
      }
      return;
    }
    if (message.type === "extension_ui_request" && DIALOG_METHODS.has(String(message.method))) {
      this.send({ type: "extension_ui_response", id: message.id, cancelled: true });
    }
    this.onEvent(message);
  }
  send(command) {
    if (this.done)
      return;
    this.proc.write(JSON.stringify(command) + `
`);
  }
  request(command, timeoutMs = PI_REQUEST_TIMEOUT_MS) {
    if (this.done)
      return Promise.resolve({ success: false, error: "pi exited" });
    const id = `sd-${++this.counter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ success: false, error: "pi did not answer" });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.send({ ...command, id });
    });
  }
  close() {
    if (this.done)
      return;
    this.done = true;
    this.proc.kill();
  }
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
function costOf(usage) {
  const cost = record(record(usage)?.cost);
  return number(cost?.total) ?? 0;
}
function flattenPiContent(content) {
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
function newPiStream() {
  return { messageId: null, messages: 0, turnStartedAt: null, costUsd: 0, errors: [] };
}
function assistantBlocks(content) {
  const blocks = [];
  if (typeof content === "string") {
    if (content)
      blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content))
    return blocks;
  for (const part of content) {
    const p = record(part);
    if (!p)
      continue;
    if (p.type === "text") {
      const value = text(p.text) ?? "";
      if (value)
        blocks.push({ type: "text", text: value });
    } else if (p.type === "toolCall") {
      blocks.push({
        type: "tool_use",
        id: text(p.id) ?? "",
        name: text(p.name) ?? "",
        input: p.arguments ?? {}
      });
    }
  }
  return blocks;
}
function mapPiEvent(event, ctx, stream) {
  const now = ctx.now ?? Date.now;
  switch (event.type) {
    case "agent_start": {
      if (stream.turnStartedAt === null)
        stream.turnStartedAt = now();
      return [];
    }
    case "message_start": {
      const message = record(event.message);
      if (message?.role !== "assistant")
        return [];
      stream.messages += 1;
      stream.messageId = `pi-${stream.messages}`;
      return [];
    }
    case "message_update": {
      const delta = record(event.assistantMessageEvent);
      if (!delta || delta.type !== "text_delta")
        return [];
      const chunk = text(delta.delta) ?? "";
      if (!chunk)
        return [];
      if (stream.messageId === null) {
        stream.messages += 1;
        stream.messageId = `pi-${stream.messages}`;
      }
      return [
        {
          kind: "text_delta",
          messageId: stream.messageId,
          index: number(delta.contentIndex) ?? 0,
          text: chunk
        }
      ];
    }
    case "message_end": {
      const message = record(event.message);
      if (message?.role !== "assistant")
        return [];
      stream.costUsd += costOf(message.usage);
      const events = [];
      const blocks = assistantBlocks(message.content);
      if (blocks.length > 0) {
        events.push({
          kind: "assistant",
          messageId: stream.messageId ?? `pi-${++stream.messages}`,
          turn: ctx.turn,
          blocks,
          parentToolUseId: null
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
          parentToolUseId: null
        }
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
          ...errors.length > 0 ? { text: errors.join(`
`) } : {},
          denials: 0
        }
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
            text: `Pi: ${text(event.message) ?? ""}`.trimEnd()
          }
        ];
      }
      if (DIALOG_METHODS.has(method)) {
        return [
          {
            kind: "note",
            level: "info",
            code: "api",
            text: `A Pi extension asked for input the pane cannot show (${method}) — dismissed.`
          }
        ];
      }
      return [];
    }
    default:
      return [];
  }
}
function piCommands(data) {
  const list = data?.commands;
  if (!Array.isArray(list))
    return [];
  const commands = [];
  for (const entry of list) {
    const c = record(entry);
    const name = c ? text(c.name) : null;
    if (!name)
      continue;
    commands.push({
      name,
      description: (c && text(c.description)) ?? "",
      argumentHint: ""
    });
  }
  return commands;
}
function piState(data) {
  const model = record(data?.model);
  const name = model ? text(model.name) ?? text(model.id) : null;
  const sessionId = data ? text(data.sessionId) : null;
  return { ...name ? { model: name } : {}, ...sessionId ? { sessionId } : {} };
}

// ../../../../plugins/plugins/agent-pi/src/provider.ts
var PI_MISSING = "Pi CLI not found — install the `pi` command (https://pi.dev)";
var PI_NO_PERMISSIONS = "Pi runs its own tools — SpecDriven cannot gate them, so nothing asks for permission.";

class PiSession {
  host;
  cwd;
  client = null;
  stream = newPiStream();
  stderrTail = [];
  constructor(host, cwd) {
    this.host = host;
    this.cwd = cwd;
  }
  get final() {
    return this.host.status() === "ended" || this.host.status() === "error";
  }
  stderr = (line) => {
    this.stderrTail = [...this.stderrTail, line].slice(-5);
  };
  async ready() {
    const client = this.client;
    const [state, commands] = await Promise.all([
      client.request({ type: "get_state" }),
      client.request({ type: "get_commands" })
    ]);
    if (this.final)
      return;
    const info = piState(state.data);
    this.host.note("info", "init", `Pi · ${info.model ?? "no model"} · ${this.cwd}`);
    this.host.note("info", "init", PI_NO_PERMISSIONS);
    this.host.ready({
      ...info.model ? { model: info.model } : {},
      ...info.sessionId ? { agentSessionId: info.sessionId } : {},
      commands: piCommands(commands.data)
    });
  }
  event(event) {
    if (this.final)
      return;
    if (event.type === "agent_start")
      this.host.turnStarted();
    for (const body of mapPiEvent(event, { turn: this.host.turn() }, this.stream))
      this.host.emit(body);
    if (event.type === "agent_settled")
      this.host.turnEnded();
  }
  exited(code, error) {
    if (this.final)
      return;
    const tail = this.stderrTail.join(`
`);
    const detail = (text2) => tail ? `${text2}
${tail}` : text2;
    if (error)
      return this.host.failed(detail(`Could not start Pi: ${error.message}`), "spawn_failed");
    if (code === 0 || code === null)
      return this.host.ended("Pi exited.");
    this.host.failed(detail(`Pi exited with code ${code}.`));
  }
  async send(text2) {
    this.client.send({ type: "prompt", message: text2 });
  }
  async interrupt() {
    await this.client.request({ type: "abort" });
  }
  async setPermissionMode() {}
  close() {
    this.client?.close();
  }
}
var piProvider = {
  id: "pi",
  label: "Pi",
  description: "Minimal, and runs its own tools — nothing asks for permission",
  rank: 30,
  cli: PI_BIN,
  available: piAvailable,
  missingMessage: PI_MISSING,
  capabilities: {
    permissionModes: [],
    noPermissionsNote: "Pi runs its own tools — SpecDriven cannot gate them",
    canInterrupt: true,
    canChangeModeMidSession: false,
    hasAccount: false,
    rememberPermissions: "none",
    oneShot: false
  },
  defaultPermissionMode: "bypassPermissions",
  loginHint: {
    text: "Pi has no credentials for this model here: run pi in a terminal and /login, then start a new session.",
    command: "pi"
  },
  async start(opts) {
    const session = new PiSession(opts.host, opts.cwd);
    session.client = new PiClient({
      cwd: opts.cwd,
      name: opts.name,
      onEvent: (event) => session.event(event),
      onStderr: session.stderr,
      onExit: (code, error) => session.exited(code, error)
    });
    opts.signal.addEventListener("abort", () => session.close(), { once: true });
    if (opts.prompt)
      await session.send(opts.prompt);
    session.ready();
    return session;
  }
};

// ../../../../plugins/plugins/agent-pi/src/host.ts
var plugin = {
  name: "agent-pi",
  inject: ["agents"],
  apply(ctx) {
    const agents2 = ctx.need("agents");
    ctx.effect(() => agents2.register(piProvider));
  }
};
var host_default2 = plugin;
export {
  host_default2 as default
};

//# debugId=6FC29C320FC79D6164756E2164756E21
//# sourceMappingURL=host.js.map
