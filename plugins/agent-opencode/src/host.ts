// The OpenCode agent plugin's host half: it registers the provider
// (src/provider.ts) on the app's agent registry for as long as the plugin
// is on; switching the plugin off takes its sessions down with it. The
// model and effort the pane picks last are kept in the plugin's own
// settings section, as what new sessions start on.

import type { Context, HostConfig, Plugin } from "@specdriven/host";
import { createOpencodeProvider } from "./provider";

const plugin: Plugin<Context, HostConfig> = {
  name: "agent-opencode",
  inject: ["agents"],
  apply(ctx, config) {
    const agents = ctx.need("agents");
    const provider = createOpencodeProvider({ settings: config.settings });
    ctx.effect(() => agents.register(provider));
  },
};

export default plugin;
