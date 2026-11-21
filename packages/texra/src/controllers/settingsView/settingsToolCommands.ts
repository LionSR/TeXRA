/**
 * The Plugins and LaTeX pages of the settings body: the plugin rows
 * (`./pluginRows`), TeXRA's plugin switches and their terminal commands, the
 * LaTeX toolchain status with its install commands, and the host editor's
 * extensions and recommended settings where the host has an editor.
 */
import { Effect, Predicate, Stream, SubscriptionRef } from 'effect';

import { ToolAvailability } from '@texra-ai/harness/host';
import { logFailure, ToolCatalog } from '@texra-ai/harness/plugins';
import {
  detectLatexSettingsStatus,
  isAllowedLatexInstallCommand,
} from '@texra/controllers/settingsView/LatexToolingController';
import {
  buildPluginRows,
  type PluginPageRoots,
} from '@texra/controllers/settingsView/pluginRows';
import { planToolTerminalAction } from '@texra/controllers/settingsView/ToolDashboardData';

import {
  SETTINGS_LOG_CHANNEL,
  SettingsRequestFailed,
  hostStatePage,
  type SettingsHostBindings,
  type SettingsPresentation,
  type SettingsViewInboundHandlerRegistry,
} from './settingsHostBindings';

/** The Plugins and LaTeX pages: their handlers, their pages, and the follower
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
    : Effect.fail(
        new SettingsRequestFailed({ message: 'This host has no code editor.' }),
      );
  /** Probe this workspace's tools again; the rows follow what it finds. */
  const refresh = Effect.flatMap(ToolAvailability, (availability) =>
    availability.refresh(roots),
  );

  const pages = [
    // Results no probe has produced yet are probed now, never coerced to
    // `[]`, which would render "zero external tools"; the held ones are
    // what a toggle repaints from at once. The view shows a spinner until
    // data arrives, so a failed build still sends an empty page to end it.
    hostStatePage(
      'plugins',
      ['plugins'],
      Effect.gen(function* () {
        const availability = yield* ToolAvailability;
        const held = yield* SubscriptionRef.get(availability.results);
        return yield* buildPluginRows(
          { ...roots, editor },
          held.get(roots.workspace) ?? (yield* availability.refresh(roots)),
        );
      }).pipe(
        Effect.catch((error) =>
          logFailure(
            SETTINGS_LOG_CHANNEL,
            'The plugin rows could not be built; showing the page empty.',
          )(error).pipe(
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
   *
   * The surface holds its workspace's results for as long as it follows
   * them. Results are kept only while something holds their root, and a
   * page that found none probes once: with no session open here and no
   * hold, that probe's result was dropped as the probe returned, the
   * follower had seen it and rebuilt the page, and the page, finding none
   * again, probed again, without end.
   */
  const followToolAvailability = Effect.flatMap(
    ToolAvailability,
    (availability) =>
      Effect.scoped(
        Effect.andThen(
          availability.hold(roots),
          SubscriptionRef.changes(availability.results).pipe(
            Stream.map((held) => held.get(roots.workspace)),
            Stream.changes,
            Stream.filter(Predicate.isNotUndefined),
            Stream.runForEach(() => changed('plugins')),
          ),
        ),
      ),
  );

  const handlers = {
    toggleTool: ({ toolId, enabled }) =>
      Effect.flatMap(ToolCatalog, (catalog) =>
        catalog.setEnabled(toolId, enabled),
      ).pipe(
        // A plugin's bundled agents follow its switch, and every launcher
        // follows the agent catalog (`agentCatalogFollower`).
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
                new SettingsRequestFailed({
                  message: `No ${kind} command for tool "${toolId}" (${action.reason})`,
                }),
              )
            : bindings.runInTerminal(action.name, action.command),
      ),
    runInstallCommand: ({ installCommand }) =>
      isAllowedLatexInstallCommand(installCommand)
        ? bindings.runInTerminal('TeXRA Install', installCommand)
        : Effect.fail(
            new SettingsRequestFailed({
              message: `Rejected unknown install command: ${installCommand}`,
            }),
          ),
    // The rows follow the results the re-probe publishes.
    recheckToolStatus: () => refresh,
    // The LaTeX page reads which extensions are installed; no plugin probe
    // or row does, so only that page is rebuilt.
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
