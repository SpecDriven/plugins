// The Codex agent plugin's browser half: its Settings section (specs/
// agents/agent-plugins.feature.md "The Settings page shows a plugin's
// section", in the specs repo) — how the Codex the app starts signs in, and
// the model it starts on — registered after Claude's, before Git. A local
// Codex only, so not in the demo or the hosted app.

import { CORE_SETTINGS_ORDER } from "@specdriven/client";
import type { Context, Plugin, SettingsSectionProps } from "@specdriven/client";
import { CodexSettings, codexModelsOf } from "./ui/CodexSettings";

/** Where the section sits: after Workflow (900) and Claude's (950), before Git (1000). */
export const CODEX_SETTINGS_ORDER = CORE_SETTINGS_ORDER.workflow + 60;

function CodexSection({ settings }: SettingsSectionProps) {
  return <CodexSettings models={codexModelsOf(settings)} />;
}

const plugin: Plugin<Context> = {
  name: "agent-codex",
  inject: ["settings"],
  apply(ctx) {
    const settings = ctx.need("settings");
    ctx.effect(() =>
      settings.add({
        // The agent's id: the app puts Codex's model list in this section.
        id: "codex",
        title: "Codex",
        hint: "How the Codex the app starts signs in — your ChatGPT account, or the API with a key kept on this device — and the model it starts on.",
        order: CODEX_SETTINGS_ORDER,
        when: ({ demo, hosted }) => !demo && !hosted,
        Component: CodexSection,
      }),
    );
  },
};

export default plugin;
