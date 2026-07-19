// Local imports - shared settings controllers

// Local imports - shared settings types
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import type { SettingsViewCommandActions } from '@controllers/settingsView/SettingsViewCommandHandlers';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  LATEX_WORKSHOP_EXT_ID,
  type LatexConfigField,
} from '@shared/constants/latex';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingsStatePorts } from '@shared/settingsView/types';

// Local imports - controller and tool dashboard types
import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';

interface DesktopToolDashboardPort {
  buildItems(
    cachedResults?: ExternalToolCheckResult[],
  ): Promise<ToolDashboardItem[]>;
  getCachedCheckResults(): Promise<ExternalToolCheckResult[] | undefined>;
  refreshAvailability(): Promise<void>;
  refreshDisabledCache(): Promise<void>;
  findCommand(
    toolId: string,
    kind: 'install' | 'auth',
  ): Promise<string | undefined>;
}

interface DesktopToolingRendererPort {
  postToRenderer(message: unknown): void;
}

interface DesktopToolingNavigationPort {
  openExternal(url: string): Promise<void>;
  presentExtensionInstall(extensionId: string): Promise<void>;
}

interface DesktopToolingCommandPort {
  run(command: string): Promise<void>;
}

interface DefaultDesktopToolingSettingsControllerOptions extends SettingsStatePorts {
  readonly renderer: DesktopToolingRendererPort;
  readonly dashboard: DesktopToolDashboardPort;
  readonly navigation: DesktopToolingNavigationPort;
  readonly commands: DesktopToolingCommandPort;
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

  private readonly latexConfigPersistenceController: LatexConfigPersistenceController;

  constructor(
    private readonly options: DefaultDesktopToolingSettingsControllerOptions,
  ) {
    this.latexConfigPersistenceController =
      options.latexConfigPersistenceController;
    this.toolsActions = {
      openInstallUrl: (url) => options.navigation.openExternal(url),
      installExtension: (extensionId) =>
        options.navigation.presentExtensionInstall(extensionId),
      recheckStatus: () => this.recheckToolStatus(),
      toggle: (toolId, enabled) => this.setToolEnabled(toolId, enabled),
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
      this.latexConfigPersistenceController.buildConfigMessage((key) =>
        this.options.workspaceState.get(key),
      ),
    );
  }

  async postStartupData(): Promise<void> {
    await Promise.all([
      this.postToolDashboardData(),
      this.postLatexSettingsStatus(),
    ]);
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

  private async setToolEnabled(
    toolId: string,
    enabled: boolean,
  ): Promise<void> {
    const current = this.options.globalState.get<string[]>(
      GlobalStateKey.DISABLED_TOOLS,
      [],
    );
    const disabled = new Set(current);
    if (enabled) {
      disabled.delete(toolId);
    } else {
      disabled.add(toolId);
    }

    await this.options.globalState.update(GlobalStateKey.DISABLED_TOOLS, [
      ...disabled,
    ]);
    await this.options.dashboard.refreshDisabledCache();
    await this.postToolDashboardData(true);
  }

  private async recheckToolStatus(): Promise<void> {
    await this.options.dashboard.refreshAvailability();
    await this.postToolDashboardData(true);
  }

  private async runToolCommand(input: {
    toolId: string;
    kind: 'install' | 'auth';
  }): Promise<void> {
    const command = await this.options.dashboard.findCommand(
      input.toolId,
      input.kind,
    );
    if (!command) return;
    await this.options.commands.run(command);
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
    const plan = this.latexConfigPersistenceController.planUpdate(input);
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
