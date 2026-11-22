/**
 * The one row list of everything that adds tools or agents, which the
 * settings view's Plugins page and the TUI's `/plugins` both render: TeXRA's
 * own plugins (their dashboard cards, availability included), the installed
 * Claude Code and Codex plugins, and the MCP servers of the user's
 * `~/.texra/mcp.json`, listed read-only. Nothing here turns another row on.
 */
import { Effect } from 'effect';

import { type WorkspaceRoots } from '@texra-ai/worldline';
import {
  InstalledPlugins,
  mcpConfigPathOf,
  readMcpConfig,
  type ExternalToolCheckResult,
  type PluginEnv,
} from '@texra-ai/worldline/host';
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
        programs: [...plugin.programs],
        mcpServers: [...plugin.mcpServers],
        problem: plugin.problem,
      },
    })),
    ...(mcp?.servers ?? []).map((server): PluginRow => ({
      kind: 'mcp',
      name: server.name,
      command: [server.command, ...server.args].join(' '),
    })),
  ];
  return { rows, mcpWarnings: mcp?.warnings ?? [] };
});
