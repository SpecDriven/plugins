# Event Storming

The Event Storming tab: Alberto Brandolini's workshop
([eventstorming.com](https://www.eventstorming.com)) as a wall of sticky
notes — domain events on a timeline, read left to right, with what causes
them and who is involved each in the classic legend's colour:

| Sticky | Colour | Key |
| --- | --- | --- |
| Domain event | orange | 1 |
| Command | blue | 2 |
| Actor | small yellow | 3 |
| Policy | lilac | 4 |
| Aggregate | big yellow | 5 |
| Read model | green | 6 |
| External system | pink | 7 |
| Hotspot | magenta, on its corner | 8 |
| Note | white | 9 |

Plus **areas** (dashed frames for bounded contexts, swimlanes or phases),
**pivotal events** (drawn with the boundary line the workshop tapes through
them), and optional **arrows** between stickies for process-level modeling.

On the wall: double-click the bare wall for a domain event, or press 1–9
for a sticky of that kind at the pointer; double-click a sticky (or Enter)
to write on it; drag from its right dot to another sticky for an arrow;
shift-drag to select many; ⌘D duplicates, ⌘Z / ⇧⌘Z undo and redo,
Backspace deletes. A bar over the selection recolours stickies and marks
events pivotal. The legend hides and shows kinds, counts them, and carries
the workshop's steps. An empty tab offers an online-shop example board.

## What it keeps in the data repo

- `storms/<path>.storm.json` — one file per board: the stickies where they
  were put, the areas and the arrows, as canonical JSON (keys in a fixed
  order, whole-pixel coordinates), so a diff reads as the change made.
- `.specdriven/automerge/storms/<path>.storm.json/` — the Automerge
  document behind each file, so two people on one wall merge instead of
  conflicting. The file is the document's projection.

Import takes this format or the JSON the
[Event Storm](https://vanillajonathan.github.io/eventstorm/) web app saves.

## What it adds to the app

The `/storms` tab with `g w`; the `/api/storms` routes; the folder's drift
pass on every sync tick; the `storms` search scope the tab's palette
searches; a "New Event Storming board" palette command; "Copy timeline as
Markdown" (the events in order, cut into phases at the pivotal ones); and
the open board — its outline, then its JSON — in a code gen session's
prompt.

## Layout

```
src/host.ts        the host half: routes, drift pass, search, sessions
src/client.tsx     the browser half: the tab, its palette and session names
src/route.ts       the tab's urls
src/storm/         the file format: kinds and colours, serializer, outline, example
src/server/        the folder, the documents, search, sessions
src/ui/            the React Flow wall, its stickies and areas, the store
test/              bun test, against an app checkout
```

## Develop

With the app checked out beside this repository (`../specdriven-app`):

```sh
bun install
bun test                                   # against ../specdriven-app
bunx tsc --noEmit
bun ../../../specdriven-app/src/index.ts plugin build .   # writes dist/
```

Link the folder in Settings → Plugins → Plugin folders to run it from
source; the app rebuilds it as you edit. `dist/` is committed: a
marketplace install loads it as shipped.
