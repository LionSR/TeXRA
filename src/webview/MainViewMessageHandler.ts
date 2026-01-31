import * as vscode from 'vscode';

import {
  dispatchMainViewInbound,
  MainViewInboundHandlerRegistry,
} from '@shared/schemas';
import { toErrorMessage } from '@common/errors';
import { BaseViewMessageHandler, MAIN_VIEW_COMMANDS } from '@common/webview';
import { RecordingManager } from '@common/managers/RecordingManager';
import { agentDirectories } from '@frontend/agents';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { getConfig, updateConfig, SETTINGS_QUERY } from '@utils/config';
import { checkCoreDependencies, getToolDocsCommand } from '@utils/system';
import { AUTH_COMMANDS, getAuthStatus } from '@commands/auth';
import { PROVIDER_URLS } from '@commands/api/apiKeyCommands';

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
        // Fall back to base class for unhandled messages
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
      [MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]: (m) =>
        this.handleInfoMessage(m),
      [MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION]: (m) =>
        showInstructionWithSuppress(m.key, m.text),
      [MAIN_VIEW_COMMANDS.GET_THEME]: () => this.handleThemeRequest(),
      [MAIN_VIEW_COMMANDS.GET_DEBUG_MODE]: () => this.handleDebugModeRequest(),

      // Settings messages
      [MAIN_VIEW_COMMANDS.MODEL_SELECTED]: (m) => this.handleModelSelection(m),
      [MAIN_VIEW_COMMANDS.SETTINGS_OPEN]: () =>
        safeExecuteCommand(
          'workbench.action.openSettings',
          [SETTINGS_QUERY.EXTENSION],
          this.viewName,
        ),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS]: (m) => {
        const query =
          m.sessionType === 'toolUse'
            ? SETTINGS_QUERY.TOOL_USE_AGENTS
            : SETTINGS_QUERY.WORKFLOW_AGENTS;
        return safeExecuteCommand(
          'workbench.action.openSettings',
          [query],
          this.viewName,
        );
      },
      [MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS]: () =>
        safeExecuteCommand(
          'workbench.action.openSettings',
          [SETTINGS_QUERY.MODELS],
          this.viewName,
        ),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY]: async (m) => {
        if (!m.customDirSet) {
          await safeExecuteCommand(
            'workbench.action.openSettings',
            [SETTINGS_QUERY.AGENT_DIRECTORY],
            this.viewName,
          );
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
        safeExecuteCommand('texra.openDoc', ['agent-explorer'], this.viewName),
      [MAIN_VIEW_COMMANDS.OPEN_INSTALLATION_DOCS]: () =>
        safeExecuteCommand('texra.openDoc', ['installation'], this.viewName),

      // Execution messages (passthrough schemas preserve all fields)
      [MAIN_VIEW_COMMANDS.EXECUTE]: (m) =>
        this.executionManager.handleExecute(m as any),
      [MAIN_VIEW_COMMANDS.MERGE]: (m) =>
        this.executionManager.handleFileOperation(m as any),
      [MAIN_VIEW_COMMANDS.COMPARE]: (m) =>
        this.executionManager.handleFileOperation(m as any),
      [MAIN_VIEW_COMMANDS.ACCEPT_EDITED]: (m) =>
        this.executionManager.handleFileOperation(m as any),

      // File selection messages
      [MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE]: (m) =>
        this.fileManager.handleFileSelection(m),
      [MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE]: (m) =>
        this.fileManager.handleFileSelection(m),
      [MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE]: (m) =>
        this.fileManager.handleFileSelection(m),
      [MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE]: (m) =>
        this.fileManager.handleFileSelection(m),
      [MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE]: () =>
        this.fileManager.handleEditedFileSelection(),
      [MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES]: (m) =>
        this.fileManager.handleSelectMultipleFiles(m),

      // File selected messages
      [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: (m) =>
        this.fileManager.handleInputFileSelected({
          command: m.command,
          filePath: m.filePath ?? '',
        }),
      [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: (m) =>
        this.fileManager.handleGenericFileSelected({
          command: m.command,
          filePath: m.filePath ?? '',
        }),
      [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: (m) =>
        this.fileManager.handleGenericFileSelected({
          command: m.command,
          filePath: m.filePath ?? '',
        }),
      [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: (m) =>
        this.fileManager.handleGenericFileSelected({
          command: m.command,
          filePath: m.filePath ?? '',
        }),
      [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: (m) =>
        this.fileManager.handleGenericFileSelected({
          command: m.command,
          filePath: m.filePath ?? '',
        }),

      // Request file messages
      [MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE]: (m) =>
        this.fileManager.handleRequestInputFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE]: (m) =>
        this.fileManager.handleRequestFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE]: (m) =>
        this.fileManager.handleRequestFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE]: (m) =>
        this.fileManager.handleRequestFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE]: (m) =>
        this.fileManager.handleRequestEditedFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE]: (m) =>
        this.fileManager.handleRequestBaseFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES]: (m) =>
        this.fileManager.handleRequestDefaultOutputFiles(m),

      // Set files messages
      [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: (m) =>
        this.fileManager.handleSetMultipleFiles(m),
      [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: (m) =>
        this.fileManager.handleSetMultipleFiles(m),
      [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: (m) =>
        this.fileManager.handleSetMultipleFiles(m),
      [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: (m) =>
        this.fileManager.handleSetMultipleFiles(m),

      // Other file operation messages
      [MAIN_VIEW_COMMANDS.GET_CURRENT_FILE]: (m) =>
        this.fileManager.handleGetCurrentFile(m),
      [MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES]: () =>
        this.fileManager.handleRefreshAllFiles(),
      [MAIN_VIEW_COMMANDS.ADD_OPENED_FILES]: (m) =>
        this.fileManager.handleAddOpenedFiles(m.fileType),
      [MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES]: (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES]: (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES]: (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES]: (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES]: (m) =>
        this.fileManager.handleUpdateFiles(m),

      // Instruction messages (passthrough schema preserves all fields)
      [MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT]: (m) =>
        this.instructionManager.handlePolishInstructionText(m as any),
      [MAIN_VIEW_COMMANDS.TRANSCRIBE_INSTRUCTION]: () =>
        this.instructionManager.handleTranscribeInstruction(),
      [MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE]: (m) =>
        this.instructionManager.handleClipboardImage(m),

      // Recording messages
      [MAIN_VIEW_COMMANDS.START_RECORDING]: () =>
        this.recordingManager.start(webviewView),
      [MAIN_VIEW_COMMANDS.STOP_RECORDING]: () =>
        this.recordingManager.stop(webviewView),

      // API key messages
      [MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY]: () =>
        safeExecuteCommand('texra.setApiKey'),
      [MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY]: (m) => {
        if (m.provider) {
          return safeExecuteCommand('texra.setApiKey', [m.provider]);
        }
      },
      [MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL]: async (m) => {
        if (m.provider) {
          const url = PROVIDER_URLS[m.provider as keyof typeof PROVIDER_URLS];
          if (url) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
        }
      },
      [MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE]: async () => {
        await vscode.env.openExternal(
          vscode.Uri.parse(
            'https://texra.ai/guide/installation#setting-up-api-keys',
          ),
        );
      },

      // Banner messages
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
      [MAIN_VIEW_COMMANDS.UPDATE_DEPENDENCY_REMINDER_SETTING]: (m) =>
        updateConfig('ui.showDependencyReminders', m.value),
      [MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE]: (m) => {
        const cmd = getToolDocsCommand(m.tool);
        if (cmd) {
          const [command, ...args] = cmd.split(',');
          return safeExecuteCommand(command, args);
        }
      },
      [MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES]: async () => {
        const view = this.getActiveView();
        if (!view) {
          return;
        }
        const missingTools = await checkCoreDependencies(true);
        if (missingTools.length > 0) {
          view.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER,
            missingTools,
          });
        } else {
          view.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER,
          });
        }
      },
      [MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER]: (m) => this.postToActiveView(m),
      [MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER]: () =>
        this.postToActiveView({
          command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
        }),
      [MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER]: async () => {
        try {
          await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
          const authStatus = await getAuthStatus();
          if (authStatus.authenticated) {
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
      [MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER]: async () => {
        await updateConfig('ui.showLoginBanner', false);
        this.postToActiveView({
          command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
        });
      },

      // Git/diff messages
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

      // Housekeeping messages
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

      // Navigation messages
      [MAIN_VIEW_COMMANDS.SHOW_AGENT_HISTORY]: () =>
        this.handleShowAgentHistory(),
    };
  }

  private handleInfoMessage(message: { text: string }): void {
    vscode.window.showInformationMessage(message.text);
    this.logger.debug(this.channel, `Information message: ${message.text}`);
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

  private handleModelSelection(message: { model: string }): void {
    this.postToActiveView({
      command: MAIN_VIEW_COMMANDS.MODEL_SELECTED,
      model: message.model,
    });
  }

  /** Post message to active view if available */
  private postToActiveView(message: unknown): void {
    this.getActiveView()?.webview.postMessage(message);
  }

  private async handleShowAgentHistory(): Promise<void> {
    await safeExecuteCommand('texra.showAgentHistory', [], this.viewName);
  }

  protected async handleWebviewReady(): Promise<void> {
    const webviewView = this.getActiveView();
    if (!webviewView) {
      return;
    }
    await super.handleWebviewReady(undefined, webviewView);
    try {
      const [options, authStatus] = await Promise.all([
        loadOptions((error) => {
          this.logger.error(
            this.channel,
            `Failed to load options: ${toErrorMessage(error)}`,
          );
        }),
        getAuthStatus(),
      ]);
      if (!options) return;

      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        optionsData: options.modelOptions,
      });
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        optionsData: options.agentOptions,
      });

      // Show login banner if not authenticated and banner not dismissed
      const showBanner =
        !authStatus.authenticated &&
        getConfig<boolean>('ui.showLoginBanner', true);
      webviewView.webview.postMessage({
        command: showBanner
          ? MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER
          : MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
      });
    } catch (error) {
      this.logger.error(
        this.channel,
        `Failed to compute options: ${toErrorMessage(error)}`,
      );
    }
  }
}
