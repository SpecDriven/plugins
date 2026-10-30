// Claude in the coding agent pane (specs/agents/claude.feature.md in the
// specs repo): one
// long-lived `query()` from the Claude Agent SDK per chat, in streaming-input
// mode — the only mode in which permission requests, interrupts and mode
// changes reach us — spawning the developer's own `claude` binary with the
// code repo as its working directory. An AgentProvider
// (src/plugins/host/agents.ts): the engine (src/server/agentChat.ts) owns
// the event log and the permission cards; this file owns the subprocess,
// the SDK message mapping, the account chip and the proxy watchdog.
//
// Node APIs only (src/server/run.ts): this module also runs inside Electron.
// The SDK itself is imported lazily, on the first session, so booting the
// server, `bun test` and the desktop shell never pay for it.

import type {
  Options,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentError, normalizePermissionMode, which } from "@specdriven/host";
import type {
  AgentHost,
  AgentOutput,
  AgentProvider,
  AgentSession,
  AgentStartOptions,
  AssistantBlock,
  ChatAccount,
  OneShotRequest,
  OneShotResult,
  PermissionMode,
  SlashCommandInfo,
} from "@specdriven/host";
import { claudeLaunch, detectClaudeProxy } from "./auth";
import { CLAUDE_BIN, claudeAvailable } from "./cli";
import { DEFAULT_SETTINGS, type ClaudeSettingsValues } from "./settings";

// --- The account chip -------------------------------------------------------

/** What Claude Code's initialize answer says of the login (the SDK's
    AccountInfo). Claude Code fills `subscriptionType` with a display name
    ("Claude Max", "Claude Pro", "Claude Team", "Claude Enterprise") only
    while a claude.ai login is what it uses, and "Claude API" when that
    login has no plan; `tokenSource` may be the literal "none". */
export interface AccountInfoLike {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  anthropicAws: "Anthropic on AWS",
  anthropicGoogleCloud: "Anthropic on Google Cloud",
  mantle: "Mantle",
  gateway: "Gateway",
};

// Tokens that come from a claude.ai login (`claude setup-token`, a cloud
// session's file): a plan, though Claude Code does not say which.
const OAUTH_TOKEN_SOURCES = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CCR_OAUTH_TOKEN_FILE",
]);

/**
 * Where Claude Code sends its API calls when its own configuration moved
 * them: ANTHROPIC_BASE_URL from the environment it inherits, overridden by
 * the `env` block of each settings file it loads (settingSources: user, then
 * project, then local — the later one wins). The sign-in Settings chose
 * (src/server/claudeAuth.ts) decides what a session actually uses.
 */
export async function claudeBaseUrl(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  configDir?: string,
): Promise<string | undefined> {
  return (await detectClaudeProxy(cwd, env, configDir)).url ?? undefined;
}

const LOCAL_HOSTS = /^(localhost|.*\.localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i;

export function describeAccount(info: AccountInfoLike, baseUrl?: string): ChatAccount {
  const present = (v?: string) => (v && v !== "none" ? v : undefined);
  const apiKey = present(info.apiKeySource);
  const token = present(info.tokenSource);
  const who = [info.email, info.organization].filter(Boolean).join(" · ");
  const detailOf = (what: string, source?: string) =>
    [what, who, source ? `credential: ${source}` : ""].filter(Boolean).join(" · ");
  if (info.apiProvider && info.apiProvider !== "firstParty") {
    const name = PROVIDER_LABEL[info.apiProvider] ?? info.apiProvider;
    return { billing: "provider", label: name, detail: detailOf(`Billed through ${name}`) };
  }
  // A moved base URL: every call goes there, whatever the credential, and
  // a local one is a proxy in front of the API.
  let endpoint: URL | undefined;
  try {
    endpoint = baseUrl ? new URL(baseUrl) : undefined;
  } catch {
    // Not a URL Claude Code could use either; judge by the credential.
  }
  if (endpoint) {
    const label = LOCAL_HOSTS.test(endpoint.hostname) ? "PROXY" : endpoint.hostname;
    return { billing: "api", label: `API:${label}`, detail: `API:${endpoint.host}` };
  }
  const plan = present(info.subscriptionType);
  if (plan && plan !== "Claude API") {
    return { billing: "plan", label: plan, detail: detailOf("Claude subscription", "claude.ai login") };
  }
  if (token && OAUTH_TOKEN_SOURCES.has(token)) {
    return { billing: "plan", label: "Claude plan", detail: detailOf("Claude subscription token", token) };
  }
  // A bearer token sent as is: whoever issued it (a gateway, a proxy)
  // decides the billing, so the chip names the credential, not a plan.
  if (!apiKey && token === "ANTHROPIC_AUTH_TOKEN") {
    return { billing: "api", label: "Auth token", detail: detailOf("Billed by whoever issued the token", token) };
  }
  if (apiKey || token || plan) {
    const source = apiKey ?? token ?? "claude.ai login without a plan";
    return { billing: "api", label: "API billing", detail: detailOf("Billed per token", source) };
  }
  return { billing: "none", label: "Not logged in", detail: "Run claude auth login in a terminal, then start a new session." };
}

// --- The SDK seam -----------------------------------------------------------

/**
 * The prompt side of a streaming query: an async iterable the SDK pulls
 * from, that we push into as the user types. Closing it ends Claude's input.
 */
export class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter: (() => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) throw new Error("input closed");
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.done = true;
    this.wake();
  }

  get closed(): boolean {
    return this.done;
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/** What we need of the SDK's Query — narrow, so a test can hand in a fake. */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  /** Optional: a fake need not answer it. */
  accountInfo?(): Promise<AccountInfoLike | undefined>;
}

export type QueryFactory = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => QueryLike | Promise<QueryLike>;

// Injection seam (src/server/agent.ts setDesktopRunner): tests never spawn
// Claude; null restores the SDK.
let queryFactory: QueryFactory | null = null;

export function setQueryFactory(factory: QueryFactory | null): QueryFactory | null {
  const previous = queryFactory;
  queryFactory = factory;
  return previous;
}

const sdkFactory: QueryFactory = async ({ prompt, options }) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return query({ prompt, options });
};

/** The factory a query goes through right now: the injected one, else the SDK. */
export function currentQueryFactory(): QueryFactory {
  return queryFactory ?? sdkFactory;
}

// Injection seam for the first-response wait (the Settings value, in whole
// seconds): a test wants a wait shorter than a second; null restores the
// setting.
let firstResponseReader: (() => Promise<number>) | null = null;

export function setClaudeFirstResponseSeconds(fn: (() => Promise<number>) | null): (() => Promise<number>) | null {
  const previous = firstResponseReader;
  firstResponseReader = fn;
  return previous;
}

export function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

function commandInfo(c: SlashCommand): SlashCommandInfo {
  return { name: c.name, description: c.description ?? "", argumentHint: c.argumentHint ?? "" };
}

// --- SDK messages → pane events ---------------------------------------------

export interface StreamContext {
  /** The API message id the current stream_event deltas belong to. */
  messageId: string | null;
}

/**
 * The SDK message → our events. Pure apart from `stream`, which remembers
 * which message the partial deltas belong to (a delta names its block
 * index, not its message). Messages the pane has no use for map to nothing.
 */
export function mapSdkMessage(
  msg: SDKMessage,
  ctx: { turn: number },
  stream: StreamContext = { messageId: null },
): AgentOutput[] {
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        return [
          {
            kind: "note",
            level: "info",
            code: "init",
            text: `Claude Code ${msg.claude_code_version} · ${msg.model} · ${msg.cwd}`,
          },
        ];
      }
      if (msg.subtype === "compact_boundary") {
        const m = msg.compact_metadata;
        return [
          {
            kind: "note",
            level: "info",
            code: "compact",
            text: `Context compacted (${m.trigger}) — ${m.pre_tokens} tokens before.`,
          },
        ];
      }
      return [];
    }
    case "stream_event": {
      const ev = msg.event;
      if (ev.type === "message_start") {
        stream.messageId = ev.message.id;
        return [];
      }
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        return [
          {
            kind: "text_delta",
            messageId: stream.messageId ?? "",
            index: ev.index,
            text: ev.delta.text,
          },
        ];
      }
      return [];
    }
    case "assistant": {
      const blocks: AssistantBlock[] = [];
      for (const block of msg.message.content) {
        if (block.type === "text") blocks.push({ type: "text", text: block.text });
        else if (block.type === "tool_use") {
          blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      }
      const events: AgentOutput[] = [];
      if (blocks.length > 0) {
        events.push({
          kind: "assistant",
          messageId: msg.message.id,
          turn: ctx.turn,
          blocks,
          parentToolUseId: msg.parent_tool_use_id,
        });
      }
      if (msg.error) {
        events.push({ kind: "note", level: "error", code: "api", text: `API error: ${msg.error}` });
      }
      return events;
    }
    case "user": {
      // Only tool results are Claude's news; the rest is our own input
      // coming back (replays, synthetic turns).
      if ("isReplay" in msg && msg.isReplay) return [];
      const content = msg.message.content;
      if (typeof content === "string") return [];
      const events: AgentOutput[] = [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        events.push({
          kind: "tool_result",
          toolUseId: block.tool_use_id,
          content: flattenResult(block.content),
          isError: block.is_error === true,
          parentToolUseId: msg.parent_tool_use_id,
        });
      }
      return events;
    }
    case "result": {
      const text =
        msg.subtype === "success" ? msg.result : msg.errors.filter(Boolean).join("\n");
      return [
        {
          kind: "result",
          turn: ctx.turn,
          subtype: msg.subtype,
          isError: msg.is_error,
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          ...(text ? { text } : {}),
          denials: msg.permission_denials.length,
        },
      ];
    }
    default:
      return [];
  }
}

/** A tool result's content as one string: text joined, images named. */
function flattenResult(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "type" in part) {
        const p = part as { type: string; text?: string };
        if (p.type === "text") return p.text ?? "";
        return `[${p.type}]`;
      }
      return JSON.stringify(part);
    })
    .join("\n");
}

// --- The session ------------------------------------------------------------

/** The refusal when no `claude` is on PATH. */
export const CLAUDE_MISSING = "Claude CLI not found — install the `claude` command";

class ClaudeSession implements AgentSession {
  readonly input = new InputQueue<SDKUserMessage>();
  readonly abort = new AbortController();
  query: QueryLike | null = null;
  /** Claude Code sends `init` with every turn; only the first is news. */
  private initSeen = false;
  private commands: SlashCommandInfo[] = [];
  /** The last few stderr lines, for the error note when the CLI dies. */
  private stderrTail: string[] = [];
  private readonly stream: StreamContext = { messageId: null };
  /** Where Claude Code sends its API calls when something moved them
      (claudeBaseUrl) — a proxy or gateway. */
  apiBaseUrl?: string;
  /** How long a turn waits for the API's first sign of life behind that
      proxy; 0 is no limit. */
  firstResponseMs = 0;
  /** The armed first-response watchdog of the turn under way. */
  private firstResponse: ReturnType<typeof setTimeout> | null = null;
  /** Retries Claude Code reported in that turn before anything came back. */
  private apiRetries = 0;

  constructor(private readonly host: AgentHost) {}

  readonly stderr = (data: string): void => {
    const line = data.trim();
    if (!line) return;
    this.stderrTail = [...this.stderrTail, line].slice(-5);
  };

  get final(): boolean {
    return this.host.status() === "ended" || this.host.status() === "error";
  }

  /** The SDK asks; the pane answers (specs: "permission card"). */
  readonly canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    ctx: { signal: AbortSignal; suggestions?: PermissionUpdate[]; title?: string },
  ): Promise<PermissionResult> => {
    const suggestions = ctx.suggestions ?? [];
    const { decision } = await this.host.requestPermission({
      toolName,
      input,
      suggestions,
      ...(ctx.title ? { title: ctx.title } : {}),
      signal: ctx.signal,
    });
    if (decision.behavior === "deny") return { behavior: "deny", message: decision.message };
    return {
      behavior: "allow",
      updatedInput: decision.updatedInput,
      ...(decision.remember && suggestions.length > 0 ? { updatedPermissions: suggestions } : {}),
    };
  };

  async send(text: string): Promise<void> {
    this.input.push(userMessage(text));
    this.armFirstResponse();
  }

  async interrupt(): Promise<void> {
    this.disarmFirstResponse();
    await this.query?.interrupt();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.host.status() === "starting") throw new AgentError(409, "Claude is still starting");
    await this.query!.setPermissionMode(mode);
  }

  close(): void {
    this.disarmFirstResponse();
    this.input.close();
    this.abort.abort();
  }

  /**
   * Claude Code answers control requests as soon as it is up, but sends its
   * `init` message only with the first turn — so the first answer is what
   * says the session is ready to type into, and it brings the "/" commands.
   */
  async ready(): Promise<void> {
    try {
      const commands = await this.query!.supportedCommands();
      if (this.final) return;
      this.commands = commands.map(commandInfo);
    } catch {
      // The names in init will do when it comes.
    }
    let account: ChatAccount | undefined;
    try {
      const info = await this.query!.accountInfo?.();
      if (info) account = describeAccount(info, this.apiBaseUrl);
    } catch {
      // Older binaries lack the request; the pane just shows no chip.
    }
    if (this.final) return;
    this.host.ready({ commands: this.commands, ...(account ? { account } : {}) });
  }

  /** Read Claude's messages until it exits or we abort it. */
  async pump(): Promise<void> {
    try {
      for await (const msg of this.query!) {
        this.handleMessage(msg);
      }
      if (!this.final) this.host.ended("Claude exited.");
    } catch (e) {
      // Our own abort (end/shutdown) also ends the generator with an error.
      if (this.final) return;
      const tail = this.stderrTail.join("\n");
      this.host.failed(
        tail ? `${(e as Error).message}\n${tail}` : (e as Error).message,
        this.initSeen ? "ended" : "spawn_failed",
      );
    }
  }

  private handleMessage(msg: SDKMessage): void {
    this.noteFirstResponse(msg);
    if (msg.type === "system" && msg.subtype === "init") {
      const first = !this.initSeen;
      this.initSeen = true;
      const mode = normalizePermissionMode(msg.permissionMode);
      // Normally the readiness probe has the commands already; if it did not
      // answer, the names from init stand until the control request does.
      if (this.commands.length === 0) {
        this.commands = msg.slash_commands.map((name) => ({ name, description: "", argumentHint: "" }));
        void this.loadCommands();
      }
      // Later inits only refresh the facts above.
      if (!first) {
        this.host.update(
          { agentSessionId: msg.session_id, model: msg.model, ...(mode ? { permissionMode: mode } : {}) },
          { quiet: true },
        );
        return;
      }
      for (const body of mapSdkMessage(msg, { turn: this.host.turn() }, this.stream)) this.host.emit(body);
      this.host.update({
        agentSessionId: msg.session_id,
        model: msg.model,
        ...(mode ? { permissionMode: mode } : {}),
        tools: msg.tools,
        commands: this.commands,
      });
      return;
    }
    if (msg.type === "system" && msg.subtype === "commands_changed") {
      this.commands = msg.commands.map(commandInfo);
      this.host.update({ commands: this.commands });
      return;
    }
    for (const body of mapSdkMessage(msg, { turn: this.host.turn() }, this.stream)) this.host.emit(body);
    if (msg.type === "result") this.host.turnEnded();
  }

  private async loadCommands(): Promise<void> {
    try {
      const commands = await this.query!.supportedCommands();
      if (this.final) return;
      this.commands = commands.map(commandInfo);
      this.host.update({ commands: this.commands });
    } catch {
      // The names from init stand.
    }
  }

  // --- The first-response watchdog ---------------------------------------
  //
  // With the API behind a proxy (ANTHROPIC_BASE_URL) that is not running,
  // Claude Code retries its first request ten times with growing back-off —
  // minutes of a spinner. The pane gives a turn firstResponseMs to show any
  // sign of the API instead: a streamed event (the API's `ping` keepalives
  // included), a finished message or a result. None by then, and the turn
  // is stopped with a note saying why; the session stays up for the next
  // try.

  armFirstResponse(): void {
    this.disarmFirstResponse();
    this.apiRetries = 0;
    if (!this.firstResponseMs || !this.apiBaseUrl) return;
    this.firstResponse = setTimeout(() => void this.noFirstResponse(), this.firstResponseMs);
  }

  private disarmFirstResponse(): void {
    if (this.firstResponse) clearTimeout(this.firstResponse);
    this.firstResponse = null;
  }

  /** Anything the API sent ends the wait; Claude Code's own retries do not. */
  private noteFirstResponse(msg: SDKMessage): void {
    if (!this.firstResponse) return;
    if (msg.type === "system" && msg.subtype === "api_retry") {
      this.apiRetries = msg.attempt;
      return;
    }
    if (msg.type === "stream_event" || msg.type === "assistant" || msg.type === "result") {
      this.disarmFirstResponse();
    }
  }

  private async noFirstResponse(): Promise<void> {
    this.firstResponse = null;
    if (this.final || !this.host.busy() || !this.query) return;
    const seconds = Math.round(this.firstResponseMs / 1000);
    const retries =
      this.apiRetries > 0 ? ` after ${this.apiRetries} ${this.apiRetries === 1 ? "retry" : "retries"}` : "";
    this.host.note(
      "error",
      "api",
      `No response from the API at ${this.apiBaseUrl} within ${seconds}s${retries} — is the proxy running? ` +
        "The turn was stopped; send it again once the proxy is up. (Settings → Workflow sets this wait.)",
    );
    // Claude Code answers the interrupt with the turn's result, which puts
    // the session back to idle.
    try {
      await this.query.interrupt();
    } catch {
      // A Claude Code that died meanwhile ends the session through pump.
    }
  }
}

// --- The provider -----------------------------------------------------------

export interface ClaudeProviderOptions {
  /** Default: the Claude CLI on PATH (src/cli.ts claudeAvailable). */
  available?: () => boolean;
  /** Default: the injected factory, else the SDK. */
  query?: QueryFactory;
  /** The plugin's settings as they stand; default: the defaults. */
  settings?: () => Promise<ClaudeSettingsValues>;
  /** The proxy token the plugin's secret store holds; default: none. */
  token?: () => Promise<string | null>;
}

/** The Claude provider; the host half hands it the plugin's settings and token. */
export function createClaudeProvider(options: ClaudeProviderOptions = {}): AgentProvider {
  const factory = () => options.query ?? currentQueryFactory();
  const settings = options.settings ?? (async () => DEFAULT_SETTINGS);
  const token = options.token ?? (async () => null);
  const firstResponseSeconds = async () =>
    firstResponseReader ? firstResponseReader() : (await settings()).firstResponseSeconds;
  return {
    id: "claude",
    label: "Claude",
    description: "Claude Code, with permission cards and its own commands",
    rank: 10,
    cli: CLAUDE_BIN,
    available: options.available ?? claudeAvailable,
    missingMessage: CLAUDE_MISSING,
    capabilities: {
      permissionModes: ["auto", "default", "acceptEdits", "plan", "bypassPermissions"],
      canInterrupt: true,
      canChangeModeMidSession: true,
      hasAccount: true,
      rememberPermissions: "rule",
      oneShot: true,
    },
    defaultPermissionMode: "auto",
    loginHint: {
      text: "The Claude CLI is not signed in on this machine: run the command in a terminal, then start a new session.",
      command: "claude auth login",
    },
    async start(opts: AgentStartOptions): Promise<AgentSession> {
      const session = new ClaudeSession(opts.host);
      opts.signal.addEventListener("abort", () => session.close(), { once: true });
      // The sign-in Settings chose (src/server/claudeAuth.ts): the
      // environment to inherit, and the `--settings` override that makes
      // Claude Code honor the choice over its own settings files.
      const launch = await claudeLaunch(await settings(), opts.cwd, await token());
      session.apiBaseUrl = launch.apiBaseUrl;
      session.firstResponseMs = Math.max(0, Math.floor((await firstResponseSeconds()) * 1000));
      const sdkOptions: Options = {
        cwd: opts.cwd,
        pathToClaudeCodeExecutable: which(CLAUDE_BIN) ?? undefined,
        includePartialMessages: true,
        permissionMode: opts.permissionMode,
        // Lets the pane's mode select switch to bypass later; nothing
        // bypasses unless the user picks it.
        allowDangerouslySkipPermissions: true,
        abortController: session.abort,
        canUseTool: session.canUseTool,
        // Claude Code's own system prompt, CLAUDE.md, skills and project
        // commands — the point is a session like the one the CLI would open.
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        // With a code repo the specs live elsewhere; let Claude read them.
        ...(opts.codeRepo ? { additionalDirectories: [opts.dataRepo] } : {}),
        env: launch.env,
        ...(Object.keys(launch.extraArgs).length ? { extraArgs: launch.extraArgs } : {}),
        stderr: session.stderr,
      };
      if (opts.prompt) {
        session.input.push(userMessage(opts.prompt));
        session.armFirstResponse();
      }
      try {
        session.query = await factory()({ prompt: session.input, options: sdkOptions });
      } catch (e) {
        session.close();
        throw e;
      }
      void session.pump();
      void session.ready();
      return session;
    },
    async oneShot(req: OneShotRequest): Promise<OneShotResult> {
      const abortController = new AbortController();
      req.signal?.addEventListener("abort", () => abortController.abort(), { once: true });
      const prompt = new InputQueue<SDKUserMessage>();
      prompt.push(userMessage(req.prompt));
      prompt.close();
      const launch = await claudeLaunch(await settings(), req.cwd, await token());
      const timer = setTimeout(() => abortController.abort(), req.timeoutMs);
      try {
        const query = await factory()({
          prompt,
          options: {
            cwd: req.cwd,
            pathToClaudeCodeExecutable: which(CLAUDE_BIN) ?? undefined,
            maxTurns: 1,
            // No built-in tools at all: nothing to read, nothing to run,
            // nothing to ask permission for.
            tools: [],
            permissionMode: "default",
            systemPrompt: req.systemPrompt,
            // No CLAUDE.md, skills or hooks: the question is the whole context.
            settingSources: [],
            // Leaves nothing in ~/.claude/projects: this is not a session.
            persistSession: false,
            thinking: { type: "disabled" },
            ...(req.model ? { model: req.model } : {}),
            ...(req.schema ? { outputFormat: { type: "json_schema", schema: req.schema } } : {}),
            abortController,
            env: launch.env,
            ...(Object.keys(launch.extraArgs).length ? { extraArgs: launch.extraArgs } : {}),
          },
        });
        for await (const msg of query) {
          if (msg.type !== "result") continue;
          if (msg.subtype !== "success") {
            return { text: msg.errors?.filter(Boolean).join("; ") || msg.subtype, isError: true };
          }
          return { text: msg.result, structured: msg.structured_output, isError: msg.is_error };
        }
        throw new Error(abortController.signal.aborted ? "Claude did not answer in time" : "Claude exited without an answer");
      } finally {
        clearTimeout(timer);
        // The streaming-input turn is over either way; nothing must linger.
        abortController.abort();
      }
    },
  };
}

