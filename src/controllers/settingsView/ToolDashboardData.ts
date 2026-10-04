/**
 * Tool dashboard data builder.
 *
 * Projects TeXRA's plugin cards (`@tools/pluginCards`) over the process's
 * plugins ({@link @tools/plugins}) onto the Tools dashboard, enriched with
 * runtime availability; this controller module keeps that tool-layer
 * dependency out of shared settings-view code.
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
import {
  TEXRA_PLUGIN_CARDS,
  type PluginCard,
  type ToolPluginSetup,
} from '@tools/pluginCards';
import { readDisabledTools, type Plugin } from '@tools/plugins';
import type { ToolProbeInputs } from '@tools/toolProbes';
import { ToolRegistry } from '@tools/toolTable';
import {
  ToolAvailability,
  type ExternalToolCheckResult,
} from '@tools/toolAvailabilityService';

// ============================================================
// Tool terminal actions
// ============================================================

type ToolTerminalAction =
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
 * Hosts re-look up the command from the plugin's card rather than trusting
 * a command string supplied by the webview, and report which of the two
 * failure reasons applies instead of silently doing nothing.
 */
export function planToolTerminalAction(input: {
  readonly toolId: string;
  readonly commandKind: ToolCommandKind;
}): ToolTerminalAction {
  const card = TEXRA_PLUGIN_CARDS.find(({ id }) => id === input.toolId);
  if (card?.setup === undefined) return { kind: 'none', reason: 'unknownTool' };

  const command =
    input.commandKind === 'install'
      ? card.setup.installCommand
      : card.setup.authCommand;
  if (!command) return { kind: 'none', reason: 'missingCommand' };

  return { kind: 'terminal', name: `TeXRA: ${card.name}`, command };
}

/** The card's inline settings rows, as the dashboard item carries them. */
function settingRows(card: PluginCard): Pick<ToolDashboardItem, 'settings'> {
  return card.settings
    ? { settings: card.settings.map(({ row, label }) => [row.key, label]) }
    : {};
}

// ============================================================
// Public API
// ============================================================

/**
 * The cards on `host`'s dashboard, each with its plugin, in card order. A
 * card whose plugin this process does not list, that names the host in its
 * `unavailableHosts`, or whose plugin's every tool declares itself
 * unavailable on the asking host, is not shown there and cannot be
 * installed, authed or toggled from it: host exclusion removes those tools
 * from the resolved agent list, so they can never be called there.
 */
export function visibleToolPlugins(
  plugins: ReadonlyMap<string, Plugin>,
  host: SettingHost,
): readonly { readonly card: PluginCard; readonly plugin: Plugin }[] {
  return TEXRA_PLUGIN_CARDS.flatMap((card) => {
    const plugin = plugins.get(card.id);
    if (plugin === undefined || card.unavailableHosts?.includes(host))
      return [];
    const tools = Object.values(plugin.tools ?? {});
    return tools.length === 0 ||
      tools.some((tool) => tool.unavailableHosts?.includes(host) !== true)
      ? [{ card, plugin }]
      : [];
  });
}

/**
 * Build the complete tool dashboard items list.
 *
 * Built-in plugins come first, then the probed plugins, each in card order.
 *
 * @param probeInputs - the asking host (see {@link visibleToolPlugins}), its
 *   workspace folder and configuration,
 *   carried as data for the probes that need them (the GitHub group asks
 *   whether the folder is a git repository, the Zotero group reads its port).
 *   Ignored when `cachedResults` skips the probes.
 * @param cachedResults - when provided, skips network probes and uses
 *   these results (including their `statusDetail`). Used by the toggle
 *   handler for instant UI updates.
 */
export const buildToolDashboardItems = Effect.fn('buildToolDashboardItems')(
  function* (
    probeInputs: ToolProbeInputs,
    cachedResults?: readonly ExternalToolCheckResult[],
  ) {
    const visible = visibleToolPlugins(
      (yield* ToolRegistry).entries,
      probeInputs.host,
    );
    const builtinItems: ToolDashboardItem[] = visible
      .filter(({ plugin }) => plugin.availability === undefined)
      .map(({ card, plugin }) => ({
        id: card.id,
        name: card.name,
        category: card.category,
        description: card.description,
        tools: Object.keys(plugin.tools ?? {}).map((name) => ({ name })),
        status: 'available' as const,
        installActions: [],
        requiresSetup: false,
        ...settingRows(card),
      }));

    const results = new Map(
      (
        cachedResults ?? (yield* (yield* ToolAvailability).refresh(probeInputs))
      ).map((result) => [result.id, result]),
    );

    const disabledIds = yield* readDisabledTools(yield* AppState);
    const externalItems: ToolDashboardItem[] = [];
    for (const { card, plugin } of visible) {
      const result = results.get(card.id);
      if (result === undefined) continue;
      const { tools, status, statusLabel, statusDetail } = result;
      const {
        installGuide,
        installCommand,
        authCommand,
        installExtensionId,
        installUrl,
        configNotes,
        authNote,
      }: ToolPluginSetup = card.setup ?? {};
      externalItems.push({
        id: card.id,
        name: card.name,
        category: card.category,
        description: card.description,
        tools: tools.map((name) => ({ name })),
        status,
        statusLabel,
        requiresSetup: true,
        installActions: [
          ...(installGuide
            ? [{ kind: 'guide' as const, text: installGuide }]
            : []),
          ...(installCommand
            ? [{ kind: 'command' as const, command: installCommand }]
            : []),
          ...(authCommand
            ? [{ kind: 'auth' as const, command: authCommand }]
            : []),
          // The desktop app cannot host VS Code extensions, so it gets no
          // "Install Extension" button; the install guide and URL still
          // describe the standalone path (Lean 4's `lake` build, for one).
          ...(installExtensionId && probeInputs.host !== 'desktop'
            ? [
                {
                  kind: 'extension' as const,
                  extensionId: installExtensionId,
                },
              ]
            : []),
          ...(installUrl ? [{ kind: 'url' as const, url: installUrl }] : []),
        ],
        configNotes,
        statusDetail,
        authNote,
        toggleable: plugin.toggle !== undefined,
        enabled: !disabledIds.has(card.id),
        ...settingRows(card),
      });
    }

    return [...builtinItems, ...externalItems];
  },
);
