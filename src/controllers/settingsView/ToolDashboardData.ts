/**
 * Tool dashboard data builder.
 *
 * Projects the tool plugin manifest ({@link @tools/plugins}) onto the Tools
 * dashboard, enriched with runtime availability; this controller module keeps
 * that tool-layer dependency out of shared settings-view code.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { AppState } from '@platform/interfaces';
import type { SettingHost } from '@shared/state/stateSettings';
import type {
  ToolCommandKind,
  ToolDashboardItem,
} from '@shared/settingsView/settingsViewMessages';
import { TOOL_PLUGINS, findToolPlugin, type ToolPlugin } from '@tools/plugins';
import { isToolUnavailableOnHost } from '@tools/registry';
import type { ToolProbeInputs } from '@tools/toolProbes';
import {
  runExternalToolChecks,
  type ExternalToolCheckResult,
} from '@tools/toolAvailability';
import { getDisabledToolIds } from '@utils/config/constants';

// ============================================================
// Tool terminal actions
// ============================================================

export type ToolTerminalAction =
  | {
      readonly kind: 'terminal';
      readonly name: string;
      readonly command: string;
    }
  | {
      readonly kind: 'none';
      readonly reason: 'unknownTool' | 'missingCommand';
    };

/**
 * Plan the terminal command for a tool-dashboard install/auth action.
 *
 * Hosts re-look up the command from the plugin manifest rather than
 * trusting a command string supplied by the webview, and report which of the
 * two failure reasons applies instead of silently doing nothing.
 */
export function planToolTerminalAction(input: {
  readonly toolId: string;
  readonly commandKind: ToolCommandKind;
}): ToolTerminalAction {
  const def = findToolPlugin(input.toolId);
  if (!def?.availability) return { kind: 'none', reason: 'unknownTool' };

  const command =
    input.commandKind === 'install' ? def.installCommand : def.authCommand;
  if (!command) return { kind: 'none', reason: 'missingCommand' };

  return { kind: 'terminal', name: `TeXRA: ${def.name}`, command };
}

/** The plugin's inline settings rows, as the dashboard item carries them. */
function settingRows(plugin: ToolPlugin): Pick<ToolDashboardItem, 'settings'> {
  return plugin.settings
    ? { settings: plugin.settings.map(([key, label]) => [key, label]) }
    : {};
}

// ============================================================
// Public API
// ============================================================

/**
 * Whether a plugin belongs on `host`'s dashboard. A hidden plugin, or one
 * whose every tool declares itself unavailable on the asking host, is not
 * shown there and cannot be installed, authed or toggled from it: host
 * exclusion removes those tools from the resolved roster, so they can never
 * be called there.
 */
export function isToolPluginVisible(
  plugin: ToolPlugin,
  host: SettingHost,
): boolean {
  return (
    plugin.hidden !== true &&
    !plugin.toolNames.every((name) => isToolUnavailableOnHost(name, host))
  );
}

/**
 * Build the complete tool dashboard items list.
 *
 * Built-in plugins come first, in manifest order, then the probed plugins in
 * the order their results arrive.
 *
 * @param host - the product host asking; see {@link isToolPluginVisible}.
 * @param probeInputs - the asking host's workspace folder and configuration,
 *   carried as data for the probes that need them (the GitHub group asks
 *   whether the folder is a git repository, the Zotero group reads its port).
 *   Ignored when `cachedResults` skips the probes.
 * @param cachedResults - when provided, skips network probes and uses
 *   these results (including their `statusDetail`). Used by the toggle
 *   handler for instant UI updates.
 */
export const buildToolDashboardItems = Effect.fn('buildToolDashboardItems')(
  function* (
    host: SettingHost,
    probeInputs: ToolProbeInputs,
    cachedResults?: ExternalToolCheckResult[],
  ) {
    const builtinItems: ToolDashboardItem[] = TOOL_PLUGINS.filter(
      (plugin) =>
        plugin.availability === undefined && isToolPluginVisible(plugin, host),
    ).map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      category: plugin.category,
      description: plugin.description,
      tools: plugin.toolNames.map((toolName) => ({ name: toolName })),
      status: 'available' as const,
      installActions: [],
      requiresSetup: false,
      ...settingRows(plugin),
    }));

    const results =
      cachedResults ?? (yield* runExternalToolChecks(probeInputs));

    const disabledIds = yield* getDisabledToolIds(yield* AppState);
    const externalItems: ToolDashboardItem[] = [];
    for (const { id, tools, status, statusLabel, statusDetail } of results) {
      const def = findToolPlugin(id);
      if (!def || !isToolPluginVisible(def, host)) continue;
      externalItems.push({
        id: def.id,
        name: def.name,
        category: def.category,
        description: def.description,
        tools: tools.map((name) => ({ name })),
        status,
        statusLabel,
        requiresSetup: true,
        installActions: [
          ...(def.installGuide
            ? [{ kind: 'guide' as const, text: def.installGuide }]
            : []),
          ...(def.installCommand
            ? [{ kind: 'command' as const, command: def.installCommand }]
            : []),
          ...(def.authCommand
            ? [{ kind: 'auth' as const, command: def.authCommand }]
            : []),
          ...(def.installExtensionId
            ? [
                {
                  kind: 'extension' as const,
                  extensionId: def.installExtensionId,
                },
              ]
            : []),
          ...(def.installUrl
            ? [{ kind: 'url' as const, url: def.installUrl }]
            : []),
        ],
        configNotes: def.configNotes,
        statusDetail,
        authNote: def.authNote,
        toggleable: def.toggleable,
        enabled: !disabledIds.has(def.id),
        ...settingRows(def),
      });
    }

    return [...builtinItems, ...externalItems];
  },
);
