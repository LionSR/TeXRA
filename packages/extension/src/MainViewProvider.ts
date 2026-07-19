// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent

// Local imports - common

import { refresh, computeAgentOptionsData, getAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { hasAnyUsableSetupCredential } from '@commands/setup';
import { consumePendingState } from '@common/state';
import {
  BaseWebviewProvider,
  BundledViewContentProvider,
  getCombinedLocalResourceRoots,
  SIDEBAR_VIEWS,
  setActiveSidebarView,
} from '@common/webview';
import { EXTENSION_CATEGORIES, getFilterExtensions } from '@common/files';
import {
  planOnboardingFunnelTransition,
  type OnboardingFunnelState,
} from '@controllers/onboarding/onboardingFunnel';
import { appSignals } from '@eventBus/AppSignals';
import { agentDirectories } from '@frontend/agents';
import {
  isAgentCatalogAuthRefreshDeferred,
  runAfterAgentCatalogAuthRefresh,
} from '@frontend/auth/agentCatalogRefreshScope';
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import { loadMainViewModelOptions } from '@frontend/agents/optionsLoader';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { MainViewPersistedStateSchema } from '@shared/schemas';
import { agentKeyOf } from '@shared/schemas/agent';
import {
  readOnboardingFlags,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { watchConfig, DEBOUNCE_OPTIONS_MS } from '@utils/config';
import { debounce } from '@utils/core';

// Local file imports
import { MainViewMessageHandler } from './webview/MainViewMessageHandler';

import type { ProgressViewProvider } from './progressView/ProgressViewProvider';

export type SidebarMode = 'main' | 'progress';

export class MainViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'texra.mainView';
  protected messageHandler: MainViewMessageHandler;
  protected contentProvider: BundledViewContentProvider;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private agentWatcher: vscode.Disposable | undefined;

  private static commandsRegistered = false;

  private _activeMode: SidebarMode = 'main';
  private _messageDisposable?: vscode.Disposable;
  private _progressViewProvider?: ProgressViewProvider;
  private _progressContentProvider?: BundledViewContentProvider;

  /** Last computed funnel state, so credential hooks can detect the
   *  in-session State 0 → 1 transition. Session-scoped by design. */
  private onboardingFunnelState: OnboardingFunnelState | undefined;
  /** A State 1 entry observed with no view keeps its setup-agent selection
   *  pending until a launcher exists to receive it. */
  private pendingSetupAgentSelection = false;

  // Debounced refresh for agent option changes
  private debouncedRefreshAgentOptions = debounce(
    this.refreshAgentOptions.bind(this),
    DEBOUNCE_OPTIONS_MS,
  );

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.messageHandler = new MainViewMessageHandler(context, {
      refreshOnboardingFunnel: () => this.refreshOnboardingFunnel(),
    });
    this.contentProvider = new BundledViewContentProvider(
      context,
      'MainView',
      {
        dist: 'webview',
        bundleKey: 'mainViewBundleUri',
        styleKey: 'mainViewStyleUri',
      },
      'webview',
    );
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
    onTexraAuthSessionsChanged(this.context, () => {
      if (isAgentCatalogAuthRefreshDeferred()) {
        runAfterAgentCatalogAuthRefresh(async () => {
          await Promise.all([
            this.refreshModelOptions(),
            this.refreshOnboardingFunnel(),
          ]);
        });
        return;
      }
      void this.refreshOptionsAndView();
    });
    this.context.subscriptions.push({
      dispose: appSignals.on('includedModelAccessChanged', () => {
        void this.refreshOptionsAndView();
      }),
    });
  }

  /** Returns the sidebar webview, but only when in main mode. */
  private getMainModeView(): vscode.WebviewView | undefined {
    return this._activeMode === 'main' ? this.getWebviewView() : undefined;
  }

  /**
   * Refresh both agent and model options.
   * Called when auth state changes (login/logout affects both).
   */
  async refreshOptionsAndView() {
    await refresh();
    const view = this.getMainModeView();
    if (view) {
      await this.messageHandler.handleMessage(
        { command: MAIN_VIEW_COMMANDS.WEBVIEW_READY },
        view,
      );
      return;
    }
    await this.refreshOnboardingFunnel();
  }

  /**
   * Single derivation point for the onboarding funnel on this host (PRD:
   * agent-native onboarding). Recomputes the user-scoped funnel state,
   * pushes it to the webview when the main tab is visible, and acts on the
   * State 0 → 1 transition: clear a stale skip and select the setup agent.
   * It never auto-starts setup — the user launches it explicitly from the
   * setup card's "Run setup assistant" button (ONBOARDING_RUN_SETUP).
   * Invoked by the message handler on webview ready — which credential-changed
   * hooks replay via refreshOptionsAndView — and after welcome-card actions.
   */
  async refreshOnboardingFunnel(): Promise<void> {
    const view = this.getMainModeView();

    // Same usable-credential check the setup command uses: non-blank provider
    // key or server-side key access.
    const hasCredential = await hasAnyUsableSetupCredential().catch(
      () => false,
    );
    const transition = planOnboardingFunnelTransition(
      this.onboardingFunnelState,
      { hasCredential, ...readOnboardingFlags(this.context.globalState) },
    );
    this.onboardingFunnelState = transition.state;

    if (view) {
      view.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
        state: transition.state,
      });
    }

    if (transition.clearDeclined) {
      await setOnboardingDeclined(this.context.globalState, false);
    }
    // An off-view advance consumes the transition (previous latches to
    // 'setup'), so remember the selection until a view exists to receive it —
    // otherwise a credential arriving while the panel is hidden would leave
    // the dropdown on the old agent when the launcher reopens.
    if (transition.selectSetupAgent && !view) {
      this.pendingSetupAgentSelection = true;
    }
    if (
      view &&
      (transition.selectSetupAgent ||
        (this.pendingSetupAgentSelection && transition.state === 'setup'))
    ) {
      this.pendingSetupAgentSelection = false;
      // Resolve the qualified registry key so the dropdown matches by value;
      // the plain name still resolves by label if the registry isn't loaded.
      const entry = getAgent('setup', AgentCategory.ToolUse);
      view.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
        agentId: entry ? agentKeyOf(entry) : 'setup',
        sessionType: 'toolUse',
      });
    }
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

    const optionsDataByCategory = await loadMainViewModelOptions();
    view.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsData: optionsDataByCategory.workflow,
      optionsDataByCategory,
    });
  }

  private setupFileWatcher() {
    // Watch exactly the categories the launcher file lists are built from
    // (fileListingRules), including user-configured extension overrides, so
    // the watched set cannot drift from what the lists display.
    const extensions = new Set(
      EXTENSION_CATEGORIES.flatMap(getFilterExtensions),
    );
    const filePattern =
      extensions.size === 0 ? '**/*' : `**/*.{${[...extensions].join(',')}}`;
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
