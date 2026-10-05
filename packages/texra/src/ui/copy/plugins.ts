/**
 * The copy of a plugin row (`PluginRow`), which the settings view's Plugins
 * page and the TUI's `/plugins` both print: where it comes from, what it
 * adds, whether it is on, whether it is trusted, whether it can run here,
 * and which agents use it. A renderer lays these out; it spells none of
 * them itself.
 */
import { toolDependencyStatusLabel } from '@texra/shared/tools/toolDependencyStatusLabels';
import type { PluginRow } from '@texra/shared/settingsView/settingsViewMessages';
import { formatResultCount } from '@utils/text/stringUtils';

/** The page's own copy. */
export const PLUGINS_PAGE = Object.freeze({
  description:
    'Everything that adds tools or agents: TeXRA’s plugins, installed Claude Code and Codex plugins, and your MCP servers.',
  add: 'Add plugin',
  recheck: 'Re-check',
  openMcpConfig: 'Open mcp.json',
  loading: 'Checking plugins…',
  empty: 'No plugins found.',
  /** The visible label of a row's one switch. */
  on: 'On',
  review: 'Review',
  update: 'Update',
  remove: 'Remove',
  installInTerminal: 'Install in terminal',
  signIn: 'Sign in',
  installExtension: 'Install extension',
  openInstallPage: 'Open install page',
  setUp: (name: string) => `Set up ${name}`,
  toolsItAdds: 'Tools it adds',
});

/** The TUI's `/plugins` copy. */
export const PLUGINS_TUI = Object.freeze({
  description:
    'Switch plugins on or off. Add one: /plugins add <URL or folder>',
  compactTitle: '/plugins · Switch plugins on or off',
  switchAction: 'switch on/off',
  chooseAction: 'choose',
  trustTitle: (name: string) => `/plugins · Trust ${name}?`,
  trust: 'Trust and switch on',
  decline: 'Keep it off',
  addUsage:
    'Usage: /plugins add <github.com/owner/repo[@ref], a repository URL, or a folder> [--plugin <name>]',
  added: (names: readonly string[]) =>
    `Added ${names.join(', ')}. Switch it on in /plugins to review what it declares and trust it.`,
});

/** The row's identity, unique across the three kinds: the page's repeat key
 *  and the TUI's select value. */
export function pluginRowKey(row: PluginRow): string {
  switch (row.kind) {
    case 'texra':
      return `texra:${row.item.id}`;
    case 'installed':
      return `installed:${row.plugin.name}`;
    case 'mcp':
      return `mcp:${row.name}`;
  }
}

/** Whether the row's switch can be flipped: a TeXRA plugin with a switch,
 *  or an installed plugin TeXRA can read and run. An MCP server is listed
 *  only. */
export function pluginRowSwitchable(row: PluginRow): boolean {
  switch (row.kind) {
    case 'texra':
      return row.item.toggleable === true;
    case 'installed':
      return row.plugin.code.length === 0 && row.plugin.problem === undefined;
    case 'mcp':
      return false;
  }
}

/** The row's name, with an installed plugin's version. */
export function pluginRowName(row: PluginRow): string {
  switch (row.kind) {
    case 'texra':
      return row.item.name;
    case 'installed':
      return row.plugin.version
        ? `${row.plugin.name} ${row.plugin.version}`
        : row.plugin.name;
    case 'mcp':
      return row.name;
  }
}

/** Where the row comes from, then what it adds: "TeXRA plugin · 6 tools". */
export function pluginRowSummary(row: PluginRow): string {
  switch (row.kind) {
    case 'texra':
      return row.item.tools.length === 0
        ? 'TeXRA plugin'
        : `TeXRA plugin · ${formatResultCount(row.item.tools.length, 'tool')}`;
    case 'installed': {
      const { plugin } = row;
      const adds = [
        [plugin.skillCount, 'skill'],
        [plugin.commandCount, 'command'],
        [plugin.agentCount, 'agent'],
        [plugin.mcpServers.length, 'MCP server'],
      ] as const;
      const parts = adds
        .filter(([count]) => count > 0)
        .map(([count, noun]) => formatResultCount(count, noun));
      return parts.length === 0
        ? 'Claude Code or Codex plugin'
        : `Claude Code or Codex plugin · ${parts.join(', ')}`;
    }
    case 'mcp':
      return `MCP server in mcp.json · ${row.command}`;
  }
}

/**
 * The row's on/off state as a word: "on", "off", "always on" for a TeXRA
 * plugin without a switch, and "listed" for an MCP server, which an agent
 * uses by naming its tools.
 */
export function pluginRowState(row: PluginRow): string {
  switch (row.kind) {
    case 'texra':
      if (row.item.toggleable !== true) return 'always on';
      return row.item.enabled === false ? 'off' : 'on';
    case 'installed':
      return row.plugin.enabled ? 'on' : 'off';
    case 'mcp':
      return 'listed';
  }
}

/**
 * Trust and the revision it holds, for an installed plugin only: a TeXRA
 * plugin ships with the app and an MCP server is the user's own file.
 */
export function pluginRowTrust(row: PluginRow): string | null {
  // One that cannot be switched on has no trust question to answer.
  if (row.kind !== 'installed' || !pluginRowSwitchable(row)) return null;
  const { plugin } = row;
  const revision = plugin.commit?.slice(0, 12) ?? plugin.version;
  if (plugin.trusted) return revision ? `trusted at ${revision}` : 'trusted';
  return plugin.enabled
    ? 'not trusted as it is now: review it to load it'
    : 'not trusted yet: switching it on shows what it declares';
}

/**
 * Why the row cannot run here, or null when it can: a missing program,
 * credential or service for a TeXRA plugin, an unreadable or unsupported
 * installed plugin.
 */
export function pluginRowProblem(row: PluginRow): string | null {
  switch (row.kind) {
    case 'texra':
      return row.item.status === 'available'
        ? null
        : toolDependencyStatusLabel(row.item.status, row.item.statusLabel);
    case 'installed':
      if (row.plugin.problem) return row.plugin.problem;
      return row.plugin.code.length > 0
        ? `ships ${row.plugin.code.join(', ')}, which TeXRA does not run yet`
        : null;
    case 'mcp':
      return null;
  }
}

/** "Used by: assistant, referee and 3 more", or null when no agent's
 *  tool list reaches the row. */
export function pluginRowUsedBy(row: PluginRow): string | null {
  const { usedBy } = row;
  if (usedBy.length === 0) return null;
  const shown = usedBy.slice(0, 3);
  const more = usedBy.length - shown.length;
  return more > 0
    ? `Used by: ${shown.join(', ')} and ${more} more`
    : `Used by: ${shown.join(', ')}`;
}
