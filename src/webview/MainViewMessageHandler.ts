// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { computeAgentOptions } from '@agent/index';
import { toErrorMessage } from '@common/errors';

// Local imports - webview
import { BaseViewMessageHandler, MessageHandler } from '@common/webview';
// @ts-ignore - Import JavaScript module
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { agentDirectories } from '@frontend/agents';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { computeModelOptions } from '@model/computeModelOptions';
import { getConfig, setConfig } from '@utils/config';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { checkCoreDependencies, getToolDocsCommand } from '@utils/system';
import { SETTINGS_QUERY } from '@utils/config';
import { AUTH_COMMANDS, getAuthStatus } from '@commands/auth';
import { PROVIDER_URLS } from '@commands/api/apiKeyCommands';

// Local file imports
import {
  SettingsManager,
  RecordingManager,
  FileManager,
  ExecutionManager,
  DiffManager,
  InstructionManager,
} from './managers';

export class MainViewMessageHandler extends BaseViewMessageHandler {
  private readonly settingsManager: SettingsManager;
  private readonly recordingManager: RecordingManager;
  private readonly fileManager: FileManager;
  private readonly executionManager: ExecutionManager;
  private readonly diffManager: DiffManager;
  private readonly instructionManager: InstructionManager;

  constructor(context: vscode.ExtensionContext) {
    super('MainView', { trackActiveView: true });
    this.settingsManager = new SettingsManager();
    this.recordingManager = new RecordingManager(context, {
      recordingStartedCommand: MAIN_VIEW_COMMANDS.RECORDING_STARTED,
      recordingStoppedCommand: MAIN_VIEW_COMMANDS.RECORDING_STOPPED,
      recordingErrorCommand: MAIN_VIEW_COMMANDS.RECORDING_ERROR,
      transcriptionCommand: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED,
      progressTitle: 'Transcribing instruction',
    });
    this.fileManager = new FileManager(context);
    this.executionManager = new ExecutionManager();
    this.diffManager = new DiffManager();
    this.instructionManager = new InstructionManager(context);
  }

  public override async handleMessage(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    // Attach webview to managers that need it for message posting
    this.fileManager.attachWebview(webviewView);
    this.instructionManager.attachWebview(webviewView);

    // Base class handles activeView tracking when trackActiveView is enabled
    await super.handleMessage(message, webviewView);
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
      [MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE]: async (m) =>
        this.fileManager.handleFileSelection(m),
      [MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE]: async (m) =>
        this.fileManager.handleFileSelection(m),
      [MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE]: async (m) =>
        this.fileManager.handleFileSelection(m),
      [MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE]: async (m) =>
        this.fileManager.handleFileSelection(m),
      [MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE]: async () =>
        this.fileManager.handleEditedFileSelection(),

      // File selected commands
      [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: async (m) =>
        this.fileManager.handleInputFileSelected(m),
      [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: async (m) =>
        this.fileManager.handleGenericFileSelected(m),
      [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: async (m) =>
        this.fileManager.handleGenericFileSelected(m),
      [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: async (m) =>
        this.fileManager.handleGenericFileSelected(m),
      [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: async (m) =>
        this.fileManager.handleGenericFileSelected(m),

      // Request file commands
      [MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE]: async (m) =>
        this.fileManager.handleRequestInputFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE]: async (m) =>
        this.fileManager.handleRequestFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE]: async (m) =>
        this.fileManager.handleRequestFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE]: async (m) =>
        this.fileManager.handleRequestFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE]: async (m) =>
        this.fileManager.handleRequestEditedFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE]: async (m) =>
        this.fileManager.handleRequestBaseFile(m),
      [MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES]: async (m) =>
        this.fileManager.handleRequestDefaultOutputFiles(m),

      // Multiple file operations
      [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: async (m) =>
        this.fileManager.handleSetMultipleFiles(m),
      [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: async (m) =>
        this.fileManager.handleSetMultipleFiles(m),
      [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: async (m) =>
        this.fileManager.handleSetMultipleFiles(m),
      [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: async (m) =>
        this.fileManager.handleSetMultipleFiles(m),
      [MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES]: async (m) =>
        this.fileManager.handleSelectMultipleFiles(m),

      // Other file operations
      [MAIN_VIEW_COMMANDS.GET_CURRENT_FILE]: async (m) =>
        this.fileManager.handleGetCurrentFile(m),
      [MAIN_VIEW_COMMANDS.ADD_OPENED_FILES]: async (m) =>
        this.fileManager.handleAddOpenedFiles(m.fileType),

      // Execution commands
      [MAIN_VIEW_COMMANDS.MERGE]: async (m) =>
        this.executionManager.handleMerge(m),
      [MAIN_VIEW_COMMANDS.COMPARE]: async (m) =>
        this.executionManager.handleCompare(m),

      // Settings commands
      [MAIN_VIEW_COMMANDS.SETTINGS_OPEN]: async () =>
        this.settingsManager.openSettings(),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS]: async (m) => {
        const query =
          m?.sessionType === 'toolUse'
            ? SETTINGS_QUERY.TOOL_USE_AGENTS
            : SETTINGS_QUERY.WORKFLOW_AGENTS;
        return this.settingsManager.openSettings(query);
      },
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
      [MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT]: async (m) =>
        this.instructionManager.handlePolishInstructionText(m),
      [MAIN_VIEW_COMMANDS.TRANSCRIBE_INSTRUCTION]: async () =>
        this.instructionManager.handleTranscribeInstruction(),
      [MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE]: async (m) =>
        this.instructionManager.handleClipboardImage(m),
      [MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY]: async () =>
        safeExecuteCommand('texra.setApiKey'),
      [MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY]: async (m) => {
        // Reuse existing setApiKey command with provider parameter
        if (m?.provider) {
          await safeExecuteCommand('texra.setApiKey', [m.provider]);
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
      [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: async (m) => {
        /* Banner handled client-side */
        const view = this.getActiveView();
        view?.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: async (m) => {
        /* Banner handled client-side */
        const view = this.getActiveView();
        view?.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER]: async (m) => {
        /* Banner handled client-side */
        const view = this.getActiveView();
        view?.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER]: async (m) => {
        /* Banner handled client-side */
        const view = this.getActiveView();
        view?.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER]: async (m) => {
        /* Banner handled client-side */
        const view = this.getActiveView();
        view?.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER]: async (m) => {
        /* Banner handled client-side */
        const view = this.getActiveView();
        view?.webview.postMessage(m);
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
      [MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER]: async (m) => {
        /* Banner handled client-side */
        const view = this.getActiveView();
        view?.webview.postMessage(m);
      },
      [MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER]: async () => {
        /* Banner handled client-side */
        const view = this.getActiveView();
        view?.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
        });
      },
      [MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER]: async () => {
        try {
          await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
          // Only hide banner if sign-in was successful
          const authStatus = await getAuthStatus();
          if (authStatus.authenticated) {
            const view = this.getActiveView();
            view?.webview.postMessage({
              command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
            });
          }
        } catch (error) {
          // Sign-in was cancelled or failed - banner remains visible
          this.logger.debug(
            this.channel,
            `Sign-in from banner failed: ${toErrorMessage(error)}`,
          );
        }
      },
      [MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER]: async () => {
        // Save dismissal preference
        await setConfig('ui.showLoginBanner', false);
        const view = this.getActiveView();
        view?.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
        });
      },

      // Recording commands
      [MAIN_VIEW_COMMANDS.START_RECORDING]: async (_m, w) =>
        this.recordingManager.start(w),
      [MAIN_VIEW_COMMANDS.STOP_RECORDING]: async (_m, w) =>
        this.recordingManager.stop(w),

      // File refresh and update operations
      [MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES]: async () =>
        this.fileManager.handleRefreshAllFiles(),
      [MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES]: async (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES]: async (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES]: async (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES]: async (m) =>
        this.fileManager.handleUpdateFiles(m),
      [MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES]: async (m) =>
        this.fileManager.handleUpdateFiles(m),

      // Git/diff operations
      [MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS]: async (m) => {
        const view = this.getActiveView();
        if (!view) {
          return;
        }
        await this.diffManager.handleRequestRecentCommits(m, view);
      },
      [MAIN_VIEW_COMMANDS.REFRESH_COMMITS]: async () => {
        const view = this.getActiveView();
        if (!view) {
          return;
        }
        await this.diffManager.handleRefreshCommits(view);
      },
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
  private async handleInfoMessage(message: any): Promise<void> {
    vscode.window.showInformationMessage(message.text);
    this.logger.debug(this.channel, `Information message: ${message.text}`);
  }

  private async handleThemeRequest(_message: unknown): Promise<void> {
    const webviewView = this.getActiveView();
    if (!webviewView) {
      return;
    }
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? 'dark'
        : 'light';
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.THEME_SET,
      theme,
    });
  }

  private async handleDebugModeRequest(_message: unknown): Promise<void> {
    const webviewView = this.getActiveView();
    if (!webviewView) {
      return;
    }
    const debugMode = getConfig<boolean>('texra.logger.debugMode', false);
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.DEBUG_MODE_SET,
      debugMode,
    });
  }

  private async handleModelSelection(message: any): Promise<void> {
    const webviewView = this.getActiveView();
    if (!webviewView) {
      return;
    }
    if (message.model) {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.MODEL_SELECTED,
        model: message.model,
      });
    }
  }

  private async handleShowAgentHistory(_message: unknown): Promise<void> {
    await safeExecuteCommand('texra.showAgentHistory', [], this.viewName);
  }

  protected async handleWebviewReady(_message: any): Promise<void> {
    const webviewView = this.getActiveView();
    if (!webviewView) {
      return;
    }
    await super.handleWebviewReady(_message, webviewView);
    try {
      // computeModelOptions checks canUseServerSideKeys() and sets data-requires-key
      // accordingly. The webview's _applyModelOptions then calls updateModelApiKeyBanner()
      // which shows/hides the banner based on the selected model's data-requires-key.
      // No separate banner message needed here - webview handles it.
      const modelOptions = await computeModelOptions();
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        options: modelOptions,
      });

      const agentOptions = await computeAgentOptions();
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        options: agentOptions,
      });

      // Check if user is authenticated and show/hide login banner accordingly
      const showLoginBanner = getConfig<boolean>('ui.showLoginBanner', true);
      const authStatus = await getAuthStatus();
      if (showLoginBanner && !authStatus.authenticated) {
        webviewView.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER,
        });
      } else if (authStatus.authenticated) {
        // Hide banner if user signed in through other means (account menu, etc.)
        webviewView.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
        });
      }
    } catch (error) {
      this.logger.error(
        this.channel,
        `Failed to compute options: ${toErrorMessage(error)}`,
      );
    }
  }
}
