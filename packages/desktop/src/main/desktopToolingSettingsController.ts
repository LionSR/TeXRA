import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import type { ToolTerminalAction } from '@controllers/settingsView/ToolDashboardData';
import { appSignals } from '@eventBus/AppSignals';
import { platform } from '@platform/platform';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  SettingsViewInboundHandlerRegistry,
  ToolCommandKind,
  ToolDashboardItem,
} from '@shared/schemas';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { unsupported } from '@shared/utils/dispatcher';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';
import { setToolEnabled } from '@utils/config/constants';

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
  readonly onError: (error: unknown) => void;
  readonly renderer: {
    postToRenderer(message: unknown): void;
  };
  readonly dashboard: {
    buildItems(
      cachedResults?: ExternalToolCheckResult[],
    ): Promise<ToolDashboardItem[]>;
    getCachedCheckResults(): Promise<ExternalToolCheckResult[] | undefined>;
    refreshAvailability(): Promise<void>;
    planTerminalAction(
      toolId: string,
      kind: ToolCommandKind,
    ): Promise<ToolTerminalAction>;
  };
  readonly navigation: {
    openExternal(url: string): Promise<void>;
  };
  readonly commands: {
    run(command: string): Promise<void>;
  };
  readonly latexToolingController: LatexToolingController;
  readonly latexConfigPersistenceController: LatexConfigPersistenceController;
}

export interface DesktopToolingSettingsController {
  readonly toolHandlers: DesktopToolHandlers;
  readonly latexHandlers: DesktopLatexHandlers;
  postLatexConfigValues(): void;
  postStartupData(): Promise<void>;
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
      recheckToolStatus: () => options.dashboard.refreshAvailability(),
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
    // Every re-probe repaints the Tools tab, whoever triggered it — the
    // Re-check button, a GitHub token write, or any future core-side input
    // change. Subscribing here rather than posting after each call site is
    // what makes the dashboard follow availability instead of following the
    // one path that remembered to re-post.
    this.unsubscribeToolAvailability = appSignals.on(
      'toolAvailabilityChanged',
      () => {
        void this.postToolDashboardData().catch(options.onError);
      },
    );
  }

  dispose(): void {
    this.unsubscribeToolAvailability();
  }

  postLatexConfigValues(): void {
    this.options.renderer.postToRenderer(
      this.options.latexConfigPersistenceController.buildConfigMessage(
        (key) => this.options.workspaceState.get(key),
        platform().config,
      ),
    );
  }

  async postStartupData(): Promise<void> {
    await Promise.all([
      this.postToolDashboardData(),
      this.postLatexSettingsStatus(),
    ]);
    void this.options.dashboard
      .refreshAvailability()
      .catch(this.options.onError);
  }

  private async postToolDashboardData(): Promise<void> {
    const cachedResults = await this.options.dashboard.getCachedCheckResults();
    const items = await this.options.dashboard.buildItems(cachedResults);
    this.options.renderer.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items: items.map(withoutExtensionInstall),
    });
  }

  private async postLatexSettingsStatus(): Promise<void> {
    const settings = await this.options.latexToolingController.detectStatus();
    this.options.renderer.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
      settings,
    });
  }

  private async toggleTool(toolId: string, enabled: boolean): Promise<void> {
    await setToolEnabled(toolId, enabled, this.options.globalState);
    await this.postToolDashboardData();
  }

  private async runToolCommand(input: {
    toolId: string;
    kind: ToolCommandKind;
  }): Promise<void> {
    const action = await this.options.dashboard.planTerminalAction(
      input.toolId,
      input.kind,
    );
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
  if (item.installExtensionId == null) return item;
  const { installExtensionId, ...rest } = item;
  return rest;
}
