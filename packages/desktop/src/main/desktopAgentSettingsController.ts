import path from 'node:path';

import {
  type AgentEntry,
  type AgentRosterController,
  getAgent,
  getCustomAgentScanIssues,
} from '@agent/index';
import type {
  computeAgentOptionsData,
  loadAgents,
  refresh,
} from '@agent/index/agentRegistry';
import {
  AGENT_TEMPLATE_FILES,
  DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
  renderAgentTemplateString,
} from '@agent/templates/agentTemplateRenderer';
import type { TeamAvailabilityChoice } from '@common/teams/TeamAvailabilityPreflight';
import { loadTeamOptions } from '@common/teams/TeamPlan';
import { applyTeamRosterWithPreflight } from '@common/teams/TeamRosterApplication';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import { createSettingsAgentActions } from '@controllers/settingsView/backend/SettingsAgentActions';
import { createSettingsAgentControllers } from '@controllers/settingsView/SettingsAgentControllerFactory';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  agentKey,
  type AgentCategory,
  type AgentSource,
  type SettingsMessageFor,
  type SettingsViewInboundHandlerRegistry,
  type SettingsViewInboundMessage,
} from '@shared/schemas';
import {
  buildAgentModePresetsMessage,
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createTexraTempDir } from '@utils/files/tempDir';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

type AgentCommand = SettingsViewInboundMessage['command'];
type AgentMessage<C extends AgentCommand> = SettingsMessageFor<C>;
type DesktopAgentHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED
  | typeof SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER
  | typeof SETTINGS_VIEW_COMMANDS.CREATE_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE
  | typeof SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT
  | typeof SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR
  | typeof SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR
  | typeof SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET
  | typeof SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET
  | typeof SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET
>;

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
    /**
     * Confirm a destructive or overwriting action. Used by the custom-agent
     * delete and overwrite paths and by team deletion, which the extension
     * guards with a modal.
     */
    readonly confirm: (input: {
      title: string;
      message: string;
    }) => Promise<boolean>;
    readonly chooseTeamAvailability: (input: {
      presetName: string;
      unavailableNames: readonly string[];
    }) => Promise<TeamAvailabilityChoice>;
  };
  /**
   * Root of the packaged resources tree, used to read the bundled agent
   * templates (`templates/<kind>.yaml`) when creating an agent from template.
   */
  readonly resourcesPath: string;
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
  readonly handlers: DesktopAgentHandlers;
  postStartupData(): Promise<void>;
  refreshCatalogData(): Promise<void>;
}

/** Owns the desktop settings agent catalog, directory, and roster behavior. */
export class DefaultDesktopAgentSettingsController implements DesktopAgentSettingsController {
  readonly handlers: DesktopAgentHandlers;

  private readonly catalogController;
  private readonly directoryController;
  private readonly roster: AgentRosterController;
  private readonly registry: DefaultDesktopAgentSettingsControllerOptions['registry'];
  private readonly directory: DefaultDesktopAgentSettingsControllerOptions['directory'];
  private readonly renderer: DefaultDesktopAgentSettingsControllerOptions['renderer'];
  private readonly prompts: DefaultDesktopAgentSettingsControllerOptions['prompts'];
  private readonly remoteCatalog: DefaultDesktopAgentSettingsControllerOptions['remoteCatalog'];
  private readonly notifications: DefaultDesktopAgentSettingsControllerOptions['notifications'];
  private readonly resourcesPath: string;
  private readonly agentActions;
  private readonly remotePromptController;

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
      resourcesPath,
    } = options;
    this.registry = registry;
    this.directory = directory;
    this.renderer = renderer;
    this.prompts = prompts;
    this.remoteCatalog = remoteCatalog;
    this.notifications = notifications;
    this.resourcesPath = resourcesPath;
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
    this.roster = controllers.roster;
    this.remotePromptController = controllers.remotePromptController;
    this.agentActions = createSettingsAgentActions({
      directoryController: this.directoryController,
      findAgent: (source, name) => getAgent(agentKey(source, name)),
      getCustomAgentDirectory: directory.getCustomAgentDirectory,
      getSourceDirectory: directory.getSourceDirectory,
      openDocument: directory.openPath,
      revealFile: directory.revealPath,
      confirmAction: (message, confirmLabel) =>
        prompts.confirm({
          title:
            confirmLabel === 'Delete'
              ? 'Delete custom agent?'
              : 'Overwrite custom copy?',
          message,
        }),
      showInfoMessage: notifications.showInfoMessage,
      showErrorMessage: notifications.showErrorMessage,
      formatOpenAgentYamlError: (reason, name) =>
        reason === 'missingAgent'
          ? `Agent not found: ${name}`
          : `No configuration file found for agent: ${name}`,
      refreshAfterMutation: () => this.refreshAfterAgentMutation(),
      run: async (command, failureMessage, action) => {
        if (
          command === SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML ||
          command === SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE
        ) {
          await action();
          return;
        }
        try {
          await action();
        } catch (error) {
          await notifications.showErrorMessage(
            `${failureMessage}: ${toErrorMessage(error)}`,
          );
        }
      },
    });
    this.handlers = {
      setAgentEnabled: (message) => this.updateAgentEnabled(message),
      setAllAgentsEnabled: (message) => this.updateAllAgentsEnabled(message),
      openAgentYaml: this.agentActions.openAgentYaml,
      openAgentFolder: () => this.openAgentFolder(),
      createAgent: (message) => this.createAgent(message),
      customizeAgent: this.agentActions.customizeAgent,
      deleteCustomAgent: this.agentActions.deleteCustomAgent,
      revealAgentFile: this.agentActions.revealAgentFile,
      viewRemoteAgentPrompt: (message) => this.viewRemoteAgentPrompt(message),
      setCustomAgentDir: () => this.setCustomAgentDir(),
      resetCustomAgentDir: () => this.resetCustomAgentDir(),
      applyAgentModePreset: (message) => this.applyAgentModePreset(message),
      saveAgentModePreset: () => this.saveAgentModePreset(),
      deleteAgentModePreset: (message) => this.deleteAgentModePreset(message),
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
      this.postMainAgentAndTeamOptionsData(),
    ]);
  }

  private async postAgentSelectionData(): Promise<void> {
    this.renderer.postToRenderer(
      await buildAgentSelectionMessage({
        loadAgents: this.registry.loadAgents,
        buildSelectionItems: () => this.catalogController.buildSelectionItems(),
        getCustomAgentScanIssues,
      }),
    );
  }

  private async postMainAgentOptionsData(
    selectedToolUseAgent?: string,
  ): Promise<void> {
    this.renderer.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      optionsData: await this.registry.loadAgentOptionsData(),
      ...(selectedToolUseAgent && { selectedToolUseAgent }),
    });
  }

  private async postMainTeamOptionsData(): Promise<void> {
    this.renderer.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
      optionsData: await loadTeamOptions(createTeamCatalogPorts()),
    });
  }

  /**
   * Every catalog-refresh path posts agent and team options together,
   * mirroring the extension host's `refreshAgentOptions` pairing — team
   * availability depends on the same catalog (sign-in, remote load, roster,
   * and custom-dir changes), so refreshing one without the other leaves the
   * main-view team picker stale. Startup is exempt: the main-view startup
   * controller already posts both.
   */
  private async postMainAgentAndTeamOptionsData(
    selectedToolUseAgent?: string,
  ): Promise<void> {
    await Promise.all([
      this.postMainAgentOptionsData(selectedToolUseAgent),
      this.postMainTeamOptionsData(),
    ]);
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

  private async updateAgentEnabled(
    message: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED>,
  ): Promise<void> {
    await this.roster.setAgentEnabled({
      category: message.category,
      source: message.agentSource,
      name: message.agentName,
      enabled: message.enabled,
    });
    await this.refreshCatalogData();
  }

  private async updateAllAgentsEnabled(
    message: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED>,
  ): Promise<void> {
    await this.catalogController.setAllAgentsEnabled(message);
    await this.refreshCatalogData();
  }

  private async setCustomAgentDir(): Promise<void> {
    const selectedPath = await this.directory.selectCustomAgentDirectory();
    if (!selectedPath) return;

    await this.directoryController.setCustomDir(selectedPath);
    await Promise.all([this.postCustomAgentDir(), this.refreshCatalogData()]);
  }

  /**
   * Re-read the agent catalog from disk and rebroadcast every view that shows
   * it. Creating, copying, or deleting a custom agent changes the YAML files the
   * registry was built from, so a plain re-post would serve a stale catalog.
   */
  private async refreshAfterAgentMutation(): Promise<void> {
    await this.registry.refreshAgents();
    await this.refreshCatalogData();
  }

  private async resetCustomAgentDir(): Promise<void> {
    await this.directoryController.resetCustomDir();
    await Promise.all([this.postCustomAgentDir(), this.refreshCatalogData()]);
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

  /**
   * Create a custom agent. Mirrors the extension's `handleCreateAgent`: the
   * template path writes a rendered bundled template, while the AI path is the
   * agent-creator flow. Only the template path is wired here; AI creation needs
   * the creator flow's own UI, which this host does not present yet.
   */
  private async createAgent(
    data: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.CREATE_AGENT>,
  ): Promise<void> {
    if (data.mode !== 'template') {
      await this.notifications.showErrorMessage(
        'Creating an agent with AI is not available in the desktop app yet. Choose "From template" instead.',
      );
      return;
    }

    const categoryLabel = data.category === 'toolUse' ? 'Tool Use' : 'Workflow';
    const name = await this.prompts.promptText({
      title: `New ${categoryLabel} agent`,
      prompt: `Enter a name for the new ${categoryLabel} agent (without .yaml extension)`,
    });
    if (!name) return;

    const invalid = this.directoryController.validateTemplateName(name);
    if (invalid) {
      await this.notifications.showErrorMessage(invalid);
      return;
    }

    try {
      const customDir = await this.directory.getCustomAgentDirectory();
      await AbsoluteFS.ensureDir(customDir);

      const plan = this.directoryController.planTemplateAgent({
        category: data.category,
        name,
        customDir,
      });

      if (await AbsoluteFS.exists(plan.filePath)) {
        await this.notifications.showErrorMessage(
          `A file named "${plan.fileName}" already exists in the custom agents folder.`,
        );
        return;
      }

      const raw = await AbsoluteFS.read(
        path.join(
          this.resourcesPath,
          'templates',
          AGENT_TEMPLATE_FILES[plan.templateKind],
        ),
      );
      await AbsoluteFS.write(
        plan.filePath,
        renderAgentTemplateString(raw, {
          AGENT_NAME: plan.baseName,
          DESCRIPTION: plan.description,
          TOOLS_YAML: DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
        }),
      );

      await this.directory.openPath(plan.filePath);
      await this.notifications.showInfoMessage(
        `Created custom agent: ${plan.fileName}`,
      );
      await this.refreshAfterAgentMutation();
    } catch (error) {
      await this.notifications.showErrorMessage(
        `Failed to create custom agent: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Show a hosted agent's prompt YAML. The extension opens an untitled editor;
   * the desktop has no editor surface, so the config is written to a temporary
   * file and opened with the OS handler.
   */
  private async viewRemoteAgentPrompt(
    data: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT>,
  ): Promise<void> {
    try {
      const result = await this.remotePromptController.getPromptConfig(
        data.agentName,
      );
      if (!result.ok) {
        await this.notifications.showErrorMessage(result.message);
        return;
      }

      const target = path.join(
        await createTexraTempDir('texra-agent-prompt-'),
        `${data.agentName}.yaml`,
      );
      await AbsoluteFS.write(target, result.config);
      await this.directory.openPath(target);
    } catch (error) {
      await this.notifications.showErrorMessage(
        `Failed to view remote agent prompt: ${toErrorMessage(error)}`,
      );
    }
  }

  private async applyAgentModePreset(
    message: AgentMessage<
      typeof SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET
    >,
  ): Promise<void> {
    const { presetId } = message;
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
    if (result.status === 'cancelled' || result.status === 'choice-required')
      return;
    if (result.status === 'unavailable') {
      await this.notifications.showErrorMessage(
        `Team "${result.preset.name}" is still unavailable: ${result.unavailableNames.join(', ')}`,
      );
      return;
    }
    await Promise.all([
      this.postAgentSelectionData(),
      this.postMainAgentAndTeamOptionsData(
        this.catalogController.getPresetToolUseRoot(
          result.preset.agents.toolUse,
          result.preset.id,
        ),
      ),
    ]);
    const unresolvedCount = result.resolution.unresolvedNames.length;
    await this.notifications.showInfoMessage(
      unresolvedCount === 0
        ? `Applied "${result.preset.name}" team`
        : `Applied "${result.preset.name}" with ${formatResultCount(unresolvedCount, 'member')} still unavailable`,
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
    await this.postMainTeamOptionsData();
    await this.notifications.showInfoMessage(`Saved team "${preset.name}"`);
  }

  private async deleteAgentModePreset(
    message: AgentMessage<
      typeof SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET
    >,
  ): Promise<void> {
    const { presetId } = message;
    const target = this.catalogController.getCustomPreset(presetId);
    if (!target) {
      await this.notifications.showErrorMessage(
        `Unknown custom team: ${presetId}`,
      );
      return;
    }

    const confirmed = await this.prompts.confirm({
      title: 'Delete team?',
      message: `Delete team "${target.name}"?`,
    });
    if (!confirmed) return;

    await this.catalogController.deleteCustomPreset(presetId);
    this.postAgentModePresets();
    await this.postMainTeamOptionsData();
  }
}
