// The models a menu offers (specs/agents/codex.feature.md "Codex lists the
// models its sign-in offers", in the specs repo): the full list is what the
// sign-in offers — the API's GET <address>/models, or Codex's own list for
// a ChatGPT account (src/models.ts) — and the data repo's
// `.specdriven/codex-models.json` narrows it to the names it lists, when it
// lists any. Pure: the Settings page and the host both use it.

/** The pane's effort levels (the app's EffortLevel), lowest first. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** An effort level, or null when the value is none. */
export function normalizeEffort(value: unknown): EffortLevel | null {
  return (EFFORT_LEVELS as readonly unknown[]).includes(value) ? (value as EffortLevel) : null;
}

/** One row of a model menu. */
export interface CodexModel {
  /** What Codex takes as a model: its id. */
  value: string;
  displayName: string;
  description: string;
  /** The reasoning efforts the model takes, as the pane's levels: Codex's
      own list for it, without the levels the pane has none for (`minimal`,
      `ultra`). Empty: a model Codex sends no effort for. Absent: unknown. */
  efforts?: EffortLevel[];
  /** The effort Codex runs the model at when none is asked for. */
  defaultEffort?: EffortLevel;
}

/** Codex's effort names, in whatever order it lists them, as the pane's
    levels in the pane's order; the ones the pane has none for dropped. */
export function paneEfforts(names: readonly unknown[]): EffortLevel[] {
  return EFFORT_LEVELS.filter((level) => names.includes(level));
}

/**
 * The effort to ask of a model for the level picked: the level itself when
 * the model takes it, else the highest it takes below the level, else its
 * lowest (the pane offers every level for a model it knows nothing of, and
 * "the agent lowers one its model does not take"). Null when the model
 * takes none; the level unchanged when nothing is known of the model.
 */
export function effortFor(level: EffortLevel, model: Pick<CodexModel, "efforts"> | undefined): EffortLevel | null {
  const takes = model?.efforts;
  if (!takes) return level;
  if (takes.length === 0) return null;
  if (takes.includes(level)) return level;
  const rank = EFFORT_LEVELS.indexOf(level);
  const below = takes.filter((e) => EFFORT_LEVELS.indexOf(e) < rank);
  return below.at(-1) ?? takes[0]!;
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
