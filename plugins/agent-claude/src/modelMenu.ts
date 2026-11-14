// The models a menu offers (specs/agents/agent-plugins.feature.md "Each
// agent offers the models the data repo lists", in the specs repo): the
// full list is what the sign-in offers — the account's models, the proxy's
// GET /v1/models, else Claude Code's aliases — and the data repo's
// `.specdriven/agent-models.json` narrows it to the names it lists, when it
// lists any. Pure: the Settings page and the host both use it.

/** The least a menu row holds; AccountModel and the host's AgentModelOption both do. */
export interface MenuRow {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
}

/**
 * The full list narrowed to the names the data repo lists, in the data
 * repo's order: each name is the full list's row for it (by value, else by
 * the id an alias resolves to), or a bare row when the full list has none —
 * a name listed on purpose is not dropped. An empty list narrows nothing.
 */
export function narrowModels<T extends MenuRow>(all: readonly T[], listed: readonly string[]): (T | MenuRow)[] {
  if (listed.length === 0) return [...all];
  const out: (T | MenuRow)[] = [];
  for (const name of listed) {
    const row = all.find((m) => m.value === name) ?? all.find((m) => m.resolvedModel === name);
    out.push(row ?? { value: name, displayName: name, description: "" });
  }
  return out;
}

/**
 * Whether a model is on the menu: a row of the full list narrowed to the
 * names the data repo lists, or the same model under its other name — an
 * alias whose id is on it, or the id of an alias on it. A model the sign-in
 * does not offer (one chosen under another sign-in) is not. With nothing
 * offered there is nothing to hold it against: the listed names alone, and
 * with none listed either, any model.
 */
export function inList(model: string, all: readonly MenuRow[], listed: readonly string[]): boolean {
  if (listed.includes(model)) return true;
  if (all.length === 0) return listed.length === 0;
  return narrowModels(all, listed).some((m) => m.value === model || m.resolvedModel === model);
}
