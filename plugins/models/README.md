# Event models

The Models tab: Event Models ([eventmodeling.org](https://eventmodeling.org))
drawn on a canvas — screens, commands, events and read models in swimlanes,
cut into vertical slices — and each slice scaffolded into a spec. It was
built into SpecDriven until 0.1.86; from 0.1.87 it is this plugin, installed
from Settings → Plugins → Marketplaces (a profile that had the Models switch
on lists it there with "Find in marketplace").

What it keeps in the data repo:

- `models/<path>.model.json` — one file per model. Its `model` half is the
  published [Event Modeling schema](https://github.com/dilgerma/event-modeling-spec),
  so a model can leave for, and arrive from, the tools that speak it.
- `.specdriven/automerge/event-models/<path>.model.json/` — the Automerge
  document behind each file, so two people on one canvas merge instead of
  conflicting. The file is the document's canonical JSON.

What it adds to the app: the `/models` tab with `g m`; the `/api/models`
routes; the folder's drift pass on every sync tick; the `models` search
scope the tab's palette searches; the open model (and any model whose slice
links a picked spec) in a code gen session's prompt; and the crumb on a
feature page back to the model whose slice links it.

## Layout

```
src/host.ts        the host half: routes, drift pass, search, sessions, migration hooks
src/client.tsx     the browser half: the tab, its palette, crumbs and session names
src/route.ts       the tab's urls
src/model/         the file format: types, serializer, layout, schema validation, slice → feature
src/server/        the folder, the documents, search, sessions, relinking
src/ui/            the React Flow canvas, inspector and store
test/              bun test, against an app checkout
```

`@specdriven/host` and `@specdriven/client` are the app's own modules
(`src/plugins/sdk/` in the app). The build points them — and React — at
shims over what the running app publishes, so the plugin shares the app's
React, Automerge, document store and git engine rather than bundling copies.

## Develop

With the app checked out beside this repository (`../specdriven-app`):

```sh
bun install
bun test                                   # against ../specdriven-app
bunx tsc --noEmit
bun ../specdriven-app/src/index.ts plugin build .   # writes dist/
```

Against another checkout, pass a tsconfig that extends this one with other
`paths`: `bun test --tsconfig-override <file>` and `tsc -p <file>`.

Link the folder in Settings → Plugins → Plugin folders to run it from
source; the app rebuilds it as you edit. `dist/` is committed: a
marketplace install loads it as shipped.
