// Local imports
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import type { SettingsViewCommandActions } from '@controllers/settingsView/SettingsViewCommandHandlers';
import type { ToolTerminalAction } from '@controllers/settingsView/ToolDashboardData';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  LATEX_WORKSHOP_EXT_ID,
  type LatexConfigField,
} from '@shared/constants/latex';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import type {
  ToolCommandKind,
  ToolDashboardItem,
} from '@shared/schemas/settingsViewMessages';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';
import { setToolEnabled } from '@utils/config/constants';

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
    refreshDisabledCache(): Promise<void>;
    planTerminalAction(
      toolId: string,
      kind: ToolCommandKind,
    ): Promise<ToolTerminalAction>;
  };
  readonly navigation: {
    openExternal(url: string): Promise<void>;
    presentExtensionInstall(extensionId: string): Promise<void>;
  };
  readonly commands: {
    run(command: string): Promise<void>;
  };
  readonly latexToolingController: LatexToolingController;
  readonly latexConfigPersistenceController: LatexConfigPersistenceController;
}

export interface DesktopToolingSettingsController {
  readonly toolsActions: SettingsViewCommandActions['tools'];
  readonly latexActions: SettingsViewCommandActions['latex'];
  postLatexConfigValues(): void;
  postStartupData(): Promise<void>;
}

/** Owns the desktop settings Tools and LaTeX domains. */
export class DefaultDesktopToolingSettingsController implements DesktopToolingSettingsController {
  readonly toolsActions: SettingsViewCommandActions['tools'];
  readonly latexActions: SettingsViewCommandActions['latex'];

  constructor(
    private readonly options: DefaultDesktopToolingSettingsControllerOptions,
  ) {
    this.toolsActions = {
      openInstallUrl: (url) => options.navigation.openExternal(url),
      installExtension: (extensionId) =>
        options.navigation.presentExtensionInstall(extensionId),
      recheckStatus: () => this.refreshToolDashboard(),
      toggle: (toolId, enabled) => this.toggleTool(toolId, enabled),
      runCommand: (input) => this.runToolCommand(input),
    };
    this.latexActions = {
      applySettings: () => this.postLatexSettingsStatus(),
      installLatexWorkshop: () =>
        options.navigation.presentExtensionInstall(LATEX_WORKSHOP_EXT_ID),
      runInstallCommand: (command) => this.runLatexInstallCommand(command),
      setConfigValue: (input) => this.updateLatexConfigValue(input),
    };
  }

  postLatexConfigValues(): void {
    this.options.renderer.postToRenderer(
      this.options.latexConfigPersistenceController.buildConfigMessage((key) =>
        this.options.workspaceState.get(key),
      ),
    );
  }

  async postStartupData(): Promise<void> {
    await Promise.all([
      this.postToolDashboardData(true),
      this.postLatexSettingsStatus(),
    ]);
    void this.refreshToolDashboard().catch(this.options.onError);
  }

  private async postToolDashboardData(useCachedResults = false): Promise<void> {
    const cachedResults = useCachedResults
      ? await this.options.dashboard.getCachedCheckResults()
      : undefined;
    const items = await this.options.dashboard.buildItems(cachedResults);
    this.options.renderer.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items,
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
    await this.options.dashboard.refreshDisabledCache();
    await this.postToolDashboardData(true);
  }

  private async refreshToolDashboard(): Promise<void> {
    await this.options.dashboard.refreshAvailability();
    await this.postToolDashboardData(true);
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

  private async updateLatexConfigValue(input: {
    field: LatexConfigField;
    value: unknown;
  }): Promise<void> {
    const plan =
      this.options.latexConfigPersistenceController.planUpdate(input);
    if (!plan.ok) {
      throw new Error(`Invalid LaTeX config value for ${input.field}`, {
        cause: plan.error,
      });
    }

    await this.options.workspaceState.update(
      plan.update.key,
      plan.update.value,
    );
    this.postLatexConfigValues();
  }
}
