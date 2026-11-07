// The composer bar's contract: the app's pane (SpecDriven 0.1.223 and later)
// asks an agent for its model menu and defaults and switches a running
// session's model and effort. Declared here rather than imported from
// @specdriven/host so the plugin still type-checks against the older apps
// it runs in — they lack these types and simply never call these methods.

import type { AgentProvider, AgentStartOptions } from "@specdriven/host";
import type { ClaudeEffort } from "./settings";

export interface AgentModelOption {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  efforts?: ClaudeEffort[];
}

export interface AgentChoices {
  models: AgentModelOption[];
  model: string | null;
  effort: ClaudeEffort | null;
}

export interface AgentDefaultsPatch {
  model?: string | null;
  effort?: ClaudeEffort | null;
}

/** An image pasted into the pane's message (SpecDriven 0.1.230 and later):
    its bytes, base64, and the copy the app keeps on disk. */
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

export type PaneStartOptions = AgentStartOptions & {
  model?: string;
  effort?: ClaudeEffort;
  images?: PastedImage[];
  mcpServers?: AgentMcpServer[];
};

export type PaneCapabilities = AgentProvider["capabilities"] & {
  canChangeModelMidSession?: boolean;
  effort?: boolean;
  images?: boolean;
};

export type PaneProvider = Omit<AgentProvider, "capabilities" | "start"> & {
  capabilities: PaneCapabilities;
  start(opts: PaneStartOptions): ReturnType<AgentProvider["start"]>;
  choices(ctx: { dataRepo: string | null }): Promise<AgentChoices>;
  setDefaults(patch: AgentDefaultsPatch): Promise<void>;
};
