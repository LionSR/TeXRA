/**
 * The Tools and LaTeX pages of the settings body: the tool dashboard, its
 * switches and terminal commands, and the LaTeX toolchain status with its
 * install commands. Installing a VS Code extension and writing VS Code's own
 * settings stay with the host that can.
 */
import { Effect } from 'effect';

import { refresh as refreshAgentCatalog } from '@agent/index';
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
import {
  getLastCheckResults,
  refreshToolAvailability,
} from '@tools/toolAvailability';
import { setToolEnabled } from '@utils/config/constants';

import {
  SETTINGS_LOG_CHANNEL,
  type SettingsHostBindings,
} from './settingsHostBindings';

/** The Tools and LaTeX pages: their arms, repaints and opening data. */
export function settingsToolCommands(ports: {
  readonly host: 'vscode' | 'desktop';
  readonly roots: Pick<WorkspaceRoots, 'workspace' | 'config' | 'globalState'>;
  readonly bindings: SettingsHostBindings;
}) {
  const { bindings, roots } = ports;
  const probeInputs = { workspaceRoot: roots.workspace, config: roots.config };

  const postItems = <E, R>(items: Effect.Effect<ToolDashboardItem[], E, R>) =>
    bindings.post(
      Effect.map(items, (built) => ({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
        items: built,
      })),
    );
  // A cold probe cache stays `undefined` so the build runs the probes;
  // coercing it to `[]` would render "zero external tools".
  const postToolDashboard = postItems(
    Effect.suspend(() =>
      buildToolDashboardItems(
        ports.host,
        probeInputs,
        getLastCheckResults(roots.workspace) ?? undefined,
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
   * The dashboard posts from the probe cache on a detached fiber, so a cold
   * cache's network probes (Zotero and others) never hold the first render,
   * then re-probes; the re-probe's `toolAvailabilityChanged` signal repaints
   * it. The view shows a spinner until data arrives, so a failed build still
   * posts an empty dashboard to end it.
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
        Effect.andThen(refreshToolAvailability(probeInputs)),
      ),
      { startImmediately: true },
    ),
    postLatexStatus,
  );

  const handlers = {
    toggleTool: ({ toolId, enabled }) =>
      setToolEnabled(toolId, enabled, roots.globalState).pipe(
        // A plugin's bundled agents follow its switch.
        Effect.andThen(refreshAgentCatalog()),
        Effect.andThen(postToolDashboard),
      ),
    // The command is looked up from the plugin manifest, never taken from
    // the webview.
    runToolCommand: ({ toolId, kind }) => {
      const action = planToolTerminalAction({ toolId, commandKind: kind });
      return action.kind === 'none'
        ? Effect.fail(
            new Error(
              `No ${kind} command for tool "${toolId}" (${action.reason})`,
            ),
          )
        : bindings.runInTerminal(action.name, action.command);
    },
    runInstallCommand: ({ installCommand }) =>
      isAllowedLatexInstallCommand(installCommand)
        ? bindings.runInTerminal('TeXRA Install', installCommand)
        : Effect.fail(
            new Error(`Rejected unknown install command: ${installCommand}`),
          ),
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;

  return { handlers, postStartup, postToolDashboard, postLatexStatus };
}
