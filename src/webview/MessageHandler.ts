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

// Local imports - agent

const CHANNEL = 'MessageHandler';

export class WebviewMessageHandler {
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
      showInformationMessage: (message) => this.handleInfoMessage(message),
      getTheme: (_m, view) => this.handleThemeRequest(view),
      getDebugMode: (_m, view) => this.handleDebugModeRequest(view),
      modelSelected: (message, view) =>
        this.handleModelSelection(message, view),
      execute: (message) => this.executionManager.handleExecute(message),
      merge: (message) => this.executionManager.handleMerge(message),
      compare: (message) => this.executionManager.handleCompare(message),
      acceptEdited: (message) =>
        this.executionManager.handleAcceptEdited(message),
      // File selection cases
      selectInputFile: (message, view) =>
        this.fileManager.handleFileSelection(message, view),
      selectReferenceFile: (message, view) =>
        this.fileManager.handleFileSelection(message, view),
      selectAuxiliaryFile: (message, view) =>
        this.fileManager.handleFileSelection(message, view),
      selectMediaFile: (message, view) =>
        this.fileManager.handleFileSelection(message, view),
      selectEditedFile: (_m, view) =>
        this.fileManager.handleEditedFileSelection(view),
      // File selected cases
      inputFileSelected: (message, view) =>
        this.fileManager.handleInputFileSelected(message, view),
      referenceFileSelected: (message) =>
        this.fileManager.handleGenericFileSelected(message),
      auxiliaryFileSelected: (message) =>
        this.fileManager.handleGenericFileSelected(message),
      mediaFileSelected: (message) =>
        this.fileManager.handleGenericFileSelected(message),
      editedFileSelected: (message) =>
        this.fileManager.handleGenericFileSelected(message),
      // Request file cases
      requestInputFile: (_m, view) =>
        this.fileManager.handleRequestInputFile(view),
      requestReferenceFile: (message, view) =>
        this.fileManager.handleRequestFile(message, view),
      requestAuxiliaryFile: (message, view) =>
        this.fileManager.handleRequestFile(message, view),
      requestMediaFile: (message, view) =>
        this.fileManager.handleRequestFile(message, view),
      requestEditedFile: (message, view) =>
        this.fileManager.handleRequestEditedFile(message, view),
      requestBaseFile: (_m, view) =>
        this.fileManager.handleRequestBaseFile(view),
      requestDefaultOutputFiles: (message, view) =>
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
      setInputFiles: (message, view) =>
        this.fileManager.handleSetMultipleFiles(message, view),
      setReferenceFiles: (message, view) =>
        this.fileManager.handleSetMultipleFiles(message, view),
      setAuxiliaryFiles: (message, view) =>
        this.fileManager.handleSetMultipleFiles(message, view),
      setMediaFiles: (message, view) =>
        this.fileManager.handleSetMultipleFiles(message, view),
      selectMultipleFiles: (message, view) =>
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
      getCurrentFile: (message, view) =>
        this.fileManager.handleGetCurrentFile(message, view),
      addOpenedFiles: (message, view) =>
        this.fileManager.handleAddOpenedFiles(message.fileType, view),
      polishInstructionText: (message, view) =>
        this.instructionManager.handlePolishInstructionText(message, view),
      transcribeInstruction: (_m, view) =>
        this.instructionManager.handleTranscribeInstruction(view),
      startRecording: (_m, view) => this.recordingManager.start(view),
      stopRecording: (_m, view) => this.recordingManager.stop(view),
      showAgentHistory: () => this.handleShowAgentHistory(),
      openSettings: () => this.settingsManager.openSettings(),
      openAgentSettings: () => this.settingsManager.openAgentSettings(),
      openModelSettings: () => this.settingsManager.openModelSettings(),
      clipboardImage: (message, view) =>
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
