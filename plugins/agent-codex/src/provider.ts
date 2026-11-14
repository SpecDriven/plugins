// Codex in the coding agent pane: `codex app-server` over JSON-RPC lines
// (src/server/codexChat.ts). A chat is one Codex thread; a turn is
// `turn/start`, a stop is `turn/interrupt`, and the approvals Codex asks
// for on the way arrive as requests from the server, which the pane's
// permission cards answer. Codex has no permission modes but an approval
// policy and a sandbox; the pane's modes map onto those (codexPolicy) and
// travel with every turn. An AgentProvider (src/plugins/host/agents.ts);
// its one-shot turns run `codex exec` instead (src/oneShot.ts). How it
// signs in — a ChatGPT account or the API — is Settings → Codex's choice
// (src/auth.ts), handed to every Codex as its launch; the models it offers
// are the sign-in's (src/models.ts), and the reasoning efforts each model
// takes are Codex's own word on it.
//
// Node APIs only (src/server/run.ts): this module also runs under Electron.

import { AgentError } from "@specdriven/host";
import type {
  AgentHost,
  AgentSession,
  ChatAccount,
  OneShotRequest,
  OneShotResult,
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
  PermissionSuggestion,
} from "@specdriven/host";
import { CodexAuthError, plainLaunch, type CodexLaunch } from "./auth";
import { CODEX_BIN, codexAvailable } from "./cli";
import { effortFor, narrowModels, type CodexModel, type EffortLevel } from "./modelMenu";
import { codexOneShot } from "./oneShot";
import {
  CODEX_CLIENT_INFO,
  CODEX_TOOL,
  CodexClient,
  codexAnswers,
  codexContextUsage,
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
import { codexMcpArgs } from "./mcpConfig";
import type { AgentChoices, AgentDefaultsPatch, PaneHost, PaneProvider, PaneStartOptions, PastedImage } from "./paneContract";
import { DEFAULT_SETTINGS, type CodexSettingsValues } from "./settings";

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

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

/** What Settings → Codex has chosen, as describeSignIn reads it. */
export interface SignInChoice {
  mode: "login" | "api";
  /** The address an api-mode launch calls; null when none is set anywhere. */
  apiUrl: string | null;
  /** `codex login status` under the account sign-in; null in api mode. */
  login: { loggedIn: boolean; email: string | null } | null;
}

/**
 * The sign-in a session starts under, for the pane header's chip
 * (specs/agents/agent-pane.feature.md "The pane header says whether the
 * agent spends an account or the API"): the API at the address Settings
 * names, or the ChatGPT account Codex is signed in to.
 */
export function describeSignIn(choice: SignInChoice): ChatAccount {
  if (choice.mode === "api") {
    let endpoint: URL | undefined;
    try {
      endpoint = choice.apiUrl ? new URL(choice.apiUrl) : undefined;
    } catch {
      // Settings normalizes the address; a bad one reads as none set.
    }
    if (!endpoint) return { billing: "api", label: "API", detail: "API · as Codex's own config has it" };
    const label = LOCAL_HOSTS.test(endpoint.hostname) ? "LOCAL" : endpoint.hostname;
    return { billing: "api", label: `API:${label}`, detail: `API calls go to ${endpoint.host}` };
  }
  if (choice.login?.loggedIn) {
    const who = choice.login.email ? ` · ${choice.login.email}` : "";
    return { billing: "plan", label: "ChatGPT account", detail: `ChatGPT account${who}` };
  }
  return { billing: "none", label: "Not logged in", detail: "Sign in with your ChatGPT account in Settings → Codex." };
}

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
  /** The model the thread runs on, and the last context count shown. */
  private model: string | null = null;
  private lastCount: number | null = null;
  /** The model the pane switched to since the thread started: it goes
      with the next turn, and Codex keeps it for the turns after. */
  private nextModel: string | null = null;
  /** The effort the pane picked (null: the model's own), and the last one
      a turn asked Codex for, which Codex keeps for the turns after. */
  private effort: EffortLevel | null;
  private sentEffort: EffortLevel | null = null;

  constructor(
    private readonly host: AgentHost,
    private readonly name: string,
    private readonly cwd: string,
    mode: PermissionMode,
    /** The model the thread starts on; null is Codex's own. */
    private readonly startModel: string | null = null,
    /** The sign-in the session was started under, for the header's chip. */
    private readonly account: ChatAccount | null = null,
    /** The effort the session starts at; null is the model's own. */
    effort: EffortLevel | null = null,
    /** What the sign-in says of a model: the efforts it takes. */
    private readonly modelInfo: (model: string) => Promise<CodexModel | undefined> = async () => undefined,
  ) {
    this.mode = mode;
    this.effort = effort;
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
  async ready(prompt?: string, images?: PastedImage[]): Promise<void> {
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
      ...(this.startModel ? { model: this.startModel } : {}),
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
    this.model = info.model ?? null;
    this.host.ready({
      agentSessionId: info.threadId,
      ...(info.model ? { model: info.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.account ? { account: this.account } : {}),
    });
    if (prompt || images?.length) {
      try {
        await this.send(prompt ?? "", images);
      } catch (e) {
        // The first turn never started: say so, and give the composer back.
        this.host.note("error", "api", (e as Error).message);
        this.host.turnEnded();
      }
    }
  }

  /**
   * The effort the next turn asks of Codex: the pane's pick, lowered to one
   * the turn's model takes (none for a model Codex sends no effort for).
   * Back on the model's own after another was asked, the turn asks for the
   * model's default, since Codex keeps the last effort it was given.
   */
  private async turnEffort(): Promise<EffortLevel | null> {
    if (!this.effort && !this.sentEffort) return null;
    const model = this.nextModel ?? this.model;
    const info = model ? await this.modelInfo(model) : undefined;
    if (this.effort) return effortFor(this.effort, info);
    return info?.defaultEffort ?? null;
  }

  /** One turn: the text (and pasted images) to Codex, with the pane's mode
      as the policy overrides, and its effort when it picked one. */
  async send(text: string, images?: PastedImage[]): Promise<void> {
    const client = this.client!;
    if (!this.threadId || this.final) return;
    const policy = codexPolicy(this.mode);
    const effort = await this.turnEffort();
    if (this.final) return;
    const res = await client.request("turn/start", {
      threadId: this.threadId,
      input: codexTextInput(text, images?.map((image) => image.path)),
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: codexSandboxPolicy(policy.sandbox),
      ...(this.nextModel ? { model: this.nextModel } : {}),
      ...(effort ? { effort } : {}),
    });
    if (this.final) return;
    if (!res.ok) throw new Error(`Codex refused the turn: ${res.error}`);
    if (this.nextModel) {
      this.model = this.nextModel;
      this.nextModel = null;
    }
    if (effort) this.sentEffort = this.effort ? effort : null;
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

  /** The pane picked another model: Codex takes it with a turn, and keeps
      it for the turns after. Null is the model the thread started on. */
  async setModel(model: string | null): Promise<void> {
    if (this.host.status() === "starting") throw new AgentError(409, "Codex is still starting");
    const next = model ?? this.startModel;
    this.nextModel = next && next !== this.model ? next : null;
    if (this.host.busy()) this.host.note("info", "api", "The new model applies from the next turn.");
  }

  /** The pane picked another effort (null: the model's own): it goes with
      the next turn, lowered to one the model takes. */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    if (this.host.status() === "starting") throw new AgentError(409, "Codex is still starting");
    this.effort = effort;
    if (this.host.busy()) this.host.note("info", "api", "The new effort applies from the next turn.");
  }

  close(): void {
    this.client?.close();
  }

  notification(method: string, params: CodexParams): void {
    if (this.final) return;
    if (method === "thread/tokenUsage/updated") {
      // The pane's context meter (specs/agents/agent-pane.feature.md S10).
      const usage = codexContextUsage(params);
      if (!usage || usage.totalTokens === this.lastCount) return;
      this.lastCount = usage.totalTokens;
      (this.host as PaneHost).context?.({ ...usage, ...(this.model ? { model: this.model } : {}) });
      return;
    }
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

/** What the host half hands the provider (src/host.ts); with none of it,
    Codex runs on its own config and sign-in and offers no model menu. */
export interface CodexProviderOptions {
  /** The launch Settings → Codex's sign-in gives a Codex (src/auth.ts);
      it rejects with a CodexAuthError when that sign-in is not there. */
  launch?: () => Promise<CodexLaunch>;
  /** The sign-in a new session would start under (describeSignIn). */
  signIn?: () => Promise<ChatAccount>;
  /** The plugin's settings as they stand; default: the defaults. */
  settings?: () => Promise<CodexSettingsValues>;
  /** The names the data repo lists for Codex (src/models.ts), which narrow
      the menus to those models; default: none, so nothing is narrowed. */
  listedModels?: () => Promise<string[]>;
  /** The models the sign-in offers (src/models.ts): the API's
      GET <address>/models, or Codex's own for a ChatGPT account. */
  offeredModels?: () => Promise<CodexModel[]>;
  /** Write a patch to the plugin's settings section; default: nothing is kept. */
  saveSettings?: (patch: Record<string, unknown>) => Promise<void>;
}

/** The Codex provider; the host half hands it the plugin's settings and sign-in. */
export function createCodexProvider(options: CodexProviderOptions = {}): PaneProvider {
  const settings = options.settings ?? (async () => DEFAULT_SETTINGS);
  const listedModels = options.listedModels ?? (async () => []);
  const offered = async () => (await options.offeredModels?.().catch(() => [] as CodexModel[])) ?? [];
  /** The launch, with a sign-in that is not there as the session's refusal. */
  const launch = async (): Promise<CodexLaunch> => {
    if (!options.launch) return plainLaunch();
    try {
      return await options.launch();
    } catch (e) {
      if (e instanceof CodexAuthError) throw new AgentError(e.status, e.message);
      throw e;
    }
  };
  /** No model asked for: the default Settings names while the data repo's
      list for Codex holds it (or lists nothing), else the first that list
      names, else none — Codex's own. */
  const defaultModel = async (): Promise<string | null> => {
    const [own, listed] = [await settings(), await listedModels()];
    if (own.defaultModel && (listed.length === 0 || listed.includes(own.defaultModel))) return own.defaultModel;
    return listed[0] ?? null;
  };
  const menus = options.offeredModels !== undefined;
  return {
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
      hasAccount: options.signIn !== undefined,
      rememberPermissions: "session",
      oneShot: true,
      ...(menus ? { canChangeModelMidSession: true, effort: true } : {}),
      images: true,
      contextUsage: "totals",
    },
    defaultPermissionMode: "default",
    loginHint: {
      text: "Codex is not signed in on this machine: sign in with your ChatGPT account, or enter the API's address and key, in Settings → Codex.",
    },
    async start(opts: PaneStartOptions): Promise<AgentSession> {
      // The sign-in Settings chose, read afresh for every session: the
      // `-c` overrides and the environment that carry it (src/auth.ts).
      const run = await launch();
      const account = await options.signIn?.().catch(() => undefined);
      const model = opts.model ?? (menus ? await defaultModel() : null);
      const effort = menus ? (opts.effort ?? (await settings()).defaultEffort) : null;
      const session = new CodexSession(
        opts.host,
        opts.name,
        opts.cwd,
        opts.permissionMode,
        model,
        account ?? null,
        effort,
        async (id) => (await offered()).find((m) => m.value === id),
      );
      // The MCP servers the app asks for (AgentStartOptions.mcpServers):
      // the Confluence server while a wiki token is saved.
      const extraArgs = [...run.args, ...(opts.mcpServers?.length ? codexMcpArgs(opts.mcpServers) : [])];
      session.client = new CodexClient({
        cwd: opts.cwd,
        ...(extraArgs.length ? { extraArgs } : {}),
        ...(options.launch ? { env: run.env } : {}),
        onNotification: (method, params) => session.notification(method, params),
        onServerRequest: (id, method, params) => session.request(id, method, params),
        onStderr: session.stderr,
        onExit: (code, error) => session.exited(code, error),
      });
      opts.signal.addEventListener("abort", () => session.close(), { once: true });
      // The prompt is the first turn, once the thread is up; the core shows
      // it in the transcript straight away, and the composer stays closed
      // until Codex has taken it.
      void session.ready(opts.prompt, opts.images);
      return session;
    },
    // The app's one-shot turns (an estimate, say) go through `codex exec`,
    // read-only and without a session: src/oneShot.ts.
    oneShot: options.launch
      ? async (req: OneShotRequest): Promise<OneShotResult> => {
          let run: CodexLaunch;
          try {
            run = await launch();
          } catch (e) {
            return { text: (e as Error).message, isError: true };
          }
          return codexOneShot(req, { args: run.args, env: run.env, model: await defaultModel() });
        }
      : codexOneShot,
    ...(menus
      ? {
          /** The pane's model menu: every model the sign-in offers — the
              API's own list, or Codex's for a ChatGPT account — narrowed to
              the names the data repo lists for Codex when it lists any,
              each with the efforts Codex says it takes; and the model and
              effort a new session starts on. */
          async choices(): Promise<AgentChoices> {
            const models = narrowModels(await offered(), await listedModels()).map((m) => ({
              value: m.value,
              displayName: m.displayName,
              ...(m.description ? { description: m.description } : {}),
              ...(m.efforts ? { efforts: m.efforts } : {}),
            }));
            const account = await options.signIn?.().catch(() => undefined);
            return {
              models,
              model: await defaultModel(),
              effort: (await settings()).defaultEffort,
              ...(account ? { account } : {}),
            };
          },
          /** A pick in the pane becomes Settings → Codex's default. */
          async setDefaults(patch: AgentDefaultsPatch): Promise<void> {
            const saved = {
              ...(patch.model !== undefined ? { defaultModel: patch.model } : {}),
              ...(patch.effort !== undefined ? { defaultEffort: patch.effort } : {}),
            };
            if (Object.keys(saved).length === 0) return;
            if (!options.saveSettings) throw new AgentError(409, "Codex keeps no defaults here");
            await options.saveSettings(saved);
          },
          /** Every model the sign-in offers, for the app's check of the
              data repo's list; null when it offers none. */
          async reportedModels(): Promise<string[] | null> {
            const models = await offered();
            return models.length > 0 ? models.map((m) => m.value) : null;
          },
        }
      : {}),
  };
}

/** Codex on its own config and sign-in, as before Settings → Codex. */
export const codexProvider: PaneProvider = createCodexProvider();
