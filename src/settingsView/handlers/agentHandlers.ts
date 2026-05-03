/**
 * Agent selection, directory, and team handlers.
 *
 * Extracted from SettingsViewMessageHandler to improve cohesion.
 * Handles agent enable/disable, create/customize/delete, YAML editing,
 * custom agent directories, and agent teams.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';

import {
  type AgentEntry,
  createKey,
  getAgent,
  getVisibleAgents,
  getWorkflowAgents,
  getToolUseAgents,
  loadAgents,
} from '@agent/index';
import { EdgeFunctionResponseSchema } from '@agent/remote/types';
import { SupabaseClient } from '@auth/SupabaseClient';
import { ULTRA_TIER, SUPABASE_CONFIG } from '@auth/config';
import { renderAgentTemplateFromBundle } from '@commands/agent/agentTemplateRenderer';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview';
import { isFileNotFoundError, showLoggedErrorMessage } from '@common/errors';
import {
  WorkspaceStateKey,
  GlobalStateKey,
  workspaceSM,
  globalSM,
} from '@common/state';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import {
  AGENT_MODE_PRESETS,
  AgentModePresetSchema,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
  type AgentSelectionItem,
} from '@shared/schemas/settingsViewMessages';
import { AbsoluteFS } from '@utils/files';
import { SettingsAgentVisibilityController } from '../../controllers/settingsView/SettingsAgentVisibilityController';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

function entryToSelectionItem(
  entry: AgentEntry,
  enabledKeys: string[] | undefined,
): AgentSelectionItem {
  const key = createKey(entry.source, entry.name);
  // undefined = never configured → all enabled; [] = explicitly empty → none enabled
  const enabled =
    enabledKeys === undefined ||
    enabledKeys.includes(key) ||
    enabledKeys.includes(entry.name);
  return {
    name: entry.name,
    source: entry.source,
    category: entry.category,
    description: entry.description,
    hasPath: Boolean(entry.path),
    filePath: entry.path || undefined,
    tools: entry.tools,
    hasMultiple: entry.isMultiple ?? Boolean(entry.multiplePath),
    hasMultiplePath: Boolean(entry.multiplePath),
    enabled,
  };
}

export function buildAgentSelectionItems(): {
  workflow: AgentSelectionItem[];
  toolUse: AgentSelectionItem[];
} {
  // No default → undefined means "never configured" (all enabled)
  const workflowEnabled = workspaceSM.get<string[]>(
    WorkspaceStateKey.ENABLED_AGENTS,
  );
  const toolUseEnabled = workspaceSM.get<string[]>(
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
  );

  const workflow = getWorkflowAgents()
    .map((e) => entryToSelectionItem(e, workflowEnabled))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toolUse = getToolUseAgents()
    .map((e) => entryToSelectionItem(e, toolUseEnabled))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { workflow, toolUse };
}

/**
 * Agent selection, directory, and team handler delegate.
 */
export class AgentHandlers {
  private readonly visibilityController: SettingsAgentVisibilityController;

  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshAfterAgentMutation: () => Promise<void>,
  ) {
    this.visibilityController = new SettingsAgentVisibilityController({
      state: {
        getEnabledAgentKeys: (category) =>
          workspaceSM.get<string[]>(
            category === 'workflow'
              ? WorkspaceStateKey.ENABLED_AGENTS
              : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
          ),
        setEnabledAgentKeys: async (category, enabledKeys) => {
          await workspaceSM.update(
            category === 'workflow'
              ? WorkspaceStateKey.ENABLED_AGENTS
              : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
            enabledKeys,
          );
        },
        getAgents: (category) =>
          (category === 'workflow'
            ? getWorkflowAgents()
            : getToolUseAgents()
          ).map((entry) => ({
            source: entry.source,
            name: entry.name,
          })),
      },
    });
  }

  // ── Agent selection data ──

  async sendAgentSelectionData(webview: vscode.Webview): Promise<void> {
    await loadAgents();
    const { workflow, toolUse } = buildAgentSelectionItems();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      workflow,
      toolUse,
    });
  }

  // ── Agent selection handlers ──

  async handleOpenAgentYaml(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.OPEN_AGENT_YAML>,
  ): Promise<void> {
    try {
      const key = createKey(data.agentSource, data.agentName);
      const entry = getAgent(key);
      if (!entry) {
        await vscode.window.showErrorMessage(
          `Agent "${data.agentName}" could not be found. It may have been removed or renamed. Check the Agents tab in Settings to see available agents.`,
        );
        return;
      }

      const agentPath =
        data.variant === 'multiple' ? entry.multiplePath : entry.path;
      if (!agentPath) {
        await vscode.window.showErrorMessage(
          `No configuration file found for agent "${data.agentName}". The agent definition may be incomplete — try re-creating it from the Agents tab.`,
        );
        return;
      }

      const doc = await vscode.workspace.openTextDocument(agentPath);
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
      const folderPath = await agentDirectories.getDirectory(data.folderType);
      if (!folderPath) {
        await vscode.window.showErrorMessage(
          `No local directory for agent source: ${data.folderType}`,
        );
        return;
      }
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(folderPath),
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
      const key = createKey(data.agentSource, data.agentName);
      const entry = getAgent(key);
      if (!entry?.path) {
        await vscode.window.showErrorMessage(
          `Agent not found or has no file: ${data.agentName}`,
        );
        return;
      }
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(entry.path),
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
      const normalizedCustomDir = path.resolve(customDir);
      const sourceDir = await agentDirectories.getDirectory(data.agentSource);
      const relativePath = sourceDir
        ? path.relative(sourceDir, entry.path)
        : path.basename(entry.path);
      const targetPath = path.join(customDir, relativePath);

      // Guard: only write files under the custom agent directory
      if (
        !path.resolve(targetPath).startsWith(normalizedCustomDir + path.sep)
      ) {
        await vscode.window.showErrorMessage(
          `Refusing to copy: target path escapes the custom agents directory.`,
        );
        return;
      }

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

      // Also copy the _multiple variant if it stays inside the custom directory
      if (entry.multiplePath) {
        const multipleRelative = sourceDir
          ? path.relative(sourceDir, entry.multiplePath)
          : path.basename(entry.multiplePath);
        const multipleTarget = path.join(customDir, multipleRelative);
        if (
          path
            .resolve(multipleTarget)
            .startsWith(normalizedCustomDir + path.sep)
        ) {
          await AbsoluteFS.ensureDir(path.dirname(multipleTarget));
          try {
            await AbsoluteFS.copy(entry.multiplePath, multipleTarget, {
              overwrite: true,
            });
          } catch {
            // _multiple variant may not exist on disk even if registered
          }
        }
      }

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

      // Guard: only delete files under the custom agent directory
      const customDir = await agentDirectories.custom();
      const normalizedPath = path.resolve(entry.path);
      const normalizedCustomDir = path.resolve(customDir);
      if (!normalizedPath.startsWith(normalizedCustomDir + path.sep)) {
        await vscode.window.showErrorMessage(
          `Refusing to delete: file is not inside the custom agents directory.`,
        );
        return;
      }

      await AbsoluteFS.delete(entry.path, { recursive: false });

      // Also delete the _multiple variant if it is inside the custom directory
      if (entry.multiplePath) {
        const normalizedMultiple = path.resolve(entry.multiplePath);
        if (normalizedMultiple.startsWith(normalizedCustomDir + path.sep)) {
          try {
            await AbsoluteFS.delete(entry.multiplePath, { recursive: false });
          } catch (err) {
            // Only ignore FileNotFound; surface other errors
            if (!isFileNotFoundError(err)) {
              throw err;
            }
          }
        }
      }

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
    const configuredPath = globalSM
      .get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, '')
      .trim();
    const isDefault = configuredPath === '';
    const resolvedPath = await agentDirectories.custom();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      path: resolvedPath,
      isDefault,
    });
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
      await globalSM.update(GlobalStateKey.CUSTOM_AGENT_DIR, '');
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
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      customPresets: this.getCustomPresets(),
    });
  }

  async handleApplyAgentModePreset(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.APPLY_AGENT_MODE_PRESET>,
  ): Promise<void> {
    try {
      const preset =
        AGENT_MODE_PRESETS.find((p) => p.id === data.presetId) ??
        this.getCustomPresets().find((p) => p.id === data.presetId);
      if (!preset) {
        await vscode.window.showErrorMessage(`Unknown team: ${data.presetId}`);
        return;
      }

      await loadAgents();

      const workflowKeys = this.resolveAgentKeys(
        'workflow',
        new Set(preset.workflowAgents),
      );
      const toolUseKeys = this.resolveAgentKeys(
        'toolUse',
        new Set(preset.toolUseAgents),
      );

      await workspaceSM.update(WorkspaceStateKey.ENABLED_AGENTS, workflowKeys);
      await workspaceSM.update(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        toolUseKeys,
      );

      await this.refreshAfterAgentMutation();

      void vscode.window.showInformationMessage(
        `Applied "${preset.name}" team`,
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

      const workflowAgents = getVisibleAgents('workflow').map((e) => e.name);
      const toolUseAgents = getVisibleAgents('toolUse').map((e) => e.name);

      const preset: AgentModePreset = {
        id: `custom-${Date.now()}`,
        name: name.trim(),
        description: `Custom team: ${[...toolUseAgents, ...workflowAgents].join(', ')}`,
        icon: 'codicon-bookmark',
        workflowAgents,
        toolUseAgents,
      };

      const existing = this.getCustomPresets();
      await workspaceSM.update(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [
        ...existing,
        preset,
      ]);

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
      const presets = this.getCustomPresets();
      const target = presets.find((p) => p.id === data.presetId);
      if (!target) return;

      const confirm = await vscode.window.showWarningMessage(
        `Delete team "${target.name}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;

      const updated = presets.filter((p) => p.id !== data.presetId);
      await workspaceSM.update(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, updated);

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
        validateInput: (value) => {
          if (!value) return 'Name cannot be empty';
          if (value.includes('/') || value.includes('\\'))
            return 'Name cannot contain path separators';
          if (value.includes(' ')) return 'Use underscores instead of spaces';
          if (/[:#\[\]{}|>&*!%@`]/.test(value))
            return 'Name cannot contain YAML-special characters';
          return null;
        },
      });
      if (!name) return;

      const customDir = await agentDirectories.custom();
      await AbsoluteFS.ensureDir(customDir);

      const fileName = name.endsWith('.yaml') ? name : `${name}.yaml`;
      const filePath = path.join(customDir, fileName);

      if (await AbsoluteFS.exists(filePath)) {
        await vscode.window.showWarningMessage(
          `A file named "${fileName}" already exists in the custom agents folder.`,
        );
        return;
      }

      const baseName = name.replace(/\.yaml$/, '');
      const defaultDescription =
        category === 'toolUse'
          ? `${baseName} — interactive tool-use agent`
          : `${baseName} — workflow agent`;

      const template = await renderAgentTemplateFromBundle(
        this.ctx.extensionContext,
        category === 'toolUse' ? 'toolUse' : 'workflowSingle',
        {
          agentName: baseName,
          description: defaultDescription,
        },
      );

      await AbsoluteFS.write(filePath, template);
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(filePath),
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

  /** Read and validate custom teams from workspace state. */
  private getCustomPresets(): AgentModePreset[] {
    const raw = workspaceSM.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []);
    const parsed = z.array(AgentModePresetSchema).safeParse(raw);
    return parsed.success ? parsed.data : [];
  }

  /** Resolve agent names to source:name keys for the given category. */
  private resolveAgentKeys(
    category: 'workflow' | 'toolUse',
    names: Set<string>,
  ): string[] {
    const entries =
      category === 'workflow' ? getWorkflowAgents() : getToolUseAgents();
    return entries
      .filter((e) => names.has(e.name))
      .map((e) => createKey(e.source, e.name));
  }
}
