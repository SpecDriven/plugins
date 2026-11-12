// OpenCode in the coding agent pane: `opencode acp` over the Agent Client
// Protocol (src/acp.ts). A chat is one ACP session; a turn is
// `session/prompt`, whose answer ends it; a Stop is `session/cancel`. The
// permissions OpenCode asks for arrive as `session/request_permission`
// requests, which the pane's permission cards answer — or the plugin does,
// where the pane's mode says so (src/config.ts). OpenCode ends its turn on
// a refusal, so a refusal with a reason is followed by the reason as the
// next prompt of the same pane turn. The model, the effort and OpenCode's
// Plan agent are the session's config options, switched with
// `session/set_config_option` at any time. An AgentProvider
// (src/plugins/host/agents.ts in the app); its one-shot turns run
// `opencode run` instead (src/oneShot.ts).
//
// Node APIs only (src/server/run.ts in the app): this module also runs
// under Electron.

import { AgentError } from "@specdriven/host";
import type {
  AgentChoices,
  AgentDefaultsPatch,
  AgentHost,
  AgentImage,
  AgentMcpServer,
  AgentProvider,
  AgentSession,
  AgentStartOptions,
  EffortLevel,
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
  PermissionSuggestion,
  PluginSettings,
  SlashCommandInfo,
} from "@specdriven/host";
import {
  ACP_CLIENT_INFO,
  ACP_PROTOCOL_VERSION,
  AcpClient,
  acpCommands,
  acpConfig,
  acpUsage,
  effortFromAcp,
  effortToAcp,
  finishAcpTurn,
  mapAcpUpdate,
  newAcpStream,
  paneTool,
  record,
  showToolForPermission,
  startAcpTurn,
} from "./acp";
import type { AcpConfig, AcpParams, AcpSelect, AcpStreamContext, RpcId } from "./acp";
import { OPENCODE_BIN, opencodeAvailable, opencodePath } from "./cli";
import { sessionEnv } from "./config";
import { listedModels, modelMenu, opencodeModels, recentModels } from "./models";
import { opencodeOneShot } from "./oneShot";

/** The refusal when no `opencode` is on PATH. */
export const OPENCODE_MISSING = "OpenCode CLI not found — install the `opencode` command (https://opencode.ai)";

/** The modes the pane offers: OpenCode has no classifier for "auto". */
export const OPENCODE_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The plugin's settings: what a new session starts on. */
export interface OpencodeDefaults {
  defaultModel: string | null;
  defaultEffort: EffortLevel | null;
}

export async function readDefaults(settings: PluginSettings | null): Promise<OpencodeDefaults> {
  const own = settings ? await settings.read().catch(() => ({}) as Record<string, unknown>) : {};
  const model = str(own.defaultModel);
  const effort = effortFromAcp(str(own.defaultEffort));
  return { defaultModel: model && model.trim() ? model : null, defaultEffort: effort ?? null };
}

/** An MCP server the app hands the session, as ACP's `session/new` takes one (stdio). */
export function acpMcpServer(server: AgentMcpServer): AcpParams {
  return {
    name: server.name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  };
}

/**
 * "Allow always" here is OpenCode's "Always allow": OpenCode keeps a rule
 * of its own making for the folder — for a command, every command that
 * starts the same way — and stops asking, in later sessions too (checked
 * against OpenCode 2.2.7). The request does not say what the rule will be,
 * so the suggestion names only the tool.
 */
function opencodeRule(toolName: string): PermissionSuggestion {
  return { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "opencode" };
}

/** The kinds of tool call that change files: what "accept edits" lets through. */
const EDIT_KINDS: ReadonlySet<unknown> = new Set(["edit", "delete", "move"]);

/** What the pane's refusal says when the user typed no reason (the app's words). */
const DENIED_DEFAULT = "Denied in SpecDriven";

/** A permission option of the given kind, from the request's list. */
function optionOf(options: unknown, kind: string): string | null {
  if (!Array.isArray(options)) return null;
  for (const entry of options) {
    const o = record(entry);
    if (o && o.kind === kind && typeof o.optionId === "string") return o.optionId;
  }
  return null;
}

/** The card's heading for a tool call. */
function cardTitle(kind: unknown, toolName: string): string {
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

class OpencodeSession implements AgentSession {
  client: AcpClient | null = null;
  private readonly stream: AcpStreamContext = newAcpStream();
  /** OpenCode's permission requests awaiting the pane, by JSON-RPC id: aborting one withdraws its card. */
  private readonly requests = new Map<string, AbortController>();
  private stderrTail: string[] = [];
  private sessionId: string | null = null;
  private config: AcpConfig = { model: null, effort: null, mode: null };
  /** The model OpenCode started on: what "the agent's own default" switches back to. */
  private ownModel: string | null = null;
  private mode: PermissionMode;
  /** Why the user refused a request this turn: sent to OpenCode once it has ended its turn over the refusal. */
  private refusal: string | null = null;
  /** The user pressed Stop this turn: the turn ends, whatever was refused. */
  private stopped = false;
  private commands: SlashCommandInfo[] | null = null;
  private isReady = false;
  private lastCount: number | null = null;

  constructor(
    private readonly host: AgentHost,
    private readonly cwd: string,
    mode: PermissionMode,
  ) {
    this.mode = mode;
  }

  get final(): boolean {
    return this.host.status() === "ended" || this.host.status() === "error";
  }

  readonly stderr = (line: string): void => {
    this.stderrTail = [...this.stderrTail, line].slice(-5);
  };

  private failed(why: string): void {
    const tail = this.stderrTail.join("\n");
    this.host.failed(tail ? `Could not start OpenCode: ${why}\n${tail}` : `Could not start OpenCode: ${why}`, "spawn_failed");
  }

  private async setOption(select: AcpSelect | null, value: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!select) return { ok: false, error: "OpenCode offers no such setting" };
    if (select.current === value) return { ok: true };
    const res = await this.client!.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId: select.id,
      value,
    });
    if (!res.ok) return { ok: false, error: res.error };
    this.config = { ...this.config, ...this.configFrom(res.result.configOptions) };
    return { ok: true };
  }

  /** The config options an answer or update carries; the slots it leaves out keep theirs. */
  private configFrom(options: unknown): Partial<AcpConfig> {
    const next = acpConfig(options);
    const out: Partial<AcpConfig> = {};
    if (next.model) out.model = next.model;
    if (next.effort) out.effort = next.effort;
    if (next.mode) out.mode = next.mode;
    return out;
  }

  /** OpenCode's Plan agent for plan mode, its Build agent for the rest. */
  private async applyMode(mode: PermissionMode): Promise<{ ok: true } | { ok: false; error: string }> {
    const mode_ = this.config.mode;
    if (!mode_) return mode === "plan" ? { ok: false, error: "OpenCode offers no Plan agent here" } : { ok: true };
    const want = mode === "plan" ? "plan" : "build";
    if (!mode_.values.some((v) => v.value === want)) {
      return mode === "plan" ? { ok: false, error: "OpenCode offers no Plan agent here" } : { ok: true };
    }
    return this.setOption(mode_, want);
  }

  /**
   * The handshake: `initialize`, then `session/new` on the work dir with
   * the app's MCP servers, then the model, effort and mode the pane picked.
   * The session's answer says it is ready to type into.
   */
  async ready(opts: {
    prompt?: string;
    images?: AgentImage[];
    model?: string;
    effort?: EffortLevel;
    mcpServers?: AgentMcpServer[];
  }): Promise<void> {
    const client = this.client!;
    const init = await client.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: ACP_CLIENT_INFO,
    });
    if (this.final) return;
    if (!init.ok) return this.failed(init.error);
    const agentInfo = record(init.result.agentInfo);
    const version = agentInfo ? str(agentInfo.version) : null;
    const created = await client.request("session/new", {
      cwd: this.cwd,
      mcpServers: (opts.mcpServers ?? []).map(acpMcpServer),
    });
    if (this.final) return;
    if (!created.ok) return this.failed(created.error);
    const sessionId = str(created.result.sessionId);
    if (!sessionId) return this.failed("session/new answered without a session id");
    this.sessionId = sessionId;
    this.config = acpConfig(created.result.configOptions);
    this.ownModel = this.config.model?.current ?? null;

    if (opts.model) {
      const set = await this.setOption(this.config.model, opts.model);
      if (!set.ok) this.host.note("error", "api", `OpenCode could not switch to ${opts.model}: ${set.error}`);
    }
    if (opts.effort && this.config.effort) {
      const value = effortToAcp(opts.effort, this.config.effort);
      const set = value ? await this.setOption(this.config.effort, value) : { ok: false as const, error: "not offered" };
      if (!set.ok) this.host.note("info", "api", `This model takes no ${opts.effort} effort; OpenCode's default stands.`);
    }
    const moded = await this.applyMode(this.mode);
    if (!moded.ok) this.host.note("error", "api", moded.error);
    if (this.final) return;

    const model = this.config.model?.current ?? null;
    const effort = effortFromAcp(this.config.effort?.current);
    this.host.note("info", "init", `OpenCode${version ? ` ${version}` : ""} · ${model ?? "no model"} · ${this.cwd}`);
    this.isReady = true;
    this.host.ready({
      agentSessionId: sessionId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(this.commands ? { commands: this.commands } : {}),
    });
    if (opts.prompt || opts.images?.length) {
      try {
        await this.send(opts.prompt ?? "", opts.images);
      } catch (e) {
        // The first turn never started: say so, and give the composer back.
        this.host.note("error", "api", (e as Error).message);
        this.host.turnEnded();
      }
    }
  }

  /** One turn: the text and pasted images as the prompt's content blocks. */
  async send(text: string, images?: AgentImage[]): Promise<void> {
    if (!this.sessionId || this.final) throw new Error("OpenCode is not ready");
    const prompt: AcpParams[] = [];
    if (text) prompt.push({ type: "text", text });
    for (const image of images ?? []) prompt.push({ type: "image", data: image.data, mimeType: image.mediaType });
    if (prompt.length === 0) prompt.push({ type: "text", text: "" });
    this.host.turnStarted();
    startAcpTurn(this.stream);
    this.refusal = null;
    this.stopped = false;
    this.prompt(prompt);
  }

  /** One `session/prompt`; its answer ends the pane's turn — unless OpenCode
      stopped over a refusal the user gave a reason for, which goes back to
      it as the next prompt of the same turn. */
  private prompt(prompt: AcpParams[]): void {
    void this.client!.request("session/prompt", { sessionId: this.sessionId, prompt }, 0).then((res) => {
      if (this.final) return;
      const stopReason = res.ok ? (str(res.result.stopReason) ?? "end_turn") : null;
      const refusal = this.refusal;
      this.refusal = null;
      if (stopReason === "cancelled" && refusal && !this.stopped) {
        this.prompt([{ type: "text", text: `The user declined that, saying: ${refusal}` }]);
        return;
      }
      const outcome = res.ok ? { stopReason: stopReason! } : { error: res.error };
      for (const body of finishAcpTurn(outcome, { turn: this.host.turn() }, this.stream)) this.host.emit(body);
      this.host.turnEnded();
    });
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId || !this.client) return;
    this.stopped = true;
    // Open cards close; OpenCode hears "cancelled" for each, as ACP asks.
    for (const pending of this.requests.values()) pending.abort();
    // The turn's own answer (stopReason "cancelled") puts the session back to idle.
    this.client.notify("session/cancel", { sessionId: this.sessionId });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.host.status() === "starting") throw new AgentError(409, "OpenCode is still starting");
    const moded = await this.applyMode(mode);
    if (!moded.ok) throw new AgentError(409, moded.error);
    this.mode = mode;
  }

  async setModel(model: string | null): Promise<void> {
    if (!this.sessionId) throw new AgentError(409, "OpenCode is still starting");
    const target = model ?? this.ownModel;
    if (!target) throw new AgentError(409, "OpenCode named no default model");
    const set = await this.setOption(this.config.model, target);
    if (!set.ok) throw new AgentError(400, `OpenCode could not switch to ${target}: ${set.error}`);
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    if (!this.sessionId) throw new AgentError(409, "OpenCode is still starting");
    const select = this.config.effort;
    if (!select) throw new AgentError(409, "This model takes no effort setting");
    const value = effortToAcp(effort, select);
    if (!value) {
      const offered = select.values.map((v) => v.value).join(", ");
      throw new AgentError(400, `This model takes no ${effort ?? "default"} effort (it offers ${offered || "none"})`);
    }
    const set = await this.setOption(select, value);
    if (!set.ok) throw new AgentError(400, `OpenCode could not set the effort: ${set.error}`);
  }

  close(): void {
    this.client?.close();
  }

  notification(method: string, params: AcpParams): void {
    if (this.final || method !== "session/update") return;
    const update = record(params.update);
    if (!update) return;
    switch (update.sessionUpdate) {
      case "available_commands_update": {
        this.commands = acpCommands(update.availableCommands);
        if (this.isReady) this.host.update({ commands: this.commands });
        return;
      }
      case "config_option_update": {
        this.config = { ...this.config, ...this.configFrom(update.configOptions) };
        return;
      }
      case "usage_update": {
        // The pane's context meter (specs/agents/agent-pane.feature.md S10).
        const usage = acpUsage(update, this.stream);
        if (!usage || usage.used === this.lastCount) return;
        this.lastCount = usage.used;
        const model = this.config.model?.current;
        this.host.context({
          totalTokens: usage.used,
          maxTokens: usage.size,
          detail: "measured",
          ...(model ? { model } : {}),
        });
        return;
      }
      default:
        for (const body of mapAcpUpdate(update, { turn: this.host.turn() }, this.stream)) this.host.emit(body);
    }
  }

  /** OpenCode asks; the pane (or the mode) answers. */
  request(id: RpcId, method: string, params: AcpParams): void {
    const client = this.client!;
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
    const select = (optionId: string | null) =>
      client.respond(id, { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });

    // The row the card is about, before the card.
    for (const body of showToolForPermission(toolCall, { turn: this.host.turn() }, this.stream)) this.host.emit(body);

    // The mode answers what it allows without a card.
    const kind = toolCall.kind;
    if (once && (this.mode === "bypassPermissions" || (this.mode === "acceptEdits" && EDIT_KINDS.has(kind)))) {
      select(once);
      return;
    }

    const pane = paneTool(toolCall);
    const key = String(id);
    const withdrawn = new AbortController();
    this.requests.set(key, withdrawn);
    void this.host
      .requestPermission({
        toolName: pane.name,
        input: pane.input,
        suggestions: always ? [opencodeRule(pane.name)] : [],
        title: cardTitle(kind, pane.name),
        signal: withdrawn.signal,
      })
      .then(({ decision, via }: PermissionOutcome) => {
        this.requests.delete(key);
        this.answer(decision, via, { once, always, reject }, select);
      });
  }

  private answer(
    decision: PermissionDecision,
    via: PermissionOutcome["via"],
    options: { once: string | null; always: string | null; reject: string | null },
    select: (optionId: string | null) => void,
  ): void {
    if (decision.behavior === "allow") {
      select(decision.remember && options.always ? options.always : (options.once ?? options.always));
      return;
    }
    if (via !== "user") {
      // A Stop or the session's end: ACP's "cancelled", not a refusal.
      select(null);
      return;
    }
    this.stream.denials += 1;
    // ACP's refusal carries no words, and OpenCode ends its turn on one
    // (the prompt answers "cancelled"). A reason the user typed goes to it
    // then, as the next prompt (prompt()); without one the turn is over.
    if (decision.message && decision.message !== DENIED_DEFAULT) this.refusal = decision.message;
    else this.host.note("info", "api", "OpenCode stops its turn when a request is denied.");
    select(options.reject);
  }

  /** OpenCode is gone: an exit code of its own, or an Error where it never started. */
  exited(code: number | null, error?: Error): void {
    if (this.final) return;
    const tail = this.stderrTail.join("\n");
    const detail = (text: string) => (tail ? `${text}\n${tail}` : text);
    if (error) return this.host.failed(detail(`Could not start OpenCode: ${error.message}`), "spawn_failed");
    if (code === 0 || code === null) return this.host.ended("OpenCode exited.");
    this.host.failed(detail(`OpenCode exited with code ${code}.`));
  }
}

export interface OpencodeProviderOptions {
  /** The plugin's settings section (HostConfig.settings): the defaults the pane keeps. */
  settings?: PluginSettings;
}

export function createOpencodeProvider(options: OpencodeProviderOptions = {}): AgentProvider {
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
      // "Allow always" is a rule OpenCode keeps for the folder (opencodeRule).
      rememberPermissions: "rule",
      oneShot: true,
      canChangeModelMidSession: true,
      effort: true,
      images: true,
      contextUsage: "totals",
    },
    defaultPermissionMode: "default",
    loginHint: {
      text: "OpenCode has no credentials for this model here: run the command in a terminal, then start a new session.",
      command: "opencode auth login",
    },
    async start(opts: AgentStartOptions): Promise<AgentSession> {
      // The defaults, and each OpenCode agent's rules in this folder with
      // allow turned to ask (src/config.ts) — a moment, before the spawn.
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
        onExit: (code, error) => session.exited(code, error),
      });
      opts.signal.addEventListener("abort", () => session.close(), { once: true });
      // The prompt is the first turn, once the session is up; the core shows
      // it in the transcript straight away.
      const model = opts.model ?? defaults.defaultModel ?? undefined;
      const effort = opts.effort ?? defaults.defaultEffort ?? undefined;
      void session.ready({
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        ...(opts.images?.length ? { images: opts.images } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(opts.mcpServers?.length ? { mcpServers: opts.mcpServers } : {}),
      });
      return session;
    },
    /** The pane's model and effort menus (src/models.ts), and what a new session starts on. */
    async choices(ctx: { dataRepo: string | null }): Promise<AgentChoices> {
      const defaults = await readDefaults(settings);
      const [catalog, listed, recent] = await Promise.all([opencodeModels(), listedModels(ctx.dataRepo), recentModels()]);
      return {
        models: modelMenu({ catalog, listed, recent, defaultModel: defaults.defaultModel }),
        model: defaults.defaultModel,
        effort: defaults.defaultEffort,
      };
    },
    /** A pick in the pane becomes what new sessions start on. */
    async setDefaults(patch: AgentDefaultsPatch): Promise<void> {
      if (!settings) throw new AgentError(409, "OpenCode keeps no defaults here");
      const section: Record<string, unknown> = {};
      if (patch.model !== undefined) section.defaultModel = patch.model;
      if (patch.effort !== undefined) section.defaultEffort = patch.effort;
      if (Object.keys(section).length > 0) await settings.write(section);
    },
    async reportedModels(): Promise<string[] | null> {
      const models = await opencodeModels();
      return models.length > 0 ? models : null;
    },
    oneShot: opencodeOneShot,
  };
}
