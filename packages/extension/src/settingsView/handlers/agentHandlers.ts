/**
 * Agent selection, directory, and team handlers.
 *
 * Extracted from SettingsViewMessageHandler to improve cohesion.
 * Handles agent enable/disable, create/customize/delete, YAML editing,
 * custom agent directories, and agent teams.
 */
import * as path from 'path';
import * as vscode from 'vscode';

import { SettingsAgentFileController } from '@controllers/settingsView/SettingsAgentFileController';
import { createKey, getAgent, loadAgents } from '@agent/index';
import { EdgeFunctionResponseSchema } from '@agent/remote/types';
import { SupabaseClient } from '@auth/SupabaseClient';
import { ULTRA_TIER, SUPABASE_CONFIG } from '@auth/config';
import { renderAgentTemplateFromBundle } from '@commands/agent/agentTemplateRenderer';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview';
import { workspaceSM, globalSM } from '@common/state';
import {
  isFileNotFoundError,
  showLoggedErrorMessage,
} from '@frontend/ui/errorHandlingUtils';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { createSettingsAgentControllers } from '@shared/settingsView/handlers/agentControllerFactory';
import {
  buildAgentModePresetsMessage,
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
} from '@shared/schemas/settingsViewMessages';
import { AbsoluteFS } from '@utils/files';
import type { SettingsAgentVisibilityController } from '@controllers/settingsView/SettingsAgentVisibilityController';
import type { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
import type { SettingsAgentCatalogController } from '@controllers/settingsView/SettingsAgentCatalogController';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

/**
 * Agent selection, directory, and team handler delegate.
 */
export class AgentHandlers {
  private readonly catalogController: SettingsAgentCatalogController;
  private readonly directoryController: SettingsAgentDirectoryController;
  private readonly fileController = new SettingsAgentFileController();
  private readonly visibilityController: SettingsAgentVisibilityController;

  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshAfterAgentMutation: () => Promise<void>,
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
    await loadAgents();
    await webview.postMessage(
      buildAgentSelectionMessage(this.catalogController),
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
        await vscode.window.showErrorMessage(
          `Agent "${data.agentName}" could not be found. It may have been removed or renamed. Check the Agents tab in Settings to see available agents.`,
        );
        return;
      }

      if (!result.ok) {
        await vscode.window.showErrorMessage(
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
        await vscode.window.showErrorMessage(
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
        await vscode.window.showErrorMessage(
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
      const tier = await SupabaseClient.getUserTier();
      if (tier !== ULTRA_TIER) {
        await vscode.window.showErrorMessage(
          'Viewing remote agent prompts requires an Ultra plan.',
        );
        return;
      }

      const token = await SupabaseClient.getAccessToken();
      if (!token) {
        await vscode.window.showErrorMessage(
          'Authentication required. Sign in using "TeXRA: Sign In".',
        );
        return;
      }

      const response = await fetch(SUPABASE_CONFIG.edgeFunctionUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agentName: data.agentName }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        await vscode.window.showErrorMessage(
          `Failed to fetch agent prompt: ${errorText}`,
        );
        return;
      }

      const responseData = EdgeFunctionResponseSchema.parse(
        await response.json(),
      );

      const doc = await vscode.workspace.openTextDocument({
        content: responseData.config,
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
        await vscode.window.showErrorMessage(
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
        await vscode.window.showErrorMessage(
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
        await vscode.window.showErrorMessage(
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
        await vscode.window.showErrorMessage(
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
      await buildCustomAgentDirMessage(this.directoryController),
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
      buildAgentModePresetsMessage(this.catalogController),
    );
  }

  async handleApplyAgentModePreset(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.APPLY_AGENT_MODE_PRESET>,
  ): Promise<void> {
    try {
      await loadAgents();
      const result = await this.catalogController.applyPreset(data.presetId);
      if (!result.ok) {
        await vscode.window.showErrorMessage(`Unknown team: ${data.presetId}`);
        return;
      }

      await this.refreshAfterAgentMutation();

      void vscode.window.showInformationMessage(
        `Applied "${result.preset.name}" team`,
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
