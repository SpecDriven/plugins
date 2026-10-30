// The app's one-shot turns through Codex (src/oneShot.ts): `codex exec`
// read-only and ephemeral, the prompt on stdin, the answer in the `-o`
// file, the schema in a file of its own. The spawned CLI is swapped for a
// fake the test steers — what it writes into the out file, how it exits —
// so nothing spawns.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setCodexSpawn } from "../src/codexChat";
import type { CodexSpawnOptions } from "../src/codexChat";
import { codexOneShot, eventError, strictSchema } from "../src/oneShot";
import { codexProvider } from "../src/provider";

/** A stand-in for `codex exec`: it records what it was given and exits when told. */
class FakeExec {
  stdin = "";
  ended = false;
  killed = false;
  exited = false;

  constructor(readonly options: CodexSpawnOptions) {}

  write(text: string): void {
    this.stdin += text;
  }

  end(): void {
    this.ended = true;
  }

  kill(): void {
    this.killed = true;
    // The real child dies on SIGTERM; a stubborn one is a test of its own.
    if (!this.stubborn) this.exit(null);
  }

  stubborn = false;

  stderr(line: string): void {
    this.options.onStderr(line + "\n");
  }

  exit(code: number | null, error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.options.onExit(code, error);
  }

  /** The argument after `flag`, or undefined when the flag is missing. */
  arg(flag: string): string | undefined {
    const at = this.options.args.indexOf(flag);
    return at === -1 ? undefined : this.options.args[at + 1];
  }

  get outFile(): string {
    const file = this.arg("-o");
    if (!file) throw new Error("no -o in argv");
    return file;
  }

  /** Write the answer where Codex would, and exit cleanly. */
  async answer(text: string): Promise<void> {
    await writeFile(this.outFile, text, "utf8");
    this.exit(0);
  }
}

let fakes: FakeExec[];
/** Resolves once the next fake has been spawned. */
let spawned: Promise<FakeExec>;

beforeEach(() => {
  fakes = [];
  spawned = new Promise((resolve) => {
    setCodexSpawn((options) => {
      const fake = new FakeExec(options);
      fakes.push(fake);
      resolve(fake);
      return fake;
    });
  });
});

afterEach(() => {
  setCodexSpawn(null);
});

const SCHEMA = { type: "object", properties: { hours: { type: "number" } }, required: ["hours"] };

const request = (overrides: Partial<Parameters<typeof codexOneShot>[0]> = {}) => ({
  cwd: "/work/dir",
  systemPrompt: "You estimate tasks.",
  prompt: "How long is the Quote feature?",
  timeoutMs: 5000,
  ...overrides,
});

const exists = (path: string) => stat(path).then(() => true, () => false);

test("the provider advertises one-shot turns and answers them through codex exec", () => {
  expect(codexProvider.capabilities.oneShot).toBe(true);
  expect(codexProvider.oneShot).toBe(codexOneShot);
});

test("runs `codex exec` read-only, ephemeral, on the work dir, with the schema and out file; the prompt on stdin", async () => {
  const turn = codexOneShot(request({ schema: SCHEMA }));
  const fake = await spawned;
  const args = fake.options.args;
  expect(fake.options.bin.endsWith("codex")).toBe(true);
  expect(fake.options.cwd).toBe("/work/dir");
  expect(args[0]).toBe("exec");
  expect(args).toContain("--ephemeral");
  expect(args).toContain("--skip-git-repo-check");
  expect(fake.arg("-s")).toBe("read-only");
  expect(fake.arg("-C")).toBe("/work/dir");
  expect(fake.arg("--color")).toBe("never");
  expect(args).toContain("--json");
  expect(args.at(-1)).toBe("-");
  const schemaFile = fake.arg("--output-schema")!;
  expect(schemaFile).toBeDefined();
  expect(JSON.parse(await readFile(schemaFile, "utf8"))).toEqual(strictSchema(SCHEMA));
  expect(fake.outFile).toBeDefined();
  expect(dirname(fake.outFile)).toBe(dirname(schemaFile));
  // The system prompt leads the prompt on stdin, which is then closed.
  expect(fake.stdin).toBe("You estimate tasks.\n\nHow long is the Quote feature?");
  expect(fake.ended).toBe(true);

  await fake.answer('{"hours": 3}');
  const result = await turn;
  expect(result).toEqual({ text: '{"hours": 3}', structured: { hours: 3 }, isError: false });
});

test("no schema: no --output-schema, and no structured answer", async () => {
  const turn = codexOneShot(request());
  const fake = await spawned;
  expect(fake.options.args).not.toContain("--output-schema");
  await fake.answer("  Three hours.\n");
  const result = await turn;
  expect(result).toEqual({ text: "Three hours.", isError: false });
  expect("structured" in result).toBe(false);
});

test("an answer that is not JSON under a schema keeps the text and leaves structured undefined", async () => {
  const turn = codexOneShot(request({ schema: SCHEMA }));
  const fake = await spawned;
  await fake.answer("about three hours");
  const result = await turn;
  expect(result.isError).toBe(false);
  expect(result.text).toBe("about three hours");
  expect(result.structured).toBeUndefined();
});

test("a non-zero exit is an error carrying the stderr tail", async () => {
  const turn = codexOneShot(request());
  const fake = await spawned;
  fake.stderr("warning: something minor");
  fake.stderr("error: not logged in");
  fake.exit(1);
  const result = await turn;
  expect(result.isError).toBe(true);
  expect(result.text).toBe("warning: something minor\nerror: not logged in");
});

test("a non-zero exit with nothing on stderr names the code", async () => {
  const turn = codexOneShot(request());
  const fake = await spawned;
  fake.exit(2);
  expect(await turn).toEqual({ text: "Codex exited with code 2", isError: true });
});

test("a clean exit without an answer is an error", async () => {
  const turn = codexOneShot(request());
  const fake = await spawned;
  fake.exit(0);
  expect(await turn).toEqual({ text: "Codex gave no answer", isError: true });
});

test("a codex that never starts is an error naming why", async () => {
  const turn = codexOneShot(request());
  const fake = await spawned;
  fake.exit(null, new Error("spawn codex ENOENT"));
  const result = await turn;
  expect(result.isError).toBe(true);
  expect(result.text).toBe("Could not start Codex: spawn codex ENOENT");
});

test("a child that never answers is killed when the time is up", async () => {
  const turn = codexOneShot(request({ timeoutMs: 50 }));
  const fake = await spawned;
  const result = await turn;
  expect(fake.killed).toBe(true);
  expect(result).toEqual({ text: "Codex did not answer in time", isError: true });
});

test("an aborted signal kills the child", async () => {
  const abort = new AbortController();
  const turn = codexOneShot(request({ signal: abort.signal }));
  const fake = await spawned;
  expect(fake.killed).toBe(false);
  abort.abort();
  const result = await turn;
  expect(fake.killed).toBe(true);
  expect(result).toEqual({ text: "Codex was stopped", isError: true });
});

test("a signal already aborted spawns nothing", async () => {
  const abort = new AbortController();
  abort.abort();
  expect(await codexOneShot(request({ signal: abort.signal }))).toEqual({ text: "Codex was stopped", isError: true });
  expect(fakes).toHaveLength(0);
});

test("the temp files are gone afterwards, answered or not", async () => {
  const answered = codexOneShot(request({ schema: SCHEMA }));
  const first = await spawned;
  const firstDir = dirname(first.outFile);
  expect(await exists(firstDir)).toBe(true);
  await first.answer('{"hours": 1}');
  await answered;
  expect(await exists(firstDir)).toBe(false);
  expect(await exists(first.outFile)).toBe(false);

  const nextSpawn = new Promise<FakeExec>((resolve) => {
    setCodexSpawn((options) => {
      const fake = new FakeExec(options);
      fakes.push(fake);
      resolve(fake);
      return fake;
    });
  });
  const failed = codexOneShot(request({ schema: SCHEMA }));
  const second = await nextSpawn;
  const secondDir = dirname(second.outFile);
  expect(await exists(second.arg("--output-schema")!)).toBe(true);
  second.exit(1);
  await failed;
  expect(await exists(secondDir)).toBe(false);
});

test("the schema goes to Codex in strict form: no extra properties, every property required, nested too", () => {
  const loose = {
    type: "object",
    properties: {
      title: { type: "string" },
      scenarios: {
        type: "array",
        maxItems: 15,
        items: { type: "object", properties: { name: { type: "string" }, sources: { type: "array", items: { type: "string" } } }, required: ["name"] },
      },
    },
    required: ["title"],
  };
  expect(strictSchema(loose)).toEqual({
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      scenarios: {
        type: "array",
        maxItems: 15,
        items: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string" }, sources: { type: "array", items: { type: "string" } } },
          required: ["name", "sources"],
        },
      },
    },
    required: ["title", "scenarios"],
  });
  // What Codex is handed is a copy: the app's schema is left as it was.
  expect(loose.required).toEqual(["title"]);
});

test("an error Codex reports in its event stream names the API's own reason, over a bare exit code", async () => {
  const turn = codexOneShot(request({ schema: SCHEMA }));
  const fake = await spawned;
  fake.options.onStdout('{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.started"}\n');
  const api = JSON.stringify({ error: { code: "UPSTREAM_LLM_ERROR", message: JSON.stringify({ error: { code: "invalid_json_schema", message: "Invalid schema for response_format" } }) } });
  fake.options.onStdout(`{"type":"error","message":${JSON.stringify(api)}}\n{"type":"turn.failed","error":{"message":${JSON.stringify(api)}}}\n`);
  fake.exit(1);
  const result = await turn;
  expect(result.isError).toBe(true);
  expect(result.text).toBe("Invalid schema for response_format");
});

test("event lines that are not errors, or not JSON, carry no error", () => {
  expect(eventError('{"type":"item.completed","item":{}}')).toBeNull();
  expect(eventError("not json")).toBeNull();
  expect(eventError('{"type":"error","message":"boom"}')).toBe("boom");
  expect(eventError('{"type":"turn.failed","error":{"message":"gone"}}')).toBe("gone");
});
