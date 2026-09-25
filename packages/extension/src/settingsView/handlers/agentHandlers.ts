/** Agent settings: selection, files, directories, and teams. */
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

import {
  type AgentRosterController,
  createWorkspaceAgentRosterController,
  getAgentsByCategory,
  getAgent,
  getCustomAgentScanIssues,
  loadAgents,
  refresh as refreshAgents,
} from '@agent/index';
import { supabaseAuthenticated } from '@auth/SupabaseAuth';
import { fetchRemoteAgentPromptYaml } from '@controllers/settingsView/remoteAgentPrompt';
import { applySettingsTeamRoster } from '@controllers/settingsView/SettingsTeamRosterController';
import {
  createSettingsAgentActions,
  FAILURE_MESSAGES,
  type AgentFileCommand,
} from '@controllers/settingsView/backend/SettingsAgentActions';
import {
  templateAgentNamePrompt,
  validateTemplateAgentName,
  writeTemplateAgentFile,
} from '@controllers/settingsView/backend/templateAgentCreation';
import { SettingsAgentCatalogController } from '@controllers/settingsView/SettingsAgentCatalogController';
import { withAgentCatalogAuthRefreshDeferred } from '@frontend/auth/agentCatalogRefreshScope';
import { runSignInCommand } from '@frontend/auth/signInCommand';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { chooseTeamAvailabilityViaDialog } from '@frontend/ui/dialogs';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { NotificationFailed } from '@hosts/uiHosts';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { agentKey } from '@shared/schemas';
import type { SettingsMessageFor } from '@shared/settingsView/settingsViewMessages';
import {
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
  buildAgentModePresetsMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { allSettledVoid } from '@utils/core/allSettledVoid';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

import {
  postToWebview,
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** Agent selection, directory, and team handler delegate. */
export class AgentHandlers {
  private readonly catalogController: SettingsAgentCatalogController;
  private readonly roster: AgentRosterController<
    ReturnType<typeof getAgentsByCategory>[number]
  >;
  readonly agentActions;

  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly refreshAfterAgentMutation: (
      selectedToolUseAgent?: string,
      agentCatalogAlreadyFresh?: boolean,
    ) => Effect.Effect<void, Error, ProcessServices>,
    private readonly roots: Pick<
      WorkspaceRoots,
      'workspaceState' | 'globalState'
    >,
    private readonly refreshCatalogs: () => Effect.Effect<
      void,
      Error,
      ProcessServices
    >,
  ) {
    this.roster = createWorkspaceAgentRosterController(roots);
    this.catalogController = new SettingsAgentCatalogController({
      workspaceState: roots.workspaceState,
      roster: this.roster,
      getAgents: getAgentsByCategory,
    });
    this.agentActions = createSettingsAgentActions({
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
        vscodeUi.confirm(message, { confirmLabel }),
      showInfoMessage: (message) =>
        this.forkInfoNotice(message, 'Agent settings'),
      showErrorMessage: (message) =>
        showLoggedMessage(this.ctx.channel, message).pipe(Effect.asVoid),
      refreshAfterMutation: () => this.refreshAfterAgentMutation(),
    });
  }

  /**
   * The inbound registry's terminal for the four agent-file actions: report a
   * failed one on the settings channel, as every sibling handler in this class
   * does. The host runs the program it hands back at its message boundary.
   */
  runAgentFileAction(
    command: AgentFileCommand,
    action: Effect.Effect<void, Error, ProcessServices>,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      FAILURE_MESSAGES[command],
      action,
    );
  }

  // ── Agent selection data ──

  sendAgentSelectionData(webview: vscode.Webview) {
    return Effect.gen({ self: this }, function* () {
      yield* loadAgents();
      yield* postToWebview(
        webview,
        buildAgentSelectionMessage({
          buildSelectionItems: () =>
            this.catalogController.buildSelectionItems(),
          getCustomAgentScanIssues,
        }),
      );
    });
  }

  // ── Agent selection handlers ──

  handleSetAgentEnabled(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED>,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to update agent visibility',
      this.roster
        .setAgentEnabled({
          category: data.category,
          source: data.agentSource,
          name: data.agentName,
          enabled: data.enabled,
        })
        .pipe(Effect.andThen(this.refreshAfterAgentMutation())),
    );
  }

  handleSetAllAgentsEnabled(
    data: SettingsMessageFor<
      typeof SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED
    >,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to update agent visibility',
      this.catalogController
        .setAllAgentsEnabled({
          category: data.category,
          source: data.source,
          enabled: data.enabled,
        })
        .pipe(Effect.andThen(this.refreshAfterAgentMutation())),
    );
  }

  handleOpenAgentFolder(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER>,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to open agent folder',
      Effect.gen({ self: this }, function* () {
        const directory = yield* agentDirectories.getDirectory(data.folderType);
        if (!directory) {
          yield* showLoggedMessage(
            this.ctx.channel,
            `No local directory for agent source: ${data.folderType}`,
          );
          return;
        }
        yield* Effect.tryPromise({
          try: () =>
            vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(directory),
            ),
          catch: ensureError,
        });
      }),
    );
  }

  handleViewRemoteAgentPrompt(
    data: SettingsMessageFor<
      typeof SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT
    >,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to view remote agent prompt',
      Effect.gen({ self: this }, function* () {
        const config = yield* fetchRemoteAgentPromptYaml(data.agentName);
        if (config == null) {
          yield* showLoggedMessage(
            this.ctx.channel,
            'Authentication required. Sign in using "TeXRA: Sign In".',
          );
          return;
        }

        yield* Effect.tryPromise({
          try: async () => {
            const doc = await vscode.workspace.openTextDocument({
              content: config,
              language: 'yaml',
            });
            await vscode.window.showTextDocument(doc, { preview: false });
          },
          catch: ensureError,
        });
      }),
    );
  }

  handleCreateAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.CREATE_AGENT>,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (data.mode === 'template') {
        yield* this.createAgentFromTemplate(data.category);
      } else {
        yield* Effect.tryPromise({
          try: () =>
            vscode.commands.executeCommand(
              'texra.createAgentWithAI',
              data.category,
            ),
          catch: ensureError,
        });
      }

      yield* this.refreshAfterAgentMutation();
    });
  }

  handleDeleteCustomAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT>,
  ) {
    return this.runAgentFileAction(
      'deleteCustomAgent',
      this.agentActions.deleteCustomAgent(data),
    );
  }

  // ── Custom agent directory handlers ──

  sendCustomAgentDir(webview: vscode.Webview) {
    return Effect.flatMap(
      buildCustomAgentDirMessage(
        this.roots.globalState,
        agentDirectories.custom(),
      ),
      (message) => postToWebview(webview, message),
    );
  }

  handleSetCustomAgentDir() {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to set custom agent directory',
      Effect.gen({ self: this }, function* () {
        const selectedPath = yield* agentDirectories.promptCustom();
        if (!selectedPath) return;
        yield* this.refreshAgentDirUI();
      }),
    );
  }

  handleResetCustomAgentDir() {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to reset custom agent directory',
      this.roots.globalState
        .update(GlobalStateKey.CUSTOM_AGENT_DIR, undefined)
        .pipe(Effect.andThen(this.refreshAgentDirUI())),
    );
  }

  // ── Agent team handlers ──

  sendAgentModePresets(webview: vscode.Webview) {
    return postToWebview(
      webview,
      buildAgentModePresetsMessage({
        getCustomPresets: () => this.catalogController.getCustomPresets(),
        getOrchestratorAgentNames: () =>
          this.catalogController.getOrchestratorAgentNames(),
        getActiveTeamId: () => this.roster.getActiveTeamId(),
      }),
    );
  }

  handleApplyAgentModePreset(
    data: SettingsMessageFor<
      typeof SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET
    >,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to apply agent team',
      withAgentCatalogAuthRefreshDeferred(
        applySettingsTeamRoster(data.presetId, {
          catalog: this.catalogController,
          loadLocalCatalog: () => loadAgents({ includeRemote: false }),
          canAccessRemoteCatalog: () => supabaseAuthenticated,
          signIn: runSignInCommand,
          forceRefreshRemoteCatalog: () =>
            refreshAgents({ includeRemote: true }),
          presentation: {
            chooseTeamAvailability: (prompt) =>
              chooseTeamAvailabilityViaDialog(prompt, { modal: true }),
            // Both notices ride detached fibers, as the voided toast and the
            // forked error dialog did: the apply flow does not wait on a
            // toast, and a dialog fault is logged rather than failing the
            // apply that asked for the notice.
            showInfoMessage: (message) => this.forkInfoNotice(message, 'Team'),
            showErrorMessage: (message) =>
              Effect.forkDetach(
                showLoggedMessage(this.ctx.channel, message),
              ).pipe(Effect.asVoid),
          },
          refreshAfterApply: (selectedToolUseAgent) =>
            this.refreshAfterAgentMutation(selectedToolUseAgent, true),
        }),
      ),
    );
  }

  handleSaveAgentModePreset() {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to save agent team',
      Effect.gen({ self: this }, function* () {
        const name = yield* Effect.promise(() =>
          vscode.window.showInputBox({
            prompt: 'Name for the new team',
            placeHolder: 'e.g. My Research Team',
            validateInput: (v) => (v.trim() ? null : 'Name cannot be empty'),
          }),
        );
        if (!name) return; // cancelled

        yield* loadAgents();

        yield* this.catalogController.saveCurrentPreset(name);

        yield* this.refreshAfterAgentMutation(undefined, true);

        void vscode.window.showInformationMessage(
          `Saved team "${name.trim()}"`,
        );
      }),
    );
  }

  handleDeleteAgentModePreset(
    data: SettingsMessageFor<
      typeof SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET
    >,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to delete agent team',
      Effect.gen({ self: this }, function* () {
        const target = yield* this.catalogController.getCustomPreset(
          data.presetId,
        );
        if (!target) {
          void vscode.window.showErrorMessage(
            `Unknown custom team: ${data.presetId}`,
          );
          return;
        }

        const confirmed = yield* vscodeUi.confirm(
          `Delete team "${target.name}"?`,
          { confirmLabel: 'Delete' },
        );
        if (!confirmed) return;

        yield* this.catalogController.deleteCustomPreset(data.presetId);

        yield* this.refreshAfterAgentMutation(undefined, true);
      }),
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
      vscodeUi.showInfoMessage(message).pipe(
        Effect.catchTag('NotificationFailed', (failure) =>
          Effect.logWarning(`${scope} notice failed: ${failure.message}`),
        ),
        withLogChannel(this.ctx.channel),
      ),
    ).pipe(Effect.asVoid);
  }

  private createAgentFromTemplate(category: 'workflow' | 'toolUse') {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to create agent from template',
      Effect.gen({ self: this }, function* () {
        const name = yield* Effect.promise(() =>
          vscode.window.showInputBox({
            prompt: templateAgentNamePrompt(category),
            placeHolder: 'my_agent',
            validateInput: validateTemplateAgentName,
          }),
        );
        if (!name) return;

        const customDir = yield* agentDirectories.custom();
        yield* Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
          fs.makeDirectory(customDir, { recursive: true }),
        );

        const written = yield* writeTemplateAgentFile(
          { category, name, customDir },
          path.join(this.ctx.extensionContext.extensionPath, 'resources'),
        );
        if (!written.ok) {
          yield* Effect.promise(() =>
            vscode.window.showWarningMessage(written.message),
          );
          return;
        }

        yield* Effect.tryPromise({
          try: async () => {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(written.filePath),
            );
            await vscode.window.showTextDocument(doc);
          },
          catch: ensureError,
        });
      }),
    );
  }

  /** Refresh agent dir + selection after a directory change. */
  private refreshAgentDirUI() {
    return Effect.gen({ self: this }, function* () {
      yield* agentDirectories.refreshAfterDirChange();
      const { refreshCustomAgentRoot } = yield* Effect.promise(
        () => import('@frontend/setup'),
      );
      yield* refreshCustomAgentRoot();
      yield* allSettledVoid([
        this.ctx.withActiveWebview((w) =>
          allSettledVoid([
            this.sendCustomAgentDir(w),
            this.sendAgentSelectionData(w),
          ]),
        ),
        this.refreshCatalogs(),
      ]);
    });
  }
}
