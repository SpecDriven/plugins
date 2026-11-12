# OpenCode agent

[OpenCode](https://opencode.ai) in SpecDriven's coding agent pane, over its
Agent Client Protocol server (`opencode acp`): the chat, its tool calls,
permission cards for edits, commands and web fetches, OpenCode's slash
commands, pasted images, the context meter, and a model and effort menu
for any model OpenCode is signed in to. The app installs it itself where it
finds `opencode` on PATH.

What it adds to the app: the `opencode` provider on the agent registry,
with one-shot turns (estimates) through `opencode run`. It keeps the model
and effort the pane picked last in its settings section; OpenCode's own
sign-ins stay the CLI's (`opencode auth login`).

## Permissions

OpenCode runs edits and shell commands without asking unless its config
says otherwise. A pane session's `opencode acp` gets
`OPENCODE_CONFIG_CONTENT` with `edit`, `bash` and `webfetch` set to `ask`
(a `deny` already in that variable stands; the user's config files are
never written), and the plugin answers each request by the pane's mode:

| Pane mode           | What happens                                                  |
| ------------------- | ------------------------------------------------------------- |
| Default             | a card for every request                                      |
| Accept edits        | edits allowed without a card; commands and fetches get one     |
| Plan                | OpenCode's read-only Plan agent; a card for what it asks       |
| Bypass permissions  | every request allowed without a card                           |

"Allow always" on a card is OpenCode's "Always allow", for the rest of the
session. A refusal reaches OpenCode without the reason typed on the card
(ACP carries none).

## Models

The menu is the data repo's `.specdriven/opencode-models.json` when it
lists any; else the default and OpenCode's own recent models
(`~/.local/state/opencode/model.json`); else the first of `opencode models`.

## Layout

```
src/host.ts        the host half: registers the provider
src/provider.ts    the AgentProvider and its session over ACP
src/acp.ts         the JSON-RPC client and the translation of OpenCode's updates
src/config.ts      the OPENCODE_CONFIG_CONTENT a session runs with
src/models.ts      the model menu
src/oneShot.ts     one-shot turns through `opencode run`
src/cli.ts         the opencode command and a test seam for its availability
test/              bun test, against an app checkout
```

## Tests

`bun test` runs against the app checkout beside this repository
(`../specdriven-app`, see tsconfig.json); `bun test --tsconfig-override
<a tsconfig extending it>` points at another. The tests mount the plugin on
the app's kernel the way the loader mounts an installed one (test/app.ts)
and swap `opencode acp` for a fake (test/fakeOpencode.ts).
