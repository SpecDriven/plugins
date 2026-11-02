// The models the signed-in Claude account offers (specs/agents/claude.feature.md
// "Choose the model Claude starts on", in the specs repo): what Claude Code's
// own /model menu lists for the account, asked of a Claude Code started for
// nothing else — it is handed no prompt, sends nothing to the API and exits
// once it has answered. Settings → Claude's "Default model" offers them while
// Claude signs in with the account. Asked once, then kept until the sign-in
// changes or a few minutes pass.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeLaunch } from "./auth";
import { claudeExecutable } from "./cli";
import { InputQueue, currentQueryFactory, type QueryFactory } from "./provider";
import { normalizeDefaultModel, type ClaudeSettingsValues } from "./settings";

/** One row of the account's model menu. */
export interface AccountModel {
  /** What Claude Code takes as a model: an alias such as `opus`, or an id. */
  value: string;
  /** The model id the value stands for now, when Claude Code says. */
  resolvedModel?: string;
  displayName: string;
  description: string;
}

/** How long Claude Code gets to start and answer. */
export const ACCOUNT_MODELS_TIMEOUT_MS = 20_000;

/** How long an answer is kept before Claude Code is asked again. */
export const ACCOUNT_MODELS_TTL_MS = 10 * 60_000;

/** Claude Code's rows as AccountModels, dropping any that is no model id. */
export function accountModelsOf(rows: unknown): AccountModel[] {
  if (!Array.isArray(rows)) return [];
  const models: AccountModel[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const value = normalizeDefaultModel(row?.value);
    if (!value || models.some((m) => m.value === value)) continue;
    const resolved = normalizeDefaultModel(row.resolvedModel);
    models.push({
      value,
      ...(resolved ? { resolvedModel: resolved } : {}),
      displayName: typeof row.displayName === "string" && row.displayName ? row.displayName : value,
      description: typeof row.description === "string" ? row.description : "",
    });
  }
  return models;
}

/** Ask a Claude Code signed in as the settings say for its model menu. */
export async function fetchAccountModels(
  own: ClaudeSettingsValues,
  cwd: string,
  token: string | null,
  factory: QueryFactory = currentQueryFactory(),
  timeoutMs = ACCOUNT_MODELS_TIMEOUT_MS,
): Promise<AccountModel[]> {
  const launch = await claudeLaunch(own, cwd, token);
  const abortController = new AbortController();
  // No prompt ever comes: the run only starts, answers and is stopped.
  const prompt = new InputQueue<SDKUserMessage>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = await factory({
      prompt,
      options: {
        cwd,
        pathToClaudeCodeExecutable: claudeExecutable() ?? undefined,
        tools: [],
        settingSources: [],
        persistSession: false,
        abortController,
        env: launch.env,
        ...(Object.keys(launch.extraArgs).length ? { extraArgs: launch.extraArgs } : {}),
      },
    });
    if (!query.supportedModels) return [];
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Claude Code did not list its models in time")), timeoutMs);
    });
    return accountModelsOf(await Promise.race([query.supportedModels(), timeout]));
  } finally {
    clearTimeout(timer);
    prompt.close();
    abortController.abort();
  }
}

/** The last answer, and the one being asked for, shared by every caller. */
let cached: { models: AccountModel[]; at: number } | null = null;
let pending: Promise<AccountModel[]> | null = null;

/** The account's models, asked of Claude Code at most once per sign-in and
    TTL; a failed ask is not kept, so the next one tries again. */
export async function accountModels(ask: () => Promise<AccountModel[]>, now = Date.now()): Promise<AccountModel[]> {
  if (cached && now - cached.at < ACCOUNT_MODELS_TTL_MS) return cached.models;
  if (!pending) {
    const asking = ask()
      .then((models) => {
        if (pending === asking) cached = { models, at: Date.now() };
        return models;
      })
      .finally(() => {
        if (pending === asking) pending = null;
      });
    pending = asking;
  }
  return pending;
}

/** Forget the answer: the sign-in changed, so the account may have. */
export function forgetAccountModels(): void {
  cached = null;
  pending = null;
}
