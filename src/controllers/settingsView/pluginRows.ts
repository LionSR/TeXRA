/**
 * The one row list of everything that adds tools or agents, which the
 * settings view's Plugins page and the TUI's `/plugins` both render: TeXRA's
 * own plugins (their dashboard cards, availability included), the installed
 * Claude Code and Codex plugins, and the MCP servers of the user's
 * `~/.texra/mcp.json`, listed read-only. Each row names the agents whose
 * tool lists reach it; nothing here turns another row on.
 */
import { Effect, FileSystem } from 'effect';

import { getAgentsByCategory } from '@agent/index';
import type { PluginEnv } from '@common/plugins/installRecord';
import { listPlugins } from '@common/plugins/pluginTrust';
import { buildToolDashboardItems } from '@controllers/settingsView/ToolDashboardData';
import { AGENT_CATEGORIES } from '@shared/schemas';
import type { PluginRow } from '@shared/settingsView/settingsViewMessages';
import { readMcpConfig, USER_MCP_CONFIG_PATH } from '@tools/mcp/mcpConfig';
import { mcpServerOfToolName } from '@tools/mcp/mcpServer';
import type { ToolProbeInputs } from '@tools/toolProbes';
import type { ExternalToolCheckResult } from '@tools/toolAvailabilityService';

/**
 * Build the rows, the MCP config file they read, and what that file's
 * invalid entries raise. `cachedResults` skips the availability probes, as
 * the dashboard's own build does (`buildToolDashboardItems`); an unreadable
 * or invalid `mcp.json` lists no servers and says why in `mcpWarnings`.
 */
export const buildPluginRows = Effect.fn('buildPluginRows')(function* (
  inputs: ToolProbeInputs & PluginEnv,
  cachedResults?: readonly ExternalToolCheckResult[],
) {
  const agents = AGENT_CATEGORIES.flatMap(getAgentsByCategory).map((agent) => ({
    name: agent.name,
    tools: agent.tools ?? [],
  }));
  const usedBy = (reaches: (tool: string) => boolean) => [
    ...new Set(
      agents
        .filter((agent) => agent.tools.some(reaches))
        .map((agent) => agent.name),
    ),
  ];
  const usesServer = (servers: readonly string[]) => (tool: string) => {
    const server = mcpServerOfToolName(tool);
    return server !== undefined && servers.includes(server);
  };

  const items = yield* buildToolDashboardItems(inputs, cachedResults);
  const installed = yield* listPlugins(inputs);
  const mcp = yield* readMcpConfig(
    yield* FileSystem.FileSystem,
    USER_MCP_CONFIG_PATH,
  ).pipe(
    Effect.catch((error) =>
      Effect.succeed({ servers: [], warnings: [error.message] }),
    ),
  );

  const rows: PluginRow[] = [
    ...items.map((item): PluginRow => ({
      kind: 'texra',
      item,
      usedBy: usedBy((tool) =>
        item.tools.some((offered) => offered.name === tool),
      ),
    })),
    ...installed.map((plugin): PluginRow => ({
      kind: 'installed',
      plugin: {
        name: plugin.name,
        source: plugin.source,
        commit: plugin.commit,
        version: plugin.version,
        enabled: plugin.enabled,
        trusted: plugin.trusted,
        code: [...plugin.code],
        skillCount: plugin.skillCount,
        commandCount: plugin.commandCount,
        agentCount: plugin.agentCount,
        mcpServers: [...plugin.mcpServers],
        problem: plugin.problem,
      },
      usedBy: usedBy(usesServer(plugin.mcpServers)),
    })),
    ...(mcp?.servers ?? []).map((server): PluginRow => ({
      kind: 'mcp',
      name: server.name,
      command: [server.command, ...server.args].join(' '),
      usedBy: usedBy(usesServer([server.name])),
    })),
  ];
  return {
    rows,
    mcpConfigPath: USER_MCP_CONFIG_PATH,
    mcpWarnings: mcp?.warnings ?? [],
  };
});
