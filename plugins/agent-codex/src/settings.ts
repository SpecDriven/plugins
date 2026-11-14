// The plugin's own settings (specs/agents/codex.feature.md "Choose how
// Codex signs in", in the specs repo): how the Codex the app starts signs
// in — the ChatGPT account the Codex CLI is signed in to, or the API — the
// API's address, the model a new Codex starts on ("Codex lists the models
// its sign-in offers") and the reasoning effort it runs at ("Codex offers
// the reasoning efforts its model takes"). Kept in the plugin's section of
// the settings file (HostConfig.settings); the API key is a secret and
// lives in the plugin's secret store instead (src/host.ts). Pure, so the
// host and browser halves share it.

import { normalizeEffort, type EffortLevel } from "./modelMenu";

/** How the app's Codex signs in: the ChatGPT account, or the API. */
export type CodexAuthMode = "login" | "api";

export const CODEX_AUTH_MODES: readonly CodexAuthMode[] = ["login", "api"];

/** Where Codex sends its API calls when a key is all that is set. */
export const OPENAI_API_URL = "https://api.openai.com/v1";

export interface CodexSettingsValues {
  /** The stored choice, or null when the host infers one. */
  codexAuth: CodexAuthMode | null;
  /** The API address the plugin stores, or null for the one Codex's own config names. */
  codexApiUrl: string | null;
  /** The model a new Codex starts on, or null for Codex's own default. */
  defaultModel: string | null;
  /** The reasoning effort a new Codex runs at, or null for the model's own default. */
  defaultEffort: EffortLevel | null;
}

export const DEFAULT_SETTINGS: CodexSettingsValues = {
  codexAuth: null,
  codexApiUrl: null,
  defaultModel: null,
  defaultEffort: null,
};

/** Letters, digits and the punctuation model ids use — `gpt-5.1-codex`,
    `openai/gpt-5`, a deployment's name — with no spaces. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/;

/** A model id, trimmed, or null when absent or not one. */
export function normalizeModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return MODEL_ID.test(model) ? model : null;
}

/** Stored sign-in choice, or null when absent or unusable. */
export function normalizeCodexAuth(value: unknown): CodexAuthMode | null {
  return (CODEX_AUTH_MODES as readonly unknown[]).includes(value) ? (value as CodexAuthMode) : null;
}

/** Stored API address — an http(s) url, as Codex's `base_url` takes it
    (`https://api.openai.com/v1`), without a trailing slash — or null when
    absent or not a url. */
export function normalizeCodexApiUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim().replace(/\/+$/, "");
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The plugin's values off its settings section. */
export function codexSettingsOf(section: Record<string, unknown>): CodexSettingsValues {
  return {
    codexAuth: normalizeCodexAuth(section.codexAuth),
    codexApiUrl: normalizeCodexApiUrl(section.codexApiUrl),
    defaultModel: normalizeModel(section.defaultModel),
    defaultEffort: normalizeEffort(section.defaultEffort),
  };
}

/**
 * A `PUT /api/codex/settings` body as a patch to the section, or the
 * refusal: `codexAuth` login, api or null (forget the choice);
 * `codexApiUrl` an http(s) url, "" or null (forget it); `defaultModel` a
 * model id, "" or null (Codex's own default); `defaultEffort` an effort
 * level or null (the model's own default).
 */
export function codexSettingsPatch(body: unknown): { patch: Record<string, unknown> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "a settings object is required" };
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (b.codexAuth !== undefined) {
    if (b.codexAuth === null) patch.codexAuth = null;
    else {
      const mode = normalizeCodexAuth(b.codexAuth);
      if (!mode) return { error: "codexAuth must be login, api or null" };
      patch.codexAuth = mode;
    }
  }
  if (b.codexApiUrl !== undefined) {
    if (b.codexApiUrl !== null && typeof b.codexApiUrl !== "string") {
      return { error: "codexApiUrl must be a string or null" };
    }
    const typed = (b.codexApiUrl ?? "").trim();
    const url = normalizeCodexApiUrl(typed);
    if (typed && !url) return { error: "codexApiUrl must be an http:// or https:// url" };
    patch.codexApiUrl = url;
  }
  if (b.defaultModel !== undefined) {
    if (b.defaultModel !== null && typeof b.defaultModel !== "string") {
      return { error: "defaultModel must be a string or null" };
    }
    const model = (b.defaultModel ?? "").trim();
    if (model && !normalizeModel(model)) return { error: "Enter a model id, with no spaces" };
    patch.defaultModel = model || null;
  }
  if (b.defaultEffort !== undefined) {
    const effort = normalizeEffort(b.defaultEffort);
    if (b.defaultEffort !== null && !effort) return { error: "defaultEffort must be low, medium, high, xhigh, max or null" };
    patch.defaultEffort = effort;
  }
  if (Object.keys(patch).length === 0) {
    return { error: "codexAuth, codexApiUrl, defaultModel or defaultEffort is required" };
  }
  return { patch };
}
