# Pi agent

Pi in SpecDriven's coding agent pane, over the Pi CLI's RPC mode (`pi
--mode rpc`): the chat, its tool calls, Pi's own slash commands and its
extension's questions as permission cards. It was built into SpecDriven
through 0.1.184; this plugin takes it over, installed by the app itself
where it finds `pi` on PATH.

What it adds to the app: the `pi` provider on the agent registry. It keeps
no settings and no secrets; Pi's own login is the CLI's.

## Layout

```
src/host.ts        the host half: registers the provider
src/provider.ts    the AgentProvider over RPC mode
src/piChat.ts      the RPC protocol: the stream, its events, commands and state
src/cli.ts         the pi command and a test seam for its availability
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
