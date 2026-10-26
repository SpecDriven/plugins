// Codex in the coding agent pane: `codex app-server` over JSON-RPC lines
// (src/server/codexChat.ts). A chat is one Codex thread; a turn is
// `turn/start`, a stop is `turn/interrupt`, and the approvals Codex asks
// for on the way arrive as requests from the server, which the pane's
// permission cards answer. Codex has no permission modes but an approval
// policy and a sandbox; the pane's modes map onto those (codexPolicy) and
// travel with every turn. An AgentProvider (src/plugins/host/agents.ts).
//
// Node APIs only (src/server/run.ts): this module also runs under Electron.

import { AgentError } from "@specdriven/host";
import type {
  AgentHost,
  AgentProvider,
  AgentSession,
  AgentStartOptions,
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
  PermissionSuggestion,
} from "@specdriven/host";
import { CODEX_BIN, codexAvailable } from "./cli";
import {
  CODEX_CLIENT_INFO,
  CODEX_TOOL,
  CodexClient,
  codexAnswers,
  codexPolicy,
  codexQuestions,
  codexSandboxPolicy,
  codexTextInput,
  codexThreadInfo,
  fileChangeLine,
  mapCodexNotification,
  newCodexStream,
} from "./codexChat";
import type { CodexParams, CodexStreamContext, RpcId } from "./codexChat";

/** The refusal when no `codex` is on PATH. */
export const CODEX_MISSING = "Codex CLI not found — install the `codex` command (npm i -g @openai/codex)";

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const rec = (value: unknown): CodexParams | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as CodexParams) : null;

/** What a Codex server request becomes in the pane, and what its answer becomes for Codex. */
interface CodexAsk {
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionSuggestion[];
  title?: string;
  /** The JSON-RPC result for the pane's answer; null refuses the request. */
  answer: (decision: PermissionDecision, via: PermissionOutcome["via"]) => unknown | null;
}

/** "Allow always" for Codex: a rule shaped like the Claude SDK's, so the
    card offers it; it means "for the rest of the session". */
function sessionRule(toolName: string, ruleContent: string): PermissionSuggestion {
  return {
    type: "addRules",
    rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }],
    behavior: "allow",
    destination: "session",
  };
}

const DENIED_DEFAULT = "Denied in SpecDriven";

class CodexSession implements AgentSession {
  client: CodexClient | null = null;
  private readonly stream: CodexStreamContext = newCodexStream();
  /** The server requests awaiting the pane's answer, by their JSON-RPC id:
      aborting one withdraws its card. */
  private readonly requests = new Map<string, AbortController>();
  private stderrTail: string[] = [];
  private threadId: string | null = null;
  /** The mode the next turn carries; the core keeps the session's. */
  private mode: PermissionMode;

  constructor(
    private readonly host: AgentHost,
    private readonly name: string,
    private readonly cwd: string,
    mode: PermissionMode,
  ) {
    this.mode = mode;
  }

  get final(): boolean {
    return this.host.status() === "ended" || this.host.status() === "error";
  }

  readonly stderr = (line: string): void => {
    this.stderrTail = [...this.stderrTail, line].slice(-5);
  };

  private failed(why: string): void {
    const tail = this.stderrTail.join("\n");
    this.host.failed(tail ? `Could not start Codex: ${why}\n${tail}` : `Could not start Codex: ${why}`, "spawn_failed");
  }

  /**
   * The handshake: `initialize`, then `thread/start` on the work dir with
   * the pane's mode as the policy. The thread's answer says the session is
   * ready to type into — and brings the model and Codex's own thread id.
   */
  async ready(prompt?: string): Promise<void> {
    const client = this.client!;
    const init = await client.request("initialize", {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    if (this.final) return;
    if (!init.ok) return this.failed(init.error);
    const policy = codexPolicy(this.mode);
    const started = await client.request("thread/start", {
      cwd: this.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
    });
    if (this.final) return;
    if (!started.ok) return this.failed(started.error);
    const info = codexThreadInfo(started.result);
    if (!info.threadId) return this.failed("thread/start answered without a thread id");
    this.threadId = info.threadId;
    this.host.note(
      "info",
      "init",
      `Codex${info.cliVersion ? ` ${info.cliVersion}` : ""} · ${info.model ?? "no model"} · ${this.cwd}`,
    );
    // The one thing a Claude user must not assume here: the modes are
    // Codex's approval policy and sandbox in disguise, set per turn.
    this.host.note(
      "info",
      "init",
      "Permission modes map onto Codex's approval policy and sandbox; a change applies from the next turn.",
    );
    // Named after the session, so `codex resume` lists it by that name.
    void client.request("thread/name/set", { threadId: info.threadId, name: this.name });
    this.host.ready({ agentSessionId: info.threadId, ...(info.model ? { model: info.model } : {}) });
    if (prompt) {
      try {
        await this.send(prompt);
      } catch (e) {
        // The first turn never started: say so, and give the composer back.
        this.host.note("error", "api", (e as Error).message);
        this.host.turnEnded();
      }
    }
  }

  /** One turn: the text to Codex, with the pane's mode as the policy overrides. */
  async send(text: string): Promise<void> {
    const client = this.client!;
    if (!this.threadId || this.final) return;
    const policy = codexPolicy(this.mode);
    const res = await client.request("turn/start", {
      threadId: this.threadId,
      input: codexTextInput(text),
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: codexSandboxPolicy(policy.sandbox),
    });
    if (this.final) return;
    if (!res.ok) throw new Error(`Codex refused the turn: ${res.error}`);
    const turn = rec(res.result.turn);
    const turnId = turn ? str(turn.id) : null;
    if (turnId && this.stream.turnId === null) this.stream.turnId = turnId;
  }

  async interrupt(): Promise<void> {
    // The turn's own `turn/completed` (interrupted) puts the session back to idle.
    const turnId = this.stream.turnId;
    if (this.threadId && turnId && this.client) {
      await this.client.request("turn/interrupt", { threadId: this.threadId, turnId });
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // The mode travels with every turn/start; a turn under way keeps the
    // policy it started with.
    if (this.host.status() === "starting") throw new AgentError(409, "Codex is still starting");
    this.mode = mode;
    if (this.host.busy()) this.host.note("info", "api", "The new mode applies from the next turn.");
  }

  close(): void {
    this.client?.close();
  }

  notification(method: string, params: CodexParams): void {
    if (this.final) return;
    if (method === "turn/started") this.host.turnStarted();
    if (method === "serverRequest/resolved") {
      // Codex withdrew a question of its own (an interrupt, a dying turn):
      // the card closes without an answer, and none is sent.
      const key = String(params.requestId);
      const pending = this.requests.get(key);
      if (pending) {
        this.requests.delete(key);
        pending.abort();
      }
      return;
    }
    for (const body of mapCodexNotification(method, params, { turn: this.host.turn() }, this.stream)) {
      this.host.emit(body);
    }
    if (method === "turn/completed") this.host.turnEnded();
  }

  /** A word in Codex's ear mid-turn; best effort, since the turn may be past steering. */
  private steer(text: string): void {
    const turnId = this.stream.turnId;
    if (!this.threadId || !turnId || !this.client) return;
    void this.client.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: turnId,
      input: codexTextInput(text),
    });
  }

  /** Raise a permission card for a Codex request, and answer Codex from the card. */
  private ask(rpcId: RpcId, ask: CodexAsk): void {
    const client = this.client!;
    const key = String(rpcId);
    const withdrawn = new AbortController();
    this.requests.set(key, withdrawn);
    void this.host
      .requestPermission({
        toolName: ask.toolName,
        input: ask.input,
        suggestions: ask.suggestions,
        ...(ask.title ? { title: ask.title } : {}),
        signal: withdrawn.signal,
      })
      .then(({ decision, via }) => {
        // Withdrawn by Codex already (serverRequest/resolved): nothing to answer.
        if (!this.requests.delete(key)) return;
        if (decision.behavior === "deny" && via === "user") this.stream.denials += 1;
        const reply = ask.answer(decision, via);
        if (reply === null) {
          client.respondError(rpcId, decision.behavior === "deny" ? decision.message : "Not answered", -32000);
        } else {
          client.respond(rpcId, reply);
        }
        // A decline carries no words in Codex's protocol; the reason the
        // user typed goes in as steering, so Codex still reads it.
        if (decision.behavior === "deny" && via === "user" && decision.message !== DENIED_DEFAULT) {
          this.steer(`The user declined that, saying: ${decision.message}`);
        }
      });
  }

  /** Codex asks; the pane answers (specs: "permission card"). */
  request(id: RpcId, method: string, params: CodexParams): void {
    const client = this.client!;
    if (this.final) {
      client.respondError(id, "The session has ended", -32000);
      return;
    }
    const reason = str(params.reason);
    const item = this.stream.items.get(str(params.itemId) ?? "");
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = str(params.command) ?? (item ? str(item.command) : null) ?? "";
        const cwd = str(params.cwd) ?? (item ? str(item.cwd) : null);
        const amendment = Array.isArray(params.proposedExecpolicyAmendment)
          ? params.proposedExecpolicyAmendment
          : null;
        this.ask(id, {
          toolName: CODEX_TOOL.command,
          input: { command, ...(cwd ? { cwd } : {}), ...(reason ? { reason } : {}) },
          suggestions: [sessionRule(CODEX_TOOL.command, command)],
          title: "Codex wants to run a command",
          answer: (decision, via) => {
            if (decision.behavior !== "allow") return { decision: via === "user" ? "decline" : "cancel" };
            if (!decision.remember) return { decision: "accept" };
            return {
              decision: amendment
                ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }
                : "acceptForSession",
            };
          },
        });
        return;
      }
      case "item/fileChange/requestApproval": {
        const changes = item && Array.isArray(item.changes) ? item.changes : [];
        const files = changes.map((c) => rec(c)).filter((c): c is CodexParams => c !== null).map(fileChangeLine);
        const grantRoot = str(params.grantRoot);
        this.ask(id, {
          toolName: CODEX_TOOL.fileChange,
          input: {
            file_path: files.join(", "),
            files,
            ...(reason ? { reason } : {}),
            ...(grantRoot ? { grantRoot } : {}),
          },
          suggestions: [sessionRule(CODEX_TOOL.fileChange, files.join(", "))],
          title: "Codex wants to change files",
          answer: (decision, via) => {
            if (decision.behavior !== "allow") return { decision: via === "user" ? "decline" : "cancel" };
            return { decision: decision.remember ? "acceptForSession" : "accept" };
          },
        });
        return;
      }
      case "item/tool/requestUserInput": {
        const questions = codexQuestions(params);
        if (questions.length === 0) {
          client.respond(id, { answers: {} });
          return;
        }
        // The pane's question card, keyed the way Claude's AskUserQuestion is.
        this.ask(id, {
          toolName: "AskUserQuestion",
          input: { questions: questions.map((q) => q.question) },
          suggestions: [],
          answer: (decision) =>
            decision.behavior === "allow" ? codexAnswers(questions, rec(decision.updatedInput)?.answers) : null,
        });
        return;
      }
      case "item/permissions/requestApproval": {
        const requested = rec(params.permissions) ?? {};
        const network = rec(requested.network);
        const fileSystem = rec(requested.fileSystem);
        this.ask(id, {
          toolName: "Permissions",
          input: { ...(reason ? { reason } : {}), permissions: requested },
          suggestions: [sessionRule("Permissions", reason ?? "")],
          title: "Codex asks for more permissions",
          answer: (decision) =>
            decision.behavior === "allow"
              ? {
                  permissions: { ...(network ? { network } : {}), ...(fileSystem ? { fileSystem } : {}) },
                  scope: decision.remember ? "session" : "turn",
                }
              : null,
        });
        return;
      }
      case "mcpServer/elicitation/request": {
        // Blocks the turn until answered, and the pane has nothing to show
        // it in — cancel it, and say so.
        client.respond(id, { action: "cancel", content: null, _meta: null });
        this.host.note(
          "info",
          "api",
          `An MCP server (${str(params.serverName) ?? "unknown"}) asked for input the pane cannot show — dismissed.`,
        );
        return;
      }
      default:
        // Dynamic tools, auth token refreshes, attestations: never opted into.
        client.respondError(id, `${method} is not supported by SpecDriven`);
    }
  }

  /** Codex is gone: an exit code of its own, or an Error where it never started. */
  exited(code: number | null, error?: Error): void {
    if (this.final) return;
    const tail = this.stderrTail.join("\n");
    const detail = (text: string) => (tail ? `${text}\n${tail}` : text);
    if (error) return this.host.failed(detail(`Could not start Codex: ${error.message}`), "spawn_failed");
    if (code === 0 || code === null) return this.host.ended("Codex exited.");
    this.host.failed(detail(`Codex exited with code ${code}.`));
  }
}

export const codexProvider: AgentProvider = {
  id: "codex",
  label: "Codex",
  description: "OpenAI's Codex CLI, with permission cards for commands and file changes",
  rank: 20,
  cli: CODEX_BIN,
  available: codexAvailable,
  missingMessage: CODEX_MISSING,
  capabilities: {
    permissionModes: ["auto", "default", "acceptEdits", "plan", "bypassPermissions"],
    canInterrupt: true,
    canChangeModeMidSession: true,
    hasAccount: false,
    rememberPermissions: "session",
    oneShot: false,
  },
  defaultPermissionMode: "default",
  loginHint: {
    text: "The Codex CLI is not signed in on this machine: run the command in a terminal, then start a new session.",
    command: "codex login",
  },
  async start(opts: AgentStartOptions): Promise<AgentSession> {
    const session = new CodexSession(opts.host, opts.name, opts.cwd, opts.permissionMode);
    session.client = new CodexClient({
      cwd: opts.cwd,
      onNotification: (method, params) => session.notification(method, params),
      onServerRequest: (id, method, params) => session.request(id, method, params),
      onStderr: session.stderr,
      onExit: (code, error) => session.exited(code, error),
    });
    opts.signal.addEventListener("abort", () => session.close(), { once: true });
    // The prompt is the first turn, once the thread is up; the core shows
    // it in the transcript straight away, and the composer stays closed
    // until Codex has taken it.
    void session.ready(opts.prompt);
    return session;
  },
};
