// Local imports
import type {
  computeAgentOptionsData,
  loadAgents,
  refresh,
  AgentEntry,
} from '@agent/index/agentRegistry';
import type { TeamAvailabilityChoice } from '@common/teams/TeamAvailabilityPreflight';
import { applyTeamRosterWithPreflight } from '@common/teams/TeamRosterApplication';
import { createSettingsAgentControllers } from '@controllers/settingsView/SettingsAgentControllerFactory';
import type { SettingsViewCommandActions } from '@controllers/settingsView/SettingsViewCommandHandlers';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategory, AgentSource } from '@shared/schemas/agent';
import {
  buildAgentModePresetsMessage,
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { unsupported } from '@shared/utils/dispatcher';

export interface DefaultDesktopAgentSettingsControllerOptions extends SettingsStatePorts {
  readonly registry: {
    readonly loadAgents: typeof loadAgents;
    readonly refreshAgents: typeof refresh;
    readonly loadAgentOptionsData: typeof computeAgentOptionsData;
    readonly getAgents: (category: AgentCategory) => AgentEntry[];
    readonly getVisibleAgents: (category: AgentCategory) => AgentEntry[];
  };
  readonly directory: {
    readonly getCustomAgentDirectory: () => Promise<string>;
    readonly getSourceDirectory: (
      source: AgentSource,
    ) => Promise<string | undefined>;
    readonly selectCustomAgentDirectory: () => Promise<string | undefined>;
    readonly openPath: (filePath: string) => Promise<void>;
    readonly revealPath: (filePath: string) => Promise<void>;
  };
  readonly renderer: {
    readonly postToRenderer: (message: unknown) => void;
  };
  readonly prompts: {
    readonly promptText: (input: {
      title: string;
      prompt: string;
    }) => Promise<string | undefined>;
    readonly chooseTeamAvailability: (input: {
      presetName: string;
      unavailableNames: readonly string[];
    }) => Promise<TeamAvailabilityChoice>;
  };
  readonly remoteCatalog: {
    readonly canAccess: () => Promise<boolean>;
    readonly signIn: () => Promise<boolean>;
  };
  readonly notifications: {
    readonly showInfoMessage: (message: string) => Promise<void>;
    readonly showErrorMessage: (message: string) => Promise<void>;
  };
}

export interface DesktopAgentSettingsController {
  readonly actions: SettingsViewCommandActions['agentSelection'];
  postStartupData(): Promise<void>;
  refreshCatalogData(): Promise<void>;
}

/** Owns the desktop settings agent catalog, directory, and roster behavior. */
export class DefaultDesktopAgentSettingsController implements DesktopAgentSettingsController {
  readonly actions: SettingsViewCommandActions['agentSelection'];

  private readonly catalogController;
  private readonly directoryController;
  private readonly visibilityController;
  private readonly registry: DefaultDesktopAgentSettingsControllerOptions['registry'];
  private readonly directory: DefaultDesktopAgentSettingsControllerOptions['directory'];
  private readonly renderer: DefaultDesktopAgentSettingsControllerOptions['renderer'];
  private readonly prompts: DefaultDesktopAgentSettingsControllerOptions['prompts'];
  private readonly remoteCatalog: DefaultDesktopAgentSettingsControllerOptions['remoteCatalog'];
  private readonly notifications: DefaultDesktopAgentSettingsControllerOptions['notifications'];

  constructor(options: DefaultDesktopAgentSettingsControllerOptions) {
    const {
      workspaceState,
      globalState,
      registry,
      directory,
      renderer,
      prompts,
      remoteCatalog,
      notifications,
    } = options;
    this.registry = registry;
    this.directory = directory;
    this.renderer = renderer;
    this.prompts = prompts;
    this.remoteCatalog = remoteCatalog;
    this.notifications = notifications;
    const controllers = createSettingsAgentControllers({
      workspaceState,
      globalState,
      getCustomAgentDirectory: directory.getCustomAgentDirectory,
      getSourceDirectory: directory.getSourceDirectory,
      getAgents: registry.getAgents,
      getVisibleAgents: registry.getVisibleAgents,
    });
    this.catalogController = controllers.catalog;
    this.directoryController = controllers.directory;
    this.visibilityController = controllers.visibility;
    this.actions = {
      setEnabled: (input) => this.updateAgentEnabled(input),
      setAllEnabled: (input) => this.updateAllAgentsEnabled(input),
      openYaml: (input) => this.openAgentYaml(input),
      openFolder: () => this.openAgentFolder(),
      create: unsupported(
        'Creating custom agents is not available in the desktop app yet.',
      ),
      customize: unsupported(
        'Customizing agents is not available in the desktop app yet.',
      ),
      deleteCustom: unsupported(
        'Deleting custom agents is not available in the desktop app yet.',
      ),
      revealFile: (input) => this.revealAgentFile(input),
      viewRemotePrompt: unsupported(
        'Viewing a remote agent prompt is not available in the desktop app yet.',
      ),
      setCustomDir: () => this.setCustomAgentDir(),
      resetCustomDir: () => this.resetCustomAgentDir(),
      applyModePreset: (presetId) => this.applyAgentModePreset(presetId),
      saveModePreset: () => this.saveAgentModePreset(),
      deleteModePreset: (presetId) => this.deleteAgentModePreset(presetId),
    };
  }

  async postStartupData(): Promise<void> {
    this.postAgentModePresets();
    await Promise.all([
      this.postAgentSelectionData(),
      this.postCustomAgentDir(),
    ]);
  }

  async refreshCatalogData(): Promise<void> {
    await Promise.all([
      this.postAgentSelectionData(),
      this.postMainAgentOptionsData(),
    ]);
  }

  private async postAgentSelectionData(): Promise<void> {
    this.renderer.postToRenderer(
      await buildAgentSelectionMessage({
        loadAgents: this.registry.loadAgents,
        buildSelectionItems: () => this.catalogController.buildSelectionItems(),
      }),
    );
  }

  private async postMainAgentOptionsData(
    selectedToolUseAgent?: string,
  ): Promise<void> {
    this.renderer.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      optionsData: await this.registry.loadAgentOptionsData(),
      ...(selectedToolUseAgent ? { selectedToolUseAgent } : {}),
    });
  }

  private async postCustomAgentDir(): Promise<void> {
    this.renderer.postToRenderer(
      await buildCustomAgentDirMessage({
        getCustomDirStatus: () => this.directoryController.getCustomDirStatus(),
      }),
    );
  }

  private postAgentModePresets(): void {
    this.renderer.postToRenderer(
      buildAgentModePresetsMessage({
        getCustomPresets: () => this.catalogController.getCustomPresets(),
        getOrchestratorAgentNames: () =>
          this.catalogController.getOrchestratorAgentNames(),
      }),
    );
  }

  private async updateAgentEnabled(input: {
    category: AgentCategory;
    source: AgentSource;
    name: string;
    enabled: boolean;
  }): Promise<void> {
    await this.visibilityController.setAgentEnabled(input);
    await this.refreshCatalogData();
  }

  private async updateAllAgentsEnabled(input: {
    category: AgentCategory;
    source: AgentSource;
    enabled: boolean;
  }): Promise<void> {
    await this.visibilityController.setAllAgentsEnabled(input);
    await this.refreshCatalogData();
  }

  private async setCustomAgentDir(): Promise<void> {
    const selectedPath = await this.directory.selectCustomAgentDirectory();
    if (!selectedPath) return;

    await this.directoryController.setCustomDir(selectedPath);
    await Promise.all([
      this.postCustomAgentDir(),
      this.postAgentSelectionData(),
      this.postMainAgentOptionsData(),
    ]);
  }

  private async resetCustomAgentDir(): Promise<void> {
    await this.directoryController.resetCustomDir();
    await Promise.all([
      this.postCustomAgentDir(),
      this.postAgentSelectionData(),
      this.postMainAgentOptionsData(),
    ]);
  }

  private async openAgentYaml(input: {
    source: AgentSource;
    name: string;
  }): Promise<void> {
    const result = this.directoryController.planOpenAgentYaml(input);
    if (!result.ok) {
      await this.notifications.showErrorMessage(
        result.reason === 'missingAgent'
          ? `Agent not found: ${input.name}`
          : `No configuration file found for agent: ${input.name}`,
      );
      return;
    }
    await this.directory.openPath(result.path);
  }

  private async openAgentFolder(): Promise<void> {
    const result = await this.directoryController.planOpenAgentFolder('custom');
    if (!result.ok) {
      await this.notifications.showErrorMessage(
        'No custom agent directory is available',
      );
      return;
    }
    await this.directory.openPath(result.path);
  }

  private async revealAgentFile(input: {
    source: AgentSource;
    name: string;
  }): Promise<void> {
    const result = this.directoryController.planRevealAgentFile(input);
    if (!result.ok) {
      await this.notifications.showErrorMessage(
        `Agent not found or has no file: ${input.name}`,
      );
      return;
    }
    await this.directory.revealPath(result.path);
  }

  private async applyAgentModePreset(presetId: string): Promise<void> {
    const result = await applyTeamRosterWithPreflight(presetId, {
      catalog: this.catalogController,
      loadLocalCatalog: () =>
        this.registry.loadAgents({ includeRemote: false }),
      canAccessRemoteCatalog: this.remoteCatalog.canAccess,
      choose: (preset, unavailableNames) =>
        this.prompts.chooseTeamAvailability({
          presetName: preset.name,
          unavailableNames,
        }),
      signIn: this.remoteCatalog.signIn,
      forceRefreshRemoteCatalog: () =>
        this.registry.refreshAgents({ includeRemote: true }),
    });
    if (result.status === 'unknown') {
      await this.notifications.showErrorMessage(`Unknown team: ${presetId}`);
      return;
    }
    if (result.status === 'cancelled') return;
    if (result.status === 'choice-required') return;
    if (result.status === 'unavailable') {
      await this.notifications.showErrorMessage(
        `Team "${result.preset.name}" is still unavailable: ${result.unavailableNames.join(', ')}`,
      );
      return;
    }
    await Promise.all([
      this.postAgentSelectionData(),
      this.postMainAgentOptionsData(
        this.catalogController.getPresetToolUseRoot(
          result.preset.toolUseAgents,
        ),
      ),
    ]);
    await this.notifications.showInfoMessage(
      `Applied "${result.preset.name}" team`,
    );
  }

  private async saveAgentModePreset(): Promise<void> {
    const name = await this.prompts.promptText({
      title: 'Save agent team',
      prompt: 'Name for the new team',
    });
    if (!name?.trim()) return;
    await this.registry.loadAgents();
    const preset = await this.catalogController.saveCurrentPreset(name);
    this.postAgentModePresets();
    await this.notifications.showInfoMessage(`Saved team "${preset.name}"`);
  }

  private async deleteAgentModePreset(presetId: string): Promise<void> {
    const deleted = await this.catalogController.deleteCustomPreset(presetId);
    if (!deleted) {
      await this.notifications.showErrorMessage(
        `Unknown custom team: ${presetId}`,
      );
      return;
    }
    this.postAgentModePresets();
  }
}
