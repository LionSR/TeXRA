import * as vscode from 'vscode';

import { AUTH_COMMANDS } from '@auth/constants';
import { getAuthStatus } from '@commands/auth/authCommands';
import { GlobalStateKey, globalSM } from '@common/state';
import { BaseViewMessageHandler } from '@common/webview';
import { MainViewStartupController } from '@controllers/mainView/MainViewStartupController';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { signInWithChatGptSubscription } from '@frontend/auth/codexSubscriptionSignIn';
import { RecordingManager } from '@frontend/media/RecordingManager';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { isDebugModeEnabled } from '@logger/logUtils';
import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchMainViewInbound,
  GETTING_STARTED_COMMANDS,
  MainViewInboundHandlerRegistry,
} from '@shared/schemas';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { getConfig } from '@utils/config/configUtils';
import {
  checkCoreDependencies,
  getToolDocsCommand,
} from '@utils/system/toolUtils';
import { getProviderKeyUrl } from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { DiffManager } from './managers/DiffManager';
import * as executionHandlers from './managers/executionHandlers';
import { FileManager } from './managers/FileManager';
import { InstructionManager } from './managers/InstructionManager';

export interface MainViewOnboardingHooks {
  /**
   * Recompute and re-push the onboarding funnel (owned by
   * MainViewProvider). Called on webview ready and after welcome-card
   * actions that change the funnel inputs (skip, API-key entry).
   */
  refreshOnboardingFunnel(): Promise<void>;
}

export class MainViewMessageHandler extends BaseViewMessageHandler {
  private readonly recordingManager: RecordingManager;
  private readonly fileManager: FileManager;
  private readonly diffManager: DiffManager;
  private readonly instructionManager: InstructionManager;
  private readonly startupController: MainViewStartupController;
  private readonly handlerRegistry: MainViewInboundHandlerRegistry;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onboarding?: MainViewOnboardingHooks,
  ) {
    super('MainView');
    this.recordingManager = new RecordingManager({
      buildRecordingMessage: (message) => {
        const command = {
          started: MAIN_VIEW_COMMANDS.RECORDING_STARTED,
          stopped: MAIN_VIEW_COMMANDS.RECORDING_STOPPED,
          error: MAIN_VIEW_COMMANDS.RECORDING_ERROR,
        }[message.status];
        return message.status === 'error'
          ? { command, error: message.error }
          : { command };
      },
      buildTranscriptionMessage: (text) => ({
        command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED,
        text,
      }),
      progressTitle: 'Transcribing instruction',
    });
    this.fileManager = new FileManager();
    this.diffManager = new DiffManager();
    this.instructionManager = new InstructionManager();
    this.startupController = new MainViewStartupController({
      getConfig,
      loadOptions,
      getAuthStatus,
    });
    this.handlerRegistry = this.createHandlerRegistry();
  }

  public override async handleMessage(
    message: unknown,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await this.dispatchInbound(
      message,
      webviewView,
      dispatchMainViewInbound,
      this.handlerRegistry,
    );
  }

  /** Attaches the current webview to the sub-managers before dispatch. */
  protected override onDispatch(webviewView: vscode.WebviewView): void {
    this.fileManager.attachWebview(webviewView);
    this.instructionManager.attachWebview(webviewView);
    this.diffManager.attachWebview(webviewView);
  }

  private createHandlerRegistry(): MainViewInboundHandlerRegistry {
    return {
      // Common messages
      [MAIN_VIEW_COMMANDS.THEME_SET]: (m) =>
        this.runWithActiveView((view) => this.handleTheme(m, view)),
      [MAIN_VIEW_COMMANDS.DEBUG_MODE_SET]: (m) =>
        this.runWithActiveView((view) => this.handleDebugMode(m, view)),
      [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: () => this.handleWebviewReady(),
      [MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]: (m) => {
        vscode.window.showInformationMessage(m.text);
        this.logger.debug(this.channel, `Information message: ${m.text}`);
      },
      [MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION]: (m) =>
        showInstructionWithSuppress(m.key, m.text),
      [MAIN_VIEW_COMMANDS.GET_THEME]: () => this.handleThemeRequest(),
      [MAIN_VIEW_COMMANDS.GET_DEBUG_MODE]: () => this.handleDebugModeRequest(),
      [COMMON_COMMANDS.SWITCH_VIEW]: async (m) => {
        if (m.view === 'dashboard') {
          await safeExecuteCommand('texra.showDashboard', [], this.viewName);
          return;
        }
        if (m.view === 'main') {
          await safeExecuteCommand('texra.showMainView', [], this.viewName);
          return;
        }
        if (m.openInEditor) {
          await safeExecuteCommand(
            'texra.openProgressViewInTab',
            [],
            this.viewName,
          );
          return;
        }
        await safeExecuteCommand(
          'texra.showProgressView',
          [{ inPlace: true }],
          this.viewName,
        );
      },

      [MAIN_VIEW_COMMANDS.SETTINGS_OPEN]: () =>
        safeExecuteCommand('texra.showDashboard', [], this.viewName),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS]: (m) =>
        safeExecuteCommand(
          'texra.showAgents',
          [m.sessionType === 'toolUse' ? 'toolUse' : undefined],
          this.viewName,
        ),
      [MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS]: () =>
        safeExecuteCommand('texra.showModels', [], this.viewName),
      [MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS]: () =>
        safeExecuteCommand('texra.showMultiAgent', [], this.viewName),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY]: async (m) => {
        if (!m.customDirSet) {
          await safeExecuteCommand('texra.showAgents', [], this.viewName);
          return;
        }
        const dir = await agentDirectories.custom();
        if (dir) {
          await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(dir),
          );
        }
      },
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS]: () =>
        safeExecuteCommand('texra.openDoc', ['custom-agents'], this.viewName),
      [MAIN_VIEW_COMMANDS.OPEN_INSTALLATION_DOCS]: () =>
        safeExecuteCommand('texra.openDoc', ['installation'], this.viewName),

      [MAIN_VIEW_COMMANDS.EXECUTE]: (m) => executionHandlers.handleExecute(m),
      [MAIN_VIEW_COMMANDS.MERGE]: (m) =>
        executionHandlers.handleFileOperation(m),
      [MAIN_VIEW_COMMANDS.COMPARE]: (m) =>
        executionHandlers.handleFileOperation(m),
      [MAIN_VIEW_COMMANDS.ACCEPT_EDITED]: (m) =>
        executionHandlers.handleFileOperation(m),

      [MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE]: () =>
        this.fileManager.handleEditedFileSelection(),
      [MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES]: (m) =>
        this.fileManager.handleSelectMultipleFiles(m),

      [MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE]: (m) =>
        this.fileManager.handleRequestEditedFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE]: (m) =>
        this.fileManager.handleRequestBaseFile(m),

      [MAIN_VIEW_COMMANDS.GET_CURRENT_FILE]: (m) =>
        this.fileManager.handleGetCurrentFile(m),
      [MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES]: () =>
        this.fileManager.handleRefreshAllFiles(),
      [MAIN_VIEW_COMMANDS.ADD_OPENED_FILES]: (m) =>
        this.fileManager.handleAddOpenedFiles(m.fileType),
      [MAIN_VIEW_COMMANDS.ATTACH_DROPPED_FILES]: (m) =>
        this.fileManager.handleAttachDroppedFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES]: (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_CONTEXT_FILES]: (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES]: (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES]: (m) =>
        this.fileManager.handleUpdateFiles(m),

      [MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT]: (m) =>
        this.instructionManager.handlePolishInstructionText(m),
      [MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE]: (m) =>
        this.instructionManager.handleClipboardImage(m),

      [MAIN_VIEW_COMMANDS.START_RECORDING]: () =>
        this.runWithActiveView((view) => this.recordingManager.start(view)),
      [MAIN_VIEW_COMMANDS.STOP_RECORDING]: () =>
        this.runWithActiveView((view) => this.recordingManager.stop(view)),

      [MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY]: async () => {
        await safeExecuteCommand('texra.setApiKey');
        // SecretManager has no key-changed event, so the set-key flow's
        // completion is the explicit refresh point for the onboarding
        // funnel (welcome card → API-key entry → State 1).
        await this.onboarding?.refreshOnboardingFunnel();
      },
      [MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY]: (m) => {
        if (!m.provider) return;
        return safeExecuteCommand(
          'texra.setApiKey',
          [m.provider],
          this.viewName,
        );
      },
      [MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL]: async (m) => {
        const url = m.provider ? getProviderKeyUrl(m.provider) : undefined;
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      },
      [MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE]: async () => {
        await vscode.env.openExternal(
          vscode.Uri.parse(
            'https://texra.ai/guide/installation#setting-up-api-keys',
          ),
        );
      },

      [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: (m) => this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: (m) => this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER]: (m) =>
        this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER]: (m) =>
        this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER]: (m) =>
        this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER]: (m) =>
        this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE]: (m) => {
        const docsCommand = getToolDocsCommand(m.tool);
        if (!docsCommand) return;

        const [command, ...args] = docsCommand.split(',');
        return safeExecuteCommand(command, args, this.viewName);
      },
      [MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES]: async () => {
        const view = this.getActiveView();
        if (!view) {
          return;
        }
        const missingTools = await checkCoreDependencies(true);
        view.webview.postMessage(
          missingTools.length === 0
            ? { command: MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER }
            : {
                command: MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER,
                missingTools: [...missingTools],
              },
        );
      },
      [MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER]: (m) => this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER]: (m) => this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER]: async () => {
        try {
          const authenticated = await vscode.commands.executeCommand<boolean>(
            AUTH_COMMANDS.SIGN_IN,
          );
          if (authenticated) {
            this.postToActiveView({
              command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
            });
            await this.refreshAfterCredentialChange();
          }
        } catch (error) {
          this.logger.debug(
            this.channel,
            `Sign-in from banner failed: ${toErrorMessage(error)}`,
          );
        }
      },
      [MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER]: async () => {
        await globalSM.update(GlobalStateKey.LOGIN_BANNER_DISMISSED, true);
      },
      [MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER]: async () => {
        await globalSM.update(
          GlobalStateKey.ORCHESTRATOR_BANNER_DISMISSED,
          true,
        );
      },
      [MAIN_VIEW_COMMANDS.GETTING_STARTED_ACTION]: async (m) => {
        await safeExecuteCommand(
          GETTING_STARTED_COMMANDS[m.action],
          [],
          this.viewName,
        );
        // runSetup changes the onboarding funnel inputs, so re-derive the
        // card state once the setup assistant returns.
        if (m.action === 'runSetup') {
          await this.onboarding?.refreshOnboardingFunnel();
        }
      },
      [MAIN_VIEW_COMMANDS.ONBOARDING_SKIP]: async () => {
        // Persist the user-scoped declined flag (same flag the CLI picker
        // writes), then re-derive so the card disappears and the normal
        // launcher renders.
        await setOnboardingDeclined(this.context.globalState, true);
        await this.onboarding?.refreshOnboardingFunnel();
      },
      [MAIN_VIEW_COMMANDS.ONBOARDING_SIGN_IN_CHATGPT]: async () => {
        await signInWithChatGptSubscription(this.channel);
        await this.refreshAfterCredentialChange();
      },
      [MAIN_VIEW_COMMANDS.ONBOARDING_RUN_SETUP]: async () => {
        await safeExecuteCommand(
          GETTING_STARTED_COMMANDS.runSetup,
          [],
          this.viewName,
        );
        await this.onboarding?.refreshOnboardingFunnel();
      },
      [MAIN_VIEW_COMMANDS.ONBOARDING_OPEN_GETTING_STARTED]: () =>
        safeExecuteCommand(
          GETTING_STARTED_COMMANDS.openWalkthrough,
          [],
          this.viewName,
        ),
      [MAIN_VIEW_COMMANDS.ONBOARDING_SKIP_SETUP]: async () => {
        await setFirstRunDone(this.context.globalState, true);
        await this.onboarding?.refreshOnboardingFunnel();
      },

      [MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS]: (m) =>
        this.diffManager.postRecentCommits(m.notifyWhenEmpty ?? undefined),
      [MAIN_VIEW_COMMANDS.REFRESH_COMMITS]: () =>
        this.diffManager.postRecentCommits(),
      [MAIN_VIEW_COMMANDS.LATEXDIFF]: (m) =>
        this.diffManager.handleLatexdiff(m),
      [MAIN_VIEW_COMMANDS.LATEXDIFFVC]: (m) =>
        this.diffManager.handleLatexdiffvc(m),
      [MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC]: (m) =>
        this.diffManager.handleLatexdiffvcOperation(m),
      [MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC]: (m) =>
        this.diffManager.handleLatexdiffvcOperation(m),

      [MAIN_VIEW_COMMANDS.CLEAN_OUTPUT]: (m) =>
        executionHandlers.handleHousekeeping(m),
      [MAIN_VIEW_COMMANDS.CLEAN_BUILD]: (m) =>
        executionHandlers.handleHousekeeping(m),
      [MAIN_VIEW_COMMANDS.INDENT_TEX]: (m) =>
        executionHandlers.handleHousekeeping(m),
      [MAIN_VIEW_COMMANDS.PACK_SINGLE]: (m) =>
        executionHandlers.handleSingleOperation(m),
      [MAIN_VIEW_COMMANDS.CLEAN_SINGLE]: (m) =>
        executionHandlers.handleSingleOperation(m),
      [MAIN_VIEW_COMMANDS.PACK_MULTIPLE]: (m) =>
        executionHandlers.handleMultipleOperation(m),
      [MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE]: (m) =>
        executionHandlers.handleMultipleOperation(m),

      [MAIN_VIEW_COMMANDS.SHOW_AGENT_HISTORY]: () =>
        safeExecuteCommand('texra.showAgentHistory', [], this.viewName),
    };
  }

  private handleThemeRequest(): void {
    const isDarkTheme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    this.postToActiveView({
      command: MAIN_VIEW_COMMANDS.THEME_SET,
      theme: isDarkTheme ? 'dark' : 'light',
    });
  }

  private handleDebugModeRequest(): void {
    const debugMode = isDebugModeEnabled();
    this.postToActiveView({
      command: MAIN_VIEW_COMMANDS.DEBUG_MODE_SET,
      debugMode,
    });
  }

  /** Run `fn` with the active webview view, or no-op when none is attached. */
  private runWithActiveView<T>(
    fn: (view: vscode.WebviewView) => T,
  ): T | undefined {
    const view = this.getActiveView();
    return view ? fn(view) : undefined;
  }

  /**
   * Re-pull API-key status, picker options, and the onboarding funnel after a
   * credential change (sign-in or ChatGPT subscription) so State 0 -> 1
   * transitions land without a manual refresh.
   */
  private async refreshAfterCredentialChange(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand('texra.refreshApiKeyStatus'),
      vscode.commands.executeCommand('texra.refreshAllOptions'),
      this.onboarding?.refreshOnboardingFunnel(),
    ]);
  }

  protected async handleWebviewReady(): Promise<void> {
    const webviewView = this.getActiveView();
    if (!webviewView) {
      return;
    }
    await super.handleWebviewReady(undefined, webviewView);
    this.postWorkspaceRoots(webviewView);
    webviewView.webview.postMessage(
      this.startupController.getOrchestratorBannerMessage(),
    );

    try {
      const messages =
        await this.startupController.getOptionsAndLoginMessages();
      for (const message of messages) {
        webviewView.webview.postMessage(message);
      }
    } catch (error) {
      // Without this the model/agent pickers render empty with no explanation;
      // tell the user why so the failure is actionable rather than silent.
      await showLoggedErrorMessage(
        this.channel,
        'TeXRA failed to load model and agent options',
        error,
      );
    }

    // Onboarding funnel push (PRD: agent-native onboarding). Runs on every
    // ready — including the replays MainViewProvider.refreshOptionsAndView
    // issues from its credential-changed hooks — so the provider sees the
    // in-session State 0 → 1 transition.
    await this.onboarding?.refreshOnboardingFunnel();
  }

  /** Push the open workspace folders used by the launcher's root picker. */
  public postWorkspaceRoots(webviewView: vscode.WebviewView): void {
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_WORKSPACE_ROOTS,
      optionsData:
        vscode.workspace.workspaceFolders?.map((folder) => ({
          label: folder.name,
          value: folder.uri.fsPath,
        })) ?? [],
    });
  }
}
