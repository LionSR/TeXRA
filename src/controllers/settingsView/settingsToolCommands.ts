/**
 * The Plugins and LaTeX pages of the settings body: the plugin rows
 * (`./pluginRows`), TeXRA's plugin switches and their terminal commands, and
 * the LaTeX toolchain status with its install commands. Installing a VS Code
 * extension and writing VS Code's own settings stay with the host that can.
 */
import { Effect, Stream, SubscriptionRef } from 'effect';

import {
  detectLatexSettingsStatus,
  isAllowedLatexInstallCommand,
} from '@controllers/settingsView/LatexToolingController';
import { buildPluginRows } from '@controllers/settingsView/pluginRows';
import { planToolTerminalAction } from '@controllers/settingsView/ToolDashboardData';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { USER_MCP_CONFIG_PATH } from '@tools/mcp/mcpConfig';
import { setToolEnabled } from '@tools/toolAvailability';
import { ToolAvailability } from '@tools/toolAvailabilityService';
import { ToolRegistry } from '@tools/toolTable';

import {
  SETTINGS_LOG_CHANNEL,
  type SettingsHostBindings,
} from './settingsHostBindings';

/** The Plugins and LaTeX pages: their arms, repaints and opening data. */
export function settingsToolCommands(ports: {
  readonly roots: Pick<
    WorkspaceRoots,
    'host' | 'workspace' | 'config' | 'globalState' | 'globalStorage'
  >;
  readonly bindings: SettingsHostBindings;
}) {
  const { bindings, roots } = ports;
  const refresh = Effect.flatMap(ToolAvailability, (availability) =>
    availability.refresh(roots),
  );

  // Results no probe has produced yet stay `undefined` so the build runs the
  // probes; coercing them to `[]` would render "zero external tools".
  const postPlugins = bindings.post(
    Effect.flatMap(ToolAvailability, (availability) =>
      Effect.flatMap(SubscriptionRef.get(availability.results), (held) =>
        Effect.map(
          buildPluginRows(roots, held.get(roots.workspace)),
          (built) => ({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_PLUGINS,
            ...built,
          }),
        ),
      ),
    ),
  );
  const postLatexStatus = bindings.post(
    Effect.map(
      Effect.suspend(() =>
        detectLatexSettingsStatus(bindings.latexRecommendedStatus()),
      ),
      (settings) => ({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
        settings,
      }),
    ),
  );

  /**
   * The rows post from the last results on a detached fiber, so a first
   * probe's network checks (Zotero and others) never hold the first render,
   * then re-probe; `followToolAvailability` repaints them with what the
   * re-probe finds. The view shows a spinner until data arrives, so a failed
   * build still posts an empty page to end it.
   */
  const postStartup = Effect.andThen(
    Effect.forkDetach(
      postPlugins.pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            'The plugin rows could not be built; showing the page empty.',
          ).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(SETTINGS_LOG_CHANNEL),
            Effect.andThen(
              bindings.post(
                Effect.succeed({
                  command: SETTINGS_VIEW_COMMANDS.UPDATE_PLUGINS,
                  rows: [],
                  mcpConfigPath: USER_MCP_CONFIG_PATH,
                  mcpWarnings: [
                    `The plugin list could not be read: ${error.message}`,
                  ],
                }),
              ),
            ),
          ),
        ),
        Effect.ignore({
          log: 'Warn',
          message: 'The empty plugin page could not be posted either.',
        }),
        Effect.andThen(refresh),
      ),
      { startImmediately: true },
    ),
    postLatexStatus,
  );

  /**
   * Repaint the rows whenever this workspace's results change, whoever
   * probed: a session opening, the Re-check button, a credential write, an
   * editor extension installed. Runs until interrupted; the host holds it
   * for the view's life and settles each repaint.
   */
  const followToolAvailability = <E, R>(
    repaint: (post: typeof postPlugins) => Effect.Effect<void, E, R>,
  ) =>
    Effect.flatMap(ToolAvailability, (availability) =>
      SubscriptionRef.changes(availability.results).pipe(
        Stream.map((held) => held.get(roots.workspace)),
        Stream.changes,
        Stream.filter((results) => results !== undefined),
        Stream.runForEach(() => repaint(postPlugins)),
      ),
    );

  const handlers = {
    toggleTool: ({ toolId, enabled }) =>
      setToolEnabled(toolId, enabled, roots.globalState).pipe(
        // A plugin's bundled agents follow its switch (`pluginCatalogLayer`).
        Effect.andThen(postPlugins),
      ),
    // The command is looked up from the plugin manifest, never taken from
    // the webview.
    runToolCommand: ({ toolId, kind }) =>
      Effect.flatMap(ToolRegistry, ({ entries }) => {
        const action = planToolTerminalAction(
          { toolId, commandKind: kind },
          entries,
        );
        return action.kind === 'none'
          ? Effect.fail(
              new Error(
                `No ${kind} command for tool "${toolId}" (${action.reason})`,
              ),
            )
          : bindings.runInTerminal(action.name, action.command);
      }),
    runInstallCommand: ({ installCommand }) =>
      isAllowedLatexInstallCommand(installCommand)
        ? bindings.runInTerminal('TeXRA Install', installCommand)
        : Effect.fail(
            new Error(`Rejected unknown install command: ${installCommand}`),
          ),
    // The rows follow the results the re-probe publishes.
    recheckToolStatus: () => refresh,
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;

  return {
    handlers,
    postStartup,
    postPlugins,
    postLatexStatus,
    followToolAvailability,
  };
}
