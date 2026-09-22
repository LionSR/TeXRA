import { Effect } from 'effect';

import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import {
  buildToolDashboardItems,
  planToolTerminalAction,
} from '@controllers/settingsView/ToolDashboardData';
import type { ConfigProvider } from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  SettingsViewInboundHandlerRegistry,
  ToolCommandKind,
  ToolDashboardItem,
} from '@shared/settingsView/settingsViewMessages';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { unsupported } from '@shared/utils/dispatcher';
import type { ToolProbeInputs } from '@tools/externalToolDefs';
import {
  getLastCheckResults,
  refreshToolAvailability,
} from '@tools/toolAvailability';
import { setToolEnabled } from '@utils/config/constants';

import { subscribeDesktopAppSignal } from './desktopAppSignalSubscription.js';

const NO_EXTENSION_HOSTING =
  'TeXRA Desktop runs standalone and cannot host VS Code extensions.';

type DesktopToolHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL
  | typeof SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION
  | typeof SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS
  | typeof SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL
  | typeof SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND
>;

type DesktopLatexHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS
  | typeof SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP
  | typeof SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND
>;

interface DefaultDesktopToolingSettingsControllerOptions extends SettingsStatePorts {
  readonly config: ConfigProvider;
  /** The active paper's workspace folder, for the probes that need one. */
  readonly workspaceRoot: string | undefined;
  readonly runtime: ProcessRuntime;
  readonly onError: (error: unknown) => void;
  readonly renderer: {
    postToRenderer(message: unknown): void;
  };
  readonly navigation: {
    openExternal(url: string): Promise<void>;
  };
  readonly commands: {
    run(command: string): Promise<void>;
  };
  readonly latexToolingController: LatexToolingController;
}

export interface DesktopToolingSettingsController {
  readonly toolHandlers: DesktopToolHandlers;
  readonly latexHandlers: DesktopLatexHandlers;
  postLatexConfigValues(): Effect.Effect<void, Error>;
  postStartupData(): Effect.Effect<void, Error, ProcessServices>;
  /**
   * Releases the app-signal subscription. Scoped to the window that built this
   * controller: `createWindow` runs again on macOS dock reactivation, so an
   * undisposed subscription would keep repainting a destroyed window's
   * renderer and pile up one listener per reopen.
   */
  dispose(): void;
}

/** Owns the desktop settings Tools and LaTeX domains. */
export class DefaultDesktopToolingSettingsController implements DesktopToolingSettingsController {
  readonly toolHandlers: DesktopToolHandlers;
  readonly latexHandlers: DesktopLatexHandlers;
  private readonly unsubscribeToolAvailability: () => void;

  constructor(
    private readonly options: DefaultDesktopToolingSettingsControllerOptions,
  ) {
    this.toolHandlers = {
      openToolInstallUrl: (message) =>
        options.navigation.openExternal(message.url),
      installToolExtension: unsupported(NO_EXTENSION_HOSTING),
      // Each arm is a settings-view message, so its program settles here.
      recheckToolStatus: () =>
        options.runtime.runPromise(refreshToolAvailability(this.probeInputs)),
      toggleTool: (message) =>
        options.runtime.runPromise(
          this.toggleTool(message.toolId, message.enabled),
        ),
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
    // Every re-probe repaints the Tools tab, whoever triggered it — the
    // Re-check button, a GitHub token write, or any future core-side input
    // change. Subscribing here rather than posting after each call site is
    // what makes the dashboard follow availability instead of following the
    // one path that remembered to re-post.
    this.unsubscribeToolAvailability = subscribeDesktopAppSignal(
      options.runtime,
      'toolAvailabilityChanged',
      () => {
        options.runtime.runFork(
          this.reportingFailure(this.postToolDashboardData()),
        );
      },
    );
  }

  dispose(): void {
    this.unsubscribeToolAvailability();
  }

  postLatexConfigValues(): Effect.Effect<void, Error> {
    return Effect.map(
      buildSettingsSnapshotMessage(
        'latex',
        {
          config: this.options.config,
          workspaceState: this.options.workspaceState,
          globalState: this.options.globalState,
        },
        'desktop',
      ),
      (message) => this.options.renderer.postToRenderer(message),
    );
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
        getLastCheckResults() ?? undefined,
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

  private async runToolCommand(input: {
    toolId: string;
    kind: ToolCommandKind;
  }): Promise<void> {
    const action = planToolTerminalAction({
      toolId: input.toolId,
      commandKind: input.kind,
    });
    if (action.kind === 'none') {
      this.options.onError(
        new Error(
          `No ${input.kind} command for tool "${input.toolId}" (${action.reason})`,
        ),
      );
      return;
    }
    await this.options.commands.run(action.command);
  }

  private async runLatexInstallCommand(command: string): Promise<void> {
    if (!this.options.latexToolingController.isAllowedInstallCommand(command)) {
      throw new Error(`Rejected unknown install command: ${command}`);
    }
    await this.options.commands.run(command);
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
