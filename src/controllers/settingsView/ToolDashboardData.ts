/**
 * Tool dashboard data builder.
 *
 * Projects the process's plugins ({@link @tools/plugins}) onto the Tools
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
import {
  readDisabledTools,
  type Plugin,
  type ToolPluginSetup,
} from '@tools/plugins';
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
 * Hosts re-look up the command from the process's plugins rather than
 * trusting a command string supplied by the webview, and report which of the
 * two failure reasons applies instead of silently doing nothing.
 */
export function planToolTerminalAction(
  input: {
    readonly toolId: string;
    readonly commandKind: ToolCommandKind;
  },
  plugins: ReadonlyMap<string, Plugin>,
): ToolTerminalAction {
  const def = plugins.get(input.toolId);
  if (!def?.availability) return { kind: 'none', reason: 'unknownTool' };

  const command =
    input.commandKind === 'install'
      ? def.setup?.installCommand
      : def.setup?.authCommand;
  if (!command) return { kind: 'none', reason: 'missingCommand' };

  return { kind: 'terminal', name: `TeXRA: ${def.name}`, command };
}

/** The plugin's inline settings rows, as the dashboard item carries them. */
function settingRows(plugin: Plugin): Pick<ToolDashboardItem, 'settings'> {
  return plugin.settings
    ? { settings: plugin.settings.map(([key, label]) => [key, label]) }
    : {};
}

// ============================================================
// Public API
// ============================================================

/**
 * Whether a plugin belongs on `host`'s dashboard. A hidden plugin, one that
 * names the host in its `unavailableHosts`, or one whose every tool declares
 * itself unavailable on the asking host, is not
 * shown there and cannot be installed, authed or toggled from it: host
 * exclusion removes those tools from the resolved agent list, so they can never
 * be called there.
 */
export function isToolPluginVisible(
  plugin: Plugin,
  host: SettingHost,
): boolean {
  const tools = Object.values(plugin.tools ?? {});
  return (
    plugin.hidden !== true &&
    plugin.unavailableHosts?.includes(host) !== true &&
    (tools.length === 0 ||
      tools.some((tool) => tool.unavailableHosts?.includes(host) !== true))
  );
}

/**
 * Build the complete tool dashboard items list.
 *
 * Built-in plugins come first, in list order, then the probed plugins in
 * the order their results arrive.
 *
 * @param probeInputs - the asking host (see {@link isToolPluginVisible}), its
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
    const { host } = probeInputs;
    const plugins = (yield* ToolRegistry).entries;
    const builtinItems: ToolDashboardItem[] = [...plugins.values()]
      .filter(
        (plugin) =>
          plugin.availability === undefined &&
          isToolPluginVisible(plugin, host),
      )
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        category: plugin.category,
        description: plugin.description,
        tools: Object.keys(plugin.tools ?? {}).map((name) => ({ name })),
        status: 'available' as const,
        installActions: [],
        requiresSetup: false,
        ...settingRows(plugin),
      }));

    const results =
      cachedResults ?? (yield* (yield* ToolAvailability).refresh(probeInputs));

    const disabledIds = yield* readDisabledTools(yield* AppState);
    const externalItems: ToolDashboardItem[] = [];
    for (const { id, tools, status, statusLabel, statusDetail } of results) {
      const def = plugins.get(id);
      if (!def || !isToolPluginVisible(def, host)) continue;
      const {
        installGuide,
        installCommand,
        authCommand,
        installExtensionId,
        installUrl,
        configNotes,
        authNote,
      }: ToolPluginSetup = def.setup ?? {};
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
          ...(installExtensionId && host !== 'desktop'
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
        toggleable: def.toggleable,
        enabled: !disabledIds.has(def.id),
        ...settingRows(def),
      });
    }

    return [...builtinItems, ...externalItems];
  },
);
