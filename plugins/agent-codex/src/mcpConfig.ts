// The MCP servers the app asks a session to have (AgentStartOptions
// .mcpServers — the Confluence server while a wiki token is saved) as Codex
// takes them: Codex reads its MCP servers from ~/.codex/config.toml, and a
// `-c mcp_servers.<name>=<inline table>` on `codex app-server` adds one for
// that process alone — the user's config is never written.

import type { AgentMcpServer } from "./paneContract";

/** A TOML basic string: quoted, with quotes, backslashes and control characters escaped. */
export function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, (c) => {
      const named: Record<string, string> = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
      return named[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;
    });
  return `"${escaped}"`;
}

/** A TOML bare key (letters, digits, `_`, `-`); anything else becomes `_`. */
function tomlKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** One server as the inline table Codex's `mcp_servers.<name>` takes. */
export function tomlServer(server: AgentMcpServer): string {
  const env = Object.entries(server.env).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  const parts = [
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
    ...(env.length ? [`env = { ${env.join(", ")} }`] : []),
  ];
  return `{ ${parts.join(", ")} }`;
}

/** The `-c` overrides that give `codex app-server` these servers. */
export function codexMcpArgs(servers: AgentMcpServer[]): string[] {
  return servers.flatMap((s) => ["-c", `mcp_servers.${tomlKey(s.name)}=${tomlServer(s)}`]);
}
