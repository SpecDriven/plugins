// The models the signed-in Claude account offers (specs/agents/claude.feature.md
// "Choose the model Claude starts on", in the specs repo): what Claude Code's
// own /model menu lists for the account, asked of a Claude Code started for
// nothing else — it is handed no prompt, sends nothing to the API and exits
// once it has answered. Settings → Claude's "Default model" offers them while
// Claude signs in with the account. Asked once, then kept until the sign-in
// changes or a few minutes pass.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatAccount } from "@specdriven/host";
import { claudeLaunch } from "./auth";
import { claudeExecutable } from "./cli";
import { InputQueue, currentQueryFactory, describeAccount, type QueryFactory } from "./provider";
import { CLAUDE_EFFORTS, normalizeDefaultModel, type ClaudeEffort, type ClaudeSettingsValues } from "./settings";

/** One row of the account's model menu. */
export interface AccountModel {
  /** What Claude Code takes as a model: an alias such as `opus`, or an id. */
  value: string;
  /** The model id the value stands for now, when Claude Code says. */
  resolvedModel?: string;
  displayName: string;
  description: string;
  /** The effort levels the model takes; absent when Claude Code does not
      say, [] when it takes none. */
  efforts?: ClaudeEffort[];
}

/** A row's effort levels: none when it says it takes none, its list when
    it gives one, else not known. */
function effortsOf(row: Record<string, unknown>): ClaudeEffort[] | undefined {
  if (row.supportsEffort === false) return [];
  if (!Array.isArray(row.supportedEffortLevels)) return undefined;
  return CLAUDE_EFFORTS.filter((e) => (row.supportedEffortLevels as unknown[]).includes(e));
}

/** How long Claude Code gets to start and answer. */
export const ACCOUNT_MODELS_TIMEOUT_MS = 20_000;

/** How long an answer is kept before Claude Code is asked again. */
export const ACCOUNT_MODELS_TTL_MS = 10 * 60_000;

/** The model family a value names: an alias is its own (`opus`), a model
    id's is the word after `claude-` (`claude-opus-4-8[1m]` → `opus`); null
    for an id of another shape, which stands alone. */
export function modelFamily(value: string): string | null {
  if (!value.includes("-")) return value.toLowerCase();
  const match = /^claude-([a-z]+)/i.exec(value);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Claude Code's rows as AccountModels, dropping any that is no model id,
 * and one row per model family: the first Claude Code lists — the alias
 * where it has one (`opus`, `sonnet`, `haiku`, Fable's id) — never the
 * explicit ids of the same models an organization is also offered
 * (`claude-opus-4-8`, `claude-opus-4-7`, …), which only lengthen the menu.
 */
export function accountModelsOf(rows: unknown): AccountModel[] {
  if (!Array.isArray(rows)) return [];
  const models: AccountModel[] = [];
  const families = new Set<string>();
  for (const row of rows as Record<string, unknown>[]) {
    const value = normalizeDefaultModel(row?.value);
    if (!value || models.some((m) => m.value === value)) continue;
    const family = modelFamily(value);
    if (family) {
      if (families.has(family)) continue;
      families.add(family);
    }
    const resolved = normalizeDefaultModel(row.resolvedModel);
    const efforts = effortsOf(row);
    models.push({
      value,
      ...(resolved ? { resolvedModel: resolved } : {}),
      displayName: typeof row.displayName === "string" && row.displayName ? row.displayName : value,
      description: typeof row.description === "string" ? row.description : "",
      ...(efforts ? { efforts } : {}),
    });
  }
  return models;
}

/** What a Claude Code started under the sign-in found: the account it
    runs as — null when it did not say — and the models it offers, none
    when it found no account, token or key. */
export interface AccountProbe {
  account: ChatAccount | null;
  models: AccountModel[];
}

export const NO_ACCOUNT: AccountProbe = { account: null, models: [] };

/** Ask a Claude Code signed in as the settings say who it runs as and for
    its model menu. The model menu is Claude Code's own list and needs no
    credential, so the account it reports (its accountInfo, the pane's
    chip) is what proves the sign-in: with none, there are no models. */
export async function fetchAccountModels(
  own: ClaudeSettingsValues,
  cwd: string,
  token: string | null,
  factory: QueryFactory = currentQueryFactory(),
  timeoutMs = ACCOUNT_MODELS_TIMEOUT_MS,
): Promise<AccountProbe> {
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
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Claude Code did not list its models in time")), timeoutMs);
    });
    const info = query.accountInfo ? await Promise.race([query.accountInfo(), timeout]) : undefined;
    const account = info ? describeAccount(info, launch.apiBaseUrl) : null;
    if (account?.billing === "none" || !query.supportedModels) return { account, models: [] };
    return { account, models: accountModelsOf(await Promise.race([query.supportedModels(), timeout])) };
  } finally {
    clearTimeout(timer);
    prompt.close();
    abortController.abort();
  }
}

/** The last answer, and the one being asked for, shared by every caller,
    each with the sign-in it is for. */
let cached: { key: string; probe: AccountProbe; at: number } | null = null;
let pending: { key: string; asking: Promise<AccountProbe> } | null = null;

/** The account and its models, asked of Claude Code at most once per
    sign-in and TTL; a failed ask is not kept, so the next one tries again.
    `key` names the sign-in the answer is for — the account, or a proxy
    and its token: an answer kept or being asked for under another key is
    not given, so a sign-in that changed without a forget (Claude Code's
    own settings), or while an answer was on its way, gets its own. */
export async function accountModels(ask: () => Promise<AccountProbe>, now = Date.now(), key = ""): Promise<AccountProbe> {
  if (cached && cached.key === key && now - cached.at < ACCOUNT_MODELS_TTL_MS) return cached.probe;
  if (pending?.key !== key) {
    const mine: { key: string; asking: Promise<AccountProbe> } = { key, asking: Promise.resolve(NO_ACCOUNT) };
    mine.asking = ask()
      .then((probe) => {
        if (pending === mine) cached = { key, probe, at: Date.now() };
        return probe;
      })
      .finally(() => {
        if (pending === mine) pending = null;
      });
    pending = mine;
  }
  return pending.asking;
}

/** Forget the answer: the sign-in changed, so the account may have. */
export function forgetAccountModels(): void {
  cached = null;
  pending = null;
}
