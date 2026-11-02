// The models the data repo lists for Claude (specs/agents/agent-plugins.feature.md
// "Each agent offers the models the data repo lists", in the specs repo):
// Settings → AI agents keeps one list per agent in the data repo's
// `.specdriven/agent-models.json`, and with no default model in Settings a
// new Claude starts on the first of Claude's — the one Settings → Claude
// shows chosen.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeDefaultModel } from "./settings";

/** The app's file of each agent's models, in the data repo. */
export const AGENT_MODELS_FILE = ".specdriven/agent-models.json";

/** Claude's list, in order; none without a data repo, a file or a list. */
export async function listedClaudeModels(dataDir: string | null): Promise<string[]> {
  if (!dataDir) return [];
  try {
    const file = JSON.parse(await readFile(join(dataDir, AGENT_MODELS_FILE), "utf8")) as { claude?: unknown } | null;
    const list = file?.claude;
    if (!Array.isArray(list)) return [];
    return list.map(normalizeDefaultModel).filter((m): m is string => m !== null);
  } catch {
    return [];
  }
}
