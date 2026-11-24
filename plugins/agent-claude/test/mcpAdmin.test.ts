// Automates specs/agents/claude.feature.md "Claude manages its MCP servers
// before a session": the pane's "MCP servers…" dialog asks a Claude Code
// started for it alone — no prompt, no session — and adds and deletes
// servers with `claude mcp add-json` and `claude mcp remove`. The Claude
// Agent SDK is swapped for a fake query and the CLI for a fake runner, so
// nothing spawns.

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { handleApi, reloader } from "@specdriven/app/src/server/api";
import * as engine from "@specdriven/app/src/server/agentChat";
import { writeState } from "@specdriven/app/src/server/state";
import { AgentError } from "@specdriven/host";
import type { RunOptions, RunResult } from "@specdriven/host";
import {
  CLAUDE_MCP_MANAGE,
  createMcpAdmin,
  mcpCommandError,
  mcpJsonOf,
  withMcpAdmin,
  type ClaudeMcpAdmin,
} from "../src/mcpAdmin";
import { mcpDetailsOf, type McpStatusAnswer, type McpToolCost } from "../src/mcpServers";
import type { AgentMcpContext } from "../src/paneContract";
import { InputQueue, setQueryFactory } from "../src/provider";
import type { QueryLike } from "../src/provider";
import { setClaudeAvailability } from "../src/cli";
import { DEFAULT_SETTINGS } from "../src/settings";
import { mountPlugin, quietProfile } from "./app";

// --- What Claude Code says ---------------------------------------------------------

/** Claude Code 2.1.331's answer to mcp_status for a command server, a url
    server that is down and a server from the repo's .mcp.json — a header's
    value included, as Claude Code gives it. */
const STATUS: McpStatusAnswer[] = [
  {
    name: "stub",
    status: "connected",
    serverInfo: { name: "stub-server", version: "9.9.1" },
    config: { type: "stdio", command: "bun", args: ["/w/stub.ts", "--fast"] },
    scope: "user",
    tools: [{ name: "read" }, { name: "page_read", description: "Reads a page" }],
  },
  {
    name: "dead",
    status: "failed",
    error: "ECONNREFUSED: Unable to connect.",
    config: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer hidden", "X-Team": "t1" } },
    scope: "local",
  },
  { name: "projstub", status: "connected", serverInfo: { name: "stub-server" }, config: { type: "stdio", command: "bun" }, scope: "project", tools: [{ name: "search" }] },
  { name: "specdriven-confluence", status: "connected", config: { type: "stdio", command: "specdriven", env: { CONFLUENCE_TOKEN: "s3cret" } }, scope: "dynamic", tools: [] },
  { name: "claude.ai Slack", status: "needs-auth", config: { type: "claudeai-proxy", url: "https://mcp.slack.example" }, scope: "claudeai" },
];

/** Its get_context_usage `mcpTools`: every tool by its full name, loaded or not. */
const COSTS: McpToolCost[] = [
  { name: "mcp__stub__read", serverName: "stub", tokens: 70, isLoaded: true },
  { name: "mcp__stub__page_read", serverName: "stub", tokens: 90, isLoaded: false },
  { name: "mcp__stub__gone", serverName: "stub", tokens: 5, isLoaded: false },
  { name: "mcp__projstub__search", serverName: "projstub", tokens: 71, isLoaded: false },
  { name: "mcp__other__x", serverName: "other", tokens: 999 },
];

test("Claude Code's servers become the dialog's details, with what their tools cost and never a secret", () => {
  const details = mcpDetailsOf(STATUS, new Set(["specdriven-confluence"]), COSTS);
  expect(details.map((d) => d.name)).toEqual(["stub", "dead", "projstub", "specdriven-confluence", "claude.ai Slack"]);
  expect(details[0]).toEqual({
    name: "stub",
    status: "connected",
    source: "user",
    scope: "user",
    transport: "stdio",
    command: "bun",
    args: ["/w/stub.ts", "--fast"],
    serverName: "stub-server",
    version: "9.9.1",
    tools: 3,
    // `read` does not take the cost of `page_read`; a tool only the count knows is listed too.
    toolList: [
      { name: "read", tokens: 70, loaded: true },
      { name: "page_read", description: "Reads a page", tokens: 90, loaded: false },
      { name: "gone", tokens: 5, loaded: false },
    ],
    context: { loaded: 70, deferred: 95 },
    canToggle: true,
    canAuthenticate: false,
    canDelete: true,
  });
  // A url server: its address and the names of its headers, not their values.
  expect(details[1]).toEqual({
    name: "dead",
    status: "failed",
    source: "local",
    scope: "local",
    error: "ECONNREFUSED: Unable to connect.",
    transport: "http",
    url: "http://127.0.0.1:9/mcp",
    headerNames: ["Authorization", "X-Team"],
    canToggle: true,
    canAuthenticate: false,
    canDelete: true,
  });
  expect(details[2]).toMatchObject({ scope: "project", canDelete: true, serverName: "stub-server", context: { loaded: 0, deferred: 71 } });
  expect(details[2]).not.toHaveProperty("version");
  // The app's own server and a claude.ai connector are kept nowhere `claude mcp remove` reaches.
  expect(details[3]).toMatchObject({ source: "SpecDriven", envNames: ["CONFLUENCE_TOKEN"], canDelete: false, tools: 0, toolList: [], context: { loaded: 0, deferred: 0 } });
  expect(details[3]).not.toHaveProperty("scope");
  expect(details[4]).toMatchObject({ source: "claude.ai", transport: "claudeai-proxy", canDelete: false, canAuthenticate: true });
  expect(details[4]).not.toHaveProperty("scope");
  expect(details[4]).not.toHaveProperty("toolList");
  const said = JSON.stringify(details);
  expect(said).not.toContain("Bearer hidden");
  expect(said).not.toContain("s3cret");

  // An older Claude Code gives no count: the tools are listed without a cost.
  const bare = mcpDetailsOf(STATUS);
  expect(bare[0]).toMatchObject({ tools: 2, toolList: [{ name: "read" }, { name: "page_read", description: "Reads a page" }] });
  expect(bare[0]).not.toHaveProperty("context");
  // Handed to no session by the app, a "dynamic" server is still not one to delete.
  expect(bare[3]).toMatchObject({ source: "dynamic", canDelete: false });
});

test("a draft becomes the definition claude mcp add-json takes, and a refusal keeps Claude Code's words", () => {
  expect(mcpJsonOf({ name: "files", scope: "local", transport: "stdio", command: "npx", args: ["-y", "srv"], env: { KEY: "v" } })).toEqual({
    type: "stdio",
    command: "npx",
    args: ["-y", "srv"],
    env: { KEY: "v" },
  });
  expect(mcpJsonOf({ name: "files", scope: "local", transport: "stdio", command: "srv" })).toEqual({ type: "stdio", command: "srv", args: [] });
  expect(mcpJsonOf({ name: "web", scope: "user", transport: "sse", url: "https://x.example/sse", headers: { "X-Key": "abc" } })).toEqual({
    type: "sse",
    url: "https://x.example/sse",
    headers: { "X-Key": "abc" },
  });
  expect(mcpJsonOf({ name: "web", scope: "user", transport: "http", url: "https://x.example/mcp" })).toEqual({ type: "http", url: "https://x.example/mcp" });

  expect(mcpCommandError({ exitCode: 1, stdout: "", stderr: "MCP server files already exists in local config\n" }, "add it")).toBe("MCP server files already exists in local config");
  expect(mcpCommandError({ exitCode: 1, stdout: "Invalid name.\n", stderr: "" }, "add it")).toBe("Invalid name.");
  expect(mcpCommandError({ exitCode: 3, stdout: "", stderr: "" }, 'add "x"')).toBe('Claude Code could not add "x" (exit 3)');
  expect(mcpCommandError({ exitCode: 124, stdout: "", stderr: "", timedOut: true }, 'delete "x"')).toBe('Claude Code did not delete "x" in time');
});

// --- A Claude Code kept for the dialog ---------------------------------------------------

/** A stand-in for the SDK's Query that answers the MCP questions. */
class StandbyQuery implements QueryLike {
  readonly out = new InputQueue<SDKMessage>();
  readonly asks: string[] = [];
  servers: McpStatusAnswer[] = STATUS.map((s) => ({ ...s }));
  costs: McpToolCost[] | null = COSTS;
  stopped = false;
  /** A prompt would mean a turn: there must never be one. */
  prompted = 0;
  failWith: Error | null = null;
  hang = false;
  signIn: unknown = { authUrl: "https://mcp.slack.example/authorize?state=s1", requiresUserAction: true };

  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    void (async () => {
      for await (const _ of prompt) this.prompted += 1;
    })();
    options.abortController?.signal.addEventListener("abort", () => {
      this.stopped = true;
      this.out.close();
    });
  }
  [Symbol.asyncIterator]() {
    return this.out[Symbol.asyncIterator]();
  }
  async interrupt() {}
  async setPermissionMode() {}
  async supportedCommands() {
    return [];
  }
  async mcpServerStatus() {
    this.asks.push("status");
    if (this.hang) await new Promise(() => {});
    if (this.failWith) throw this.failWith;
    return this.servers.map((s) => ({ ...s }));
  }
  async getContextUsage(opts?: { detail?: string }) {
    this.asks.push(`context ${opts?.detail}`);
    if (!this.costs) throw new Error("Unsupported control request: get_context_usage");
    return { mcpTools: this.costs, maxTokens: 200_000, totalTokens: 26_000, categories: [] };
  }
  async toggleMcpServer(name: string, enabled: boolean) {
    this.asks.push(`${enabled ? "enable" : "disable"} ${name}`);
    if (this.failWith) throw this.failWith;
    this.servers.find((s) => s.name === name)!.status = enabled ? "connected" : "disabled";
  }
  async reconnectMcpServer(name: string) {
    this.asks.push(`reconnect ${name}`);
    if (this.failWith) throw this.failWith;
  }
  async mcpAuthenticate(name: string) {
    this.asks.push(`authenticate ${name}`);
    if (!this.signIn) throw new Error("Unsupported control request: mcp_authenticate");
    return this.signIn;
  }
}

/** An admin over fakes: the Claude Codes it started, and the commands it ran. */
function fakeAdmin(extra: { idleMs?: number; answerTimeoutMs?: number; executable?: () => string | null } = {}) {
  const started: StandbyQuery[] = [];
  const ran: { cmd: string; args: string[]; options: RunOptions }[] = [];
  const runner = { answer: { exitCode: 0, stdout: "", stderr: "" } as RunResult };
  const admin = createMcpAdmin({
    settings: async () => DEFAULT_SETTINGS,
    token: async () => null,
    query: async ({ prompt, options }) => {
      const query = new StandbyQuery(prompt, options);
      started.push(query);
      return query;
    },
    run: async (cmd, args, options = {}) => {
      ran.push({ cmd, args, options });
      return runner.answer;
    },
    executable: () => "/bin/claude",
    ...extra,
  });
  admins.push(admin);
  return { admin, started, ran, runner };
}

const admins: ClaudeMcpAdmin[] = [];
afterEach(() => {
  for (const admin of admins.splice(0)) admin.forget();
});

const CTX: AgentMcpContext = { cwd: "/w/code", dataRepo: "/w/data" };
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as AgentError);

test("the list is a Claude Code's own, started in the folder as a session would be and never given a prompt", async () => {
  const { admin, started } = fakeAdmin();
  const handed = [{ name: "specdriven-confluence", command: "specdriven", args: ["mcp"], env: { CONFLUENCE_TOKEN: "s3cret" } }];
  const ctx = { ...CTX, mcpServers: handed };
  const list = await admin.list(ctx);
  expect(started).toHaveLength(1);
  const { options } = started[0]!;
  expect(options.cwd).toBe("/w/code");
  expect(options.pathToClaudeCodeExecutable).toBe("/bin/claude");
  // The settings a session loads, and the servers the app hands one.
  expect(options.settingSources).toEqual(["user", "project", "local"]);
  expect(options.mcpServers).toEqual({ "specdriven-confluence": { type: "stdio", command: "specdriven", args: ["mcp"], env: { CONFLUENCE_TOKEN: "s3cret" } } });
  expect(options.persistSession).toBe(false);
  // Not nested in whatever started the app.
  expect(options.env).not.toHaveProperty("CLAUDECODE");

  expect(list.contextWindow).toBe(200_000);
  expect(list.servers.map((s) => `${s.name}:${s.status}`)).toEqual([
    "stub:connected",
    "dead:failed",
    "projstub:connected",
    "specdriven-confluence:connected",
    "claude.ai Slack:needs-auth",
  ]);
  expect(list.servers[0]!.context).toEqual({ loaded: 70, deferred: 95 });
  expect(list.servers[3]).toMatchObject({ source: "SpecDriven", canDelete: false });
  // The cheap count, and nothing of a secret in the answer.
  expect(started[0]!.asks).toEqual(["status", "context summary"]);
  expect(JSON.stringify(list)).not.toContain("s3cret");

  // Asked again, the same Claude Code answers; no turn was ever started.
  await admin.list(ctx);
  expect(started).toHaveLength(1);
  expect(started[0]!.prompted).toBe(0);
  expect(started[0]!.stopped).toBe(false);
  expect(admin.standing()).toEqual(["/w/code"]);

  // Another folder has its own; other servers from the app mean another run.
  await admin.list({ cwd: "/w/other", dataRepo: "/w/data" });
  expect(started).toHaveLength(2);
  await admin.list(CTX);
  expect(started).toHaveLength(3);
  expect(started[0]!.stopped).toBe(true);
  expect(started[2]!.options.mcpServers).toBeUndefined();

  // The dialog shut: that folder's Claude Code is stopped, the other stays.
  await admin.release!(CTX);
  expect(started[2]!.stopped).toBe(true);
  expect(started[1]!.stopped).toBe(false);
  expect(admin.standing()).toEqual(["/w/other"]);
  // A changed sign-in stops them all.
  admin.forget();
  expect(started.every((q) => q.stopped)).toBe(true);
  expect(admin.standing()).toEqual([]);
});

test("a Claude Code too old to count the context still lists the servers", async () => {
  const { admin, started } = fakeAdmin();
  const first = admin.list(CTX);
  // Two asks while it starts share the one run.
  const second = admin.list(CTX);
  await Promise.all([first, second]);
  expect(started).toHaveLength(1);
  started[0]!.costs = null;
  const list = await admin.list(CTX);
  expect(list).not.toHaveProperty("contextWindow");
  expect(list.servers[0]).toMatchObject({ name: "stub", tools: 2 });
  expect(list.servers[0]).not.toHaveProperty("context");
});

test("the dialog's switch, Reconnect and Sign in are requests to the kept Claude Code", async () => {
  const { admin, started } = fakeAdmin();
  await admin.list(CTX);
  const query = started[0]!;
  await admin.act(CTX, "stub", "disable");
  expect((await admin.list(CTX)).servers[0]!.status).toBe("disabled");
  await admin.act(CTX, "stub", "enable");
  await admin.act(CTX, "dead", "reconnect");
  // A sign-in answers with the page to open; the same run waits for the browser.
  expect(await admin.act(CTX, "claude.ai Slack", "authenticate")).toEqual({ url: "https://mcp.slack.example/authorize?state=s1" });
  expect(query.asks.filter((a) => !a.startsWith("status") && !a.startsWith("context"))).toEqual([
    "disable stub",
    "enable stub",
    "reconnect dead",
    "authenticate claude.ai Slack",
  ]);
  expect(started).toHaveLength(1);

  // A Claude Code that cannot start a sign-in says the way round it, and stays up.
  query.signIn = null;
  const unsupported = await refusal(admin.act(CTX, "claude.ai Slack", "authenticate") as Promise<unknown>);
  expect(unsupported).toBeInstanceOf(AgentError);
  expect(unsupported).toMatchObject({ status: 409 });
  expect(unsupported!.message).toContain("sign in to \"claude.ai Slack\" with /mcp");
  expect(query.stopped).toBe(false);

  // Claude Code's own failure is passed on — a server that still fails — and
  // the run, which may be gone, is not kept: the next ask starts another.
  query.failWith = new Error("Connection refused");
  const failed = await refusal(admin.act(CTX, "dead", "reconnect") as Promise<unknown>);
  expect(failed!.message).toBe("Connection refused");
  expect(query.stopped).toBe(true);
  await admin.list(CTX);
  expect(started).toHaveLength(2);
});

test("a Claude Code that does not answer in time is stopped, and one left alone goes after a while", async () => {
  const slow = fakeAdmin({ answerTimeoutMs: 30 });
  await slow.admin.list(CTX);
  slow.started[0]!.hang = true;
  const late = await refusal(slow.admin.list(CTX));
  expect(late).toMatchObject({ status: 504, message: "Claude Code did not list its MCP servers in time" });
  expect(slow.started[0]!.stopped).toBe(true);
  expect(slow.admin.standing()).toEqual([]);

  const idle = fakeAdmin({ idleMs: 40 });
  await idle.admin.list(CTX);
  await Bun.sleep(20);
  // An ask keeps it up for another while.
  await idle.admin.list(CTX);
  await Bun.sleep(25);
  expect(idle.started[0]!.stopped).toBe(false);
  await Bun.sleep(40);
  expect(idle.started[0]!.stopped).toBe(true);
  expect(idle.admin.standing()).toEqual([]);
});

test("a server is added and deleted with Claude Code's own commands, its definition on stdin", async () => {
  const { admin, started, ran, runner } = fakeAdmin();
  await admin.list(CTX);
  await admin.add(CTX, { name: "weather", scope: "project", transport: "http", url: "https://weather.example/mcp", headers: { Authorization: "Bearer abc" } });
  expect(ran).toHaveLength(1);
  expect(ran[0]!.cmd).toBe("/bin/claude");
  // The name after `--`, so one that starts with a hyphen is still a name; the definition as `-`, from stdin.
  expect(ran[0]!.args).toEqual(["mcp", "add-json", "--scope", "project", "--", "weather", "-"]);
  expect(JSON.parse(ran[0]!.options.input!)).toEqual({ type: "http", url: "https://weather.example/mcp", headers: { Authorization: "Bearer abc" } });
  // No secret on the command line; run in the folder, under the session's sign-in.
  expect(ran[0]!.args.join(" ")).not.toContain("Bearer");
  expect(ran[0]!.options.cwd).toBe("/w/code");
  expect(ran[0]!.options.env).not.toHaveProperty("CLAUDECODE");
  expect(ran[0]!.options.timeoutMs).toBeGreaterThan(0);
  // The running Claude Code does not see the change: it is stopped, and the next list starts another.
  expect(started[0]!.stopped).toBe(true);
  await admin.list(CTX);
  expect(started).toHaveLength(2);

  await admin.remove(CTX, "-lead", "local");
  expect(ran[1]!.args).toEqual(["mcp", "remove", "--scope", "local", "--", "-lead"]);
  expect(ran[1]!.options.input).toBeUndefined();
  expect(started[1]!.stopped).toBe(true);

  // Claude Code's refusal is the refusal, in its words; nothing was changed, so the run stays.
  await admin.list(CTX);
  runner.answer = { exitCode: 1, stdout: "", stderr: "MCP server weather already exists in .mcp.json\n" };
  const refused = await refusal(admin.add(CTX, { name: "weather", scope: "project", transport: "stdio", command: "x" }));
  expect(refused).toMatchObject({ status: 409, message: "MCP server weather already exists in .mcp.json" });
  runner.answer = { exitCode: 1, stdout: "", stderr: 'No MCP server named "nope" in user scope' };
  expect(await refusal(admin.remove(CTX, "nope", "user"))).toMatchObject({ status: 409, message: 'No MCP server named "nope" in user scope' });
  expect(started[2]!.stopped).toBe(false);

  // With no Claude Code to run there is nothing to add with.
  const none = fakeAdmin({ executable: () => null });
  expect(await refusal(none.admin.add(CTX, { name: "a", scope: "local", transport: "stdio", command: "x" }))).toMatchObject({ status: 502 });
  expect(none.ran).toEqual([]);
});

test("the provider says it manages its MCP servers and where it can add one", () => {
  const { admin } = fakeAdmin();
  const provider = withMcpAdmin({ id: "claude", capabilities: { mcpServers: true } as Record<string, unknown> }, admin);
  expect(provider.mcp).toBe(admin);
  expect(provider.capabilities.mcpManage).toEqual({ scopes: ["local", "user", "project"], transports: ["stdio", "http", "sse"] });
  expect(CLAUDE_MCP_MANAGE.scopes[0]).toBe("local");
});

// --- Through the app ------------------------------------------------------------------------

const appAsksBeforeASession = "agentMcpCatalog" in engine;

test.if(appAsksBeforeASession)("the app's MCP servers dialog is answered by Claude with no session running", async () => {
  const root = await mkdtemp(join(tmpdir(), "specdriven-claude-mcp-"));
  const realRoot = process.env.SPECDRIVEN_ROOT;
  const realHome = process.env.SPECDRIVEN_HOME;
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  const data = join(root, "data");
  await writeState({ dataRepo: data, ...quietProfile(data) }, root);
  await Bun.write(join(data, "specs", ".keep"), "");
  const started: StandbyQuery[] = [];
  const realFactory = setQueryFactory(async ({ prompt, options }) => {
    const query = new StandbyQuery(prompt, options);
    started.push(query);
    return query;
  });
  const realProbe = setClaudeAvailability(() => true);
  const unmount = await mountPlugin();
  const api = (path: string, method = "GET", body?: unknown) =>
    handleApi(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ) as Promise<Response>;
  try {
    const state = (await (await api("/api/state")).json()) as { agents: { id: string; capabilities: { mcpManage?: unknown } }[] };
    expect(state.agents.find((a) => a.id === "claude")!.capabilities.mcpManage).toEqual(CLAUDE_MCP_MANAGE);

    const listed = await api("/api/agent/agents/claude/mcp");
    expect(listed.status).toBe(200);
    const catalog = (await listed.json()) as { servers: { name: string; status: string; canDelete: boolean }[]; contextWindow: number; usage: unknown };
    expect(catalog.servers.map((s) => s.name)).toEqual(STATUS.map((s) => s.name as string));
    expect(catalog.contextWindow).toBe(200_000);
    expect(catalog.usage).toEqual({});
    expect(started).toHaveLength(1);
    expect(started[0]!.options.cwd).toBe(data);
    // No session was started, and no turn.
    expect(((await (await api("/api/agent/chat")).json()) as { sessions: unknown[] }).sessions).toEqual([]);
    expect(started[0]!.prompted).toBe(0);

    const off = await api("/api/agent/agents/claude/mcp", "POST", { server: "stub", action: "disable" });
    expect(off.status).toBe(200);
    expect(((await off.json()) as typeof catalog).servers[0]).toMatchObject({ name: "stub", status: "disabled" });
    expect(started[0]!.asks).toContain("disable stub");
    // What the list does not offer never reaches Claude Code.
    expect((await api("/api/agent/agents/claude/mcp/servers?name=claude.ai%20Slack", "DELETE")).status).toBe(409);

    // The dialog shut: its Claude Code is stopped.
    expect((await api("/api/agent/agents/claude/mcp/release", "POST", {})).status).toBe(200);
    expect(started[0]!.stopped).toBe(true);
  } finally {
    await unmount();
    reloader.stop();
    setQueryFactory(realFactory);
    setClaudeAvailability(realProbe);
    for (const [name, value] of [
      ["SPECDRIVEN_ROOT", realRoot],
      ["SPECDRIVEN_HOME", realHome],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
