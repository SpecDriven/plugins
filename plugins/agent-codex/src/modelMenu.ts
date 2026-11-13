// The models a menu offers (specs/agents/codex.feature.md "Codex lists the
// models its sign-in offers", in the specs repo): the full list is what the
// sign-in offers — the API's GET <address>/models, or Codex's own list for
// a ChatGPT account (src/models.ts) — and the data repo's
// `.specdriven/codex-models.json` narrows it to the names it lists, when it
// lists any. Pure: the Settings page and the host both use it.

/** One row of a model menu. */
export interface CodexModel {
  /** What Codex takes as a model: its id. */
  value: string;
  displayName: string;
  description: string;
}

/**
 * The full list narrowed to the names the data repo lists, in the data
 * repo's order: each name is the full list's row for it, or a bare row
 * when the full list has none — a name listed on purpose is not dropped.
 * An empty list narrows nothing.
 */
export function narrowModels(all: readonly CodexModel[], listed: readonly string[]): CodexModel[] {
  if (listed.length === 0) return [...all];
  return listed.map((name) => all.find((m) => m.value === name) ?? { value: name, displayName: name, description: "" });
}

/** An option's text: the name the sign-in gives the model, then its id. */
export function modelLabel(model: CodexModel): string {
  return model.displayName && model.displayName !== model.value ? `${model.displayName} — ${model.value}` : model.value;
}
