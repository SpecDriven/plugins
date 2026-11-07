// How full a Claude session's context window is, for the pane's session
// popover (specs/agents/claude.feature.md "Claude reports its context usage
// to the pane"): Claude Code's own /context count, from the SDK's
// getContextUsage control request, turned into the pane's slices. A Claude
// Code too old to answer it still says, with every turn, how many tokens the
// last request carried and how big the model's window is — the totals.

import type { ChatContextUsage, ContextDetail, ContextItem, ContextSlice } from "./paneContract";

/**
 * Claude Code's answer as it arrives. The SDK's published type
 * (SDKControlGetContextUsageResponse) lacks the `id` and `kind` newer Claude
 * Codes put on every category, so they are read as optional here.
 */
export interface ContextUsageAnswer {
  categories: { id?: string; name: string; tokens: number; kind?: string; isDeferred?: boolean }[];
  totalTokens: number;
  maxTokens: number;
  model?: string;
  memoryFiles?: { path: string; type: string; tokens: number }[];
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[];
  systemTools?: { name: string; tokens: number }[];
  systemPromptSections?: { name: string; tokens: number }[];
  agents?: { agentType: string; source: string; tokens: number }[];
  skills?: { skillFrontmatter?: { name: string; source: string; tokens: number }[] };
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
}

const KINDS = new Set(["used", "buffer", "free", "deferred"]);

/** A category's key: Claude Code's own id, else its name as one ("Memory files" → memory_files). */
export function categoryId(category: { id?: string; name: string }): string {
  if (category.id) return category.id;
  return category.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function kindOf(category: ContextUsageAnswer["categories"][number]): ContextSlice["kind"] {
  if (category.kind && KINDS.has(category.kind)) return category.kind as ContextSlice["kind"];
  if (category.isDeferred) return "deferred";
  if (/free space/i.test(category.name)) return "free";
  if (/buffer/i.test(category.name)) return "buffer";
  return "used";
}

/** A memory file by its name, with the folder it is in when that tells two apart. */
function memoryName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.slice(-2).join("/") : (parts[0] ?? path);
}

/** What each category is made of, by category id. */
function itemsById(answer: ContextUsageAnswer): Map<string, ContextItem[]> {
  const map = new Map<string, ContextItem[]>();
  const put = (ids: string[], items: ContextItem[] | undefined) => {
    if (!items || items.length === 0) return;
    for (const id of ids) map.set(id, items);
  };
  const tools = answer.mcpTools ?? [];
  put(
    ["mcp_tools"],
    tools.filter((t) => t.isLoaded !== false).map((t) => ({ name: t.name, detail: t.serverName, tokens: t.tokens })),
  );
  put(
    ["mcp_tools_deferred", "deferred_mcp_tools"],
    tools.filter((t) => t.isLoaded === false).map((t) => ({ name: t.name, detail: t.serverName, tokens: t.tokens })),
  );
  put(["system_tools"], answer.systemTools?.map((t) => ({ name: t.name, tokens: t.tokens })));
  put(["system_prompt"], answer.systemPromptSections?.map((s) => ({ name: s.name, tokens: s.tokens })));
  put(
    ["memory_files"],
    answer.memoryFiles?.map((f) => ({ name: memoryName(f.path), detail: f.type, tokens: f.tokens })),
  );
  put(
    ["skills"],
    answer.skills?.skillFrontmatter?.map((s) => ({ name: s.name, detail: s.source, tokens: s.tokens })),
  );
  put(
    ["custom_agents", "agents"],
    answer.agents?.map((a) => ({ name: a.agentType, detail: a.source, tokens: a.tokens })),
  );
  return map;
}

/** Claude Code's /context count as the pane shows it. */
export function contextUsageOf(answer: ContextUsageAnswer, detail: ContextDetail, at: string): ChatContextUsage {
  const items = itemsById(answer);
  const slices: ContextSlice[] = answer.categories.map((c) => {
    const id = categoryId(c);
    const kind = kindOf(c);
    const list = kind === "used" || kind === "deferred" ? items.get(id) : undefined;
    return { id, label: c.name, tokens: c.tokens, kind, ...(list ? { items: list } : {}) };
  });
  return {
    at,
    ...(answer.model ? { model: answer.model } : {}),
    totalTokens: answer.totalTokens,
    maxTokens: answer.maxTokens > 0 ? answer.maxTokens : null,
    ...(answer.isAutoCompactEnabled && answer.autoCompactThreshold ? { autoCompactAt: answer.autoCompactThreshold } : {}),
    slices,
    detail: detail === "full" ? "measured" : "estimate",
  };
}

/** A request's token usage as the Messages API reports it. */
export interface UsageLike {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
}

/** What one request put in the window: everything it read and wrote. */
export function tokensInWindow(usage: UsageLike | null | undefined): number | null {
  if (!usage) return null;
  const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens, usage.output_tokens];
  if (parts.every((n) => typeof n !== "number")) return null;
  return parts.reduce<number>((sum, n) => sum + (typeof n === "number" ? n : 0), 0);
}

/** The model's window from a turn's `modelUsage`: the model's own, else the largest named. */
export function contextWindowOf(modelUsage: unknown, model: string | null): number | null {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const entries = Object.entries(modelUsage as Record<string, { contextWindow?: unknown }>);
  const own = model ? entries.find(([name]) => name === model)?.[1]?.contextWindow : undefined;
  if (typeof own === "number" && own > 0) return own;
  const sizes = entries.map(([, u]) => u?.contextWindow).filter((n): n is number => typeof n === "number" && n > 0);
  return sizes.length ? Math.max(...sizes) : null;
}
