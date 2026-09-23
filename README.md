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
