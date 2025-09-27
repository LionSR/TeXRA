// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import {
  SettingsManager,
  RecordingManager,
  FileManager,
  ExecutionManager,
  DiffManager,
  InstructionManager,
} from './managers';
import {
  BaseViewMessageHandler,
  MessageHandler,
} from '@common/webview/BaseViewMessageHandler';

// @ts-ignore - Import JavaScript module
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { getConfig, setConfig } from '@utils/config';
import {
  safeExecuteCommand,
  checkCoreDependencies,
  getToolDocsCommand,
} from '@utils/system';
import { SETTINGS_QUERY } from '@utils/settingsQueries';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { SecretManager } from '@frontend/secretManager';
import { computeModelOptions } from '@model/computeModelOptions';
import { computeAgentOptions } from '@agent/computeAgentOptions';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { PROVIDER_URLS } from '@commands/api/apiKeyCommands';

export class MainViewMessageHandler extends BaseViewMessageHandler {
  private readonly settingsManager: SettingsManager;
  private readonly recordingManager: RecordingManager;
  private readonly fileManager: FileManager;
  private readonly executionManager: ExecutionManager;
  private readonly diffManager: DiffManager;
  private readonly instructionManager: InstructionManager;

  constructor(private readonly context: vscode.ExtensionContext) {
    super('MainView');
    this.settingsManager = new SettingsManager();
    this.recordingManager = new RecordingManager(context);
    this.fileManager = new FileManager(context);
    this.executionManager = new ExecutionManager();
    this.diffManager = new DiffManager();
    this.instructionManager = new InstructionManager(context);
  }

  protected createHandlers(): Record<
    string,
    MessageHandler<vscode.WebviewView>
  > {
    return {
      // Common handlers
      [MAIN_VIEW_COMMANDS.THEME_SET]: this.handleTheme.bind(this),
      [MAIN_VIEW_COMMANDS.DEBUG_MODE_SET]: this.handleDebugMode.bind(this),
      [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: this.handleWebviewReady.bind(this),

      // Core functionality
      [MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]:
        this.handleInfoMessage.bind(this),
      [MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION]: async (m) =>
        showInstructionWithSuppress(m.key, m.text),
      [MAIN_VIEW_COMMANDS.GET_THEME]: this.handleThemeRequest.bind(this),
      [MAIN_VIEW_COMMANDS.GET_DEBUG_MODE]:
        this.handleDebugModeRequest.bind(this),
      [MAIN_VIEW_COMMANDS.MODEL_SELECTED]: this.handleModelSelection.bind(this),
      [MAIN_VIEW_COMMANDS.EXECUTE]: async (m) =>
        this.executionManager.handleExecute(m),
      [MAIN_VIEW_COMMANDS.SHOW_AGENT_HISTORY]:
        this.handleShowAgentHistory.bind(this),

      // Delegate to managers for specific functionality
      // File selection commands
      [MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE]: async (m, w) =>
        this.fileManager.handleFileSelection(m, w),
      [MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE]: async (m, w) =>
        this.fileManager.handleFileSelection(m, w),
      [MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE]: async (m, w) =>
        this.fileManager.handleFileSelection(m, w),
      [MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE]: async (m, w) =>
        this.fileManager.handleFileSelection(m, w),
      [MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE]: async (_m, w) =>
        this.fileManager.handleEditedFileSelection(w),

      // File selected commands
      [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: async (m, w) =>
        this.fileManager.handleInputFileSelected(m, w),
      [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: async (m) =>
        this.fileManager.handleGenericFileSelected(m),
      [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: async (m) =>
        this.fileManager.handleGenericFileSelected(m),
      [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: async (m) =>
        this.fileManager.handleGenericFileSelected(m),
      [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: async (m) =>
        this.fileManager.handleGenericFileSelected(m),

      // Request file commands
      [MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE]: async (_m, w) =>
        this.fileManager.handleRequestInputFile(w),
      [MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE]: async (m, w) =>
        this.fileManager.handleRequestFile(m, w),
      [MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE]: async (m, w) =>
        this.fileManager.handleRequestFile(m, w),
      [MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE]: async (m, w) =>
        this.fileManager.handleRequestFile(m, w),
      [MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE]: async (m, w) =>
        this.fileManager.handleRequestEditedFile(m, w),
      [MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE]: async (_m, w) =>
        this.fileManager.handleRequestBaseFile(w),
      [MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES]: async (m, w) =>
        this.fileManager.handleRequestDefaultOutputFiles(m, w),

      // Multiple file operations
      [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: async (m, w) =>
        this.fileManager.handleSetMultipleFiles(m, w),
      [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: async (m, w) =>
        this.fileManager.handleSetMultipleFiles(m, w),
      [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: async (m, w) =>
        this.fileManager.handleSetMultipleFiles(m, w),
      [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: async (m, w) =>
        this.fileManager.handleSetMultipleFiles(m, w),
      [MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES]: async (m, w) =>
        this.fileManager.handleSelectMultipleFiles(m, w),

      // Other file operations
      [MAIN_VIEW_COMMANDS.GET_CURRENT_FILE]: async (m, w) =>
        this.fileManager.handleGetCurrentFile(m, w),
      [MAIN_VIEW_COMMANDS.ADD_OPENED_FILES]: async (m, w) =>
        this.fileManager.handleAddOpenedFiles(m.fileType, w),

      // Execution commands
      [MAIN_VIEW_COMMANDS.MERGE]: async (m) =>
        this.executionManager.handleMerge(m),
      [MAIN_VIEW_COMMANDS.COMPARE]: async (m) =>
        this.executionManager.handleCompare(m),

      // Settings commands
      [MAIN_VIEW_COMMANDS.SETTINGS_OPEN]: async () =>
        this.settingsManager.openSettings(),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS]: async () =>
        this.settingsManager.openSettings(SETTINGS_QUERY.AGENTS),
      [MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS]: async () =>
        this.settingsManager.openSettings(SETTINGS_QUERY.MODELS),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY]: async (m) => {
        if (m?.customDirSet) {
          const dir = await agentDirectories.custom();
          if (dir) {
            await vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(dir),
            );
          }
        } else {
          await safeExecuteCommand(
            'workbench.action.openSettings',
            [SETTINGS_QUERY.AGENT_DIRECTORY],
            this.viewName,
          );
        }
      },
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS]: async () =>
        safeExecuteCommand('texra.openDoc', ['agent-explorer'], this.viewName),
      [MAIN_VIEW_COMMANDS.OPEN_INSTALLATION_DOCS]: async () =>
        safeExecuteCommand('texra.openDoc', ['installation'], this.viewName),

      // Instruction commands
      [MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT]: async (m, w) =>
        this.instructionManager.handlePolishInstructionText(m, w),
      [MAIN_VIEW_COMMANDS.TRANSCRIBE_INSTRUCTION]: async (_m, w) =>
        this.instructionManager.handleTranscribeInstruction(w),
      [MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE]: async (m, w) =>
        this.instructionManager.handleClipboardImage(m, w),
      [MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY]: async () =>
        safeExecuteCommand('texra.setApiKey'),
      [MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY]: async (m) => {
        // Reuse existing setApiKey command with provider parameter
        if (m?.provider) {
          await safeExecuteCommand('texra.setApiKey', m.provider);
        }
      },
      [MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL]: async (m) => {
        // Open provider-specific API key page
        if (m?.provider) {
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
      [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: async (m, w) => {
        /* Banner handled client-side */
        w.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: async (m, w) => {
        /* Banner handled client-side */
        w.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER]: async (m, w) => {
        /* Banner handled client-side */
        w.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER]: async (m, w) => {
        /* Banner handled client-side */
        w.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER]: async (m, w) => {
        /* Banner handled client-side */
        w.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER]: async (m, w) => {
        /* Banner handled client-side */
        w.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.UPDATE_DEPENDENCY_REMINDER_SETTING]: async (m) => {
        await setConfig('ui.showDependencyReminders', m.value);
      },
      [MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE]: async (m) => {
        const cmd = getToolDocsCommand(m.tool);
        if (cmd) {
          const [command, ...args] = cmd.split(',');
          await safeExecuteCommand(command, args);
        }
      },
      [MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES]: async (_m, w) => {
        const missingTools = await checkCoreDependencies(true);
        if (missingTools.length > 0) {
          w.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER,
            missingTools,
          });
        } else {
          w.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER,
          });
        }
      },

      // Recording commands
      [MAIN_VIEW_COMMANDS.START_RECORDING]: async (_m, w) =>
        this.recordingManager.start(w),
      [MAIN_VIEW_COMMANDS.STOP_RECORDING]: async (_m, w) =>
        this.recordingManager.stop(w),

      // File refresh and update operations
      [MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES]: async (_m, w) =>
        this.fileManager.handleRefreshAllFiles(w),
      [MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES]: async (m, w) =>
        this.fileManager.handleUpdateFiles(m, w),
      [MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES]: async (m, w) =>
        this.fileManager.handleUpdateFiles(m, w),
      [MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES]: async (m, w) =>
        this.fileManager.handleUpdateFiles(m, w),
      [MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES]: async (m, w) =>
        this.fileManager.handleUpdateFiles(m, w),
      [MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES]: async (m, w) =>
        this.fileManager.handleUpdateFiles(m, w),

      // Git/diff operations
      [MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS]: async (_m, w) =>
        this.diffManager.handleRequestRecentCommits(w),
      [MAIN_VIEW_COMMANDS.REFRESH_COMMITS]: async (_m, w) =>
        this.diffManager.handleRefreshCommits(w),
      [MAIN_VIEW_COMMANDS.LATEXDIFF]: async (m) =>
        this.diffManager.handleLatexdiff(m),
      [MAIN_VIEW_COMMANDS.LATEXDIFFVC]: async (m) =>
        this.diffManager.handleLatexdiffvc(m),
      [MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC]: async (m) =>
        this.diffManager.handleLatexdiffvcOperation(m),
      [MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC]: async (m) =>
        this.diffManager.handleLatexdiffvcOperation(m),

      // Housekeeping operations
      [MAIN_VIEW_COMMANDS.CLEAN_OUTPUT]: async (m) =>
        this.executionManager.handleHousekeeping(m),
      [MAIN_VIEW_COMMANDS.CLEAN_BUILD]: async (m) =>
        this.executionManager.handleHousekeeping(m),
      [MAIN_VIEW_COMMANDS.INDENT_TEX]: async (m) =>
        this.executionManager.handleHousekeeping(m),
      [MAIN_VIEW_COMMANDS.PACK_SINGLE]: async (m) =>
        this.executionManager.handleSingleOperation(m),
      [MAIN_VIEW_COMMANDS.CLEAN_SINGLE]: async (m) =>
        this.executionManager.handleSingleOperation(m),
      [MAIN_VIEW_COMMANDS.PACK_MULTIPLE]: async (m) =>
        this.executionManager.handleMultipleOperation(m),
      [MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE]: async (m) =>
        this.executionManager.handleMultipleOperation(m),

      // Other operations
      [MAIN_VIEW_COMMANDS.ACCEPT_EDITED]: async (m) =>
        this.executionManager.handleAcceptEdited(m),
    };
  }

  // Implement handler methods
  private async handleInfoMessage(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    vscode.window.showInformationMessage(message.text);
    this.logger.debug(`Information message: ${message.text}`);
  }

  private async handleThemeRequest(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? 'dark'
        : 'light';
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.THEME_SET,
      theme,
    });
  }

  private async handleDebugModeRequest(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const debugMode = getConfig<boolean>('logger.debugMode', false);
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.DEBUG_MODE_SET,
      debugMode,
    });
  }

  private async handleModelSelection(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    if (message.model) {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.MODEL_SELECTED,
        model: message.model,
      });
    }
  }

  private async handleShowAgentHistory(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await safeExecuteCommand('texra.showAgentHistory', [], this.viewName);
  }

  protected async handleWebviewReady(
    _message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await super.handleWebviewReady(_message, webviewView);
    try {
      const modelOptions = await computeModelOptions();
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        options: modelOptions,
      });

      const showReminders = getConfig<boolean>('ui.showApiKeyReminders', true);
      if (showReminders) {
        const hasAnyApiKey = await SecretManager.anyApiKeyExists();
        if (!hasAnyApiKey) {
          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER,
          });
        }
      }

      const agentOptions = await computeAgentOptions(this.context);
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        options: agentOptions,
      });
    } catch (error) {
      this.logger.error(
        this.channel,
        `Failed to compute options: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
