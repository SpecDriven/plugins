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

## CI and publishing

Every released app reads `marketplace.json` from this repository's `main`
and installs a plugin's `dist/` as committed, so merging to `main` is
publishing. CI (`.github/workflows/ci.yml`) checks each listed plugin inside
the app, checked out beside this repository at three refs:

- **floor**: the app at `v<minAppVersion>`. If this fails, the plugin needs a
  newer app than it claims, so raise `minAppVersion`. A row can't name an app
  that hasn't been released yet, so merge after the app release it needs.
- **release**: the newest app release. Also checks that `dist/` is what
  `src/` builds to now.
- **main**: the app's `main`. On pull requests this is only a warning; the
  nightly run requires it, so an app change that breaks a plugin is caught
  before it ships.

`scripts/check-index.ts` checks each row against its package.json with the
app's own parsers: id, version and api must match, `dist/` must exist, and
every folder under `plugins/` must be listed. Run the scripts locally with
the app checked out at `../specdriven-app`, or point `SPECDRIVEN_APP` at
another checkout:

```bash
bun scripts/check-index.ts
bun scripts/check-dist.ts plugins/models
```

After changing a plugin's `src/`, rebuild with `specdriven plugin build` (or
`bun ../specdriven-app/src/index.ts plugin build plugins/<name>`) and commit
`dist/`. The scaffold's `.gitignore` leaves `dist/` out; a plugin listed here
must not.

## License

Apache License 2.0. See [LICENSE](LICENSE).
