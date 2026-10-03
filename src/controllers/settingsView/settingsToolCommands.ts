/**
 * The Tools and LaTeX pages of the settings body: the tool dashboard, its
 * switches and terminal commands, and the LaTeX toolchain status with its
 * install commands. Installing a VS Code extension and writing VS Code's own
 * settings stay with the host that can.
 */
import { Effect, Stream, SubscriptionRef } from 'effect';

import {
  detectLatexSettingsStatus,
  isAllowedLatexInstallCommand,
} from '@controllers/settingsView/LatexToolingController';
import {
  buildToolDashboardItems,
  planToolTerminalAction,
} from '@controllers/settingsView/ToolDashboardData';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ToolDashboardItem } from '@shared/settingsView/settingsViewMessages';
import { setToolEnabled } from '@tools/toolAvailability';
import { ToolAvailability } from '@tools/toolAvailabilityService';
import { ToolRegistry } from '@tools/toolTable';

import {
  SETTINGS_LOG_CHANNEL,
  type SettingsHostBindings,
} from './settingsHostBindings';

/** The Tools and LaTeX pages: their arms, repaints and opening data. */
export function settingsToolCommands(ports: {
  readonly roots: Pick<
    WorkspaceRoots,
    'host' | 'workspace' | 'config' | 'globalState'
  >;
  readonly bindings: SettingsHostBindings;
}) {
  const { bindings, roots } = ports;
  const refresh = Effect.flatMap(ToolAvailability, (availability) =>
    availability.refresh(roots),
  );

  const postItems = <E, R>(items: Effect.Effect<ToolDashboardItem[], E, R>) =>
    bindings.post(
      Effect.map(items, (built) => ({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
        items: built,
      })),
    );
  // Results no probe has produced yet stay `undefined` so the build runs the
  // probes; coercing them to `[]` would render "zero external tools".
  const postToolDashboard = postItems(
    Effect.flatMap(ToolAvailability, (availability) =>
      Effect.flatMap(SubscriptionRef.get(availability.results), (held) =>
        buildToolDashboardItems(roots, held.get(roots.workspace)),
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
   * The dashboard posts from the last results on a detached fiber, so a first
   * probe's network checks (Zotero and others) never hold the first render,
   * then re-probes; `followToolAvailability` repaints it with what the
   * re-probe finds. The view shows a spinner until data arrives, so a failed
   * build still posts an empty dashboard to end it.
   */
  const postStartup = Effect.andThen(
    Effect.forkDetach(
      postToolDashboard.pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            'The tool dashboard could not be built; showing it empty.',
          ).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(SETTINGS_LOG_CHANNEL),
            Effect.andThen(postItems(Effect.succeed([]))),
          ),
        ),
        Effect.ignore({
          log: 'Warn',
          message: 'The empty tool dashboard could not be posted either.',
        }),
        Effect.andThen(refresh),
      ),
      { startImmediately: true },
    ),
    postLatexStatus,
  );

  /**
   * Repaint the dashboard whenever this workspace's results change, whoever
   * probed: a session opening, the Re-check button, a credential write, an
   * editor extension installed. Runs until interrupted; the host holds it
   * for the view's life and settles each repaint.
   */
  const followToolAvailability = <E, R>(
    repaint: (post: typeof postToolDashboard) => Effect.Effect<void, E, R>,
  ) =>
    Effect.flatMap(ToolAvailability, (availability) =>
      SubscriptionRef.changes(availability.results).pipe(
        Stream.map((held) => held.get(roots.workspace)),
        Stream.changes,
        Stream.filter((results) => results !== undefined),
        Stream.runForEach(() => repaint(postToolDashboard)),
      ),
    );

  const handlers = {
    toggleTool: ({ toolId, enabled }) =>
      setToolEnabled(toolId, enabled, roots.globalState).pipe(
        // A plugin's bundled agents follow its switch (`pluginCatalogLayer`).
        Effect.andThen(postToolDashboard),
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
    // The dashboard follows the results the re-probe publishes.
    recheckToolStatus: () => refresh,
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;

  return {
    handlers,
    postStartup,
    postToolDashboard,
    postLatexStatus,
    followToolAvailability,
  };
}
