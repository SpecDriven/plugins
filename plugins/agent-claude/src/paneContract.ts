// The composer bar's contract: the app's pane (SpecDriven 0.1.223 and later)
// asks an agent for its model menu and defaults and switches a running
// session's model and effort. Declared here rather than imported from
// @specdriven/host so the plugin still type-checks against the older apps
// it runs in — they lack these types and simply never call these methods.

import type {
  AgentHost,
  AgentOutput,
  AgentProvider,
  AgentStartOptions,
  AssistantBlock,
  ChatAccount,
} from "@specdriven/host";
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
  /** The sign-in a new session would start under, for the pane header's
      API / ACNT chip before any session has said (SpecDriven 0.1.249 and
      later read it; an older app ignores it). */
  account?: ChatAccount;
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
  contextUsage?: "breakdown" | "totals";
  /** Whether the agent reports its thinking (the transcript views, below). */
  thinking?: boolean;
};

export type PaneProvider = Omit<AgentProvider, "capabilities" | "start"> & {
  capabilities: PaneCapabilities;
  start(opts: PaneStartOptions): ReturnType<AgentProvider["start"]>;
  choices(ctx: { dataRepo: string | null }): Promise<AgentChoices>;
  setDefaults(patch: AgentDefaultsPatch): Promise<void>;
};

// --- The session popover's context meter (SpecDriven 0.1.243 and later) ----
//
// The pane shows how full a session's context window is: the plugin counts
// it and hands the count to `host.context`, and answers the popover's
// Refresh through `AgentSession.contextUsage`. An older app's host has no
// `context`, so the plugin calls it as optional.

export interface ContextItem {
  name: string;
  detail?: string;
  tokens: number;
}

export interface ContextSlice {
  id: string;
  label: string;
  tokens: number;
  kind: "used" | "buffer" | "free" | "deferred";
  items?: ContextItem[];
}

export interface ChatContextUsage {
  at: string;
  model?: string;
  totalTokens: number;
  maxTokens: number | null;
  autoCompactAt?: number;
  slices?: ContextSlice[];
  detail: "estimate" | "measured";
}

export type ContextDetail = "summary" | "full";

/** The host as an app with the context meter lends it. */
export type PaneHost = AgentHost & { context?(usage: Omit<ChatContextUsage, "at"> & { at?: string }): void };

// --- The transcript views' thinking (SpecDriven after 0.1.267) -------------
//
// The pane's Thinking and Verbose transcript views show what the agent
// reasoned before it answered: the plugin passes it on as it streams
// (`thinking_delta`) and then whole, as a `thinking` block of the message it
// belongs to. A delta may also name the subagent call it streams under. An
// older app knows neither the event nor the block and ignores both, in its
// log and in its pane, so they are sent whatever the app.

/** What Claude thought, whole: one block of an assistant message. */
export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

/** A block as the plugin sends it: the app's own, or thinking. */
export type PaneBlock = AssistantBlock | ThinkingBlock;

/** What the plugin puts in a session's log: the app's own events, with the
    thinking an app from before the transcript views has no type for. */
export type PaneOutput =
  | Exclude<AgentOutput, { kind: "assistant" | "text_delta" }>
  | { kind: "text_delta"; messageId: string; index: number; text: string; parentToolUseId?: string | null }
  | { kind: "thinking_delta"; messageId: string; index: number; text: string; parentToolUseId?: string | null }
  | { kind: "assistant"; messageId: string; turn: number; blocks: PaneBlock[]; parentToolUseId: string | null };
