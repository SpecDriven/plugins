// What the app's pane hands an agent that newer apps added: pasted images
// (SpecDriven 0.1.230 and later) and MCP servers (0.1.237 and later).
// Declared here rather than imported from @specdriven/host so the plugin
// still type-checks against the older apps it runs in — they lack these
// types and simply never pass them.

import type { AgentProvider, AgentStartOptions } from "@specdriven/host";

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

export type PaneStartOptions = AgentStartOptions & { images?: PastedImage[]; mcpServers?: AgentMcpServer[] };

export type PaneProvider = Omit<AgentProvider, "capabilities" | "start"> & {
  capabilities: AgentProvider["capabilities"] & { images?: boolean };
  start(opts: PaneStartOptions): ReturnType<AgentProvider["start"]>;
};
