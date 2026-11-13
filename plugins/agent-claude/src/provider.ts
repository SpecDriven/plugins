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
  McpStdioServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentError, normalizePermissionMode } from "@specdriven/host";
import type {
  AgentHost,
  AgentOutput,
  AgentSession,
  ChatAccount,
  OneShotRequest,
  OneShotResult,
  PermissionMode,
  SlashCommandInfo,
} from "@specdriven/host";
import { claudeLaunch, detectClaudeProxy } from "./auth";
import { CLAUDE_BIN, claudeAvailable, claudeExecutable } from "./cli";
import type { AccountModel } from "./accountModels";
import { inList, narrowModels } from "./modelMenu";
import type {
  AgentChoices,
  AgentDefaultsPatch,
  AgentMcpServer,
  AgentModelOption,
  ChatContextUsage,
  ContextDetail,
  PaneBlock,
  PaneHost,
  PaneOutput,
  PaneProvider,
  PaneStartOptions,
  PastedImage,
} from "./paneContract";
import { contextUsageOf, contextWindowOf, tokensInWindow, type ContextUsageAnswer } from "./contextUsage";
import { CLAUDE_MODEL_ALIASES, DEFAULT_SETTINGS, type ClaudeEffort, type ClaudeSettingsValues } from "./settings";

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
  return { billing: "none", label: "Not logged in", detail: "Sign in with your Claude account's email in Settings → Claude." };
}

/** What Settings → Claude has chosen, as describeSignIn reads it. */
export interface SignInChoice {
  mode: "login" | "proxy";
  /** The address a proxy-mode launch goes through; null when none is set. */
  proxyUrl: string | null;
  /** `claude auth status` under the account sign-in; null in proxy mode. */
  login: { loggedIn: boolean; method: string; email: string | null } | null;
}

/**
 * The sign-in a new session would start under, before any session has
 * reported one (specs/agents/agent-pane.feature.md "The pane header says
 * whether the agent spends an account or the API"): the API at the
 * address Settings names, or the Claude account Claude Code is signed in to.
 * A session's own account answer (describeAccount) replaces it once it
 * comes.
 */
export function describeSignIn(choice: SignInChoice): ChatAccount {
  if (choice.mode === "proxy") {
    let endpoint: URL | undefined;
    try {
      endpoint = choice.proxyUrl ? new URL(choice.proxyUrl) : undefined;
    } catch {
      // Settings normalizes the url; a bad one reads as none set.
    }
    if (!endpoint) {
      return { billing: "api", label: "API", detail: "API · no address set yet — enter one in Settings → Claude" };
    }
    const label = LOCAL_HOSTS.test(endpoint.hostname) ? "PROXY" : endpoint.hostname;
    return { billing: "api", label: `API:${label}`, detail: `API calls go to ${endpoint.host}` };
  }
  const login = choice.login;
  if (login?.loggedIn) {
    const who = login.email ? ` · ${login.email}` : "";
    if (login.method === "oauth_token") {
      return { billing: "plan", label: "Claude plan", detail: `Claude subscription token${who}` };
    }
    return { billing: "plan", label: "Claude account", detail: `Claude account${who}` };
  }
  return { billing: "none", label: "Not logged in", detail: "Sign in with your Claude account's email in Settings → Claude." };
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
  /** Optional: the account's model menu (src/accountModels.ts). */
  supportedModels?(): Promise<unknown[]>;
  /** Switch the model from the next request on; undefined is Claude Code's own. */
  setModel?(model?: string): Promise<void>;
  /** Merge settings into the session's flag layer (the effort, here). */
  applyFlagSettings?(settings: { effortLevel?: ClaudeEffort | null }): Promise<void>;
  /** Claude Code's /context count (src/contextUsage.ts); older binaries refuse it. */
  getContextUsage?(opts?: { detail?: ContextDetail }): Promise<unknown>;
  /** The thinking budget and how thinking is reported (askForThinking, below). */
  setMaxThinkingTokens?(
    maxThinkingTokens: number | null,
    thinkingDisplay?: "summarized" | "omitted" | null,
  ): Promise<void>;
}

/**
 * Ask Claude Code to report what Claude thinks as a summary rather than
 * nothing, for the pane's Thinking and Verbose transcript views. This never
 * switches thinking on or changes how much of it there is: `null` leaves the
 * budget the session's own, so a Claude Code whose settings turn thinking
 * off (`alwaysThinkingEnabled: false`) still does not think — checked
 * against Claude Code 2.1.323, where the same turn took as long with the
 * request as without. A Claude Code that refuses the request, or a query
 * with no such method, is left as it is: the session matters more.
 */
export function askForThinking(query: QueryLike): void {
  if (!query.setMaxThinkingTokens) return;
  void query.setMaxThinkingTokens(null, "summarized").catch(() => undefined);
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

/** How many times the pane tries a turn's request on an API that stays
    silent before it gives the turn up. */
export const API_TRIES = 3;

/** The pause before the pane's second try; each further one waits as much
    again (2 seconds, then 4). */
const RETRY_PAUSE_MS = 2000;

// Injection seam for that pause: a test wants milliseconds; null restores it.
let retryPauseMs: number | null = null;

export function setClaudeRetryPauseMs(ms: number | null): number | null {
  const previous = retryPauseMs;
  retryPauseMs = ms;
  return previous;
}

/** A user turn for Claude Code: the text, or, with pasted images, the
    images first and then the text (an empty text block is refused, so a
    message of images alone has none). */
export function userMessage(text: string, images: readonly PastedImage[] = []): SDKUserMessage {
  if (images.length === 0) {
    return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
  }
  const content = [
    ...images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
    })),
    ...(text.trim() ? [{ type: "text" as const, text }] : []),
  ];
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
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
): PaneOutput[] {
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
      // A subagent's stream names the call that started it, so the pane
      // keeps it with that call from its first word.
      const parent = msg.parent_tool_use_id ? { parentToolUseId: msg.parent_tool_use_id } : {};
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        return [
          {
            kind: "text_delta",
            messageId: stream.messageId ?? "",
            index: ev.index,
            text: ev.delta.text,
            ...parent,
          },
        ];
      }
      // What Claude thinks, as it thinks it. A Claude Code that keeps the
      // thinking to itself streams empty deltas (and a token estimate the
      // pane has no use for): those are nothing to show.
      if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta" && ev.delta.thinking) {
        return [
          {
            kind: "thinking_delta",
            messageId: stream.messageId ?? "",
            index: ev.index,
            text: ev.delta.thinking,
            ...parent,
          },
        ];
      }
      return [];
    }
    case "assistant": {
      const blocks: PaneBlock[] = [];
      for (const block of msg.message.content) {
        if (block.type === "text") blocks.push({ type: "text", text: block.text });
        else if (block.type === "tool_use") {
          blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        } else if (block.type === "thinking") {
          // The thought whole. One Claude kept to itself comes empty, and a
          // redacted one is not text at all: neither adds to the transcript.
          if (block.thinking.trim()) blocks.push({ type: "thinking", text: block.thinking });
        }
      }
      const events: PaneOutput[] = [];
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
      const events: PaneOutput[] = [];
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

/** The refusal when there is no Claude Code: no `claude` on PATH, nothing fetched. */
export const CLAUDE_MISSING = "Claude Code is not set up — sign in with your Claude account's email in Settings → Claude";

/** What one Claude Code run of a session is handed. */
interface LaunchArgs {
  input: InputQueue<SDKUserMessage>;
  abort: AbortController;
  permissionMode: PermissionMode;
  /** Claude Code's id for the conversation to carry on, from a run before. */
  resume?: string;
  /** The model the run before ran on, which the conversation keeps. */
  model?: string;
  /** The effort the run before ran at, which the conversation keeps. */
  effort?: ClaudeEffort;
}

/** Start one Claude Code run with the sign-in as it stands now. */
type Launcher = (args: LaunchArgs) => Promise<{ query: QueryLike; apiBaseUrl?: string; firstResponseMs: number }>;

class ClaudeSession implements AgentSession {
  /** The prompt side and the abort of the Claude Code run under way; a
      refresh swaps both for the next run's. */
  input = new InputQueue<SDKUserMessage>();
  abort = new AbortController();
  query: QueryLike | null = null;
  /** Starts a run; set by start(). */
  launch: Launcher | null = null;
  /** Claude Code's id for the conversation (init), which a new run resumes. */
  private claudeSessionId: string | null = null;
  /** The model Claude Code said it runs on (init), which a new run keeps. */
  private model: string | null = null;
  /** The effort the session runs at (start, then the pane's switch), which
      a new run keeps; null is Claude Code's own. */
  effort: ClaudeEffort | null = null;
  /** A sign-in change came while a turn ran or Claude was starting. */
  private refreshWanted = false;
  /** The new run being started; a message typed meanwhile waits for it. */
  private restarting: Promise<void> | null = null;
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
  /** Retries Claude Code reported in the try under way before anything came back. */
  private apiRetries = 0;
  /** What the turn under way sent, to send again when the API stays silent. */
  lastMessage: SDKUserMessage | null = null;
  /** Requests the turn's earlier tries made, and how often the pane sent
      the message again. */
  private triesBefore = 0;
  private resends = 0;
  /** A try the pane gave up on: its interrupt's result is awaited, then
      kept through the pause before the next try. */
  private retry: { pauseMs: number; result: SDKMessage | null; timer: ReturnType<typeof setTimeout> | null } | null =
    null;
  /** Whether this Claude Code answers the context count: asked once, and
      a refusal then means the totals from each turn stand in for it. */
  private contextProbe: "unknown" | "yes" | "no" = "unknown";
  /** The newest count asked for; an older answer arriving later is dropped. */
  private contextTicket = 0;
  /** What the last request put in the window, and the model's window, from
      the turns themselves: the count an older Claude Code still gives. */
  private lastWindowTokens: number | null = null;
  private contextWindow: number | null = null;

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

  async send(text: string, images?: PastedImage[]): Promise<void> {
    if (this.restarting) await this.restarting;
    this.lastMessage = userMessage(text, images);
    this.input.push(this.lastMessage);
    this.armFirstResponse();
  }

  async interrupt(): Promise<void> {
    this.disarmFirstResponse();
    const retry = this.retry;
    if (retry) {
      // Stopped while the pane was trying again: no further try. The try
      // it gave up on is interrupted already, and its result ends the turn —
      // now, when it came before the pause, else when it comes.
      this.dropRetry();
      if (retry.result) this.handleMessage(retry.result);
      return;
    }
    await this.query?.interrupt();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.host.status() === "starting") throw new AgentError(409, "Claude is still starting");
    await this.query!.setPermissionMode(mode);
  }

  /** The pane's model pick (specs/agents/claude.feature.md "Pick Claude's
      model and effort in the pane"): from the next request on, and for any
      run that carries the conversation on. */
  async setModel(model: string | null): Promise<void> {
    if (this.host.status() === "starting") throw new AgentError(409, "Claude is still starting");
    if (this.restarting) await this.restarting;
    if (!this.query?.setModel) throw new AgentError(409, "This Claude Code cannot switch models mid-session");
    await this.query.setModel(model ?? undefined);
    this.model = model;
  }

  /** Put Claude's output in the session's log. An app from before the
      transcript views has no type for thinking (src/paneContract.ts
      PaneOutput); its log and its pane take the events all the same. */
  private emit(body: PaneOutput): void {
    this.host.emit(body as AgentOutput);
  }

  /** The pane's effort pick, the same way. */
  async setEffort(effort: ClaudeEffort | null): Promise<void> {
    if (this.host.status() === "starting") throw new AgentError(409, "Claude is still starting");
    if (this.restarting) await this.restarting;
    if (!this.query?.applyFlagSettings) throw new AgentError(409, "This Claude Code cannot change effort mid-session");
    await this.query.applyFlagSettings({ effortLevel: effort });
    this.effort = effort;
  }

  close(): void {
    this.disarmFirstResponse();
    this.dropRetry();
    this.input.close();
    this.abort.abort();
  }

  /**
   * Count the context window now (specs/agents/claude.feature.md "Claude
   * reports its context usage to the pane"): "summary" is Claude Code's
   * cheap count from the last response, "full" counts every category with
   * the API. Null when there is nothing to say yet. A Claude Code that
   * refuses the request is not asked again; the turns' totals stand in.
   */
  async contextUsage(detail: ContextDetail): Promise<ChatContextUsage | null> {
    const query = this.query;
    if (query?.getContextUsage && this.contextProbe !== "no") {
      try {
        const answer = (await query.getContextUsage({ detail })) as ContextUsageAnswer;
        this.contextProbe = "yes";
        return contextUsageOf(answer, detail, new Date().toISOString());
      } catch (e) {
        // An answer that came before: a passing failure, not an old binary.
        if (this.contextProbe === "yes") {
          if (detail === "full") throw e;
          return null;
        }
        this.contextProbe = "no";
      }
    }
    return this.totalsFromTurns();
  }

  /** The count from the turns alone: what the last request carried, of the model's window. */
  private totalsFromTurns(): ChatContextUsage | null {
    if (this.lastWindowTokens === null) return null;
    return {
      at: new Date().toISOString(),
      ...(this.model ? { model: this.model } : {}),
      totalTokens: this.lastWindowTokens,
      maxTokens: this.contextWindow,
      detail: "estimate",
    };
  }

  /** Count the window and show the count; never in the way of a turn. */
  private countContext(): void {
    const ticket = ++this.contextTicket;
    const query = this.query;
    void this.contextUsage("summary")
      .then((usage) => {
        if (!usage || this.final || ticket !== this.contextTicket || query !== this.query) return;
        (this.host as PaneHost).context?.(usage);
      })
      .catch(() => {
        // The last count stands.
      });
  }

  /**
   * The sign-in changed (src/host.ts): the Claude Code under way keeps the
   * credentials it started with, and its account is what the chip says. So
   * a new run starts with the sign-in as it stands, carrying the
   * conversation on (resume), and the old one goes. A turn under way, or a
   * Claude still starting, finishes first.
   */
  async refresh(): Promise<void> {
    if (this.final) return;
    if (this.host.status() === "starting" || this.host.busy() || this.restarting) {
      this.refreshWanted = true;
      return;
    }
    await this.restart();
  }

  /** A refresh that waited: now, if nothing else is under way. */
  private refreshIfWanted(): void {
    if (!this.refreshWanted || this.final || this.host.busy() || this.restarting) return;
    void this.restart().catch((e: Error) => {
      if (!this.final) {
        this.host.note("error", "api", `Could not pick up the new Claude sign-in: ${e.message} — start a new session.`);
      }
    });
  }

  private restart(): Promise<void> {
    this.refreshWanted = false;
    const run = this.swapRun().finally(() => {
      this.restarting = null;
      this.refreshIfWanted();
    });
    this.restarting = run.catch(() => {});
    return run;
  }

  private async swapRun(): Promise<void> {
    if (!this.launch || this.final) return;
    const input = new InputQueue<SDKUserMessage>();
    const abort = new AbortController();
    let next: Awaited<ReturnType<Launcher>>;
    try {
      next = await this.launch({
        input,
        abort,
        permissionMode: this.host.permissionMode(),
        ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
        ...(this.claudeSessionId && this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      });
    } catch (e) {
      input.close();
      abort.abort();
      throw e;
    }
    if (this.final) {
      input.close();
      abort.abort();
      return;
    }
    const previous = { input: this.input, abort: this.abort };
    this.input = input;
    this.abort = abort;
    this.query = next.query;
    this.apiBaseUrl = next.apiBaseUrl;
    this.firstResponseMs = next.firstResponseMs;
    this.stderrTail = [];
    this.stream.messageId = null;
    previous.input.close();
    previous.abort.abort();
    void this.pump(next.query);
    let account: ChatAccount | undefined;
    try {
      const info = await next.query.accountInfo?.();
      if (info) account = describeAccount(info, this.apiBaseUrl);
    } catch {
      // Older binaries lack the request; the chip stays as it was.
    }
    if (this.final || this.query !== next.query) return;
    if (account) this.host.update({ account });
    this.host.note(
      "info",
      "init",
      `Claude's sign-in changed — restarted with ${account ? account.label : "the new sign-in"}; the conversation carries on.`,
    );
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
    this.host.ready({
      commands: this.commands,
      ...(account ? { account } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
    });
    // What fills the window before the first turn: the system prompt, the tools.
    this.countContext();
    this.refreshIfWanted();
  }

  /** Read a run's messages until it exits or we abort it; a run a refresh
      replaced says nothing more. */
  async pump(query: QueryLike): Promise<void> {
    try {
      for await (const msg of query) {
        if (query !== this.query) return;
        this.handleMessage(msg);
      }
      if (!this.final && query === this.query) this.host.ended("Claude exited.");
    } catch (e) {
      // Our own abort (end/shutdown, a refresh) also ends the generator with an error.
      if (this.final || query !== this.query) return;
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
      this.claudeSessionId = msg.session_id;
      const mode = normalizePermissionMode(msg.permissionMode);
      // Normally the readiness probe has the commands already; if it did not
      // answer, the names from init stand until the control request does.
      if (this.commands.length === 0) {
        this.commands = msg.slash_commands.map((name) => ({ name, description: "", argumentHint: "" }));
        void this.loadCommands();
      }
      if (msg.model) this.model = msg.model;
      // Later inits only refresh the facts above.
      if (!first) {
        this.host.update(
          { agentSessionId: msg.session_id, model: msg.model, ...(mode ? { permissionMode: mode } : {}) },
          { quiet: true },
        );
        return;
      }
      for (const body of mapSdkMessage(msg, { turn: this.host.turn() }, this.stream)) this.emit(body);
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
    if (this.retry && !this.retry.result) {
      // The try the pane gave up on says nothing more; its result (Claude
      // Code's answer to the interrupt) starts the pause before the next.
      if (msg.type === "result") {
        this.retry.result = msg;
        this.retry.timer = setTimeout(() => this.tryAgain(), this.retry.pauseMs);
      }
      return;
    }
    if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
      const tokens = tokensInWindow(msg.message.usage);
      if (tokens !== null && tokens > 0) this.lastWindowTokens = tokens;
    }
    for (const body of mapSdkMessage(msg, { turn: this.host.turn() }, this.stream)) this.emit(body);
    if (msg.type === "result") {
      this.contextWindow = contextWindowOf(msg.modelUsage, this.model) ?? this.contextWindow;
      this.host.turnEnded();
      // Counted once the composer is free again, not before.
      this.countContext();
      this.refreshIfWanted();
    } else if (msg.type === "system" && msg.subtype === "compact_boundary") {
      this.countContext();
    }
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
  // minutes of a spinner — and a proxy that takes the request and never
  // answers is not retried at all. The pane gives each try firstResponseMs
  // to show any sign of the API instead: a streamed event (the API's `ping`
  // keepalives included), a finished message or a result. None by then, and
  // the try is stopped; the pane sends the message again after a pause until
  // the API has been asked API_TRIES times, Claude Code's own retries
  // counted. Still nothing, and the turn is stopped with a note saying why;
  // the session stays up for the next message.

  /** A new turn: the wait starts, and the tries count from one. */
  armFirstResponse(): void {
    this.dropRetry();
    this.triesBefore = 0;
    this.resends = 0;
    this.armWait();
  }

  /** One try's wait. */
  private armWait(): void {
    this.disarmFirstResponse();
    this.apiRetries = 0;
    if (!this.firstResponseMs || !this.apiBaseUrl) return;
    this.firstResponse = setTimeout(() => void this.noFirstResponse(), this.firstResponseMs);
  }

  private disarmFirstResponse(): void {
    if (this.firstResponse) clearTimeout(this.firstResponse);
    this.firstResponse = null;
  }

  private dropRetry(): void {
    if (this.retry?.timer) clearTimeout(this.retry.timer);
    this.retry = null;
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
    // Each retry Claude Code reported is a request that failed; with none
    // reported, the one request is still unanswered.
    const tries = this.triesBefore + Math.max(1, this.apiRetries);
    const silent = `No response from the API at ${this.apiBaseUrl} within ${seconds}s`;
    if (this.lastMessage && tries < API_TRIES) {
      this.triesBefore = tries;
      this.resends += 1;
      const pauseMs = (retryPauseMs ?? RETRY_PAUSE_MS) * this.resends;
      this.retry = { pauseMs, result: null, timer: null };
      this.host.note(
        "info",
        "api",
        `${silent} — trying again in ${Math.round(pauseMs / 1000)}s (try ${tries + 1} of ${API_TRIES}).`,
      );
    } else {
      this.host.note(
        "error",
        "api",
        `${silent}, after ${tries} ${tries === 1 ? "try" : "tries"} — is the proxy running? ` +
          "The turn was stopped; send it again once the proxy is up. (Settings → Claude sets this wait.)",
      );
    }
    // Claude Code answers the interrupt with the turn's result, which puts
    // the session back to idle — or, with another try to come, starts the
    // pause before it (handleMessage).
    try {
      await this.query.interrupt();
    } catch {
      // A Claude Code that died meanwhile ends the session through pump.
    }
  }

  /** The pause is over: the same message again, with a wait of its own. */
  private tryAgain(): void {
    this.retry = null;
    if (this.final || !this.host.busy() || !this.lastMessage) return;
    this.input.push(this.lastMessage);
    this.armWait();
  }
}

// --- The provider -----------------------------------------------------------

export interface ClaudeProviderOptions {
  /** Default: a Claude Code to run (src/cli.ts claudeAvailable). */
  available?: () => boolean;
  /** Default: the injected factory, else the SDK. */
  query?: QueryFactory;
  /** The plugin's settings as they stand; default: the defaults. */
  settings?: () => Promise<ClaudeSettingsValues>;
  /** The proxy token the plugin's secret store holds; default: none. */
  token?: () => Promise<string | null>;
  /** The names the data repo lists for Claude (src/models.ts), which narrow
      the menus to those models; default: none, so nothing is narrowed. */
  listedModels?: () => Promise<string[]>;
  /** The models the sign-in offers: the signed-in Claude account's
      (src/accountModels.ts) or the proxy's (src/proxyModels.ts); none signed
      out or with no proxy answer. Default: none. */
  accountModels?: () => Promise<AccountModel[]>;
  /** Write a patch to the plugin's settings section (HostConfig.settings);
      default: nothing is kept. */
  saveSettings?: (patch: Record<string, unknown>) => Promise<void>;
  /** The sign-in a new session would start under (describeSignIn), for
      choices().account; default: none said. */
  signIn?: () => Promise<ChatAccount>;
}

/** The pane's menu with nothing listed: Claude Code's aliases for its latest models. */
const ALIAS_MENU: AgentModelOption[] = CLAUDE_MODEL_ALIASES.filter((a) => a !== "opusplan").map((a) => ({
  value: a,
  displayName: a.charAt(0).toUpperCase() + a.slice(1),
  description: `Claude Code's latest ${a.charAt(0).toUpperCase() + a.slice(1)}`,
}));

/** The Claude provider; the host half hands it the plugin's settings and token. */
export function createClaudeProvider(options: ClaudeProviderOptions = {}): PaneProvider {
  const factory = () => options.query ?? currentQueryFactory();
  const settings = options.settings ?? (async () => DEFAULT_SETTINGS);
  const token = options.token ?? (async () => null);
  const listedModels = options.listedModels ?? (async () => []);
  /** No model asked for: the default Settings names while the data repo's
      list for Claude holds it, else the first that list names, else none —
      Claude Code's own. The offered models pair aliases with ids, asked for
      only when the default is not listed by name. */
  const defaultModel = async (own: ClaudeSettingsValues) => {
    const listed = await listedModels();
    const set = own.defaultModel;
    if (set && (listed.length === 0 || listed.includes(set))) return set;
    if (set) {
      const offered = await (options.accountModels?.() ?? Promise.resolve([])).catch(() => [] as AccountModel[]);
      if (inList(set, offered, listed)) return set;
    }
    return listed[0] ?? null;
  };
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
      canChangeModelMidSession: true,
      effort: true,
      images: true,
      contextUsage: "breakdown",
      thinking: true,
    },
    defaultPermissionMode: "auto",
    loginHint: {
      text: "Claude is not signed in on this machine: sign in with your email in Settings → Claude.",
    },
    async start(opts: PaneStartOptions): Promise<AgentSession> {
      const session = new ClaudeSession(opts.host);
      opts.signal.addEventListener("abort", () => session.close(), { once: true });
      session.launch = async ({ input, abort, permissionMode, resume, model, effort }) => {
        // The sign-in Settings chose (src/auth.ts), read afresh for every
        // run: the environment to inherit, and the `--settings` override
        // that makes Claude Code honor the choice over its own settings files.
        const own = await settings();
        const launch = await claudeLaunch(own, opts.cwd, await token());
        const firstResponseMs = Math.max(0, Math.floor((await firstResponseSeconds()) * 1000));
        // A carried-on conversation keeps the model it ran on, whatever the
        // default says now; a new one starts on the default Settings names,
        // else the first listed model, else Claude Code's own.
        // The pane's pick for a new session comes as opts.model.
        const runModel = model ?? opts.model ?? (await defaultModel(own));
        // The effort likewise: the run before's, the pane's, the default.
        const runEffort = effort ?? opts.effort ?? own.defaultEffort;
        const sdkOptions: Options = {
          cwd: opts.cwd,
          pathToClaudeCodeExecutable: claudeExecutable() ?? undefined,
          includePartialMessages: true,
          permissionMode,
          // Lets the pane's mode select switch to bypass later; nothing
          // bypasses unless the user picks it.
          allowDangerouslySkipPermissions: true,
          abortController: abort,
          canUseTool: session.canUseTool,
          // Claude Code's own system prompt, CLAUDE.md, skills and project
          // commands — the point is a session like the one the CLI would open.
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          // With a code repo the specs live elsewhere; let Claude read them.
          ...(opts.codeRepo ? { additionalDirectories: [opts.dataRepo] } : {}),
          // The MCP servers the app asks for (AgentStartOptions.mcpServers):
          // the Confluence server while a wiki token is saved.
          ...(opts.mcpServers?.length ? { mcpServers: mcpServerConfigs(opts.mcpServers) } : {}),
          ...(resume ? { resume } : {}),
          ...(runModel ? { model: runModel } : {}),
          ...(runEffort ? { effort: runEffort } : {}),
          env: launch.env,
          ...(Object.keys(launch.extraArgs).length ? { extraArgs: launch.extraArgs } : {}),
          stderr: session.stderr,
        };
        const query = await factory()({ prompt: input, options: sdkOptions });
        askForThinking(query);
        return { query, apiBaseUrl: launch.apiBaseUrl, firstResponseMs };
      };
      session.effort = opts.effort ?? (await settings()).defaultEffort;
      if (opts.prompt || opts.images?.length) {
        session.lastMessage = userMessage(opts.prompt ?? "", opts.images);
        session.input.push(session.lastMessage);
      }
      try {
        const run = await session.launch({ input: session.input, abort: session.abort, permissionMode: opts.permissionMode });
        session.query = run.query;
        session.apiBaseUrl = run.apiBaseUrl;
        session.firstResponseMs = run.firstResponseMs;
      } catch (e) {
        session.close();
        throw e;
      }
      if (opts.prompt || opts.images?.length) session.armFirstResponse();
      void session.pump(session.query);
      void session.ready();
      return session;
    },
    /** The pane's model and effort menus: every model the sign-in offers —
        the account's, or the proxy's — else Claude Code's aliases, narrowed
        to the names the data repo lists for Claude when it lists any; and
        what a new session starts on. */
    async choices(): Promise<AgentChoices> {
      const own = await settings();
      const offered = await (options.accountModels?.() ?? Promise.resolve([])).catch(() => [] as AccountModel[]);
      const all: AgentModelOption[] =
        offered.length > 0
          ? offered.map((m) => ({
              value: m.value,
              ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
              displayName: m.displayName,
              ...(m.description ? { description: m.description } : {}),
              ...(m.efforts ? { efforts: m.efforts } : {}),
            }))
          : ALIAS_MENU;
      const models = narrowModels(all, await listedModels()).map((m) =>
        "description" in m && m.description === "" ? { value: m.value, displayName: m.displayName } : m,
      );
      const account = await options.signIn?.().catch(() => undefined);
      return { models, model: await defaultModel(own), effort: own.defaultEffort, ...(account ? { account } : {}) };
    },
    /** A pick in the pane becomes Settings → Claude's default. */
    async setDefaults(patch: AgentDefaultsPatch): Promise<void> {
      const section: Record<string, unknown> = {};
      if (patch.model !== undefined) section.defaultModel = patch.model;
      if (patch.effort !== undefined) section.defaultEffort = patch.effort;
      if (Object.keys(section).length === 0) return;
      if (!options.saveSettings) throw new AgentError(409, "Claude keeps no defaults here");
      await options.saveSettings(section);
    },
    async oneShot(req: OneShotRequest): Promise<OneShotResult> {
      const abortController = new AbortController();
      req.signal?.addEventListener("abort", () => abortController.abort(), { once: true });
      const prompt = new InputQueue<SDKUserMessage>();
      prompt.push(userMessage(req.prompt));
      prompt.close();
      const own = await settings();
      const launch = await claudeLaunch(own, req.cwd, await token());
      // A model the caller asks for, else the default Settings names, else
      // the first listed model, else Claude Code's own.
      const model = req.model ?? (await defaultModel(own));
      const timer = setTimeout(() => abortController.abort(), req.timeoutMs);
      try {
        const query = await factory()({
          prompt,
          options: {
            cwd: req.cwd,
            pathToClaudeCodeExecutable: claudeExecutable() ?? undefined,
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
            ...(model ? { model } : {}),
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

/** The app's MCP servers (AgentStartOptions.mcpServers) as the SDK's stdio server configs, by name. */
export function mcpServerConfigs(servers: AgentMcpServer[]): Record<string, McpStdioServerConfig> {
  return Object.fromEntries(
    servers.map((s) => [s.name, { type: "stdio" as const, command: s.command, args: [...s.args], env: { ...s.env } }]),
  );
}
