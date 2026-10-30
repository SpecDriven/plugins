# Codex agent

OpenAI Codex in SpecDriven's coding agent pane, over the Codex CLI's app
server (`codex app-server`): the chat, its approvals as permission cards,
the sandbox and approval policies as the pane's modes, and the CLI's own
slash commands. It was built into SpecDriven through 0.1.184; this plugin takes it
over, installed by the app itself where it finds `codex` on PATH.

What it adds to the app: the `codex` provider on the agent registry. It
also answers the app's one-shot turns (an estimate, say) through `codex
exec`, read-only and without a session on disk. It keeps no settings and
no secrets; Codex's own login is the CLI's.

## Layout

```
src/host.ts        the host half: registers the provider
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
