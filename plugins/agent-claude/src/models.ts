// The models the data repo allows for Claude (specs/agents/agent-plugins.feature.md
// "Each agent offers the models the data repo lists", in the specs repo):
// Settings → AI agents keeps one file per agent in the data repo's
// `.specdriven/` — Claude's is `claude-models.json`, a JSON list — which
// narrows every model menu to the names it lists (src/modelMenu.ts). Before
// the app split the lists,
// they shared `.specdriven/agent-models.json`, keyed by agent id; a data
// repo the app has not opened since is still read from there.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountModel } from "./accountModels";
import { normalizeDefaultModel } from "./settings";

/** Claude's file of models, in the data repo. */
export const CLAUDE_MODELS_FILE = ".specdriven/claude-models.json";

/** The app's old file of every agent's models, in the data repo. */
export const AGENT_MODELS_FILE = ".specdriven/agent-models.json";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Claude's list, in order; none without a data repo, a file or a list. */
export async function listedClaudeModels(dataDir: string | null): Promise<string[]> {
  if (!dataDir) return [];
  let list: unknown;
  try {
    list = await readJson(join(dataDir, CLAUDE_MODELS_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return [];
    try {
      list = ((await readJson(join(dataDir, AGENT_MODELS_FILE))) as { claude?: unknown } | null)?.claude;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map(normalizeDefaultModel).filter((m): m is string => m !== null);
}

/**
 * The provider with `reportedModels()`: every value and id the sign-in
 * offers — the signed-in account's models, or a proxy's GET /v1/models —
 * what the app checks the data repo's list for Claude against, logging a
 * warning for a listed model not among them; null when the sign-in offers
 * none (signed out, a proxy that lists none), so nothing is checked. An app
 * from before the hook ignores it.
 */
export function withReportedModels<P extends object>(
  provider: P,
  offered: () => Promise<AccountModel[]>,
): P & { reportedModels(): Promise<string[] | null> } {
  return Object.assign(provider, {
    async reportedModels(): Promise<string[] | null> {
      const models = await offered().catch(() => [] as AccountModel[]);
      if (models.length === 0) return null;
      const names = new Set<string>();
      for (const m of models) {
        names.add(m.value);
        if (m.resolvedModel) names.add(m.resolvedModel);
      }
      return [...names];
    },
  });
}
