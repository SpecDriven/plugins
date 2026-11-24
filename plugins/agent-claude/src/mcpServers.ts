// The session popover's MCP servers (specs/agents/claude.feature.md "Claude
// lists its MCP servers, turns them on and off and signs in to them", in
// the specs repo): Claude Code's own answer to "which MCP servers does this
// session have, and how does each stand" — the ones the app handed it and
// the ones its settings, plugins and claude.ai account bring — in the
// pane's words. Pure: the provider asks, this file translates.

import { AgentError } from "@specdriven/host";
import type {
  ChatMcpServer,
  McpScope,
  McpServerDetail,
  McpServerStatus,
  McpSignIn,
  McpToolInfo,
} from "./paneContract";

/**
 * What Claude Code says of one MCP server (the SDK's McpServerStatus), as
 * far as the list needs it. Loosely typed on purpose: a newer Claude Code
 * may add a status or a scope, and the list should still show the server.
 */
export interface McpStatusAnswer {
  name?: unknown;
  /** "connected" | "failed" | "needs-auth" | "pending" | "disabled". */
  status?: unknown;
  /** Why it failed. */
  error?: unknown;
  /** Where it is configured: "project", "user", "local", "claudeai", "managed", … */
  scope?: unknown;
  /** Its transport — `type` is "stdio", "sse", "http", "sdk" or
      "claudeai-proxy" — and how it is reached. Claude Code gives a url
      server's headers with their values; a command's environment not at all. */
  config?: {
    type?: unknown;
    command?: unknown;
    args?: unknown;
    env?: unknown;
    url?: unknown;
    headers?: unknown;
  } | null;
  /** What the server calls itself, once connected. */
  serverInfo?: { name?: unknown; version?: unknown } | null;
  /** Its tools, once connected: `{ name, description? }` each. */
  tools?: unknown;
}

/** What Claude Code answers when a sign-in is started (the `mcp_authenticate` control request). */
export interface McpAuthAnswer {
  /** The page to sign in on; absent when the stored sign-in still holds. */
  authUrl?: unknown;
  /** Whether the user has something to do in the browser. */
  requiresUserAction?: unknown;
}

const STATUS: Readonly<Record<string, McpServerStatus>> = {
  connected: "connected",
  failed: "failed",
  "needs-auth": "needs-auth",
  pending: "connecting",
  disabled: "disabled",
};

/** Claude Code's scope names, where the pane has better words. */
const SOURCE: Readonly<Record<string, string>> = { claudeai: "claude.ai" };

/** Transports a browser sign-in cannot apply to: a local command, an in-process server. */
const NO_SIGN_IN = new Set(["stdio", "sdk"]);

/**
 * Claude Code's MCP servers as the popover lists them, in Claude Code's
 * order. `fromApp` names the servers the app handed the session
 * (AgentStartOptions.mcpServers): their source is "SpecDriven", whatever
 * Claude Code calls a server given on the command line. A status this
 * plugin does not know is shown as failed with the status as the reason,
 * rather than dropped.
 */
export function mcpServersOf(answer: readonly McpStatusAnswer[], fromApp: ReadonlySet<string> = new Set()): ChatMcpServer[] {
  const servers: ChatMcpServer[] = [];
  for (const raw of answer) {
    if (!raw || typeof raw.name !== "string" || !raw.name) continue;
    const said = typeof raw.status === "string" ? raw.status : "";
    const status = STATUS[said] ?? "failed";
    const scope = typeof raw.scope === "string" && raw.scope ? raw.scope : undefined;
    const source = fromApp.has(raw.name) ? "SpecDriven" : scope ? (SOURCE[scope] ?? scope) : undefined;
    const error =
      status !== "failed"
        ? undefined
        : typeof raw.error === "string" && raw.error
          ? raw.error
          : STATUS[said]
            ? undefined
            : `Claude Code reports the status "${said}"`;
    const transport = typeof raw.config?.type === "string" ? raw.config.type : undefined;
    servers.push({
      name: raw.name,
      status,
      ...(source ? { source } : {}),
      ...(error ? { error } : {}),
      ...(status === "connected" && Array.isArray(raw.tools) ? { tools: raw.tools.length } : {}),
      canToggle: true,
      canAuthenticate: status === "needs-auth" && !(transport !== undefined && NO_SIGN_IN.has(transport)),
    });
  }
  return servers;
}

/** The page to open for a sign-in Claude Code started; none when nothing is left for the user to do. */
export function signInPage(answer: McpAuthAnswer | null | undefined): { url?: string } {
  if (!answer || answer.requiresUserAction === false) return {};
  const url = typeof answer.authUrl === "string" ? answer.authUrl : "";
  return /^https?:\/\//i.test(url) ? { url } : {};
}

/** Whether a failure is Claude Code not knowing the request at all (an older binary). */
export function isUnsupportedRequest(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /unsupported control request|is not supported in this context/i.test(text);
}

// --- What the session and the "MCP servers…" dialog both ask of Claude Code ----

/** The MCP side of a Claude Code run (the provider's QueryLike has it). */
export interface McpQuery {
  mcpServerStatus?(): Promise<unknown[]>;
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<void>;
  reconnectMcpServer?(serverName: string): Promise<void>;
  mcpAuthenticate?(serverName: string, redirectUri?: string): Promise<unknown>;
}

/** How every MCP server of the run stands, as Claude Code says it. */
export async function mcpStatus(query: McpQuery): Promise<McpStatusAnswer[]> {
  if (!query.mcpServerStatus) throw new AgentError(409, "This Claude Code does not list its MCP servers");
  return (await query.mcpServerStatus()) as McpStatusAnswer[];
}

export async function setMcpEnabled(query: McpQuery, name: string, enabled: boolean): Promise<void> {
  if (!query.toggleMcpServer) throw new AgentError(409, "This Claude Code cannot turn MCP servers on or off");
  await query.toggleMcpServer(name, enabled);
}

export async function reconnectMcp(query: McpQuery, name: string): Promise<void> {
  if (!query.reconnectMcpServer) throw new AgentError(409, "This Claude Code cannot reconnect MCP servers");
  await query.reconnectMcpServer(name);
}

/**
 * Start a server's sign-in: Claude Code answers with the page to sign in
 * on and waits on localhost for the browser to come back, then connects
 * the server by itself — the list shows it. A Claude Code that does not
 * know the request says so in words that name the way round it.
 */
export async function authenticateMcp(query: McpQuery, name: string): Promise<McpSignIn> {
  const unsupported = () =>
    new AgentError(409, `This Claude Code cannot start an MCP sign-in from here; run \`claude\` in a terminal and sign in to "${name}" with /mcp`);
  if (!query.mcpAuthenticate) throw unsupported();
  try {
    return signInPage((await query.mcpAuthenticate(name)) as McpAuthAnswer);
  } catch (e) {
    if (isUnsupportedRequest(e)) throw unsupported();
    throw e;
  }
}

// --- The "MCP servers…" dialog's details ------------------------------------------
//
// specs/agents/claude.feature.md "Claude manages its MCP servers before a
// session": everything Claude Code says of a server, and what its tools take
// of the context window (Claude Code's /context count, src/contextUsage.ts).

/** The scopes `claude mcp add` and `remove` take: a server kept in one of them can be deleted. */
const DELETABLE: ReadonlySet<string> = new Set<McpScope>(["local", "user", "project"]);

/** What Claude Code's context count says of the MCP tools, as far as the details need it. */
export interface McpToolCost {
  /** The tool's full name, `mcp__<server>__<tool>`. */
  name?: unknown;
  serverName?: unknown;
  tokens?: unknown;
  /** False for a tool Claude Code loads only when it looks for it. */
  isLoaded?: unknown;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

const namesOf = (value: unknown): string[] =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : [];

/** A server's name as it stands inside its tools' names. */
const toolKey = (server: string) => server.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * A server's tools with what each costs. The names are the server's own;
 * a cost is found by the tool's full name, which ends in the tool's — the
 * longest that fits, so `read` never takes the cost of `page_read`. A tool
 * only the count knows is listed too, under its name without the server.
 */
function toolsOf(server: string, tools: unknown, costs: readonly McpToolCost[]): McpToolInfo[] {
  const list: McpToolInfo[] = [];
  const byName = new Map<string, McpToolInfo>();
  for (const raw of Array.isArray(tools) ? (tools as { name?: unknown; description?: unknown }[]) : []) {
    if (!raw || typeof raw.name !== "string" || !raw.name || byName.has(raw.name)) continue;
    const tool: McpToolInfo = {
      name: raw.name,
      ...(typeof raw.description === "string" && raw.description ? { description: raw.description } : {}),
    };
    byName.set(raw.name, tool);
    list.push(tool);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const prefix = `mcp__${toolKey(server)}__`;
  for (const cost of costs) {
    if (cost.serverName !== server || typeof cost.name !== "string" || typeof cost.tokens !== "number") continue;
    const full = cost.name;
    const own = names.find((n) => full === n || full.endsWith(`__${n}`));
    let tool = own ? byName.get(own)! : undefined;
    if (!tool) {
      tool = { name: full.startsWith(prefix) ? full.slice(prefix.length) : full };
      byName.set(tool.name, tool);
      list.push(tool);
    }
    tool.tokens = cost.tokens;
    tool.loaded = cost.isLoaded !== false;
  }
  return list;
}

/**
 * Claude Code's MCP servers as the dialog shows them: the popover's row
 * (mcpServersOf), and where each is kept, how it is reached, what it calls
 * itself and what its tools cost. `costs` is the context count's `mcpTools`;
 * without it — an older Claude Code — the tools are listed with no cost.
 * A header's or an environment variable's value never leaves this function.
 */
export function mcpDetailsOf(
  answer: readonly McpStatusAnswer[],
  fromApp: ReadonlySet<string> = new Set(),
  costs: readonly McpToolCost[] | null = null,
): McpServerDetail[] {
  const rows = mcpServersOf(answer, fromApp);
  const byName = new Map(answer.filter((raw) => raw && typeof raw.name === "string").map((raw) => [raw.name as string, raw]));
  return rows.map((row) => {
    const raw = byName.get(row.name)!;
    const config = raw.config ?? {};
    const said = typeof raw.scope === "string" ? raw.scope : "";
    // A server the app handed over is given on the command line, whatever
    // scope Claude Code names for it: nothing a `claude mcp remove` reaches.
    const scope = !fromApp.has(row.name) && DELETABLE.has(said) ? (said as McpScope) : undefined;
    const args = strings(config.args);
    const envNames = namesOf(config.env);
    const headerNames = namesOf(config.headers);
    const toolList = row.status === "connected" ? toolsOf(row.name, raw.tools, costs ?? []) : [];
    const cost = (loaded: boolean) => toolList.filter((t) => t.loaded === loaded).reduce((n, t) => n + (t.tokens ?? 0), 0);
    return {
      ...row,
      ...(scope ? { scope } : {}),
      ...(typeof config.type === "string" && config.type ? { transport: config.type } : {}),
      ...(typeof config.command === "string" && config.command ? { command: config.command } : {}),
      ...(args.length ? { args } : {}),
      ...(typeof config.url === "string" && config.url ? { url: config.url } : {}),
      ...(envNames.length ? { envNames } : {}),
      ...(headerNames.length ? { headerNames } : {}),
      ...(typeof raw.serverInfo?.name === "string" && raw.serverInfo.name ? { serverName: raw.serverInfo.name } : {}),
      ...(typeof raw.serverInfo?.version === "string" && raw.serverInfo.version ? { version: raw.serverInfo.version } : {}),
      ...(row.status === "connected" ? { tools: toolList.length, toolList } : {}),
      ...(row.status === "connected" && costs ? { context: { loaded: cost(true), deferred: cost(false) } } : {}),
      canDelete: scope !== undefined,
    };
  });
}
