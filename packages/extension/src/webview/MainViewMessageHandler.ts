import * as vscode from 'vscode';

import {
  MainViewInteractionController,
  type MainViewCommandPlan,
} from '@controllers/mainView/MainViewInteractionController';
import { MainViewStartupController } from '@controllers/mainView/MainViewStartupController';
import { AUTH_COMMANDS, getAuthStatus } from '@commands/auth';
import { toErrorMessage } from '@common/errors';
import {
  BaseViewMessageHandler,
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
} from '@common/webview';
import { RecordingManager } from '@common/managers/RecordingManager';
import { agentDirectories } from '@frontend/agents';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import {
  dispatchMainViewInbound,
  MainViewInboundHandlerRegistry,
} from '@shared/schemas';
import { PROVIDER_URLS } from '@shared/constants/providers';
import { getConfig, updateConfig, SETTINGS_QUERY } from '@utils/config';
import { checkCoreDependencies, getToolDocsCommand } from '@utils/system';

import { DiffManager } from './managers/DiffManager';
import { ExecutionManager } from './managers/ExecutionManager';
import { FileManager } from './managers/FileManager';
import { InstructionManager } from './managers/InstructionManager';

export class MainViewMessageHandler extends BaseViewMessageHandler {
  private readonly recordingManager: RecordingManager;
  private readonly fileManager: FileManager;
  private readonly executionManager: ExecutionManager;
  private readonly diffManager: DiffManager;
  private readonly instructionManager: InstructionManager;
  private readonly interactionController: MainViewInteractionController;
  private readonly startupController: MainViewStartupController;

  constructor(context: vscode.ExtensionContext) {
    super('MainView', { trackActiveView: true });
    this.recordingManager = new RecordingManager(context, {
      recordingStartedCommand: MAIN_VIEW_COMMANDS.RECORDING_STARTED,
      recordingStoppedCommand: MAIN_VIEW_COMMANDS.RECORDING_STOPPED,
      recordingErrorCommand: MAIN_VIEW_COMMANDS.RECORDING_ERROR,
      transcriptionCommand: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED,
      progressTitle: 'Transcribing instruction',
    });
    this.fileManager = new FileManager();
    this.executionManager = new ExecutionManager();
    this.diffManager = new DiffManager();
    this.instructionManager = new InstructionManager(context);
    this.interactionController = new MainViewInteractionController({
      getProviderUrl: (provider) =>
        PROVIDER_URLS[provider as keyof typeof PROVIDER_URLS],
      getToolDocsCommand,
    });
    this.startupController = new MainViewStartupController({
      getConfig,
      loadOptions,
      getAuthStatus,
    });
  }

  public override async handleMessage(
    message: unknown,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await this.withActiveView(webviewView, async () => {
      this.fileManager.attachWebview(webviewView);
      this.instructionManager.attachWebview(webviewView);
      this.diffManager.attachWebview(webviewView);

      const handled = dispatchMainViewInbound(
        message,
        this.createHandlerRegistry(webviewView),
        (error) => {
          this.logger.error(
            this.channel,
            `Error handling message: ${toErrorMessage(error)}`,
          );
        },
      );

      if (!handled) {
        await super.handleMessage(message, webviewView);
      }
    });
  }

  private createHandlerRegistry(
    webviewView: vscode.WebviewView,
  ): MainViewInboundHandlerRegistry {
    return {
      // Common messages
      [MAIN_VIEW_COMMANDS.THEME_SET]: (m) => this.handleTheme(m, webviewView),
      [MAIN_VIEW_COMMANDS.DEBUG_MODE_SET]: (m) =>
        this.handleDebugMode(m, webviewView),
      [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: () => this.handleWebviewReady(),
      [MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]: (m) => {
        vscode.window.showInformationMessage(m.text);
        this.logger.debug(this.channel, `Information message: ${m.text}`);
      },
      [MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION]: (m) =>
        showInstructionWithSuppress(m.key, m.text),
      [MAIN_VIEW_COMMANDS.GET_THEME]: () => this.handleThemeRequest(),
      [MAIN_VIEW_COMMANDS.GET_DEBUG_MODE]: () => this.handleDebugModeRequest(),
      [COMMON_COMMANDS.SWITCH_VIEW]: (m) => {
        return this.runCommandPlan(
          this.interactionController.getSwitchViewCommand(m),
        );
      },

      [MAIN_VIEW_COMMANDS.MODEL_SELECTED]: (m) =>
        this.postToActiveView({
          command: MAIN_VIEW_COMMANDS.MODEL_SELECTED,
          model: m.model,
        }),
      [MAIN_VIEW_COMMANDS.SETTINGS_OPEN]: () =>
        this.runCommandPlan(
          this.interactionController.getOpenSettingsCommand(
            SETTINGS_QUERY.EXTENSION,
          ),
        ),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS]: (m) =>
        this.runCommandPlan(
          this.interactionController.getOpenAgentSettingsCommand(m),
        ),
      [MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS]: () =>
        safeExecuteCommand('texra.showModels', [], this.viewName),
      [MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS]: () =>
        safeExecuteCommand('texra.showMultiAgent', [], this.viewName),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY]: async (m) => {
        const action = this.interactionController.getAgentDirectoryAction(m);
        if (action.kind === 'openAgentSettings') {
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

      [MAIN_VIEW_COMMANDS.EXECUTE]: (m) =>
        this.executionManager.handleExecute(m as any),
      [MAIN_VIEW_COMMANDS.MERGE]: (m) =>
        this.executionManager.handleFileOperation(m as any),
      [MAIN_VIEW_COMMANDS.COMPARE]: (m) =>
        this.executionManager.handleFileOperation(m as any),
      [MAIN_VIEW_COMMANDS.ACCEPT_EDITED]: (m) =>
        this.executionManager.handleFileOperation(m as any),

      [MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE]: () =>
        this.fileManager.handleEditedFileSelection(),
      [MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES]: (m) =>
        this.fileManager.handleSelectMultipleFiles(m),

      [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: (m) =>
        this.fileManager.handleGenericFileSelected({
          command: m.command,
          filePath: m.filePath ?? '',
        }),

      [MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE]: (m) =>
        this.fileManager.handleRequestEditedFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE]: (m) =>
        this.fileManager.handleRequestBaseFile(m),

      [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: (m) =>
        this.fileManager.handleSetMultipleFiles(m),
      [MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES]: (m) =>
        this.fileManager.handleSetMultipleFiles(m),
      [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: (m) =>
        this.fileManager.handleSetMultipleFiles(m),

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
        this.instructionManager.handlePolishInstructionText(m as any),
      [MAIN_VIEW_COMMANDS.TRANSCRIBE_INSTRUCTION]: () =>
        this.instructionManager.handleTranscribeInstruction(),
      [MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE]: (m) =>
        this.instructionManager.handleClipboardImage(m),

      [MAIN_VIEW_COMMANDS.START_RECORDING]: () =>
        this.recordingManager.start(webviewView),
      [MAIN_VIEW_COMMANDS.STOP_RECORDING]: () =>
        this.recordingManager.stop(webviewView),

      [MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY]: () =>
        safeExecuteCommand('texra.setApiKey'),
      [MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY]: (m) => {
        return this.runCommandPlan(
          this.interactionController.getSetProviderApiKeyCommand(m),
        );
      },
      [MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL]: async (m) => {
        const url = this.interactionController.getProviderApiKeyUrl(m);
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      },
      [MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE]: async () => {
        await vscode.env.openExternal(
          vscode.Uri.parse(this.interactionController.getApiKeyGuideUrl()),
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
        return this.runCommandPlan(
          this.interactionController.getInstallGuideCommand(m),
        );
      },
      [MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES]: async () => {
        const view = this.getActiveView();
        if (!view) {
          return;
        }
        const missingTools = await checkCoreDependencies(true);
        view.webview.postMessage(
          this.interactionController.getDependencyBannerMessage(missingTools),
        );
      },
      [MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER]: (m) => this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER]: () =>
        this.postToActiveView({
          command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
        }),
      [MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER]: async () => {
        try {
          const authenticated = await vscode.commands.executeCommand<boolean>(
            AUTH_COMMANDS.SIGN_IN,
          );
          if (authenticated) {
            this.postToActiveView({
              command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
            });
          }
        } catch (error) {
          this.logger.debug(
            this.channel,
            `Sign-in from banner failed: ${toErrorMessage(error)}`,
          );
        }
      },
      [MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER]: (m) =>
        this.applyConfigUpdate(
          this.interactionController.getDismissConfigUpdate(m),
        ),
      [MAIN_VIEW_COMMANDS.DISMISS_GETTING_STARTED_BANNER]: (m) =>
        this.applyConfigUpdate(
          this.interactionController.getDismissConfigUpdate(m),
        ),
      [MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER]: (m) =>
        this.applyConfigUpdate(
          this.interactionController.getDismissConfigUpdate(m),
        ),

      [MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS]: (m) =>
        this.diffManager.handleRequestRecentCommits(m),
      [MAIN_VIEW_COMMANDS.REFRESH_COMMITS]: () =>
        this.diffManager.handleRefreshCommits(),
      [MAIN_VIEW_COMMANDS.LATEXDIFF]: (m) =>
        this.diffManager.handleLatexdiff(m),
      [MAIN_VIEW_COMMANDS.LATEXDIFFVC]: (m) =>
        this.diffManager.handleLatexdiffvc(m),
      [MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC]: (m) =>
        this.diffManager.handleLatexdiffvcOperation(m),
      [MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC]: (m) =>
        this.diffManager.handleLatexdiffvcOperation(m),

      [MAIN_VIEW_COMMANDS.CLEAN_OUTPUT]: (m) =>
        this.executionManager.handleHousekeeping(m),
      [MAIN_VIEW_COMMANDS.CLEAN_BUILD]: (m) =>
        this.executionManager.handleHousekeeping(m),
      [MAIN_VIEW_COMMANDS.INDENT_TEX]: (m) =>
        this.executionManager.handleHousekeeping(m),
      [MAIN_VIEW_COMMANDS.PACK_SINGLE]: (m) =>
        this.executionManager.handleSingleOperation(m),
      [MAIN_VIEW_COMMANDS.CLEAN_SINGLE]: (m) =>
        this.executionManager.handleSingleOperation(m),
      [MAIN_VIEW_COMMANDS.PACK_MULTIPLE]: (m) =>
        this.executionManager.handleMultipleOperation(m),
      [MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE]: (m) =>
        this.executionManager.handleMultipleOperation(m),

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
    const debugMode = getConfig<boolean>('texra.logger.debugMode', false);
    this.postToActiveView({
      command: MAIN_VIEW_COMMANDS.DEBUG_MODE_SET,
      debugMode,
    });
  }

  private async runCommandPlan(
    plan: MainViewCommandPlan | null,
  ): Promise<void> {
    if (!plan) return;
    await safeExecuteCommand(plan.command, plan.args, this.viewName);
  }

  private async applyConfigUpdate(configUpdate: {
    key: string;
    value: boolean;
  }): Promise<void> {
    await updateConfig(configUpdate.key, configUpdate.value);
  }

  /** Post message to active view if available */
  private postToActiveView(message: unknown): void {
    this.getActiveView()?.webview.postMessage(message);
  }

  protected async handleWebviewReady(): Promise<void> {
    const webviewView = this.getActiveView();
    if (!webviewView) {
      return;
    }
    await super.handleWebviewReady(undefined, webviewView);
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
      this.logger.error(
        this.channel,
        `Failed to compute options: ${toErrorMessage(error)}`,
      );
    }
  }
}
