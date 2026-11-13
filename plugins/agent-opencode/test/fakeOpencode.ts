// A fake `opencode acp` the tests steer from both ends: the JSON-RPC
// messages the app writes, and the updates and requests OpenCode "sends".
// It answers the handshake and config changes itself and holds every
// `session/prompt` until the test answers it.

import type { OpencodeProcess, OpencodeSpawnOptions } from "../src/acp";

export type Message = Record<string, unknown> & { id?: number | string; method?: string; params?: Record<string, unknown> };

export const MODELS = ["cerebras/gpt-oss-120b", "openai/gpt-6", "anthropic/claude-opus-5-5"];

function select(id: string, category: string, current: string, values: string[]) {
  return { id, name: id, category, type: "select", currentValue: current, options: values.map((value) => ({ value, name: value })) };
}

export class FakeOpencode implements OpencodeProcess {
  readonly written: Message[] = [];
  readonly sessionId = "ses_fake_1";
  model = MODELS[0]!;
  effort = "default";
  mode = "build";
  /** Fail `session/new` with this message. */
  failNew: string | null = null;
  /** Everything written to stdin, as it came (a one-shot's message is plain text). */
  stdin = "";
  private buffer = "";
  private exited = false;
  ended = false;
  killed = false;

  constructor(readonly options: OpencodeSpawnOptions) {}

  configOptions() {
    return [
      select("model", "model", this.model, MODELS),
      select("effort", "thought_level", this.effort, ["low", "medium", "high", "xhigh", "default"]),
      select("mode", "mode", this.mode, ["build", "plan"]),
    ];
  }

  write(text: string): void {
    this.stdin += text;
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        continue; // not JSON-RPC: a one-shot's message
      }
      this.written.push(message);
      this.autoAnswer(message);
    }
  }

  end(): void {
    this.ended = true;
  }

  kill(): void {
    this.killed = true;
    this.exit(null);
  }

  /** One line from OpenCode. */
  send(message: Record<string, unknown>): void {
    this.options.onStdout(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  update(update: Record<string, unknown>): void {
    this.send({ method: "session/update", params: { sessionId: this.sessionId, update } });
  }

  stderr(line: string): void {
    this.options.onStderr(line + "\n");
  }

  exit(code: number | null, error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.options.onExit(code, error);
  }

  /** The requests the app made of a method, in order. */
  calls(method: string): Message[] {
    return this.written.filter((m) => m.method === method);
  }

  /** The app's answer to OpenCode's request `id`. */
  answer(id: number | string): Message | undefined {
    return this.written.find((m) => m.id === id && m.method === undefined);
  }

  /** Answer the latest `session/prompt`. */
  finishPrompt(result: Record<string, unknown> = { stopReason: "end_turn" }): void {
    const prompt = this.calls("session/prompt").at(-1)!;
    this.send({ id: prompt.id, result });
  }

  failPrompt(message: string): void {
    const prompt = this.calls("session/prompt").at(-1)!;
    this.send({ id: prompt.id, error: { code: -32603, message } });
  }

  private autoAnswer(message: Message): void {
    const { id, method, params } = message;
    if (id === undefined || !method) return;
    if (method === "initialize") {
      this.send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          agentInfo: { name: "OpenCode", version: "9.9.9" },
        },
      });
    } else if (method === "session/new") {
      if (this.failNew) {
        this.send({ id, error: { code: -32603, message: this.failNew } });
        return;
      }
      this.send({ id, result: { sessionId: this.sessionId, configOptions: this.configOptions() } });
      this.update({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "review changes" }],
      });
    } else if (method === "session/set_config_option") {
      const value = String(params?.value);
      if (params?.configId === "model") {
        if (!MODELS.includes(value)) {
          this.send({ id, error: { code: -32602, message: `Unknown model ${value}` } });
          return;
        }
        this.model = value;
      }
      if (params?.configId === "effort") this.effort = value;
      if (params?.configId === "mode") this.mode = value;
      this.send({ id, result: { configOptions: this.configOptions() } });
    }
  }
}
