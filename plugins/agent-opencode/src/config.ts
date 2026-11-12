// What the plugin changes of OpenCode's configuration, for its own process
// only: OpenCode reads extra config as JSON from OPENCODE_CONFIG_CONTENT,
// over the user's files, so the user's opencode.json is never written.
//
// OpenCode's own default is to run edits and shell commands without
// asking. The pane's permission modes need it to ask, so a session's
// process sets those permissions to "ask" and the plugin answers each
// request itself where the mode says so (bypass: every one; accept edits:
// the edits), and raises a card for the rest. That keeps a mode change
// instant — the process never restarts — and a "deny" the user set in the
// same variable stands.

/** The permissions a pane session's OpenCode asks for. */
export const ASKED_PERMISSIONS = ["edit", "bash", "webfetch"] as const;

/**
 * The OPENCODE_CONFIG_CONTENT for a pane session: the one the environment
 * already has, if it is a JSON object, with ASKED_PERMISSIONS set to "ask"
 * — except one it sets to "deny".
 */
export function sessionConfigContent(existing: string | undefined): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // Not JSON: OpenCode would refuse it anyway; ours replaces it.
    }
  }
  const own = base.permission;
  const permission: Record<string, unknown> =
    own && typeof own === "object" && !Array.isArray(own) ? { ...(own as Record<string, unknown>) } : {};
  for (const key of ASKED_PERMISSIONS) {
    if (permission[key] !== "deny") permission[key] = "ask";
  }
  return JSON.stringify({ ...base, permission });
}

/** The environment a pane session's `opencode acp` runs in. */
export function sessionEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return { ...env, OPENCODE_CONFIG_CONTENT: sessionConfigContent(env.OPENCODE_CONFIG_CONTENT) };
}
