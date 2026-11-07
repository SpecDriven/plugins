// What the app's pane hands an agent that newer apps added: pasted images
// (SpecDriven 0.1.230 and later). Declared here rather than imported from
// @specdriven/host so the plugin still type-checks against the older apps
// it runs in — they lack these types and simply never pass images.

import type { AgentHost, AgentProvider, AgentStartOptions } from "@specdriven/host";

/** An image pasted into the pane's message: its bytes, base64, and the
    copy the app keeps on disk. */
export interface PastedImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  path: string;
}

export type PaneStartOptions = AgentStartOptions & { images?: PastedImage[] };

export type PaneProvider = Omit<AgentProvider, "capabilities" | "start"> & {
  capabilities: AgentProvider["capabilities"] & { images?: boolean; contextUsage?: "breakdown" | "totals" };
  start(opts: PaneStartOptions): ReturnType<AgentProvider["start"]>;
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
