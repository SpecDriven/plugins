# Hello Tab

A SpecDriven plugin: a host half that runs inside the server and a browser
half the server serves to the app. Both are plain ESM modules whose default
export is `{ name, inject, apply(ctx, config) }`.

- `src/host.ts` — registers routes on `ctx.need("routes")`, against the data
  folder through `ctx.need("data")`; every registration is an effect the app
  unwinds when the plugin is switched off.
- `src/client.tsx` — registers a tab on `ctx.need("tabs")`: an icon, the urls
  it owns, a Sidebar and a Pane. It imports `react` like any component; the
  app shares its own React with the bundle.

While the app runs on Bun (the dev server, the `specdriven` binary) it builds
this folder itself and rebuilds it as you edit. The desktop app loads
`dist/` only: run `specdriven plugin build` first.

    specdriven plugin link .
    specdriven plugin build
