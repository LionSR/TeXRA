/**
 * The Plugins and LaTeX pages of the settings body: the plugin rows
 * (`./pluginRows`), TeXRA's plugin switches and their terminal commands, the
 * LaTeX toolchain status with its install commands, and the host editor's
 * extensions and recommended settings where the host has an editor.
 */
import { Effect, Predicate, Stream, SubscriptionRef } from 'effect';

import { ToolAvailability, ToolCatalog } from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import {
  detectLatexSettingsStatus,
  isAllowedLatexInstallCommand,
} from '@texra/controllers/settingsView/LatexToolingController';
import {
  buildPluginRows,
  type PluginPageRoots,
} from '@texra/controllers/settingsView/pluginRows';
import { planToolTerminalAction } from '@texra/controllers/settingsView/ToolDashboardData';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';

import {
  SETTINGS_LOG_CHANNEL,
  hostStatePage,
  type SettingsHostBindings,
  type SettingsPresentation,
} from './settingsHostBindings';

/** The Plugins and LaTeX pages: their arms, their pages, and the follower
 *  of the tool availability the Plugins page reads. */
export function settingsToolCommands(ports: {
  readonly roots: PluginPageRoots;
  readonly bindings: SettingsHostBindings;
  readonly present: Pick<
    SettingsPresentation,
    'changed' | 'notice' | 'reported'
  >;
}) {
  const { bindings, roots } = ports;
  const { editor } = bindings;
  const { changed, notice, reported } = ports.present;
  // The page shows no editor control on a host without one.
  const requireEditor = editor
    ? Effect.succeed(editor)
    : Effect.fail(new Error('This host has no code editor.'));
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
          buildPluginRows({ ...roots, editor }, held.get(roots.workspace)),
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
        Effect.suspend(() => detectLatexSettingsStatus(editor)),
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
    // The plugin rows follow the editor's own extension-change re-probe.
    installExtension: ({ extensionId }) =>
      reported(
        `Failed to install extension "${extensionId}"`,
        Effect.gen(function* () {
          yield* (yield* requireEditor).install(extensionId);
          yield* notice(`Extension "${extensionId}" installed`);
          yield* changed('latex');
        }),
      ),
    applyLatexSettings: ({ field, reset = false }) =>
      reported(
        'Failed to update LaTeX settings',
        Effect.gen(function* () {
          yield* (yield* requireEditor).applyRecommended(field, reset);
          yield* changed('latex');
          const verb = reset ? 'reset' : 'applied';
          yield* notice(
            field
              ? `LaTeX setting ${verb}`
              : `All recommended LaTeX settings ${verb}`,
          );
        }),
      ),
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;

  return { handlers, pages, refresh, followToolAvailability };
}
