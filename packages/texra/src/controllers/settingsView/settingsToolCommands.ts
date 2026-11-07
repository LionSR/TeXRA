/**
 * The Plugins and LaTeX pages of the settings body: the plugin rows
 * (`./pluginRows`), TeXRA's plugin switches and their terminal commands, and
 * the LaTeX toolchain status with its install commands. Installing a VS Code
 * extension and writing VS Code's own settings stay with the host that can.
 */
import { Effect, Predicate, Stream, SubscriptionRef } from 'effect';

import {
  ToolAvailability,
  ToolCatalog,
  withLogChannel,
} from '@texra-ai/harness/host';
import {
  detectLatexSettingsStatus,
  isAllowedLatexInstallCommand,
} from '@texra/controllers/settingsView/LatexToolingController';
import { buildPluginRows } from '@texra/controllers/settingsView/pluginRows';
import { planToolTerminalAction } from '@texra/controllers/settingsView/ToolDashboardData';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';

import {
  SETTINGS_LOG_CHANNEL,
  hostStatePage,
  type SettingsHostBindings,
  type SettingsPresentation,
} from './settingsHostBindings';
import type { WorkspaceRoots } from '@texra-ai/harness';

/** The Plugins and LaTeX pages: their arms, their pages, and the follower
 *  of the tool availability the Plugins page reads. */
export function settingsToolCommands(ports: {
  readonly roots: Pick<
    WorkspaceRoots,
    'workspace' | 'config' | 'globalState' | 'globalStorage' | 'storageRoot'
  >;
  readonly bindings: SettingsHostBindings;
  readonly present: Pick<SettingsPresentation, 'changed'>;
  /** The host installs an editor extension a plugin card names. */
  readonly installsExtensions: boolean;
}) {
  const { bindings, roots, installsExtensions } = ports;
  const { changed } = ports.present;
  /** Probe this workspace's tools again; the rows follow what it finds. */
  const refresh = Effect.flatMap(ToolAvailability, (availability) =>
    availability.refresh(roots),
  );

  const pages = [
    // Results no probe has produced yet stay `undefined` so the build runs
    // the probes; coercing them to `[]` would render "zero external tools".
    // The view shows a spinner until data arrives, so a failed build still
    // sends an empty page to end it.
    hostStatePage(
      'plugins',
      ['plugins'],
      Effect.flatMap(ToolAvailability, (availability) =>
        Effect.flatMap(SubscriptionRef.get(availability.results), (held) =>
          buildPluginRows(
            { ...roots, installsExtensions },
            held.get(roots.workspace),
          ),
        ),
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            'The plugin rows could not be built; showing the page empty.',
          ).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(SETTINGS_LOG_CHANNEL),
            Effect.as({
              rows: [],
              mcpWarnings: [
                `The plugin list could not be read: ${error.message}`,
              ],
            }),
          ),
        ),
      ),
    ),
    hostStatePage(
      'latex',
      ['latex'],
      Effect.map(
        Effect.suspend(() =>
          detectLatexSettingsStatus(bindings.latexEditorStatus()),
        ),
        (settings) => ({ settings }),
      ),
    ),
  ];

  /**
   * The rows' input changes whenever this workspace's results change,
   * whoever probed: a session opening, the Re-check button, a credential
   * write, an editor extension installed. Runs until interrupted.
   */
  const followToolAvailability = Effect.flatMap(
    ToolAvailability,
    (availability) =>
      SubscriptionRef.changes(availability.results).pipe(
        Stream.map((held) => held.get(roots.workspace)),
        Stream.changes,
        Stream.filter(Predicate.isNotUndefined),
        Stream.runForEach(() => changed('plugins')),
      ),
  );

  const handlers = {
    toggleTool: ({ toolId, enabled }) =>
      Effect.flatMap(ToolCatalog, (catalog) =>
        catalog.setEnabled(toolId, enabled),
      ).pipe(
        // A plugin's bundled agents follow its switch (`pluginCatalogLayer`):
        // reload them before the rows read who uses what.
        Effect.andThen(bindings.refreshCatalogs()),
        Effect.andThen(changed('plugins')),
      ),
    // The command is looked up from the plugin's card, never taken from
    // the webview.
    runToolCommand: ({ toolId, kind }) =>
      Effect.flatMap(
        planToolTerminalAction({ toolId, commandKind: kind }),
        (action) =>
          action.kind === 'none'
            ? Effect.fail(
                new Error(
                  `No ${kind} command for tool "${toolId}" (${action.reason})`,
                ),
              )
            : bindings.runInTerminal(action.name, action.command),
      ),
    runInstallCommand: ({ installCommand }) =>
      isAllowedLatexInstallCommand(installCommand)
        ? bindings.runInTerminal('TeXRA Install', installCommand)
        : Effect.fail(
            new Error(`Rejected unknown install command: ${installCommand}`),
          ),
    // The rows follow the results the re-probe publishes.
    recheckToolStatus: () => refresh,
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;

  return { handlers, pages, refresh, followToolAvailability };
}
