// What the app's pane hands an agent that newer apps added: pasted images
// (SpecDriven 0.1.230 and later) and MCP servers (0.1.237 and later).
// Declared here rather than imported from @specdriven/host so the plugin
// still type-checks against the older apps it runs in — they lack these
// types and simply never pass them.

import type { AgentHost, AgentProvider, AgentStartOptions, ChatAccount } from "@specdriven/host";

// The composer bar's contract (SpecDriven 0.1.223 and later): the pane asks
// an agent for its model menu and the model a new session starts on, and
// switches a running session's model.

export interface AgentModelOption {
  value: string;
  displayName: string;
  description?: string;
}

export interface AgentChoices {
  models: AgentModelOption[];
  model: string | null;
  /** Codex's reasoning effort is not the pane's to pick. */
  effort: null;
  /** The sign-in a new session would start under, for the pane header's
      account chip before any session has said (SpecDriven 0.1.249 and
      later read it; an older app ignores it). */
  account?: ChatAccount;
}

export interface AgentDefaultsPatch {
  model?: string | null;
  effort?: unknown;
}

/** An image pasted into the pane's message: its bytes, base64, and the
    copy the app keeps on disk. */
export interface PastedImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  path: string;
}

/** An MCP server the app hands every session (SpecDriven 0.1.237 and later;
    the Confluence server while a wiki token is saved), run over stdio. */
export interface AgentMcpServer {
  /** The server's name as the agent lists its tools (`mcp__<name>__<tool>`). */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type PaneStartOptions = AgentStartOptions & { model?: string; images?: PastedImage[]; mcpServers?: AgentMcpServer[] };

export type PaneProvider = Omit<AgentProvider, "capabilities" | "start"> & {
  capabilities: AgentProvider["capabilities"] & {
    canChangeModelMidSession?: boolean;
    images?: boolean;
    contextUsage?: "breakdown" | "totals";
  };
  start(opts: PaneStartOptions): ReturnType<AgentProvider["start"]>;
  choices?(ctx: { dataRepo: string | null }): Promise<AgentChoices>;
  setDefaults?(patch: AgentDefaultsPatch): Promise<void>;
  /** Every model the sign-in offers, for the app's check of the data
      repo's list; null when it cannot say. */
  reportedModels?(): Promise<string[] | null>;
};

/** How full a session's context window is, for the pane's session popover
    (SpecDriven 0.1.243 and later): Codex says the count and the window's
    size, not what fills it. An older app's host has no `context`. */
export interface ChatContextUsage {
  at?: string;
  model?: string;
  totalTokens: number;
  maxTokens: number | null;
  detail: "estimate" | "measured";
}

export type PaneHost = AgentHost & { context?(usage: ChatContextUsage): void };
