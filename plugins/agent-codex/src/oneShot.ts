// The app's one-shot turns (src/server/estimate.ts asks the agent registry
// for one: a system prompt, a prompt, a schema to fit, an answer and
// nothing else) through `codex exec`, Codex's non-interactive mode: it
// never asks for approvals, runs read-only here, keeps no session on disk
// (--ephemeral) and writes the agent's last message to a file (-o). It has
// no system-prompt flag, so the system prompt leads the prompt on stdin.
// The schema goes in as a file too (--output-schema); both live in a temp
// folder of the turn's own, gone when it ends. The spawn seam is
// codexChat.ts's, so tests drive a fake child and never spawn one.
//
// Node APIs only (src/server/run.ts): this module also runs under Electron.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "@specdriven/host";
import type { OneShotRequest, OneShotResult } from "@specdriven/host";
import { CODEX_BIN } from "./cli";
import { codexSpawner } from "./codexChat";

/** How long a killed Codex gets to go before the turn is reported without it. */
const KILL_GRACE_MS = 3000;

/** The stderr lines kept for the error text. */
const STDERR_TAIL = 5;

/** The `codex exec` argv for one turn; the prompt itself comes on stdin (`-`). */
export function codexExecArgs(cwd: string, outFile: string, schemaFile: string | null): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-C",
    cwd,
    "--color",
    "never",
    "--json",
    ...(schemaFile ? ["--output-schema", schemaFile] : []),
    "-o",
    outFile,
    "-",
  ];
}

/**
 * The schema as Codex's structured output wants it (OpenAI's strict mode,
 * checked against codex-cli 0.164 on 2026-10-29): every object says
 * `additionalProperties: false` and requires each of its properties. A
 * property the app left optional is required of the model instead, which
 * only makes it answer completely; `maxItems` and the rest pass as given.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    out[key] =
      key === "properties" && value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, strictSchema(v)]))
        : strictSchema(value);
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Record<string, unknown>);
  }
  return out;
}

/** What goes down stdin: the system prompt first, then the question. */
export function codexExecPrompt(req: Pick<OneShotRequest, "systemPrompt" | "prompt">): string {
  return `${req.systemPrompt}\n\n${req.prompt}`;
}

/** One `codex exec` run: how it ended, what it said on stderr, and the errors its event stream carried. */
interface ExecOutcome {
  code: number | null;
  error?: Error;
  killed: "timeout" | "abort" | null;
  stderrTail: string;
  /** What `--json` reported as errors on stdout (`error`, `turn.failed`), in order. */
  errors: string[];
}

/** The error text in one line of the `--json` event stream, if it is one. */
export function eventError(line: string): string | null {
  let event: { type?: unknown; message?: unknown; error?: { message?: unknown } };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  if (event.type === "error" && typeof event.message === "string") return event.message;
  if (event.type === "turn.failed" && typeof event.error?.message === "string") return event.error.message;
  return null;
}

/** Codex's error as a person reads it: a nested API error's innermost message, cut to a line or two. */
function readableError(raw: string): string {
  let text = raw;
  for (let i = 0; i < 4; i++) {
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown; code?: unknown }; message?: unknown };
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner !== "string") break;
      text = inner;
    } catch {
      break;
    }
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export async function codexOneShot(req: OneShotRequest): Promise<OneShotResult> {
  if (req.signal?.aborted) return { text: "Codex was stopped", isError: true };
  const dir = await mkdtemp(join(tmpdir(), "specdriven-codex-oneshot-"));
  try {
    const outFile = join(dir, "last-message.txt");
    let schemaFile: string | null = null;
    if (req.schema) {
      schemaFile = join(dir, "schema.json");
      await writeFile(schemaFile, JSON.stringify(strictSchema(req.schema)), "utf8");
    }
    const outcome = await runExec(req, codexExecArgs(req.cwd, outFile, schemaFile));
    if (outcome.error) {
      return { text: withTail(`Could not start Codex: ${outcome.error.message}`, outcome.stderrTail), isError: true };
    }
    if (outcome.killed === "timeout") return { text: "Codex did not answer in time", isError: true };
    if (outcome.killed === "abort") return { text: "Codex was stopped", isError: true };
    const reported = outcome.errors.length ? readableError(outcome.errors[outcome.errors.length - 1]!) : "";
    if (outcome.code !== 0) {
      return { text: reported || outcome.stderrTail || `Codex exited with code ${outcome.code}`, isError: true };
    }
    const text = (await readFile(outFile, "utf8").catch(() => "")).trim();
    if (!text) return { text: reported || outcome.stderrTail || "Codex gave no answer", isError: true };
    return { text, ...(req.schema ? { structured: parseJson(text) } : {}), isError: false };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function withTail(text: string, tail: string): string {
  return tail ? `${text}\n${tail}` : text;
}

/** The answer as JSON when it parses; the caller keeps the text either way. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Spawn `codex exec`, feed it the prompt, and wait for it to go — on its
 * own, or killed when the request's time is up or its signal aborts.
 */
function runExec(req: OneShotRequest, args: string[]): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    let stderr: string[] = [];
    let stderrRest = "";
    const errors: string[] = [];
    let stdoutRest = "";
    let killed: ExecOutcome["killed"] = null;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      req.signal?.removeEventListener("abort", onAbort);
      const tail = [...stderr, stderrRest].filter((line) => line.trim()).slice(-STDERR_TAIL);
      const last = eventError(stdoutRest);
      if (last) errors.push(last);
      resolve({ code, ...(error ? { error } : {}), killed, stderrTail: tail.join("\n").trim(), errors });
    };

    const child = codexSpawner()({
      bin: which(CODEX_BIN) ?? CODEX_BIN,
      args,
      cwd: req.cwd,
      env: process.env,
      // The JSONL event stream (--json): the answer is in the out file, but
      // an API refusal (a schema it rejects, a model it lacks) is reported
      // only here, as an `error` event, before Codex exits 1.
      onStdout: (chunk) => {
        const lines = (stdoutRest + chunk).split("\n");
        stdoutRest = lines.pop() ?? "";
        for (const line of lines) {
          const message = eventError(line);
          if (message) errors.push(message);
        }
      },
      onStderr: (chunk) => {
        const lines = (stderrRest + chunk).split("\n");
        stderrRest = lines.pop() ?? "";
        stderr = [...stderr, ...lines].slice(-STDERR_TAIL);
      },
      onExit: finish,
    });

    const kill = (why: NonNullable<ExecOutcome["killed"]>) => {
      if (settled || killed) return;
      killed = why;
      child.kill();
      // A Codex that ignores the signal must not hold the turn open.
      grace = setTimeout(() => finish(null), KILL_GRACE_MS);
    };
    const onAbort = () => kill("abort");
    if (settled) return;
    timer = setTimeout(() => kill("timeout"), req.timeoutMs);
    req.signal?.addEventListener("abort", onAbort, { once: true });

    child.write(codexExecPrompt(req));
    child.end();
  });
}
