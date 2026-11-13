// The app's one-shot turns (an estimate: a system prompt, a prompt, a
// schema to fit, an answer and nothing else) through `opencode run`,
// OpenCode's non-interactive mode, with its read-only Plan agent, on a
// private server (--standalone: the CLI's background service is not
// started for it) and the session archived so it stays out of OpenCode's
// session list. The message goes in on stdin — no length limit, and
// nothing in it read as a flag. It prints its events as JSON lines
// (--format json): `text` parts carry the answer, an `error` event the
// reason there is none. It has no system-prompt flag, so the system prompt
// leads the message, and the schema goes in as words. The spawn seam is
// acp.ts's, so tests drive a fake child.
//
// Node APIs only (src/server/run.ts in the app): this module also runs
// under Electron.

import { jsonlReader } from "@specdriven/host";
import type { OneShotRequest, OneShotResult } from "@specdriven/host";
import { opencodePath } from "./cli";
import { opencodeSpawner, record } from "./acp";

/** The stderr lines kept for the error text. */
const STDERR_TAIL = 5;

/** The `opencode run` argv for one turn; the message itself comes on stdin. */
export function runArgs(model?: string): string[] {
  return ["run", "--standalone", "--format", "json", "--agent", "plan", "--archived", ...(model ? ["-m", model] : [])];
}

/** The one message: the system prompt, the question, and the schema the answer must fit. */
export function oneShotMessage(req: Pick<OneShotRequest, "systemPrompt" | "prompt" | "schema">): string {
  const parts = [req.systemPrompt, req.prompt];
  if (req.schema) {
    parts.push(
      `Answer with one JSON value and nothing else — no prose, no code fence — that fits this JSON schema:\n${JSON.stringify(req.schema)}`,
    );
  }
  return parts.filter((p) => p.trim()).join("\n\n");
}

/** The answer as JSON when it parses (a code fence around it is forgiven). */
export function parseAnswer(text: string): unknown {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  try {
    return JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    return undefined;
  }
}

export async function opencodeOneShot(req: OneShotRequest): Promise<OneShotResult> {
  if (req.signal?.aborted) return { text: "OpenCode was stopped", isError: true };
  return new Promise<OneShotResult>((resolve) => {
    const texts: string[] = [];
    const errors: string[] = [];
    let stderr: string[] = [];
    let killed: "timeout" | "abort" | null = null;
    let settled = false;
    const readStdout = jsonlReader((line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "text") {
        const part = record(event.part);
        if (part && typeof part.text === "string") texts.push(part.text);
      } else if (event.type === "error") {
        const error = record(event.error);
        const message = error && typeof error.message === "string" ? error.message : null;
        errors.push(message ?? "OpenCode failed");
      }
    });
    const readStderr = jsonlReader((line) => {
      stderr = [...stderr, line].slice(-STDERR_TAIL);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proc: { kill(): void } | null = null;
    const onAbort = () => {
      killed = "abort";
      proc?.kill();
    };
    const finish = (result: OneShotResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const child = opencodeSpawner()({
      bin: opencodePath(),
      args: runArgs(req.model),
      cwd: req.cwd,
      env: process.env,
      onStdout: readStdout,
      onStderr: readStderr,
      onExit: (code, error) => {
        const tail = stderr.join("\n");
        if (error) return finish({ text: `Could not start OpenCode: ${error.message}${tail ? `\n${tail}` : ""}`, isError: true });
        if (killed === "timeout") return finish({ text: "OpenCode did not answer in time", isError: true });
        if (killed === "abort") return finish({ text: "OpenCode was stopped", isError: true });
        const text = texts.join("").trim();
        if (errors.length > 0 && !text) return finish({ text: errors.at(-1)!, isError: true });
        if (code !== 0 && code !== null && !text) {
          return finish({ text: tail || `OpenCode exited with code ${code}`, isError: true });
        }
        if (!text) return finish({ text: tail || "OpenCode gave no answer", isError: true });
        finish({ text, ...(req.schema ? { structured: parseAnswer(text) } : {}), isError: false });
      },
    });
    proc = child;
    child.write(oneShotMessage(req));
    child.end();
    if (settled) return;
    timer = setTimeout(() => {
      killed = "timeout";
      child.kill();
    }, req.timeoutMs);
    req.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
