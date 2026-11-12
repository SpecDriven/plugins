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

Written against OpenCode 2.x and checked live against 2.2.7. The CLI is
taken from PATH, else from `~/.opencode/bin`, where OpenCode's installer
puts it — a desktop app started from the Dock does not have that folder on
its PATH. (The app's own install of this plugin still goes by PATH.)

## Permissions

OpenCode runs edits and shell commands without asking unless its config
says otherwise. A pane session's `opencode acp` gets
`OPENCODE_CONFIG_CONTENT` (the user's config files are never written) in
which every edit, shell command and web fetch OpenCode would *allow*
becomes one it *asks* for. Only "allow" changes: the plugin reads each
OpenCode agent's resolved rules for the session's folder
(`opencode debug agents`) and writes them back with allow → ask, so a
`deny` of the user's (`"git push*": "deny"`) still denies, and the Plan
agent still cannot edit the project. The plugin then answers each request
by the pane's mode:

| Pane mode           | What happens                                                        |
| ------------------- | ------------------------------------------------------------------- |
| Default             | a card for every request                                            |
| Accept edits        | file changes allowed without a card; commands and fetches get one    |
| Plan                | OpenCode's Plan agent: no edits to the project; a card for the rest  |
| Bypass permissions  | every request allowed without a card; what OpenCode denies stays denied |

On a card:

- **Allow always** is OpenCode's "Always allow": OpenCode keeps a rule of
  its own for the folder — for a command, every command that starts the
  same way — and stops asking, in later sessions too.
- **Deny** ends OpenCode's turn (it stops on a refusal). With a reason
  typed, the reason goes to OpenCode as a follow-up and the turn carries
  on; without one the turn is over.

In Plan mode the Plan agent may still write its plan into OpenCode's own
`~/.opencode/plan/` folder, which asks first.

## Models

The menu is the data repo's `.specdriven/opencode-models.json` when it
lists any; else the default and OpenCode's own recent models
(`~/.local/state/opencode/model.json`); else the first of `opencode models`.
The model list and the one-shot turns run with `--standalone`, so the CLI's
background service is not started (and left running) on the app's account.

## Layout

```
src/host.ts        the host half: registers the provider
src/provider.ts    the AgentProvider and its session over ACP
src/acp.ts         the JSON-RPC client and the translation of OpenCode's updates
src/config.ts      the OPENCODE_CONFIG_CONTENT a session runs with: allow → ask
src/models.ts      the model menu
src/oneShot.ts     one-shot turns through `opencode run`
src/cli.ts         where the opencode command is, and a test seam for its availability
test/              bun test, against an app checkout
```

## Tests

`bun test` runs against the app checkout beside this repository
(`../specdriven-app`, see tsconfig.json); `bun test --tsconfig-override
<a tsconfig extending it>` points at another. The tests mount the plugin on
the app's kernel the way the loader mounts an installed one (test/app.ts)
and swap `opencode acp` for a fake (test/fakeOpencode.ts).
