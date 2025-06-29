import * as vscode from 'vscode';
import { safeExecuteCommand } from '@utils/system';
import { getConfig } from '@utils/config';
import { BaseViewMessageHandler, MessageHandler } from '@common/webview/BaseViewMessageHandler';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
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

  constructor(private readonly context: vscode.ExtensionContext) {
    super('MainView');
    this.settingsManager = new SettingsManager();
    this.recordingManager = new RecordingManager(context);
    this.fileManager = new FileManager(context);
    this.executionManager = new ExecutionManager();
    this.diffManager = new DiffManager();
    this.instructionManager = new InstructionManager(context);
  }

  protected createHandlers(): Record<string, MessageHandler> {
    return {
      // Common handlers
      [MAIN_VIEW_COMMANDS.THEME_SET]: this.handleTheme.bind(this),
      [MAIN_VIEW_COMMANDS.DEBUG_MODE_SET]: this.handleDebugMode.bind(this),
      [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: this.handleWebviewReady.bind(this),
      
      // Core functionality
      [MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]: this.handleInfoMessage.bind(this),
      [MAIN_VIEW_COMMANDS.GET_THEME]: this.handleThemeRequest.bind(this),
      [MAIN_VIEW_COMMANDS.GET_DEBUG_MODE]: this.handleDebugModeRequest.bind(this),
      [MAIN_VIEW_COMMANDS.MODEL_SELECTED]: this.handleModelSelection.bind(this),
      [MAIN_VIEW_COMMANDS.EXECUTE]: this.handleExecute.bind(this),
      [MAIN_VIEW_COMMANDS.SHOW_AGENT_HISTORY]: this.handleShowAgentHistory.bind(this),
      
      // Delegate to managers for specific functionality
      // File operations will be handled by managers
    };
  }

  // Implement handler methods
  private async handleInfoMessage(message: any, webviewView: vscode.WebviewView): Promise<void> {
    vscode.window.showInformationMessage(message.text);
    this.logger.debug(`Information message: ${message.text}`);
  }

  private async handleThemeRequest(message: any, webviewView: vscode.WebviewView): Promise<void> {
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? 'dark'
        : 'light';
    webviewView.webview.postMessage({ command: 'setTheme', theme });
  }

  private async handleDebugModeRequest(message: any, webviewView: vscode.WebviewView): Promise<void> {
    const debugMode = getConfig<boolean>('logger.debugMode', false);
    webviewView.webview.postMessage({ command: 'setDebugMode', debugMode });
  }

  private async handleModelSelection(message: any, webviewView: vscode.WebviewView): Promise<void> {
    if (message.model) {
      webviewView.webview.postMessage({
        command: 'modelSelected',
        model: message.model,
      });
    }
  }

  private async handleExecute(message: any, webviewView: vscode.WebviewView): Promise<void> {
    return this.executionManager.handleExecute(message);
  }

  private async handleShowAgentHistory(message: any, webviewView: vscode.WebviewView): Promise<void> {
    await safeExecuteCommand('texra.showAgentHistory', [], this.viewName);
  }
}