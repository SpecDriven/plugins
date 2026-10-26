# Claude agent

Claude Code in SpecDriven's coding agent pane: the chat the app drives over
the Claude Agent SDK, with its permission cards, slash commands, modes and
the account chip — and, in Settings, how the Claude the app starts signs in:
your Claude account (the claude.ai login driven from Settings), or an API
proxy with a token kept in the plugin's secret store on this device. It was
built into SpecDriven through 0.1.184; this plugin takes it over, installed
by the app itself where it finds `claude` on PATH.

What it keeps: its settings under `pluginSettings["agent-claude"]` in the
app's settings.json (the sign-in mode, the proxy url, the pane's
first-response wait), adopting the top-level keys they had while built in;
the proxy token in the app's secret store (`~/.specdriven/secrets/`, or the
OS keychain in the desktop app).

What it adds to the app: the `claude` provider on the agent registry; the
`/api/claude/*` routes behind Settings → Claude; the Claude section of the
Settings page.

## Layout

```
src/host.ts            the host half: the provider, the settings adoption, the routes
src/client.tsx         the browser half: the Settings section
src/provider.ts        the AgentProvider over the Claude Agent SDK
src/auth.ts            how Claude signs in: proxy detection, the login, the --settings override
src/settings.ts        the plugin's settings values and the PUT body's validation
src/cli.ts             the claude command and a test seam for its availability
src/ui/                the Settings section's React
test/                  bun test, against an app checkout
```

`@specdriven/host` and `@specdriven/client` are the app's own modules
(`src/plugins/sdk/` in the app); the build points them, and React, at shims
over what the running app publishes. `bun install` leaves the SDK's optional
per-platform packages out (bunfig.toml): the plugin runs the developer's own
`claude`, and the host bundle carries nothing native.

## Tests

`bun test` runs against the app checkout beside this repository
(`../specdriven-app`, see tsconfig.json); `bun test --tsconfig-override
<a tsconfig extending it>` points at another. The tests mount the plugin on
the app's kernel the way the loader mounts an installed one (test/app.ts).
