import { Effect } from 'effect';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';

import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import {
  buildToolDashboardItems,
  planToolTerminalAction,
} from '@controllers/settingsView/ToolDashboardData';
import { onAppSignal } from '@eventBus/AppSignals';
import type { ConfigProvider, StateStore } from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  ToolCommandKind,
  ToolDashboardItem,
} from '@shared/settingsView/settingsViewMessages';
import { unsupported } from '@shared/utils/dispatcher';
import type { ToolProbeInputs } from '@tools/toolProbes';
import {
  getLastCheckResults,
  refreshToolAvailability,
} from '@tools/toolAvailability';
import { ensureError } from '@utils/errors/errorMessage';
import { setToolEnabled } from '@utils/config/constants';

const NO_EXTENSION_HOSTING =
  'TeXRA Desktop runs standalone and cannot host VS Code extensions.';

type DesktopToolHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION
  | typeof SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL
  | typeof SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND
>;

type DesktopLatexHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS
  | typeof SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP
  | typeof SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND
>;

interface DefaultDesktopToolingSettingsControllerOptions {
  readonly config: ConfigProvider;
  readonly globalState: StateStore;
  /** The active paper's workspace folder, for the probes that need one. */
  readonly workspaceRoot: string | undefined;
  readonly runtime: ProcessRuntime;
  readonly onError: (error: unknown) => void;
  readonly renderer: {
    postToRenderer(message: unknown): void;
  };
  readonly commands: {
    run(command: string): Promise<void>;
  };
  readonly latexToolingController: LatexToolingController;
}

export interface DesktopToolingSettingsController {
  readonly toolHandlers: DesktopToolHandlers;
  readonly latexHandlers: DesktopLatexHandlers;
  postStartupData(): Effect.Effect<void, Error, ProcessServices>;
  /**
   * Repaints the Tools tab on every re-probe, whoever triggered it — the
   * shared Re-check arm, a GitHub token write, or any future core-side input
   * change — until interrupted. Following the signal rather than posting
   * after each call site is what makes the dashboard follow availability
   * instead of following the one path that remembered to re-post. The
   * settings IPC forks it into the window's project scope.
   */
  readonly followToolAvailability: Effect.Effect<void>;
}

/** Owns the desktop settings Tools and LaTeX domains. */
export class DefaultDesktopToolingSettingsController implements DesktopToolingSettingsController {
  readonly toolHandlers: DesktopToolHandlers;
  readonly latexHandlers: DesktopLatexHandlers;
  readonly followToolAvailability: Effect.Effect<void>;

  constructor(
    private readonly options: DefaultDesktopToolingSettingsControllerOptions,
  ) {
    this.toolHandlers = {
      installToolExtension: unsupported(NO_EXTENSION_HOSTING),
      // Each arm is a settings-view message, so its program settles here.
      toggleTool: (message) => this.toggleTool(message.toolId, message.enabled),
      runToolCommand: (message) => this.runToolCommand(message),
    };
    this.latexHandlers = {
      applyLatexSettings: unsupported(
        'Recommended VS Code settings can only be applied from the TeXRA VS Code extension.',
      ),
      installLatexWorkshop: unsupported(NO_EXTENSION_HOSTING),
      runInstallCommand: (message) =>
        this.runLatexInstallCommand(message.installCommand),
    };
    this.followToolAvailability = onAppSignal('toolAvailabilityChanged', () => {
      options.runtime.runFork(
        this.reportingFailure(this.postToolDashboardData()),
      );
    });
  }

  postStartupData(): Effect.Effect<void, Error, ProcessServices> {
    return Effect.all(
      [this.postToolDashboardData(), this.postLatexSettingsStatus()],
      { concurrency: 'unbounded' },
    ).pipe(
      // The re-probe is not awaited and outlives this program: the cached
      // data is already posted, and its own `toolAvailabilityChanged` signal
      // repaints the dashboard through the subscription above when it lands.
      // Forked on the runtime rather than in this fiber, like that
      // subscription, so a defect still reaches the fork-failure reporter.
      Effect.andThen(
        Effect.sync(() => {
          this.options.runtime.runFork(
            this.reportingFailure(refreshToolAvailability(this.probeInputs)),
          );
        }),
      ),
      Effect.asVoid,
    );
  }

  /** A post or probe nobody awaits, with its failure reported rather than
   *  dropped — what the fire-and-forget `.catch(onError)` on it did. */
  private reportingFailure<A, E, R>(
    program: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | void, never, R> {
    return Effect.catch(program, (error) =>
      Effect.sync(() => {
        this.options.onError(error);
      }),
    );
  }

  /** The workspace the probes ask about, from the options this window was
   *  built with. */
  private get probeInputs(): ToolProbeInputs {
    return {
      workspaceRoot: this.options.workspaceRoot,
      config: this.options.config,
    };
  }

  private postToolDashboardData() {
    return Effect.gen({ self: this }, function* () {
      // A cold probe cache stays `undefined` so the build runs the probes;
      // coercing it to `[]` would render "zero external tools".
      const items = yield* buildToolDashboardItems(
        'desktop',
        this.probeInputs,
        getLastCheckResults(this.probeInputs.workspaceRoot) ?? undefined,
      );
      this.options.renderer.postToRenderer({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
        items: items.map(withoutExtensionInstall),
      });
    });
  }

  private postLatexSettingsStatus() {
    return Effect.map(
      this.options.latexToolingController.detectStatus(),
      (settings) => {
        this.options.renderer.postToRenderer({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
          settings,
        });
      },
    );
  }

  private toggleTool(toolId: string, enabled: boolean) {
    return Effect.andThen(
      setToolEnabled(toolId, enabled, this.options.globalState),
      this.postToolDashboardData(),
    );
  }

  private runToolCommand(input: { toolId: string; kind: ToolCommandKind }) {
    return Effect.suspend(() => {
      const action = planToolTerminalAction({
        toolId: input.toolId,
        commandKind: input.kind,
      });
      if (action.kind === 'none') {
        return Effect.fail(
          new Error(
            `No ${input.kind} command for tool "${input.toolId}" (${action.reason})`,
          ),
        );
      }
      return Effect.tryPromise({
        try: () => this.options.commands.run(action.command),
        catch: ensureError,
      });
    });
  }

  private runLatexInstallCommand(command: string) {
    return Effect.suspend(() =>
      this.options.latexToolingController.isAllowedInstallCommand(command)
        ? Effect.tryPromise({
            try: () => this.options.commands.run(command),
            catch: ensureError,
          })
        : Effect.fail(
            new Error(`Rejected unknown install command: ${command}`),
          ),
    );
  }
}

/**
 * Drops the marketplace install affordance from a dashboard item. The desktop
 * app cannot host VS Code extensions, so the "Install Extension" button would
 * have nowhere to go; the item's install guide and URL still describe the
 * standalone path (Lean 4's `lake` build, for example).
 */
function withoutExtensionInstall(item: ToolDashboardItem): ToolDashboardItem {
  const installActions = item.installActions.filter(
    (action) => action.kind !== 'extension',
  );
  return installActions.length === item.installActions.length
    ? item
    : { ...item, installActions };
}
