# plugins

The SpecDriven plugin marketplace: a git repository with `marketplace.json`
at its root, which the app reads from Settings → Plugins → Marketplaces
(it is the default index). Each row names a plugin, a description, a
version, a category and a source — a git url pinned to a `ref`, or a
subdirectory of this repository. Plugins listed here are released in
versions: each has a `release/` folder holding one zip per version, which
the app installs from, so any version in it can be installed and an older
one put back. They also still commit `dist/`, built with
`specdriven plugin build`, for apps from before release folders.

Installing one is a consent step first: the app shows the plugin's name,
version, description and the permissions its manifest declares, and notes
that it runs in the app's own process with the app's rights.

## Rows

A row's `name` is the plugin's manifest id (`specdriven.id` in its
package.json): the app installs by that name and refuses a clone whose
manifest says otherwise. `version`, `category` and `api` are what the index
claims; the manifest is checked again after the clone.

## Releases

`plugins/<name>/release/` holds what the plugin has released:

- `<name>-<version>.zip`, one per version: what runs — `package.json`,
  `dist/` without its source maps, the README — and none of the sources.
- `releases.json`, newest first: each version's zip, its SHA-256 and size,
  the day, the plugin `api` it speaks, the oldest app it runs in
  (`minAppVersion`) and a note.

An app that reads release folders installs the newest version it can run,
checking the zip against its checksum first, and offers the others on the
plugin's version chip. A version picked there stays until the user updates;
an older one is unpacked from the app's own copy of this repository, with
no network. `marketplace.json` does not mention the folder: having one is
what makes a plugin released, and the row's `version` is its newest.

To release a plugin, raise `version` in its package.json and run, with the
app checked out at `../specdriven-app` (or `SPECDRIVEN_APP` naming it):

```bash
bun scripts/release.ts plugins/models --notes "What changed, in a line"
```

That rebuilds `dist/`, writes the zip and its row, keeps the newest ten
versions and puts the version on the plugin's row in `marketplace.json`.
Commit `dist/`, `release/` and `marketplace.json` in the same pull request
as the change.

A released version is never written again. A change to a plugin's code or
manifest therefore needs a new version: CI refuses a zip that differs from
the one `main` has, and a newest zip that is not the plugin as committed.
To take a bad version back, add `"yanked": "<why>"` to its row: the app
stops offering it and moves the plugins on it to the newest good version.

## Coding agents

The `agents` category holds the plugins that put a coding agent in the
app's agent pane — `agent-claude`, `agent-codex`, `agent-opencode` and
`agent-pi`. Each row
also carries `agent: { id, command }`: the provider id the plugin registers
and the command it needs on PATH. The app looks for those commands on this
machine and installs the plugin for each it finds, so a developer with
`codex` installed gets Codex in the pane without a visit to the marketplace;
the pane's empty state offers the rest.

## CI and publishing

Every released app reads `marketplace.json` from this repository's `main`
and installs a plugin from it — the newest zip in its `release/` folder,
or, an app from before release folders, its `dist/` as committed — so
merging to `main` is publishing. CI (`.github/workflows/ci.yml`) checks each listed plugin inside
the app, checked out beside this repository at three refs:

- **floor**: the app at `v<minAppVersion>`. If this fails, the plugin needs a
  newer app than it claims, so raise `minAppVersion`. A row can't name an app
  that hasn't been released yet, so merge after the app release it needs.
- **release**: the newest app release. Also checks that `dist/` is what
  `src/` builds to now, and that the newest zip in `release/` is the plugin
  as committed.
- **main**: the app's `main`. On pull requests this is only a warning; the
  nightly run requires it, so an app change that breaks a plugin is caught
  before it ships.

`scripts/check-index.ts` checks each row against its package.json with the
app's own parsers: id, version and api must match, `dist/` must exist, and
every folder under `plugins/` must be listed. It checks each `release/`
folder too: every zip `releases.json` lists is there with the checksum and
size it claims and holds the plugin and version its row says, nothing
unlisted is in the folder, the newest version is the one package.json
names, and no zip differs from the one `main` has.
`scripts/check-release.ts` checks that a plugin's newest zip holds the
manifest and the bundles in the tree. Run the scripts locally with the app
checked out at `../specdriven-app`, or point `SPECDRIVEN_APP` at another
checkout:

```bash
bun scripts/check-index.ts
bun scripts/check-dist.ts plugins/models
bun scripts/check-release.ts plugins/models
```

Against an app from before release folders the release checks say they
were skipped: that app has no reader for them and installs `dist/`.

After changing a plugin's `src/`, raise its version and release it (see
Releases), which rebuilds `dist/` as `specdriven plugin build` does. The
scaffold's `.gitignore` leaves `dist/` out; a plugin listed here must not,
until every app that could install it reads release folders.

## License

Apache License 2.0. See [LICENSE](LICENSE).
