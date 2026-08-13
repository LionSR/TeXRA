import * as vscode from 'vscode';

import { getAuthStatus } from '@commands/auth/authCommands';
import { BaseViewMessageHandler } from '@common/webview';
import { MainViewStartupController } from '@controllers/mainView/MainViewStartupController';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { RecordingManager } from '@frontend/media/RecordingManager';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { isDebugModeEnabled } from '@logger/logUtils';
import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchMainViewInbound,
  MainViewInboundHandlerRegistry,
} from '@shared/schemas';
import { getConfig } from '@utils/config/configUtils';

import { DiffManager } from './managers/DiffManager';
import { FileManager } from './managers/FileManager';
import { InstructionManager } from './managers/InstructionManager';
import { createBannerHandlers } from './slices/bannerSlice';
import { createChatHandlers } from './slices/chatSlice';
import { createCommonHandlers } from './slices/commonSlice';
import { createDocumentHandlers } from './slices/documentSlice';
import { createOnboardingHandlers } from './slices/onboardingSlice';
import { createSessionHandlers } from './slices/sessionSlice';
import type { MainViewInboundHost } from './mainViewInboundContext';

export class MainViewMessageHandler extends BaseViewMessageHandler {
  private readonly recordingManager: RecordingManager;
  private readonly fileManager: FileManager;
  private readonly diffManager: DiffManager;
  private readonly instructionManager: InstructionManager;
  private readonly startupController: MainViewStartupController;
  private readonly handlerRegistry: MainViewInboundHandlerRegistry;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly refreshOnboardingFunnel?: () => Promise<void>,
    /**
     * Invoked as soon as the launcher reports WEBVIEW_READY — the correct
     * moment to deliver queued STATE_RESTORE messages after an HTML swap.
     */
    private readonly onWebviewReady?: () => void,
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
      globalState: context.globalState,
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

  /**
   * Composed inbound registry. Domain slices live in ./slices/ (same shape as
   * the webview's frontend/slices/) and each own a subset of the inbound
   * commands; this method only binds them to the host context and spreads them.
   */
  private createHandlerRegistry(): MainViewInboundHandlerRegistry {
    const host: MainViewInboundHost = {
      viewName: this.viewName,
      channel: this.channel,
      logger: this.logger,
      context: this.context,
      refreshOnboardingFunnel: this.refreshOnboardingFunnel,
      fileManager: this.fileManager,
      diffManager: this.diffManager,
      instructionManager: this.instructionManager,
      recordingManager: this.recordingManager,
      runWithActiveView: (fn) => this.runWithActiveView(fn),
      getActiveView: () => this.getActiveView(),
      postToActiveView: (message) => this.postToActiveView(message),
      handleWebviewReady: () => this.handleWebviewReady(),
      handleThemeRequest: () => this.handleThemeRequest(),
      handleDebugModeRequest: () => this.handleDebugModeRequest(),
      refreshAfterCredentialChange: () => this.refreshAfterCredentialChange(),
    };
    return {
      ...createCommonHandlers(host),
      ...createBannerHandlers(host),
      ...createSessionHandlers(host),
      ...createDocumentHandlers(host),
      ...createChatHandlers(host),
      ...createOnboardingHandlers(host),
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
      this.refreshOnboardingFunnel?.(),
    ]);
  }

  protected async handleWebviewReady(): Promise<void> {
    const webviewView = this.getActiveView();
    if (!webviewView) {
      return;
    }
    this.logger.debug(this.channel, 'Webview ready signal received');
    // Flush queued restores only after the launcher document has installed its
    // message listener. Posting during switchMode's HTML swap can drop them.
    this.onWebviewReady?.();
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
    await this.refreshOnboardingFunnel?.();
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
