/**
 * Agent selection, directory, and team handlers.
 *
 * Handles agent enable/disable, create/customize/delete, YAML editing,
 * custom agent directories, and agent teams.
 */
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

import {
  type AgentRosterController,
  getAgent,
  getCustomAgentScanIssues,
  loadAgents,
  refresh as refreshAgents,
} from '@agent/index';
import { supabaseAuthenticated } from '@auth/SupabaseAuth';
import type { TeamAvailabilityPrompt } from '@common/teams/TeamPlan';
import { createSettingsAgentControllers } from '@controllers/settingsView/SettingsAgentControllerFactory';
import { fetchRemoteAgentPromptYaml } from '@controllers/settingsView/remoteAgentPrompt';
import { applySettingsTeamRoster } from '@controllers/settingsView/SettingsTeamRosterController';
import {
  createSettingsAgentActions,
  FAILURE_MESSAGES,
  type AgentFileCommand,
} from '@controllers/settingsView/backend/SettingsAgentActions';
import {
  templateAgentNamePrompt,
  writeTemplateAgentFile,
} from '@controllers/settingsView/backend/templateAgentCreation';
import type { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
import type { SettingsAgentCatalogController } from '@controllers/settingsView/SettingsAgentCatalogController';
import { withAgentCatalogAuthRefreshDeferred } from '@frontend/auth/agentCatalogRefreshScope';
import { runSignInCommand } from '@frontend/auth/signInCommand';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { VscodeMessageHost } from '@frontend/hosts/VscodeMessageHost';
import {
  chooseTeamAvailabilityViaDialog,
  confirmModal,
} from '@frontend/ui/dialogs';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { NotificationFailed } from '@hosts/uiHosts';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
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
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** The typed notification surface this host's settings actions present on. */
const messages = new VscodeMessageHost();

/** Agent selection, directory, and team handler delegate. */
export class AgentHandlers {
  private readonly catalogController: SettingsAgentCatalogController;
  private readonly directoryController: SettingsAgentDirectoryController;
  private readonly roster: AgentRosterController;
  readonly agentActions;
  private readonly activeCustomAgentDeletions = new Set<string>();

  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshAfterAgentMutation: (
      selectedToolUseAgent?: string,
      agentCatalogAlreadyFresh?: boolean,
    ) => Promise<void>,
    roots: Pick<WorkspaceRoots, 'workspaceState' | 'globalState'>,
    private readonly runtime: ProcessRuntime,
  ) {
    const controllers = createSettingsAgentControllers({
      workspaceState: roots.workspaceState,
      globalState: roots.globalState,
      getCustomAgentDirectory: () => agentDirectories.custom(),
      getSourceDirectory: (source) => agentDirectories.getDirectory(source),
    });
    this.catalogController = controllers.catalog;
    this.directoryController = controllers.directory;
    this.roster = controllers.roster;
    this.agentActions = createSettingsAgentActions({
      directoryController: this.directoryController,
      findAgent: (source, name) => getAgent(agentKey(source, name)),
      getCustomAgentDirectory: () => agentDirectories.custom(),
      getSourceDirectory: (source) => agentDirectories.getDirectory(source),
      openDocument: (filePath) =>
        Effect.tryPromise({
          try: async () => {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc, { preview: false });
          },
          catch: ensureError,
        }),
      // An untitled buffer holds the text, so Ctrl+S prompts for a new
      // location instead of writing back into the packaged resources.
      openReadOnlyDocument: (filePath) =>
        Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
          Effect.flatMap(fs.readFileString(filePath), (text) =>
            Effect.tryPromise({
              try: async () => {
                const doc = await vscode.workspace.openTextDocument({
                  content: normalizeLineEndings(text),
                  language: 'yaml',
                });
                await vscode.window.showTextDocument(doc, { preview: false });
              },
              catch: ensureError,
            }),
          ),
        ),
      revealFile: (filePath) =>
        Effect.tryPromise({
          try: async () => {
            await vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(filePath),
            );
          },
          catch: ensureError,
        }),
      confirmAction: (message, confirmLabel) =>
        Effect.tryPromise({
          try: () => confirmModal(message, confirmLabel),
          catch: ensureError,
        }),
      showInfoMessage: (message) =>
        this.forkInfoNotice(message, 'Agent settings'),
      showErrorMessage: (message) =>
        Effect.tryPromise({
          try: () => showLoggedMessage(this.ctx.channel, message),
          catch: (cause) =>
            new NotificationFailed({
              member: 'showErrorMessage',
              message: toErrorMessage(cause),
              cause,
            }),
        }),
      refreshAfterMutation: () =>
        Effect.tryPromise({
          try: () => this.refreshAfterAgentMutation(),
          catch: ensureError,
        }),
    });
  }

  /**
   * The inbound registry's terminal for the four agent-file actions: run one
   * on this host's runtime and report its failure on the settings channel, as
   * every sibling handler in this class does.
   */
  runAgentFileAction(
    command: AgentFileCommand,
    action: Effect.Effect<void, Error, ProcessServices>,
  ): Promise<void> {
    return withHandlerErrorHandling(this.ctx, FAILURE_MESSAGES[command], () =>
      this.runtime.runPromise(action),
    );
  }

  // ── Agent selection data ──

  async sendAgentSelectionData(webview: vscode.Webview): Promise<void> {
    await this.runtime.runPromise(loadAgents());
    await webview.postMessage(
      buildAgentSelectionMessage({
        buildSelectionItems: () => this.catalogController.buildSelectionItems(),
        getCustomAgentScanIssues,
      }),
    );
  }

  // ── Agent selection handlers ──

  async handleSetAgentEnabled(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SET_AGENT_ENABLED>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to update agent visibility',
      async () => {
        await this.runtime.runPromise(
          this.roster.setAgentEnabled({
            category: data.category,
            source: data.agentSource,
            name: data.agentName,
            enabled: data.enabled,
          }),
        );
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
        await this.runtime.runPromise(
          this.catalogController.setAllAgentsEnabled({
            category: data.category,
            source: data.source,
            enabled: data.enabled,
          }),
        );
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
        const result = await this.runtime.runPromise(
          this.directoryController.planOpenAgentFolder(data.folderType),
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

  async handleViewRemoteAgentPrompt(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.VIEW_REMOTE_AGENT_PROMPT>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to view remote agent prompt',
      async () => {
        const config = await this.runtime.runPromise(
          fetchRemoteAgentPromptYaml(data.agentName),
        );
        if (config == null) {
          await showLoggedMessage(
            this.ctx.channel,
            'Authentication required. Sign in using "TeXRA: Sign In".',
          );
          return;
        }

        const doc = await vscode.workspace.openTextDocument({
          content: config,
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

  async handleDeleteCustomAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_CUSTOM_AGENT>,
  ): Promise<void> {
    if (this.activeCustomAgentDeletions.has(data.agentName)) return;
    this.activeCustomAgentDeletions.add(data.agentName);

    try {
      await this.runAgentFileAction(
        'deleteCustomAgent',
        this.agentActions.deleteCustomAgent(data),
      );
    } finally {
      this.activeCustomAgentDeletions.delete(data.agentName);
    }
  }

  // ── Custom agent directory handlers ──

  async sendCustomAgentDir(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await this.runtime.runPromise(
        buildCustomAgentDirMessage({
          getCustomDirStatus: () =>
            this.directoryController.getCustomDirStatus(),
        }),
      ),
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
        await this.runtime.runPromise(
          this.directoryController.resetCustomDir(),
        );
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
        getActiveTeamId: () => this.roster.getActiveTeamId(),
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
        await withAgentCatalogAuthRefreshDeferred(() =>
          this.runtime.runPromise(
            applySettingsTeamRoster(data.presetId, {
              catalog: this.catalogController,
              loadLocalCatalog: () => loadAgents({ includeRemote: false }),
              canAccessRemoteCatalog: () => supabaseAuthenticated,
              signIn: runSignInCommand,
              forceRefreshRemoteCatalog: () =>
                refreshAgents({ includeRemote: true }),
              presentation: {
                chooseTeamAvailability: (prompt) =>
                  this.chooseTeamAvailability(prompt),
                // Both notices ride detached fibers, as the voided toast and
                // the forked error dialog did: the apply flow does not wait
                // on a toast, and a dialog fault is logged rather than
                // failing the apply that asked for the notice.
                showInfoMessage: (message) =>
                  this.forkInfoNotice(message, 'Team'),
                showErrorMessage: (message) =>
                  Effect.forkDetach(
                    Effect.tryPromise({
                      try: () => showLoggedMessage(this.ctx.channel, message),
                      catch: (cause) =>
                        new NotificationFailed({
                          member: 'showErrorMessage',
                          message: toErrorMessage(cause),
                          cause,
                        }),
                    }).pipe(
                      Effect.catchTag('NotificationFailed', (failure) =>
                        Effect.sync(() => {
                          this.ctx.log.warn(
                            `Error notification failed after handoff: ${failure.message}`,
                          );
                        }),
                      ),
                    ),
                  ).pipe(Effect.asVoid),
              },
              // The extension's refresh fan-out is still the settings view's
              // promise-shaped webview transport, so it is lifted here rather
              // than in the shared controller.
              refreshAfterApply: (selectedToolUseAgent) =>
                Effect.tryPromise({
                  try: () =>
                    this.refreshAfterAgentMutation(selectedToolUseAgent, true),
                  catch: (cause) => cause,
                }),
            }),
          ),
        );
      },
    );
  }

  async handleSaveAgentModePreset(): Promise<void> {
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

        await this.runtime.runPromise(loadAgents());

        await this.runtime.runPromise(
          this.catalogController.saveCurrentPreset(name),
        );

        await this.refreshAfterAgentMutation(undefined, true);

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

        await this.runtime.runPromise(
          this.catalogController.deleteCustomPreset(data.presetId),
        );

        await this.refreshAfterAgentMutation(undefined, true);
      },
    );
  }

  // ── Private helpers ──

  /**
   * Show an info notice on a detached fiber, as the `void` toast was: the
   * caller does not wait on it, and a notification fault is logged rather
   * than failing the mutation that asked for the notice.
   */
  private forkInfoNotice(message: string, scope: string) {
    return Effect.forkDetach(
      messages.showInfoMessage(message).pipe(
        Effect.catchTag('NotificationFailed', (failure) =>
          Effect.sync(() => {
            this.ctx.log.warn(`${scope} notice failed: ${failure.message}`);
          }),
        ),
      ),
    ).pipe(Effect.asVoid);
  }

  private async chooseTeamAvailability(prompt: TeamAvailabilityPrompt) {
    return chooseTeamAvailabilityViaDialog(prompt, { modal: true });
  }

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

        const customDir = await this.runtime.runPromise(
          agentDirectories.custom(),
        );
        await this.runtime.runPromise(
          Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
            fs.makeDirectory(customDir, { recursive: true }),
          ),
        );

        const templatePlan = this.directoryController.planTemplateAgent({
          category,
          name,
          customDir,
        });

        const written = await this.runtime.runPromise(
          writeTemplateAgentFile(
            templatePlan,
            path.join(this.ctx.extensionContext.extensionPath, 'resources'),
          ),
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
    await this.runtime.runPromise(refreshCustomAgentRoot());
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
