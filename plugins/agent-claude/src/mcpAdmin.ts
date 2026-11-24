// Claude's MCP servers before a session (specs/agents/claude.feature.md
// "Claude manages its MCP servers before a session"; the app's side is
// specs/agents/agent-pane.feature.md "MCP servers before a session"): the
// pane's "MCP servers…" dialog lists the servers a session started in a
// folder would get, turns them on and off, signs in to them, adds one and
// deletes one — with no session running.
//
// Claude Code is the one that knows: which servers its settings, the
// repo's .mcp.json, its plugins and the claude.ai account bring, how each
// stands, and what their tools take of the context window. So a Claude Code
// is started for the dialog alone, in the folder, with the settings a
// session would load and the servers the app would hand it — and with no
// prompt: it sends nothing to the API (src/accountModels.ts does the same
// for the model menu). It stays up while the dialog is open, because a
// sign-in comes back to it on localhost, and is stopped when the dialog
// shuts, after a few idle minutes, and when the sign-in changes.
//
// Adding and deleting is Claude Code's own `claude mcp add-json` and
// `claude mcp remove`: they write where Claude Code reads. The server's
// definition goes in on stdin, so what it holds — a token in a header, a
// key in the environment — is never on a command line.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentError, run } from "@specdriven/host";
import type { RunOptions, RunResult } from "@specdriven/host";
import { claudeLaunch } from "./auth";
import { claudeExecutable } from "./cli";
import {
  authenticateMcp,
  mcpDetailsOf,
  mcpStatus,
  reconnectMcp,
  setMcpEnabled,
  type McpToolCost,
} from "./mcpServers";
import type {
  AgentMcpAdmin,
  AgentMcpContext,
  AgentMcpList,
  McpManageCapability,
  McpScope,
  McpServerAction,
  McpServerDraft,
  McpSignIn,
} from "./paneContract";
import { InputQueue, currentQueryFactory, mcpServerConfigs, type QueryFactory, type QueryLike } from "./provider";
import type { ClaudeSettingsValues } from "./settings";

/** Where Claude Code keeps an MCP server, and the kinds `claude mcp add-json` takes from the form. */
export const CLAUDE_MCP_MANAGE: McpManageCapability = {
  scopes: ["local", "user", "project"],
  transports: ["stdio", "http", "sse"],
};

/** How long Claude Code gets to start and answer one question. */
export const MCP_ANSWER_TIMEOUT_MS = 20_000;

/** How long the dialog's Claude Code stays up with nobody asking. */
export const MCP_IDLE_MS = 5 * 60_000;

/** How long `claude mcp add-json` or `remove` gets. */
export const MCP_COMMAND_TIMEOUT_MS = 30_000;

export type McpRunner = (cmd: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export interface McpAdminDeps {
  settings: () => Promise<ClaudeSettingsValues>;
  /** The proxy token the plugin's secret store holds. */
  token: () => Promise<string | null>;
  /** Default: the injected factory, else the SDK. */
  query?: QueryFactory;
  /** Default: the app's process runner. */
  run?: McpRunner;
  /** Default: the Claude Code the sessions run (src/cli.ts). */
  executable?: () => string | null;
  idleMs?: number;
  answerTimeoutMs?: number;
}

/** A server's definition as `claude mcp add-json` takes it. */
export function mcpJsonOf(draft: McpServerDraft): Record<string, unknown> {
  if (draft.transport === "stdio") {
    return {
      type: "stdio",
      command: draft.command ?? "",
      args: [...(draft.args ?? [])],
      ...(draft.env && Object.keys(draft.env).length ? { env: { ...draft.env } } : {}),
    };
  }
  return {
    type: draft.transport,
    url: draft.url ?? "",
    ...(draft.headers && Object.keys(draft.headers).length ? { headers: { ...draft.headers } } : {}),
  };
}

/** What Claude Code said when it refused: its own words, the last lines of them. */
export function mcpCommandError(result: RunResult, what: string): string {
  if (result.timedOut) return `Claude Code did not ${what} in time`;
  const said = (result.stderr.trim() || result.stdout.trim()).split("\n").map((l) => l.trim()).filter(Boolean);
  return said.length ? said.slice(0, 6).join(" ") : `Claude Code could not ${what} (exit ${result.exitCode})`;
}

/** The dialog's Claude Code for one folder. */
interface Standby {
  /** The folder and the servers the app hands over: another answer needs another run. */
  key: string;
  query: QueryLike;
  fromApp: ReadonlySet<string>;
  stop(): void;
  idle?: ReturnType<typeof setTimeout>;
}

export interface ClaudeMcpAdmin extends AgentMcpAdmin {
  /** Stop every Claude Code kept for a dialog: the sign-in changed, or the plugin is going. */
  forget(): void;
  /** For the tests: the folders a Claude Code is kept for. */
  standing(): string[];
}

export function createMcpAdmin(deps: McpAdminDeps): ClaudeMcpAdmin {
  const factory = () => deps.query ?? currentQueryFactory();
  const runner = deps.run ?? run;
  const executable = deps.executable ?? claudeExecutable;
  const idleMs = deps.idleMs ?? MCP_IDLE_MS;
  const answerMs = deps.answerTimeoutMs ?? MCP_ANSWER_TIMEOUT_MS;
  /** By folder; a start under way is shared by everyone who asks meanwhile. */
  const standbys = new Map<string, { starting: Promise<Standby>; up?: Standby }>();

  const keyOf = (ctx: AgentMcpContext) => JSON.stringify([ctx.cwd, (ctx.mcpServers ?? []).map((s) => [s.name, s.command, s.args])]);

  const drop = (cwd: string) => {
    const standing = standbys.get(cwd);
    if (!standing) return;
    standbys.delete(cwd);
    // One that is up stops now; one still starting, as soon as it is.
    if (standing.up) standing.up.stop();
    else
      void standing.starting.then(
        (s) => s.stop(),
        () => undefined,
      );
  };

  const start = async (ctx: AgentMcpContext): Promise<Standby> => {
    const exe = executable();
    const launch = await claudeLaunch(await deps.settings(), ctx.cwd, await deps.token());
    const abortController = new AbortController();
    // No prompt ever comes: the run only starts, answers and is stopped.
    const prompt = new InputQueue<SDKUserMessage>();
    const query = await factory()({
      prompt,
      options: {
        cwd: ctx.cwd,
        pathToClaudeCodeExecutable: exe ?? undefined,
        // What a session loads (src/provider.ts): the user's, the repo's and
        // the folder's settings, and the servers the app hands over — so the
        // list is the one a session started here would get.
        settingSources: ["user", "project", "local"],
        ...(ctx.mcpServers?.length ? { mcpServers: mcpServerConfigs(ctx.mcpServers) } : {}),
        persistSession: false,
        abortController,
        env: launch.env,
        ...(Object.keys(launch.extraArgs).length ? { extraArgs: launch.extraArgs } : {}),
      },
    });
    const standby: Standby = {
      key: keyOf(ctx),
      query,
      fromApp: new Set((ctx.mcpServers ?? []).map((s) => s.name)),
      stop() {
        clearTimeout(standby.idle);
        prompt.close();
        abortController.abort();
      },
    };
    return standby;
  };

  /** The folder's Claude Code, started when there is none (or one for other servers); asking keeps it up. */
  const standbyFor = async (ctx: AgentMcpContext): Promise<Standby> => {
    let standing = standbys.get(ctx.cwd);
    if (standing) {
      const known = await standing.starting.catch(() => null);
      if (!known || known.key !== keyOf(ctx)) {
        if (standbys.get(ctx.cwd) === standing) drop(ctx.cwd);
        standing = standbys.get(ctx.cwd);
      }
    }
    if (!standing) {
      const mine: { starting: Promise<Standby>; up?: Standby } = { starting: start(ctx) };
      standing = mine;
      standbys.set(ctx.cwd, mine);
      mine.starting.then(
        (standby) => {
          mine.up = standby;
        },
        // A start that failed is not kept: the next ask tries again.
        () => {
          if (standbys.get(ctx.cwd) === mine) standbys.delete(ctx.cwd);
        },
      );
    }
    const standby = await standing.starting;
    clearTimeout(standby.idle);
    standby.idle = setTimeout(() => drop(ctx.cwd), idleMs);
    // Nothing waits on the timer: the app may exit with a dialog's Claude Code up.
    (standby.idle as { unref?: () => void }).unref?.();
    return standby;
  };

  /** One question to the folder's Claude Code. One that does not answer, or
      that died, is stopped, so the next ask starts afresh. */
  const ask = async <T>(ctx: AgentMcpContext, what: string, question: (standby: Standby) => Promise<T>): Promise<T> => {
    const standby = await standbyFor(ctx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AgentError(504, `Claude Code did not ${what} in time`)), answerMs);
    });
    try {
      return await Promise.race([question(standby), timeout]);
    } catch (e) {
      // A refusal is an answer; anything else may be a run that is gone.
      if (!(e instanceof AgentError) || e.status === 504) drop(ctx.cwd);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  /** Run `claude mcp …` in the folder, signed in as a session would be. */
  const claudeMcp = async (ctx: AgentMcpContext, args: string[], what: string, input?: string): Promise<void> => {
    const exe = executable();
    if (!exe) throw new AgentError(502, "Claude Code is not installed");
    const launch = await claudeLaunch(await deps.settings(), ctx.cwd, await deps.token());
    const result = await runner(exe, ["mcp", ...args], {
      cwd: ctx.cwd,
      env: launch.env,
      timeoutMs: MCP_COMMAND_TIMEOUT_MS,
      label: "claude mcp",
      ...(input === undefined ? {} : { input }),
    });
    if (result.exitCode !== 0) throw new AgentError(409, mcpCommandError(result, what));
    // A running Claude Code does not see the change: the next list starts another.
    drop(ctx.cwd);
  };

  return {
    list(ctx: AgentMcpContext): Promise<AgentMcpList> {
      return ask(ctx, "list its MCP servers", async ({ query, fromApp }) => {
        const status = await mcpStatus(query);
        // What the tools cost is Claude Code's own /context count; one too
        // old to give it still lists the servers.
        const usage = query.getContextUsage
          ? ((await query.getContextUsage({ detail: "summary" }).catch(() => null)) as { mcpTools?: McpToolCost[]; maxTokens?: unknown } | null)
          : null;
        const costs = usage && Array.isArray(usage.mcpTools) ? usage.mcpTools : null;
        return {
          servers: mcpDetailsOf(status, fromApp, costs),
          ...(usage && typeof usage.maxTokens === "number" && usage.maxTokens > 0 ? { contextWindow: usage.maxTokens } : {}),
        };
      });
    },

    act(ctx: AgentMcpContext, name: string, action: McpServerAction): Promise<McpSignIn | void> {
      return ask(ctx, `${action} "${name}"`, async ({ query }) => {
        if (action === "enable" || action === "disable") return setMcpEnabled(query, name, action === "enable");
        if (action === "reconnect") return reconnectMcp(query, name);
        return authenticateMcp(query, name);
      });
    },

    /** `claude mcp add-json --scope <scope> -- <name> -`, the definition on stdin. */
    add(ctx: AgentMcpContext, draft: McpServerDraft): Promise<void> {
      return claudeMcp(
        ctx,
        ["add-json", "--scope", draft.scope, "--", draft.name, "-"],
        `add "${draft.name}"`,
        JSON.stringify(mcpJsonOf(draft)),
      );
    },

    /** `claude mcp remove --scope <scope> -- <name>`. */
    remove(ctx: AgentMcpContext, name: string, scope: McpScope): Promise<void> {
      return claudeMcp(ctx, ["remove", "--scope", scope, "--", name], `delete "${name}"`);
    },

    release(ctx: AgentMcpContext): void {
      drop(ctx.cwd);
    },

    forget(): void {
      for (const cwd of [...standbys.keys()]) drop(cwd);
    },

    standing(): string[] {
      return [...standbys.keys()];
    },
  };
}

/**
 * The provider with its MCP servers before a session: the capability the
 * app reads, and the hook it calls. An app from before the dialog reads
 * neither.
 */
export function withMcpAdmin<P extends { capabilities: object }>(
  provider: P,
  admin: AgentMcpAdmin,
): P & { mcp: AgentMcpAdmin } {
  Object.assign(provider.capabilities, { mcpManage: CLAUDE_MCP_MANAGE });
  return Object.assign(provider, { mcp: admin });
}
