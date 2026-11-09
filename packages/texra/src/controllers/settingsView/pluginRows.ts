/**
 * The one row list of everything that adds tools or agents, which the
 * settings view's Plugins page and the TUI's `/plugins` both render: TeXRA's
 * own plugins (their dashboard cards, availability included), the installed
 * Claude Code and Codex plugins, and the MCP servers of the user's
 * `~/.texra/mcp.json`, listed read-only. Each row names the agents whose
 * tool lists reach it; nothing here turns another row on.
 */
import { Effect } from 'effect';

import { type WorkspaceRoots } from '@texra-ai/harness';
import {
  AgentCatalog,
  InstalledPlugins,
  mcpConfigPathOf,
  readMcpConfig,
  type ExternalToolCheckResult,
  type PluginEnv,
} from '@texra-ai/harness/host';
import { mcpServerOfToolName } from '@texra-ai/harness/transcript';
import { buildToolDashboardItems } from '@texra/controllers/settingsView/ToolDashboardData';
import type { EditorIntegrationShape } from '@texra/hosts/editorIntegration';
import type { PluginRow } from '@texra/shared/settingsView/settingsViewMessages';

/** The roots a plugins page reads: the install record and switches in its
 *  global state, the managed plugins under its global storage, and its
 *  folder and configuration for the availability probes. */
export type PluginPageRoots = Pick<
  WorkspaceRoots,
  'workspace' | 'config' | 'globalState' | 'globalStorage' | 'storageRoot'
>;

/**
 * Build the rows from the availability `results` the caller holds or
 * probed, and what the MCP config file's invalid entries raise; an
 * unreadable or invalid `mcp.json` lists no servers and says why in
 * `mcpWarnings`.
 */
export const buildPluginRows = Effect.fn('buildPluginRows')(function* (
  inputs: PluginEnv &
    Pick<WorkspaceRoots, 'storageRoot'> & {
      /** The host's code editor, where it has one. */
      readonly editor?: EditorIntegrationShape;
    },
  results: readonly ExternalToolCheckResult[],
) {
  const agents = (yield* AgentCatalog).list().map((agent) => ({
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

  // The three loads are independent.
  const [items, installed, mcp] = yield* Effect.all(
    [
      buildToolDashboardItems(results, inputs.editor),
      InstalledPlugins.list(inputs),
      readMcpConfig(mcpConfigPathOf(inputs.storageRoot)),
    ],
    { concurrency: 'unbounded' },
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
  return { rows, mcpWarnings: mcp?.warnings ?? [] };
});
