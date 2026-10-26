# plugins

The SpecDriven plugin marketplace: a git repository with `marketplace.json`
at its root, which the app reads from Settings → Plugins → Marketplaces
(it is the default index). Each row names a plugin, a description, a
version, a category and a source — a git url pinned to a `ref`, or a
subdirectory of this repository. Plugins listed here ship `dist/`, built
with `specdriven plugin build`, since the desktop app cannot build them.

Installing one is a consent step first: the app shows the plugin's name,
version, description and the permissions its manifest declares, and notes
that it runs in the app's own process with the app's rights.

## Rows

A row's `name` is the plugin's manifest id (`specdriven.id` in its
package.json): the app installs by that name and refuses a clone whose
manifest says otherwise. `version`, `category` and `api` are what the index
claims; the manifest is checked again after the clone.

## Coding agents

The `agents` category holds the plugins that put a coding agent in the
app's agent pane — `agent-claude`, `agent-codex` and `agent-pi`. Each row
also carries `agent: { id, command }`: the provider id the plugin registers
and the command it needs on PATH. The app looks for those commands on this
machine and installs the plugin for each it finds, so a developer with
`codex` installed gets Codex in the pane without a visit to the marketplace;
the pane's empty state offers the rest.
