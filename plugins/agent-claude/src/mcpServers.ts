// The session popover's MCP servers (specs/agents/claude.feature.md "Claude
// lists its MCP servers, turns them on and off and signs in to them", in
// the specs repo): Claude Code's own answer to "which MCP servers does this
// session have, and how does each stand" — the ones the app handed it and
// the ones its settings, plugins and claude.ai account bring — in the
// pane's words. Pure: the provider asks, this file translates.

import type { ChatMcpServer, McpServerStatus } from "./paneContract";

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
  /** Its transport: `type` is "stdio", "sse", "http", "sdk" or "claudeai-proxy". */
  config?: { type?: unknown } | null;
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
