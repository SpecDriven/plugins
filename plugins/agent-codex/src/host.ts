// The Codex agent plugin's host half: it registers the provider
// (src/provider.ts) on the app's agent registry for as long as the plugin
// is on; switching the plugin off takes its sessions down with it.

import type { Context, HostConfig, Plugin } from "@specdriven/host";
import { codexProvider } from "./provider";

const plugin: Plugin<Context, HostConfig> = {
  name: "agent-codex",
  inject: ["agents"],
  apply(ctx) {
    const agents = ctx.need("agents");
    ctx.effect(() => agents.register(codexProvider));
  },
};

export default plugin;
