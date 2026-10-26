// Pi in the coding agent pane (specs/agents/integration-with-pi-dev-agent
// .feature.md): `pi --mode rpc` over JSON lines (src/server/piChat.ts).
// Commands out on stdin, events in on stdout. Pi has no permission protocol
// and no control channel — a turn is a `prompt` command, a stop is `abort`,
// and the session ends when the process does. So the provider declares no
// permission modes, and the pane never raises a permission card for it. An
// AgentProvider (src/plugins/host/agents.ts).
//
// Node APIs only (src/server/run.ts): this module also runs under Electron.

import type { AgentHost, AgentProvider, AgentSession, AgentStartOptions } from "@specdriven/host";
import { PI_BIN, piAvailable } from "./cli";
import { PiClient, mapPiEvent, newPiStream, piCommands, piState } from "./piChat";
import type { PiEvent, PiStreamContext } from "./piChat";

/** The refusal when no `pi` is on PATH. */
export const PI_MISSING = "Pi CLI not found — install the `pi` command (https://pi.dev)";

/** The chip's tooltip, and the one thing a Claude user must not assume here. */
export const PI_NO_PERMISSIONS = "Pi runs its own tools — SpecDriven cannot gate them, so nothing asks for permission.";

class PiSession implements AgentSession {
  client: PiClient | null = null;
  private readonly stream: PiStreamContext = newPiStream();
  private stderrTail: string[] = [];

  constructor(
    private readonly host: AgentHost,
    private readonly cwd: string,
  ) {}

  get final(): boolean {
    return this.host.status() === "ended" || this.host.status() === "error";
  }

  readonly stderr = (line: string): void => {
    this.stderrTail = [...this.stderrTail, line].slice(-5);
  };

  /**
   * Pi answers commands as soon as its RPC loop is up, so the first answer
   * is what says the session is ready to type into — and it brings the
   * model, pi's own session id and the "/" commands.
   */
  async ready(): Promise<void> {
    const client = this.client!;
    const [state, commands] = await Promise.all([
      client.request({ type: "get_state" }),
      client.request({ type: "get_commands" }),
    ]);
    if (this.final) return;
    const info = piState(state.data);
    this.host.note("info", "init", `Pi · ${info.model ?? "no model"} · ${this.cwd}`);
    this.host.note("info", "init", PI_NO_PERMISSIONS);
    this.host.ready({
      ...(info.model ? { model: info.model } : {}),
      ...(info.sessionId ? { agentSessionId: info.sessionId } : {}),
      commands: piCommands(commands.data),
    });
  }

  event(event: PiEvent): void {
    if (this.final) return;
    if (event.type === "agent_start") this.host.turnStarted();
    for (const body of mapPiEvent(event, { turn: this.host.turn() }, this.stream)) this.host.emit(body);
    if (event.type === "agent_settled") this.host.turnEnded();
  }

  /** Pi is gone: an exit code of its own, or an Error where it never started. */
  exited(code: number | null, error?: Error): void {
    if (this.final) return;
    const tail = this.stderrTail.join("\n");
    const detail = (text: string) => (tail ? `${text}\n${tail}` : text);
    if (error) return this.host.failed(detail(`Could not start Pi: ${error.message}`), "spawn_failed");
    if (code === 0 || code === null) return this.host.ended("Pi exited.");
    this.host.failed(detail(`Pi exited with code ${code}.`));
  }

  async send(text: string): Promise<void> {
    this.client!.send({ type: "prompt", message: text });
  }

  async interrupt(): Promise<void> {
    // Pi answers `abort` only once it is idle again; the turn's own
    // `agent_settled` is what puts the session back to idle.
    await this.client!.request({ type: "abort" });
  }

  async setPermissionMode(): Promise<void> {
    // Never reached: the core refuses a mode for a provider that declares none.
  }

  close(): void {
    this.client?.close();
  }
}

export const piProvider: AgentProvider = {
  id: "pi",
  label: "Pi",
  description: "Minimal, and runs its own tools — nothing asks for permission",
  rank: 30,
  cli: PI_BIN,
  available: piAvailable,
  missingMessage: PI_MISSING,
  capabilities: {
    permissionModes: [],
    noPermissionsNote: "Pi runs its own tools — SpecDriven cannot gate them",
    canInterrupt: true,
    canChangeModeMidSession: false,
    hasAccount: false,
    rememberPermissions: "none",
    oneShot: false,
  },
  // Pi runs its own tools with no gate of any kind; any other mode would
  // promise a prompt that never comes.
  defaultPermissionMode: "bypassPermissions",
  loginHint: {
    text: "Pi has no credentials for this model here: run pi in a terminal and /login, then start a new session.",
    command: "pi",
  },
  async start(opts: AgentStartOptions): Promise<AgentSession> {
    const session = new PiSession(opts.host, opts.cwd);
    session.client = new PiClient({
      cwd: opts.cwd,
      name: opts.name,
      onEvent: (event) => session.event(event),
      onStderr: session.stderr,
      onExit: (code, error) => session.exited(code, error),
    });
    opts.signal.addEventListener("abort", () => session.close(), { once: true });
    // The prompt can go before pi has read a byte: the pipe holds it until
    // its RPC loop starts.
    if (opts.prompt) await session.send(opts.prompt);
    void session.ready();
    return session;
  },
};
