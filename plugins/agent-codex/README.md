# Codex agent

OpenAI Codex in SpecDriven's coding agent pane, over the Codex CLI's app
server (`codex app-server`): the chat, its approvals as permission cards,
the sandbox and approval policies as the pane's modes, and the CLI's own
slash commands. It was built into SpecDriven through 0.1.184; this plugin takes it
over, installed by the app itself where it finds `codex` on PATH.

What it adds to the app: the `codex` provider on the agent registry, and a
Codex section on the Settings page. It also answers the app's one-shot
turns (an estimate, say) through `codex exec`, read-only and without a
session on disk.

## Sign-in

Settings → Codex chooses how every Codex the app starts signs in:

- **ChatGPT account** — the account the Codex CLI is signed in to (`codex
  login`, which the section can run). An API address or key in Codex's own
  config is set aside for the app's sessions.
- **API** — an address and a key. They are prefilled from what Codex's own
  config says (`~/.codex/config.toml`'s model provider, the key in
  `~/.codex/auth.json`); "Use detected" copies them into the app. The
  address goes in the plugin's section of the app's settings file, the key
  in its secret store (OS-encrypted in the desktop app). With a key and no
  address, the API is OpenAI's own.

The choice reaches Codex as `-c` overrides on its command line, for that
process alone — the API as a model provider whose key rides in an
environment variable. Codex's own files are never written.

Codex keeps one sign-in and signs it out when a launch requires the other
kind, so the ChatGPT login is only required of a Codex that `codex login
status` found signed in to one (src/auth.ts has the details).

The model menus — the pane's picker and Settings → Codex's "Default model"
— offer what the sign-in lists: the API's `GET <address>/models`, or
Codex's own list for a ChatGPT account, narrowed by the data repo's
`.specdriven/codex-models.json` when it lists any.

The effort row — the pane's picker and Settings → Codex's "Default effort"
— offers the reasoning efforts each model takes, as Codex says: its own
list for a ChatGPT account, and for an API's models the catalog shipped
with the CLI (`codex debug models --bundled`). A model the catalog does not
know gets no effort row, since Codex sends it none. The effort goes with
each turn, lowered to one the turn's model takes.

## Layout

```
src/host.ts        the host half: registers the provider, and the sign-in routes
src/client.tsx     the browser half: the Settings section
src/ui/            Settings → Codex
src/settings.ts    the plugin's own settings: the sign-in, the API's address, the default model and effort
src/auth.ts        the sign-in: what Codex's config says, the launch, the ChatGPT login, the API check
src/models.ts      the models the sign-in offers and their efforts, and the data repo's list
src/modelMenu.ts   narrowing a model menu, and lowering an effort (shared with the page)
src/provider.ts    the AgentProvider over the app server
src/codexChat.ts   the app-server protocol: the stream, its notifications, policies and answers
src/oneShot.ts     one-shot turns over `codex exec`
src/cli.ts         the codex command and a test seam for its availability
test/              bun test, against an app checkout
```

`@specdriven/host` is the app's own module (`src/plugins/sdk/host.ts` in
the app); the build points it at a shim over what the running app publishes.

## Tests

`bun test` runs against the app checkout beside this repository
(`../specdriven-app`, see tsconfig.json); `bun test --tsconfig-override
<a tsconfig extending it>` points at another. The tests mount the plugin on
the app's kernel the way the loader mounts an installed one (test/app.ts)
and swap the spawned CLI for a fake.
