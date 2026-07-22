/**
 * Agent selection, directory, and team handlers.
 *
 * Extracted from SettingsViewMessageHandler to improve cohesion.
 * Handles agent enable/disable, create/customize/delete, YAML editing,
 * custom agent directories, and agent teams.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  createKey,
  getAgent,
  loadAgents,
  refresh as refreshAgents,
} from '@agent/index';
import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { AUTH_COMMANDS } from '@auth/constants';
import { SupabaseClient } from '@auth/SupabaseClient';
import { workspaceSM, globalSM } from '@common/state';
import { applyTeamRosterWithPreflight } from '@common/teams/TeamRosterApplication';
import { createSettingsAgentControllers } from '@controllers/settingsView/SettingsAgentControllerFactory';
import { SettingsRemoteAgentPromptController } from '@controllers/settingsView/SettingsRemoteAgentPromptController';
import { SettingsAgentFileController } from '@controllers/settingsView/SettingsAgentFileController';
import type { SettingsAgentVisibilityController } from '@controllers/settingsView/SettingsAgentVisibilityController';
import type { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
import type { SettingsAgentCatalogController } from '@controllers/settingsView/SettingsAgentCatalogController';
import { renderAgentTemplateFromBundle } from '@frontend/agents/agentTemplateBundle';
import { withAgentCatalogAuthRefreshDeferred } from '@frontend/auth/agentCatalogRefreshScope';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
} from '@shared/schemas/settingsViewMessages';
import {
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
  buildAgentModePresetsMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import { AbsoluteFS } from '@utils/files';
import { formatResultCount } from '@utils/text/stringUtils';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

/**
 * Agent selection, directory, and team handler delegate.
 */
export class AgentHandlers {
  private readonly catalogController: SettingsAgentCatalogController;
  private readonly directoryController: SettingsAgentDirectoryController;
  private readonly fileController = new SettingsAgentFileController();
  private readonly remotePromptController =
    new SettingsRemoteAgentPromptController({
      getUserTier: () => SupabaseClient.getUserTier(),
      getAccessToken: () => SupabaseClient.getAccessToken(),
      fetchPromptConfig: fetchRemoteAgentConfigYaml,
    });
  private readonly visibilityController: SettingsAgentVisibilityController;

  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshAfterAgentMutation: (
      selectedToolUseAgent?: string,
      agentCatalogAlreadyFresh?: boolean,
    ) => Promise<void>,
  ) {
    const controllers = createSettingsAgentControllers({
      workspaceState: workspaceSM,
      globalState: globalSM,
      getCustomAgentDirectory: () => agentDirectories.custom(),
      getSourceDirectory: (source) => agentDirectories.getDirectory(source),
    });
    this.catalogController = controllers.catalog;
    this.directoryController = controllers.directory;
    this.visibilityController = controllers.visibility;
  }

  // ── Agent selection data ──

  async sendAgentSelectionData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await buildAgentSelectionMessage({
        loadAgents,
        buildSelectionItems: () => this.catalogController.buildSelectionItems(),
      }),
    );
  }

  // ── Agent selection handlers ──

  async handleOpenAgentYaml(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.OPEN_AGENT_YAML>,
  ): Promise<void> {
    try {
      const result = this.directoryController.planOpenAgentYaml({
        source: data.agentSource,
        name: data.agentName,
      });
      if (!result.ok && result.reason === 'missingAgent') {
        await showLoggedMessage(
          this.ctx.channel,
          `Agent "${data.agentName}" could not be found. It may have been removed or renamed. Check the Agents tab in Settings to see available agents.`,
        );
        return;
      }

      if (!result.ok) {
        await showLoggedMessage(
          this.ctx.channel,
          `No configuration file found for agent "${data.agentName}". The agent definition may be incomplete — try re-creating it from the Agents tab.`,
        );
        return;
      }

      const doc = await vscode.workspace.openTextDocument(result.path);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to open agent YAML file',
        error,
      );
    }
  }

  async handleSetAgentEnabled(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SET_AGENT_ENABLED>,
  ): Promise<void> {
    try {
      await this.visibilityController.setAgentEnabled({
        category: data.category,
        source: data.agentSource,
        name: data.agentName,
        enabled: data.enabled,
      });
      await this.refreshAfterAgentMutation();
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to update agent visibility',
        error,
      );
    }
  }

  async handleSetAllAgentsEnabled(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SET_ALL_AGENTS_ENABLED>,
  ): Promise<void> {
    try {
      await this.visibilityController.setAllAgentsEnabled({
        category: data.category,
        source: data.source,
        enabled: data.enabled,
      });
      await this.refreshAfterAgentMutation();
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to update agent visibility',
        error,
      );
    }
  }

  async handleOpenAgentFolder(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.OPEN_AGENT_FOLDER>,
  ): Promise<void> {
    try {
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
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to open agent folder',
        error,
      );
    }
  }

  async handleRevealAgentFile(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.REVEAL_AGENT_FILE>,
  ): Promise<void> {
    try {
      const result = this.directoryController.planRevealAgentFile({
        source: data.agentSource,
        name: data.agentName,
      });
      if (!result.ok) {
        await showLoggedMessage(
          this.ctx.channel,
          `Agent not found or has no file: ${data.agentName}`,
        );
        return;
      }
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(result.path),
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to reveal agent file',
        error,
      );
    }
  }

  async handleViewRemoteAgentPrompt(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.VIEW_REMOTE_AGENT_PROMPT>,
  ): Promise<void> {
    try {
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
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to view remote agent prompt',
        error,
      );
    }
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
    try {
      const key = createKey(data.agentSource, data.agentName);
      const entry = getAgent(key);
      if (!entry?.path) {
        await showLoggedMessage(
          this.ctx.channel,
          `Agent not found or has no file: ${data.agentName}`,
        );
        return;
      }

      const customDir = await agentDirectories.custom();
      const sourceDir = await agentDirectories.getDirectory(data.agentSource);

      const result = this.fileController.planCustomizeAgent({
        entry,
        customDir,
        sourceDir,
      });
      if (!result.ok) {
        await showLoggedMessage(
          this.ctx.channel,
          `Refusing to copy: target path escapes the custom agents directory.`,
        );
        return;
      }

      const { targetPath } = result.plan;

      await AbsoluteFS.ensureDir(path.dirname(targetPath));

      // Avoid overwriting an existing custom copy with user edits
      if (await AbsoluteFS.exists(targetPath)) {
        const overwrite = 'Overwrite';
        const choice = await vscode.window.showWarningMessage(
          `A custom copy already exists: ${path.basename(targetPath)}`,
          { modal: true },
          overwrite,
        );
        if (choice !== overwrite) return;
      }

      await AbsoluteFS.copy(entry.path, targetPath, { overwrite: true });

      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(targetPath),
      );
      await vscode.window.showTextDocument(doc, { preview: false });

      void vscode.window.showInformationMessage(
        `Created custom copy: ${path.basename(targetPath)}`,
      );

      await this.refreshAfterAgentMutation();
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to create custom agent copy',
        error,
      );
    }
  }

  async handleDeleteCustomAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_CUSTOM_AGENT>,
  ): Promise<void> {
    try {
      const key = createKey('custom', data.agentName);
      const entry = getAgent(key);
      if (!entry?.path) {
        await showLoggedMessage(
          this.ctx.channel,
          `Custom agent not found: ${data.agentName}`,
        );
        return;
      }

      const customDir = await agentDirectories.custom();
      const result = this.fileController.planDeleteCustomAgent({
        entry,
        customDir,
      });
      if (!result.ok) {
        await showLoggedMessage(
          this.ctx.channel,
          `Refusing to delete: file is not inside the custom agents directory.`,
        );
        return;
      }

      await AbsoluteFS.delete(result.plan.path, { recursive: false });

      void vscode.window.showInformationMessage(
        `Deleted custom agent: ${data.agentName}`,
      );

      await this.refreshAfterAgentMutation();
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to delete custom agent',
        error,
      );
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
    try {
      const selectedPath = await agentDirectories.promptCustom();
      if (!selectedPath) return;
      await this.refreshAgentDirUI();
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to set custom agent directory',
        error,
      );
    }
  }

  async handleResetCustomAgentDir(): Promise<void> {
    try {
      await this.directoryController.resetCustomDir();
      await this.refreshAgentDirUI();
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to reset custom agent directory',
        error,
      );
    }
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
    try {
      const result = await withAgentCatalogAuthRefreshDeferred(() =>
        applyTeamRosterWithPreflight(data.presetId, {
          catalog: this.catalogController,
          loadLocalCatalog: () => loadAgents({ includeRemote: false }),
          canAccessRemoteCatalog: () =>
            SupabaseClient.canAccessRemoteAgentCatalog(),
          choose: async (preset, unavailableNames) => {
            const choice = await vscode.window.showInformationMessage(
              `The "${preset.name}" team includes TeXRA-hosted members that are unavailable: ${unavailableNames.join(', ')}.`,
              { modal: true },
              'Sign in to TeXRA',
              'Continue with available members',
            );
            if (choice === 'Sign in to TeXRA') return 'sign-in';
            if (choice === 'Continue with available members') return 'continue';
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
      if (result.status === 'choice-required') return;
      if (result.status === 'cancelled') return;
      if (result.status === 'unavailable') {
        await showLoggedMessage(
          this.ctx.channel,
          `The "${result.preset.name}" team is unavailable because these TeXRA-hosted members could not be loaded: ${result.unavailableNames.join(', ')}.`,
        );
        return;
      }

      await this.refreshAfterAgentMutation(
        this.catalogController.getPresetToolUseRoot(
          result.preset.toolUseAgents,
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
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to apply agent team',
        error,
      );
    }
  }

  async handleSaveAgentModePreset(
    _data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SAVE_AGENT_MODE_PRESET>,
  ): Promise<void> {
    try {
      const name = await vscode.window.showInputBox({
        prompt: 'Name for the new team',
        placeHolder: 'e.g. My Research Team',
        validateInput: (v) => (v.trim() ? null : 'Name cannot be empty'),
      });
      if (!name) return; // cancelled

      await loadAgents();

      await this.catalogController.saveCurrentPreset(name);

      await this.ctx.withActiveWebview((w) => this.sendAgentModePresets(w));

      void vscode.window.showInformationMessage(`Saved team "${name.trim()}"`);
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to save agent team',
        error,
      );
    }
  }

  async handleDeleteAgentModePreset(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_AGENT_MODE_PRESET>,
  ): Promise<void> {
    try {
      const target = this.catalogController.getCustomPreset(data.presetId);
      if (!target) return;

      const confirm = await vscode.window.showWarningMessage(
        `Delete team "${target.name}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;

      await this.catalogController.deleteCustomPreset(data.presetId);

      await this.ctx.withActiveWebview((w) => this.sendAgentModePresets(w));
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to delete agent team',
        error,
      );
    }
  }

  // ── Private helpers ──

  private async createAgentFromTemplate(
    category: 'workflow' | 'toolUse',
  ): Promise<void> {
    try {
      const categoryLabel = category === 'toolUse' ? 'Tool Use' : 'Workflow';
      const name = await vscode.window.showInputBox({
        prompt: `Enter a name for the new ${categoryLabel} agent (without .yaml extension)`,
        placeHolder: 'my_agent',
        validateInput: (value) =>
          this.fileController.validateTemplateName(value),
      });
      if (!name) return;

      const customDir = await agentDirectories.custom();
      await AbsoluteFS.ensureDir(customDir);

      const templatePlan = this.fileController.planTemplateAgent({
        category,
        name,
        customDir,
      });

      if (await AbsoluteFS.exists(templatePlan.filePath)) {
        await vscode.window.showWarningMessage(
          `A file named "${templatePlan.fileName}" already exists in the custom agents folder.`,
        );
        return;
      }

      const template = await renderAgentTemplateFromBundle(
        this.ctx.extensionContext,
        templatePlan.templateKind,
        {
          agentName: templatePlan.baseName,
          description: templatePlan.description,
        },
      );

      await AbsoluteFS.write(templatePlan.filePath, template);
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(templatePlan.filePath),
      );
      await vscode.window.showTextDocument(doc);
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to create agent from template',
        error,
      );
    }
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
