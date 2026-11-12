// What the plugin changes of OpenCode's configuration, for its own process
// only: OpenCode reads extra config as JSON from OPENCODE_CONFIG_CONTENT,
// over the user's files, so the user's opencode.json is never written.
//
// OpenCode's own default is to run edits and shell commands without
// asking. The pane's permission modes need it to ask, so a session's
// process turns "allow" into "ask" for edits, commands and web fetches, and
// the plugin answers each request itself where the mode says so (bypass:
// every one; accept edits: the edits), raising a card for the rest. That
// keeps a mode change instant — the process never restarts.
//
// Only "allow" changes. OpenCode's permissions are an ordered list of
// rules per agent — { action, resource, effect }, the last match winning —
// and what this config adds lands last. A blanket "ask" there would undo
// every "deny" before it: the user's own (`"git push*": "deny"`) and the
// Plan agent's on edits. So the plugin first asks OpenCode for each agent's
// resolved rules (`opencode debug agents`), and writes them back per agent
// with allow → ask and everything else as it was (checked against OpenCode
// 2.2.7 on 2026-11-12). When OpenCode cannot list them, the blanket "ask"
// is what is left.

import { run } from "@specdriven/host";
import { opencodePath } from "./cli";

/** What a pane session asks for: the config's permission key, and the action OpenCode's rules name it by. */
export const ASKED: readonly { key: string; action: string }[] = [
  { key: "edit", action: "edit" },
  { key: "bash", action: "shell" },
  { key: "webfetch", action: "webfetch" },
];

/** One of an agent's resolved permission rules. */
export interface AgentRule {
  action: string;
  resource: string;
  effect: string;
}

/** An agent as `opencode debug agents` lists it: its id and its rules, in order. */
export interface ResolvedAgent {
  id: string;
  rules: AgentRule[];
}

export type AgentRulesReader = (cwd: string, env: Record<string, string | undefined>) => Promise<ResolvedAgent[] | null>;

/** `opencode debug agents` output → the agents and their rules; null when it is not that. */
export function parseResolvedAgents(stdout: string): ResolvedAgent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const agents: ResolvedAgent[] = [];
  for (const entry of parsed) {
    const a = entry as { id?: unknown; permissions?: unknown } | null;
    if (!a || typeof a.id !== "string" || !Array.isArray(a.permissions)) continue;
    const rules: AgentRule[] = [];
    for (const rule of a.permissions) {
      const r = rule as Partial<AgentRule> | null;
      if (r && typeof r.action === "string" && typeof r.resource === "string" && typeof r.effect === "string") {
        rules.push({ action: r.action, resource: r.resource, effect: r.effect });
      }
    }
    agents.push({ id: a.id, rules });
  }
  return agents.length > 0 ? agents : null;
}

/** The agents' rules as OpenCode resolves them in `cwd` (a private server: no background service is left). */
const readWithCli: AgentRulesReader = async (cwd, env) => {
  const res = await run(opencodePath(), ["debug", "agents", "--standalone"], { cwd, env });
  return res.exitCode === 0 ? parseResolvedAgents(res.stdout) : null;
};

let reader: AgentRulesReader | null = null;

/** Swap how the agents' rules are read (tests); null restores `opencode debug agents`. */
export function setAgentRulesReader(fn: AgentRulesReader | null): AgentRulesReader | null {
  const previous = reader;
  reader = fn;
  return previous;
}

export function resolvedAgents(cwd: string, env: Record<string, string | undefined> = process.env): Promise<ResolvedAgent[] | null> {
  return (reader ?? readWithCli)(cwd, env).catch(() => null);
}

/**
 * An agent's rules for one action, as the config's ordered `{ pattern:
 * effect }`: "ask" for anything, then each of its rules for the action (or
 * for every action) in order, an "allow" become "ask". The last match wins
 * in OpenCode, so a pattern stated again moves to where it was stated last.
 */
export function askingRules(rules: readonly AgentRule[], action: string): Record<string, string> {
  const out: Record<string, string> = { "*": "ask" };
  for (const rule of rules) {
    if (rule.action !== action && rule.action !== "*") continue;
    delete out[rule.resource];
    out[rule.resource] = rule.effect === "allow" ? "ask" : rule.effect;
  }
  return out;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/**
 * The OPENCODE_CONFIG_CONTENT for a pane session: the one the environment
 * already has, if it is a JSON object, with the asked permissions set to
 * "ask" (one it sets to "deny" stands), and — when OpenCode listed its
 * agents — each agent's own rules for them, allow turned to ask.
 */
export function sessionConfigContent(existing: string | undefined, agents: readonly ResolvedAgent[] | null = null): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      base = object(JSON.parse(existing));
    } catch {
      // Not JSON: OpenCode would refuse it anyway; ours replaces it.
    }
  }
  const permission = object(base.permission);
  for (const { key } of ASKED) {
    if (permission[key] !== "deny") permission[key] = "ask";
  }
  const config: Record<string, unknown> = { ...base, permission };
  if (agents) {
    const agent = object(base.agent);
    for (const { id, rules } of agents) {
      const own = object(agent[id]);
      const ownPermission = object(own.permission);
      for (const { key, action } of ASKED) ownPermission[key] = askingRules(rules, action);
      agent[id] = { ...own, permission: ownPermission };
    }
    config.agent = agent;
  }
  return JSON.stringify(config);
}

/** The environment a pane session's `opencode acp` runs in, in `cwd`. */
export async function sessionEnv(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string | undefined>> {
  const agents = await resolvedAgents(cwd, env);
  return { ...env, OPENCODE_CONFIG_CONTENT: sessionConfigContent(env.OPENCODE_CONFIG_CONTENT, agents) };
}
