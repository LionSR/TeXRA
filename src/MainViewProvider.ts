// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { refresh, computeAgentOptionsData } from '@agent/index';
import { getServerSideKeyService } from '@auth/serverKeys';

// Local imports - common
import {
  BaseWebviewProvider,
  getCombinedLocalResourceRoots,
  MAIN_VIEW_COMMANDS,
  SIDEBAR_VIEWS,
  setActiveSidebarView,
} from '@common/webview';
import { consumePendingState } from '@common/state';

import { agentDirectories } from '@frontend/agents';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { MainViewPersistedStateSchema } from '@shared/schemas';
import { watchConfig, DEBOUNCE_OPTIONS_MS } from '@utils/config';
import { debounce } from '@utils/core';

// Local file imports
import { MainViewMessageHandler } from './webview/MainViewMessageHandler';
import { MainViewContentProvider } from './webview/MainViewContentProvider';

import type { ProgressViewProvider } from './progressView/ProgressViewProvider';
import type { ProgressViewContentProvider } from './progressView/ProgressViewContentProvider';

export type SidebarMode = 'main' | 'progress';

export class MainViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'texra.mainView';
  protected messageHandler: MainViewMessageHandler;
  protected contentProvider: MainViewContentProvider;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private agentWatcher: vscode.Disposable | undefined;

  private static commandsRegistered = false;

  private _activeMode: SidebarMode = 'main';
  private _messageDisposable?: vscode.Disposable;
  private _progressViewProvider?: ProgressViewProvider;
  private _progressContentProvider?: ProgressViewContentProvider;

  // Debounced refresh for agent option changes
  private debouncedRefreshAgentOptions = debounce(
    this.refreshAgentOptions.bind(this),
    DEBOUNCE_OPTIONS_MS,
  );

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.messageHandler = new MainViewMessageHandler(context);
    this.contentProvider = new MainViewContentProvider(context);
    this.setupFileWatcher();
    this.setupAgentWatcher();
    this.setupConfigurationWatcher();
    this.setupAuthListener();
    this.registerCommandHandlers();
  }

  private registerCommandHandlers() {
    if (MainViewProvider.commandsRegistered) {
      return;
    }
    MainViewProvider.commandsRegistered = true;

    void vscode.commands.getCommands(true).then((commands) => {
      if (!commands.includes('texra.getWebviewView')) {
        this.context.subscriptions.push(
          vscode.commands.registerCommand('texra.getWebviewView', () => {
            return this.getMainModeView();
          }),
        );
      }
    });
  }

  private setupConfigurationWatcher() {
    watchConfig(this.context, ['texra.files'], this.refreshFiles.bind(this));
  }

  private setupAuthListener() {
    this.context.subscriptions.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === 'texra-supabase') {
          void this.refreshOptionsAndView();
        }
      }),
    );
    this.context.subscriptions.push(
      getServerSideKeyService().onDidChangeModelAccess(() => {
        void this.refreshOptionsAndView();
      }),
    );
  }

  /** Returns the sidebar webview, but only when in main mode. */
  private getMainModeView(): vscode.WebviewView | undefined {
    if (this._activeMode !== 'main') return undefined;
    return this._view as vscode.WebviewView | undefined;
  }

  /**
   * Refresh both agent and model options.
   * Called when auth state changes (login/logout affects both).
   */
  async refreshOptionsAndView() {
    const view = this.getMainModeView();
    if (!view) return;

    await refresh();
    await this.messageHandler.handleMessage(
      { command: MAIN_VIEW_COMMANDS.WEBVIEW_READY },
      view,
    );
  }

  /**
   * Refresh agent options only.
   * Called when agent visibility changes.
   */
  async refreshAgentOptions() {
    const view = this.getMainModeView();
    if (!view) return;

    await refresh();
    const optionsData = await computeAgentOptionsData();
    view.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      optionsData,
    });
  }

  /**
   * Refresh model options only.
   * Called via texra.refreshAllOptions when model selection changes in Settings View.
   */
  async refreshModelOptions() {
    const view = this.getMainModeView();
    if (!view) return;

    const optionsData = await computeModelOptionsData();
    view.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsData,
    });
  }

  private setupFileWatcher() {
    const filePattern =
      '**/*.{tex,txt,md,cls,png,pdf,jpeg,jpg,svg,gif,heic,heif,webp,wav,mp3,m4a,aiff,aac,ogg,flac}';
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(filePattern);
    this.fileWatcher.onDidCreate(this.refreshFiles.bind(this));
    this.fileWatcher.onDidDelete(this.refreshFiles.bind(this));
    this.context.subscriptions.push(this.fileWatcher);
  }

  private setupAgentWatcher() {
    this.agentWatcher = agentDirectories.watchAgentDirectories({
      pattern: '**/*.yaml',
      onEvent: () => this.debouncedRefreshAgentOptions(),
    });

    this.context.subscriptions.push(this.agentWatcher);
  }

  private async refreshFiles() {
    const view = this.getMainModeView();
    if (!view) return;

    await this.messageHandler.handleMessage(
      { command: MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES },
      view,
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: getCombinedLocalResourceRoots(this.context, [
        'webview',
        'progressView',
      ]),
    };

    this.cleanupView();
    this._view = webviewView;

    webviewView.webview.html = this.contentProvider.getHtmlContent(
      webviewView.webview,
    );

    this._messageDisposable = webviewView.webview.onDidReceiveMessage(
      (message) => this.messageHandler.handleMessage(message, webviewView),
    );

    this._viewDisposables.push(
      webviewView.onDidDispose(this.cleanupView.bind(this)),
    );

    this.setupInitialState(webviewView);
  }

  protected override cleanupView(): void {
    this._messageDisposable?.dispose();
    this._messageDisposable = undefined;
    if (this._activeMode === 'progress') {
      this._progressViewProvider?.resetSidebarReady();
      void setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
    }
    this._activeMode = 'main';
    super.cleanupView();
  }

  private async setupInitialState(webviewView: vscode.WebviewView) {
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    });

    let pendingData = consumePendingState();
    while (pendingData) {
      const parsed = MainViewPersistedStateSchema.safeParse(pendingData.state);
      if (!parsed.success) {
        console.warn('Invalid pending state restore payload', parsed.error);
        pendingData = consumePendingState();
        continue;
      }
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state: parsed.data,
        executeImmediately: pendingData.executeImmediately,
      });
      pendingData = consumePendingState();
    }
  }

  // --- Mode switching ---

  public setProgressViewProvider(pvp: ProgressViewProvider): void {
    this._progressViewProvider = pvp;
    this._progressContentProvider = pvp.getContentProvider();
  }

  public getActiveMode(): SidebarMode {
    return this._activeMode;
  }

  public getWebviewView(): vscode.WebviewView | undefined {
    return this._view as vscode.WebviewView | undefined;
  }

  /**
   * Switch the single sidebar view between 'main' (launcher) and 'progress' content.
   * Swaps HTML and message listener so both bundles share one VS Code view slot.
   */
  public async switchMode(mode: SidebarMode): Promise<void> {
    const webviewView = this.getWebviewView();
    if (!webviewView || mode === this._activeMode) return;

    // Guard provider availability before mutating any state.
    if (
      mode === 'progress' &&
      (!this._progressContentProvider || !this._progressViewProvider)
    ) {
      return;
    }

    this._activeMode = mode;
    await setActiveSidebarView(
      mode === 'progress' ? SIDEBAR_VIEWS.PROGRESS : SIDEBAR_VIEWS.MAIN,
    );

    // A concurrent switchMode call may have changed _activeMode while we awaited.
    // Bail out so the newer call's HTML/listener wins.
    if (this._activeMode !== mode) return;

    this._messageDisposable?.dispose();
    this._messageDisposable = undefined;

    if (mode === 'progress') {
      webviewView.webview.html = this._progressContentProvider!.getHtmlContent(
        webviewView.webview,
      );
      const pvp = this._progressViewProvider!;
      this._messageDisposable = webviewView.webview.onDidReceiveMessage(
        (message) => pvp.handleSidebarMessage(message, webviewView),
      );
    } else {
      this._progressViewProvider?.resetSidebarReady();
      webviewView.webview.html = this.contentProvider.getHtmlContent(
        webviewView.webview,
      );
      this._messageDisposable = webviewView.webview.onDidReceiveMessage(
        (message) => this.messageHandler.handleMessage(message, webviewView),
      );
    }
  }

  public async showInSidebar(): Promise<void> {
    await this.switchMode('main');
    await vscode.commands.executeCommand('texra.mainView.focus');
  }
}
