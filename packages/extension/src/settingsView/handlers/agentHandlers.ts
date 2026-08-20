/**
 * Agent selection, directory, and team handlers.
 *
 * Handles agent enable/disable, create/customize/delete, YAML editing,
 * custom agent directories, and agent teams.
 */
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  type AgentRosterController,
  getAgent,
  getCustomAgentScanIssues,
  loadAgents,
  refresh as refreshAgents,
} from '@agent/index';
import { AUTH_COMMANDS } from '@auth/constants';
import { SupabaseClient } from '@auth/SupabaseClient';
import { applyTeamRosterWithPreflight } from '@common/teams/TeamRosterApplication';
import { createSettingsAgentControllers } from '@controllers/settingsView/SettingsAgentControllerFactory';
import { createSettingsAgentActions } from '@controllers/settingsView/backend/SettingsAgentActions';
import {
  templateAgentNamePrompt,
  writeTemplateAgentFile,
} from '@controllers/settingsView/backend/templateAgentCreation';
import type { SettingsRemoteAgentPromptController } from '@controllers/settingsView/SettingsRemoteAgentPromptController';
import type { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
import type { SettingsAgentCatalogController } from '@controllers/settingsView/SettingsAgentCatalogController';
import { withAgentCatalogAuthRefreshDeferred } from '@frontend/auth/agentCatalogRefreshScope';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { confirmModal } from '@frontend/ui/dialogs';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { platform } from '@platform/platform';
import {
  agentKey,
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
} from '@shared/schemas';
import {
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
  buildAgentModePresetsMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { formatResultCount } from '@utils/text/stringUtils';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** Agent selection, directory, and team handler delegate. */
export class AgentHandlers {
  private readonly catalogController: SettingsAgentCatalogController;
  private readonly directoryController: SettingsAgentDirectoryController;
  private readonly remotePromptController: SettingsRemoteAgentPromptController;
  private readonly roster: AgentRosterController;
  private readonly agentActions;
  private readonly activeCustomAgentDeletions = new Set<string>();

  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshAfterAgentMutation: (
      selectedToolUseAgent?: string,
      agentCatalogAlreadyFresh?: boolean,
    ) => Promise<void>,
  ) {
    const controllers = createSettingsAgentControllers({
      workspaceState: platform().workspaceState,
      globalState: platform().globalState,
      getCustomAgentDirectory: () => agentDirectories.custom(),
      getSourceDirectory: (source) => agentDirectories.getDirectory(source),
    });
    this.catalogController = controllers.catalog;
    this.directoryController = controllers.directory;
    this.roster = controllers.roster;
    this.remotePromptController = controllers.remotePromptController;
    this.agentActions = createSettingsAgentActions({
      directoryController: this.directoryController,
      findAgent: (source, name) => getAgent(agentKey(source, name)),
      getCustomAgentDirectory: () => agentDirectories.custom(),
      getSourceDirectory: (source) => agentDirectories.getDirectory(source),
      openDocument: async (filePath) => {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, { preview: false });
      },
      revealFile: async (filePath) => {
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(filePath),
        );
      },
      confirmAction: confirmModal,
      showInfoMessage: async (message) => {
        void vscode.window.showInformationMessage(message);
      },
      showErrorMessage: async (message) => {
        await showLoggedMessage(this.ctx.channel, message);
      },
      refreshAfterMutation: () => this.refreshAfterAgentMutation(),
      run: (_command, failureMessage, action) =>
        withHandlerErrorHandling(this.ctx, failureMessage, action),
    });
  }

  // ── Agent selection data ──

  async sendAgentSelectionData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await buildAgentSelectionMessage({
        loadAgents,
        buildSelectionItems: () => this.catalogController.buildSelectionItems(),
        getCustomAgentScanIssues,
      }),
    );
  }

  // ── Agent selection handlers ──

  async handleOpenAgentYaml(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.OPEN_AGENT_YAML>,
  ): Promise<void> {
    await this.agentActions.openAgentYaml(data);
  }

  async handleSetAgentEnabled(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SET_AGENT_ENABLED>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to update agent visibility',
      async () => {
        await this.roster.setAgentEnabled({
          category: data.category,
          source: data.agentSource,
          name: data.agentName,
          enabled: data.enabled,
        });
        await this.refreshAfterAgentMutation();
      },
    );
  }

  async handleSetAllAgentsEnabled(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SET_ALL_AGENTS_ENABLED>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to update agent visibility',
      async () => {
        await this.catalogController.setAllAgentsEnabled({
          category: data.category,
          source: data.source,
          enabled: data.enabled,
        });
        await this.refreshAfterAgentMutation();
      },
    );
  }

  async handleOpenAgentFolder(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.OPEN_AGENT_FOLDER>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to open agent folder',
      async () => {
        const result = await this.directoryController.planOpenAgentFolder(
          data.folderType,
        );
        if (!result.ok) {
          await showLoggedMessage(
            this.ctx.channel,
            `No local directory for agent source: ${data.folderType}`,
          );
          return;
        }
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(result.path),
        );
      },
    );
  }

  async handleRevealAgentFile(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.REVEAL_AGENT_FILE>,
  ): Promise<void> {
    await this.agentActions.revealAgentFile(data);
  }

  async handleViewRemoteAgentPrompt(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.VIEW_REMOTE_AGENT_PROMPT>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to view remote agent prompt',
      async () => {
        const result = await this.remotePromptController.getPromptConfig(
          data.agentName,
        );
        if (!result.ok) {
          await showLoggedMessage(this.ctx.channel, result.message);
          return;
        }

        const doc = await vscode.workspace.openTextDocument({
          content: result.config,
          language: 'yaml',
        });
        await vscode.window.showTextDocument(doc, { preview: false });
      },
    );
  }

  async handleCreateAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.CREATE_AGENT>,
  ): Promise<void> {
    if (data.mode === 'template') {
      await this.createAgentFromTemplate(data.category);
    } else {
      await vscode.commands.executeCommand(
        'texra.createAgentWithAI',
        data.category,
      );
    }

    await this.refreshAfterAgentMutation();
  }

  async handleCustomizeAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.CUSTOMIZE_AGENT>,
  ): Promise<void> {
    await this.agentActions.customizeAgent(data);
  }

  async handleDeleteCustomAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_CUSTOM_AGENT>,
  ): Promise<void> {
    if (this.activeCustomAgentDeletions.has(data.agentName)) return;
    this.activeCustomAgentDeletions.add(data.agentName);

    try {
      await this.agentActions.deleteCustomAgent(data);
    } finally {
      this.activeCustomAgentDeletions.delete(data.agentName);
    }
  }

  // ── Custom agent directory handlers ──

  async sendCustomAgentDir(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await buildCustomAgentDirMessage({
        getCustomDirStatus: () => this.directoryController.getCustomDirStatus(),
      }),
    );
  }

  async handleSetCustomAgentDir(): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to set custom agent directory',
      async () => {
        const selectedPath = await agentDirectories.promptCustom();
        if (!selectedPath) return;
        await this.refreshAgentDirUI();
      },
    );
  }

  async handleResetCustomAgentDir(): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to reset custom agent directory',
      async () => {
        await this.directoryController.resetCustomDir();
        await this.refreshAgentDirUI();
      },
    );
  }

  // ── Agent team handlers ──

  async sendAgentModePresets(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      buildAgentModePresetsMessage({
        getCustomPresets: () => this.catalogController.getCustomPresets(),
        getOrchestratorAgentNames: () =>
          this.catalogController.getOrchestratorAgentNames(),
      }),
    );
  }

  async handleApplyAgentModePreset(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.APPLY_AGENT_MODE_PRESET>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to apply agent team',
      async () => {
        const result = await withAgentCatalogAuthRefreshDeferred(() =>
          applyTeamRosterWithPreflight(data.presetId, {
            catalog: this.catalogController,
            loadLocalCatalog: () => loadAgents({ includeRemote: false }),
            canAccessRemoteCatalog: () => SupabaseClient.isAuthenticated(),
            choose: async (preset, unavailableNames) => {
              const choice = await vscode.window.showInformationMessage(
                `The "${preset.name}" team includes TeXRA-hosted members that are unavailable: ${unavailableNames.join(', ')}.`,
                { modal: true },
                'Sign in to TeXRA',
                'Continue with available members',
              );
              if (choice === 'Sign in to TeXRA') return 'sign-in';
              if (choice === 'Continue with available members') {
                return 'continue';
              }
              return 'cancel';
            },
            signIn: async () =>
              (await vscode.commands.executeCommand<boolean>(
                AUTH_COMMANDS.SIGN_IN,
              )) === true,
            forceRefreshRemoteCatalog: () =>
              refreshAgents({ includeRemote: true }),
          }),
        );

        if (result.status === 'unknown') {
          await showLoggedMessage(
            this.ctx.channel,
            `Unknown team: ${data.presetId}`,
          );
          return;
        }
        if (
          result.status === 'choice-required' ||
          result.status === 'cancelled'
        )
          return;
        if (result.status === 'unavailable') {
          await showLoggedMessage(
            this.ctx.channel,
            `The "${result.preset.name}" team is unavailable because these TeXRA-hosted members could not be loaded: ${result.unavailableNames.join(', ')}.`,
          );
          return;
        }

        await this.refreshAfterAgentMutation(
          this.catalogController.getPresetToolUseRoot(
            result.preset.agents.toolUse,
            result.preset.id,
          ),
          true,
        );

        const unresolvedCount = result.resolution.unresolvedNames.length;
        void vscode.window.showInformationMessage(
          unresolvedCount === 0
            ? `Applied "${result.preset.name}" team`
            : `Applied "${result.preset.name}" with ${formatResultCount(unresolvedCount, 'member')} still unavailable`,
        );
      },
    );
  }

  async handleSaveAgentModePreset(
    _data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SAVE_AGENT_MODE_PRESET>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to save agent team',
      async () => {
        const name = await vscode.window.showInputBox({
          prompt: 'Name for the new team',
          placeHolder: 'e.g. My Research Team',
          validateInput: (v) => (v.trim() ? null : 'Name cannot be empty'),
        });
        if (!name) return; // cancelled

        await loadAgents();

        await this.catalogController.saveCurrentPreset(name);

        await Promise.all([
          this.ctx.withActiveWebview((w) => this.sendAgentModePresets(w)),
          this.refreshAfterAgentMutation(undefined, true),
        ]);

        void vscode.window.showInformationMessage(
          `Saved team "${name.trim()}"`,
        );
      },
    );
  }

  async handleDeleteAgentModePreset(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_AGENT_MODE_PRESET>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to delete agent team',
      async () => {
        const target = this.catalogController.getCustomPreset(data.presetId);
        if (!target) return;

        const confirmed = await confirmModal(
          `Delete team "${target.name}"?`,
          'Delete',
        );
        if (!confirmed) return;

        await this.catalogController.deleteCustomPreset(data.presetId);

        await Promise.all([
          this.ctx.withActiveWebview((w) => this.sendAgentModePresets(w)),
          this.refreshAfterAgentMutation(undefined, true),
        ]);
      },
    );
  }

  // ── Private helpers ──

  private async createAgentFromTemplate(
    category: 'workflow' | 'toolUse',
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to create agent from template',
      async () => {
        const name = await vscode.window.showInputBox({
          prompt: templateAgentNamePrompt(category),
          placeHolder: 'my_agent',
          validateInput: (value) =>
            this.directoryController.validateTemplateName(value),
        });
        if (!name) return;

        const customDir = await agentDirectories.custom();
        await AbsoluteFS.ensureDir(customDir);

        const templatePlan = this.directoryController.planTemplateAgent({
          category,
          name,
          customDir,
        });

        const written = await writeTemplateAgentFile(
          templatePlan,
          path.join(this.ctx.extensionContext.extensionPath, 'resources'),
        );
        if (!written.ok) {
          await vscode.window.showWarningMessage(written.message);
          return;
        }

        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(templatePlan.filePath),
        );
        await vscode.window.showTextDocument(doc);
      },
    );
  }

  /** Refresh agent dir + selection after a directory change. */
  private async refreshAgentDirUI(): Promise<void> {
    await agentDirectories.refreshAfterDirChange();
    const { refreshCustomAgentRoot } = await import('@frontend/setup');
    await refreshCustomAgentRoot();
    await Promise.all([
      this.ctx.withActiveWebview(async (w) => {
        await Promise.all([
          this.sendCustomAgentDir(w),
          this.sendAgentSelectionData(w),
        ]);
      }),
      vscode.commands.executeCommand('texra.refreshAllOptions'),
    ]);
  }
}
