/**
 * Tool dashboard data builder.
 *
 * Projects the process's plugins that carry a card (`TexraPlugin`,
 * `@texra/tools/registry`) onto the Tools dashboard, enriched with runtime
 * availability; this controller module keeps that tool-layer dependency out
 * of shared settings-view code.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { Plugin } from '@texra-ai/harness/plugins';
import {
  ToolCatalog,
  type ExternalToolCheckResult,
} from '@texra-ai/harness/host';
import { ToolRegistry } from '@texra-ai/harness/plugins';
import type { EditorIntegrationShape } from '@texra/hosts/editorIntegration';
import type {
  ToolCommandKind,
  ToolDashboardItem,
} from '@texra/shared/settingsView/settingsViewMessages';
import type {
  PluginCard,
  TexraPlugin,
  ToolPluginSetup,
} from '@texra/tools/registry';

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

/** The card a plugin of TeXRA's list carries (`texraPlugins`), which the
 *  table holds as listed; none for a plugin another list adds. */
const cardOf = (plugin: Plugin | undefined): PluginCard | undefined =>
  // cast: the registry holds TeXRA's plugin list as listed, each a `TexraPlugin`.
  (plugin as TexraPlugin | undefined)?.card;

/**
 * Plan the terminal command for a tool-dashboard install/auth action.
 *
 * Hosts re-look up the command from the plugin's card rather than trusting
 * a command string supplied by the webview, and report which of the two
 * failure reasons applies instead of silently doing nothing.
 */
export const planToolTerminalAction = (input: {
  readonly toolId: string;
  readonly commandKind: ToolCommandKind;
}) =>
  Effect.map(ToolRegistry, ({ entries }): ToolTerminalAction => {
    const card = cardOf(entries.get(input.toolId));
    if (card?.setup === undefined)
      return { kind: 'none', reason: 'unknownTool' };

    const command =
      input.commandKind === 'install'
        ? card.setup.installCommand
        : card.setup.authCommand;
    if (!command) return { kind: 'none', reason: 'missingCommand' };

    return { kind: 'terminal', name: `TeXRA: ${card.name}`, command };
  });

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
 * The plugins on this process's dashboard, each with its card, in the order
 * the process lists them. A plugin without a card is not shown and cannot
 * be installed, authed or toggled from it.
 */
export function visibleToolPlugins(
  plugins: ReadonlyMap<string, Plugin>,
): readonly { readonly card: PluginCard; readonly plugin: Plugin }[] {
  return [...plugins.values()].flatMap((plugin) => {
    const card = cardOf(plugin);
    return card === undefined ? [] : [{ card, plugin }];
  });
}

/**
 * The tool dashboard's items: the built-in plugins first, then the probed
 * plugins as `results` found them (their `statusDetail` included), each in
 * list order. Only a host with a code editor (VS Code's settings view; not
 * the desktop app or the CLI) gets an "Install Extension" action.
 */
export const buildToolDashboardItems = Effect.fn('buildToolDashboardItems')(
  function* (
    results: readonly ExternalToolCheckResult[],
    editor: EditorIntegrationShape | undefined,
  ) {
    const visible = visibleToolPlugins((yield* ToolRegistry).entries);
    const builtinItems: ToolDashboardItem[] = visible
      .filter(({ plugin }) => plugin.availability === undefined)
      .map(({ card, plugin }) => ({
        id: plugin.id,
        name: card.name,
        description: card.description,
        tools: (plugin.tools ?? []).map(({ definition: { name } }) => ({
          name,
        })),
        status: 'available' as const,
        installActions: [],
        requiresSetup: false,
        ...settingRows(card),
      }));

    const resultById = new Map(results.map((result) => [result.id, result]));

    const disabledIds = yield* Effect.flatMap(
      ToolCatalog,
      (catalog) => catalog.disabled,
    );
    const externalItems: ToolDashboardItem[] = [];
    for (const { card, plugin } of visible) {
      const result = resultById.get(plugin.id);
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
        id: plugin.id,
        name: card.name,
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
          // Only a host with an editor gets an "Install Extension" button;
          // the install guide and URL still describe the standalone path
          // (Lean 4's `lake` build, for one).
          ...(installExtensionId && editor
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
        enabled: !disabledIds.has(plugin.id),
        ...settingRows(card),
      });
    }

    return [...builtinItems, ...externalItems];
  },
);
