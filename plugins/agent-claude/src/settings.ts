// The plugin's own settings (specs/agents/claude.feature.md "Choose how
// Claude signs in", specs/agents/agent-pane.feature.md "A Claude turn fails
// fast when the API proxy does not answer", in the specs repo): how the
// Claude the app starts signs in, the proxy it goes through, and how long a
// turn behind that proxy waits for the API. Kept in the plugin's section of
// settings.json (HostConfig.settings); the top-level keys they lived under
// while Claude was built into the app are adopted once (src/host.ts). Pure,
// so the host and browser halves share it.

/** The top-level settings keys the values lived under before this plugin. */
export const CLAUDE_LEGACY_KEYS = ["claudeAuth", "claudeProxyUrl", "agentFirstResponseSeconds"] as const;

/** Set in the section once the plugin took the old keys over. */
export const ADOPTED_KEY = "adopted";

/** How the app's Claude signs in: the claude.ai login, or an API proxy. */
export type ClaudeAuthMode = "login" | "proxy";

export const CLAUDE_AUTH_MODES: readonly ClaudeAuthMode[] = ["login", "proxy"];

/** The pane's first-response watchdog: a proxy that is down gets this many
    seconds rather than Claude Code's minutes of retries. */
export const DEFAULT_AGENT_FIRST_RESPONSE_SECONDS = 15;

export interface ClaudeSettingsValues {
  /** The stored choice, or null when the host infers one. */
  claudeAuth: ClaudeAuthMode | null;
  /** The proxy url the plugin stores, or null for the one Claude Code's own settings name. */
  claudeProxyUrl: string | null;
  /** The pane's first-response wait, whole seconds; 0 is no limit. */
  firstResponseSeconds: number;
}

export const DEFAULT_SETTINGS: ClaudeSettingsValues = {
  claudeAuth: null,
  claudeProxyUrl: null,
  firstResponseSeconds: DEFAULT_AGENT_FIRST_RESPONSE_SECONDS,
};

/** Stored sign-in choice, or null when absent or unusable. */
export function normalizeClaudeAuth(value: unknown): ClaudeAuthMode | null {
  return (CLAUDE_AUTH_MODES as readonly unknown[]).includes(value) ? (value as ClaudeAuthMode) : null;
}

/** Stored proxy base url — an http(s) url, kept as typed (a trailing slash
    is Claude Code's to interpret) — or null when absent or not a url. */
export function normalizeClaudeProxyUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Effective first-response wait for a stored value: whole seconds, 0 for
    "no limit"; anything absent or unusable is the default. */
export function normalizeAgentFirstResponseSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AGENT_FIRST_RESPONSE_SECONDS;
  return Math.floor(n);
}

/** The plugin's values off its settings section. */
export function claudeSettingsOf(section: Record<string, unknown>): ClaudeSettingsValues {
  return {
    claudeAuth: normalizeClaudeAuth(section.claudeAuth),
    claudeProxyUrl: normalizeClaudeProxyUrl(section.claudeProxyUrl),
    firstResponseSeconds: normalizeAgentFirstResponseSeconds(section.agentFirstResponseSeconds),
  };
}

/**
 * A `PUT /api/claude/settings` body as a patch to the section, or the
 * refusal: `claudeAuth` login, proxy or null (forget the choice);
 * `claudeProxyUrl` an http(s) url, "" or null (forget it);
 * `firstResponseSeconds` a number >= 0, the default stored as no key.
 */
export function claudeSettingsPatch(body: unknown): { patch: Record<string, unknown> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "a settings object is required" };
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (b.claudeAuth !== undefined) {
    if (b.claudeAuth === null) patch.claudeAuth = null;
    else {
      const mode = normalizeClaudeAuth(b.claudeAuth);
      if (!mode) return { error: "claudeAuth must be login, proxy or null" };
      patch.claudeAuth = mode;
    }
  }
  if (b.claudeProxyUrl !== undefined) {
    if (b.claudeProxyUrl !== null && typeof b.claudeProxyUrl !== "string") {
      return { error: "claudeProxyUrl must be a string or null" };
    }
    const url = (b.claudeProxyUrl ?? "").trim();
    if (url && !normalizeClaudeProxyUrl(url)) return { error: "claudeProxyUrl must be an http:// or https:// url" };
    patch.claudeProxyUrl = url || null;
  }
  if (b.firstResponseSeconds !== undefined) {
    const n = b.firstResponseSeconds;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return { error: "firstResponseSeconds must be a number >= 0" };
    }
    patch.agentFirstResponseSeconds = Math.floor(n) === DEFAULT_AGENT_FIRST_RESPONSE_SECONDS ? null : Math.floor(n);
  }
  if (Object.keys(patch).length === 0) return { error: "claudeAuth, claudeProxyUrl or firstResponseSeconds is required" };
  return { patch };
}
