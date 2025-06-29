// Standard library imports
// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utils
import { safeExecuteCommand } from '@utils/system';
import { getConfig } from '@utils/config';

// Local imports - managers
import {
  SettingsManager,
  RecordingManager,
  FileManager,
  ExecutionManager,
  DiffManager,
  InstructionManager,
} from './managers';

// Import standardized commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

const CHANNEL = 'MainViewMessageHandler';

export class MainViewMessageHandler {
  private handlers: Record<
    string,
    (message: any, webviewView: vscode.WebviewView) => unknown
  >;
  private readonly settingsManager: SettingsManager;
  private readonly recordingManager: RecordingManager;
  private readonly fileManager: FileManager;
  private readonly executionManager: ExecutionManager;
  private readonly diffManager: DiffManager;
  private readonly instructionManager: InstructionManager;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.settingsManager = new SettingsManager();
    this.recordingManager = new RecordingManager(context);
    this.fileManager = new FileManager(context);
    this.executionManager = new ExecutionManager();
    this.diffManager = new DiffManager();
    this.instructionManager = new InstructionManager(context);
    this.handlers = {
      [MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]: (message) => this.handleInfoMessage(message),
      [MAIN_VIEW_COMMANDS.GET_THEME]: (_m, view) => this.handleThemeRequest(view),
      [MAIN_VIEW_COMMANDS.GET_DEBUG_MODE]: (_m, view) => this.handleDebugModeRequest(view),
      [MAIN_VIEW_COMMANDS.MODEL_SELECTED]: (message, view) =>
        this.handleModelSelection(message, view),
      [MAIN_VIEW_COMMANDS.EXECUTE]: (message) => this.executionManager.handleExecute(message),
      [MAIN_VIEW_COMMANDS.MERGE]: (message) => this.executionManager.handleMerge(message),
      [MAIN_VIEW_COMMANDS.COMPARE]: (message) => this.executionManager.handleCompare(message),
      acceptEdited: (message) =>
        this.executionManager.handleAcceptEdited(message),
      // File selection cases
      [MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE]: (message, view) =>
        this.fileManager.handleFileSelection(message, view),
      [MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE]: (message, view) =>
        this.fileManager.handleFileSelection(message, view),
      [MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE]: (message, view) =>
        this.fileManager.handleFileSelection(message, view),
      [MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE]: (message, view) =>
        this.fileManager.handleFileSelection(message, view),
      [MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE]: (_m, view) =>
        this.fileManager.handleEditedFileSelection(view),
      // File selected cases
      [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: (message, view) =>
        this.fileManager.handleInputFileSelected(message, view),
      [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: (message) =>
        this.fileManager.handleGenericFileSelected(message),
      [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: (message) =>
        this.fileManager.handleGenericFileSelected(message),
      [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: (message) =>
        this.fileManager.handleGenericFileSelected(message),
      [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: (message) =>
        this.fileManager.handleGenericFileSelected(message),
      // Request file cases
      [MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE]: (_m, view) =>
        this.fileManager.handleRequestInputFile(view),
      [MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE]: (message, view) =>
        this.fileManager.handleRequestFile(message, view),
      [MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE]: (message, view) =>
        this.fileManager.handleRequestFile(message, view),
      [MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE]: (message, view) =>
        this.fileManager.handleRequestFile(message, view),
      [MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE]: (message, view) =>
        this.fileManager.handleRequestEditedFile(message, view),
      [MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE]: (_m, view) =>
        this.fileManager.handleRequestBaseFile(view),
      [MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES]: (message, view) =>
        this.fileManager.handleRequestDefaultOutputFiles(message, view),
      // Handle file list updates from webview
      updateInputFiles: (message, view) =>
        this.fileManager.handleUpdateFiles(message, view),
      updateReferenceFiles: (message, view) =>
        this.fileManager.handleUpdateFiles(message, view),
      updateAuxiliaryFiles: (message, view) =>
        this.fileManager.handleUpdateFiles(message, view),
      updateMediaFiles: (message, view) =>
        this.fileManager.handleUpdateFiles(message, view),
      updateOutputFiles: (message, view) =>
        this.fileManager.handleUpdateFiles(message, view),
      // Multiple file selection cases
      [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: (message, view) =>
        this.fileManager.handleSetMultipleFiles(message, view),
      [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: (message, view) =>
        this.fileManager.handleSetMultipleFiles(message, view),
      [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: (message, view) =>
        this.fileManager.handleSetMultipleFiles(message, view),
      [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: (message, view) =>
        this.fileManager.handleSetMultipleFiles(message, view),
      [MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES]: (message, view) =>
        this.fileManager.handleSelectMultipleFiles(message, view),
      refreshAllFiles: (_m, view) =>
        this.fileManager.handleRefreshAllFiles(view),
      // Housekeeping cases
      cleanOutput: (message) =>
        this.executionManager.handleHousekeeping(message),
      cleanBuild: (message) =>
        this.executionManager.handleHousekeeping(message),
      indentTeX: (message) => this.executionManager.handleHousekeeping(message),
      packSingle: (message) =>
        this.executionManager.handleSingleOperation(message),
      cleanSingle: (message) =>
        this.executionManager.handleSingleOperation(message),
      packMultiple: (message) =>
        this.executionManager.handleMultipleOperation(message),
      cleanMultiple: (message) =>
        this.executionManager.handleMultipleOperation(message),
      // Latex diff cases
      latexdiff: (message) => this.diffManager.handleLatexdiff(message),
      latexdiffvc: (message) => this.diffManager.handleLatexdiffvc(message),
      requestRecentCommits: (_m, view) =>
        this.diffManager.handleRequestRecentCommits(view),
      refreshCommits: (_m, view) => this.diffManager.handleRefreshCommits(view),
      packLatexdiffvc: (message) =>
        this.diffManager.handleLatexdiffvcOperation(message),
      cleanLatexdiffvc: (message) =>
        this.diffManager.handleLatexdiffvcOperation(message),
      // VS Code logic cases
      [MAIN_VIEW_COMMANDS.GET_CURRENT_FILE]: (message, view) =>
        this.fileManager.handleGetCurrentFile(message, view),
      [MAIN_VIEW_COMMANDS.ADD_OPENED_FILES]: (message, view) =>
        this.fileManager.handleAddOpenedFiles(message.fileType, view),
      [MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT]: (message, view) =>
        this.instructionManager.handlePolishInstructionText(message, view),
      [MAIN_VIEW_COMMANDS.TRANSCRIBE_INSTRUCTION]: (_m, view) =>
        this.instructionManager.handleTranscribeInstruction(view),
      [MAIN_VIEW_COMMANDS.START_RECORDING]: (_m, view) => this.recordingManager.start(view),
      [MAIN_VIEW_COMMANDS.STOP_RECORDING]: (_m, view) => this.recordingManager.stop(view),
      [MAIN_VIEW_COMMANDS.SHOW_AGENT_HISTORY]: () => this.handleShowAgentHistory(),
      openSettings: () => this.settingsManager.openSettings(),
      [MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS]: () => this.settingsManager.openAgentSettings(),
      [MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS]: () => this.settingsManager.openModelSettings(),
      [MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE]: (message, view) =>
        this.instructionManager.handleClipboardImage(message, view),
    };
  }

  async handleMessage(message: any, webviewView: vscode.WebviewView) {
    logger.debug(CHANNEL, `Received message: ${message.command}`);

    const handler = this.handlers[message.command];
    if (handler) {
      return handler(message, webviewView);
    }
  }

  private async handleInfoMessage(message: any) {
    vscode.window.showInformationMessage(message.text);
    logger.debug(CHANNEL, `Information message: ${message.text}`);
  }

  private handleThemeRequest(webviewView: vscode.WebviewView) {
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? 'dark'
        : 'light';
    webviewView.webview.postMessage({ command: 'setTheme', theme });
  }

  private handleDebugModeRequest(webviewView: vscode.WebviewView) {
    const debugMode = getConfig<boolean>('logger.debugMode', false);
    webviewView.webview.postMessage({ command: 'setDebugMode', debugMode });
  }

  private handleModelSelection(message: any, webviewView: vscode.WebviewView) {
    if (message.model) {
      webviewView.webview.postMessage({
        command: 'modelSelected',
        model: message.model,
      });
    }
  }

  /**
   * Handle showing the agent history view
   */
  private async handleShowAgentHistory() {
    await safeExecuteCommand('texra.showAgentHistory', [], CHANNEL);
  }
}