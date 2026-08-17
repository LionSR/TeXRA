// Third-party imports
import PQueue from 'p-queue';
import * as vscode from 'vscode';

// Local imports
import { refresh, computeAgentOptionsData, getAgent } from '@agent/index';
import { hasAnyUsableSetupCredential } from '@commands/setup/setupAssistantCommand';
import { consumePendingState } from '@common/state';
import {
  BaseWebviewProvider,
  BundledViewContentProvider,
  getActiveSidebarView,
  getCombinedLocalResourceRoots,
  SIDEBAR_VIEWS,
  setActiveSidebarView,
  type SidebarView,
} from '@common/webview';
import {
  EXTENSION_CATEGORIES,
  getFilterExtensions,
} from '@common/files/fileTypeUtils';
import {
  planOnboardingFunnelTransition,
  type OnboardingFunnelState,
} from '@controllers/onboarding/onboardingFunnel';
import { appSignals } from '@eventBus/AppSignals';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import {
  isAgentCatalogAuthRefreshDeferred,
  runAfterAgentCatalogAuthRefresh,
} from '@frontend/auth/agentCatalogRefreshScope';
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import { loadMainViewModelOptions } from '@frontend/agents/optionsLoader';
import { loadMainViewTeamOptions } from '@frontend/agents/teamOptionsLoader';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  CommonViewMessageSchema,
  MainViewMessageSchema,
  MainViewPersistedStateSchema,
  agentKeyOf,
  AgentCategory,
} from '@shared/schemas';
import {
  readOnboardingFlags,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { assertKnownOutboundMessage } from '@shared/utils/dispatcher';
import { debounce } from '@utils/core';
import { watchConfig } from '@utils/config/configUtils';
import { DEBOUNCE_OPTIONS_MS } from '@utils/config/constants';

// Local file imports
import { MainViewMessageHandler } from './MainViewMessageHandler';
import type { ProgressViewProvider } from '../progressView/ProgressViewProvider';

export class MainViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'texra.mainView';
  protected messageHandler: MainViewMessageHandler;
  protected contentProvider: BundledViewContentProvider;
  private _messageDisposable?: vscode.Disposable;
  private _progressViewProvider?: ProgressViewProvider;

  /**
   * True only after the current launcher HTML document has posted
   * WEBVIEW_READY. Mode === MAIN alone is not enough: after a progress→main
   * HTML swap (or resolveWebviewView) the document is still loading and any
   * STATE_RESTORE posted now is dropped. Cleared on every main HTML assign.
   */
  private mainWebviewReady = false;

  /** Last computed funnel state, so credential hooks can detect the
   *  in-session State 0 → 1 transition. Session-scoped by design. */
  private onboardingFunnelState: OnboardingFunnelState | undefined;
  /** A State 1 entry observed with no view keeps its setup-agent selection
   *  pending until a launcher exists to receive it. */
  private pendingSetupAgentSelection = false;
  /**
   * Funnel refresh derives an edge-triggered transition after awaiting the
   * credential probe. Serialize callers so a later completion cannot commit a
   * transition based on a stale previous funnel state, and collapse any burst
   * that arrives during a pass into one terminal re-run.
   */
  private readonly onboardingFunnelRefreshQueue = new PQueue({
    concurrency: 1,
  });
  private onboardingFunnelRerunRequested = false;

  // Debounced refresh for agent option changes
  private debouncedRefreshAgentOptions = debounce(
    this.refreshAgentOptions.bind(this),
    DEBOUNCE_OPTIONS_MS,
  );

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.messageHandler = new MainViewMessageHandler(
      context,
      () => this.refreshOnboardingFunnel(),
      () => {
        this.mainWebviewReady = true;
        this.flushPendingState();
      },
    );
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
    this.setupWorkspaceWatcher();
    this.setupAuthListener();
  }

  /**
   * Sole outbound path to the launcher webview. In dev/test runs the payload
   * goes through the boundary's outbound schemas first (`assertKnownOutbound
   * Message`), so a schema drift is caught by CI instead of silently reaching
   * the webview; production posts the typed payload as-is with no parse cost.
   */
  private postToWebview(
    webviewView: vscode.WebviewView,
    message: unknown,
  ): void {
    assertKnownOutboundMessage(
      [MainViewMessageSchema, CommonViewMessageSchema],
      message,
    );
    webviewView.webview.postMessage(message);
  }

  private setupConfigurationWatcher() {
    watchConfig(this.context, ['texra.files'], this.refreshFiles.bind(this));
  }

  private setupWorkspaceWatcher(): void {
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        const view = this.getMainModeView();
        if (view) {
          this.messageHandler.postWorkspaceRoots(view);
        }
      }),
    );
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
  public getMainModeView(): vscode.WebviewView | undefined {
    return getActiveSidebarView() === SIDEBAR_VIEWS.MAIN
      ? this.getWebviewView()
      : undefined;
  }

  /**
   * Refresh both agent and model options.
   * Called when auth state changes (login/logout affects both).
   */
  private async refreshOptionsAndView(): Promise<void> {
    await refresh();
    const view = this.getMainModeView();
    // Only synthesize WEBVIEW_READY when the launcher document is already live.
    // During a post-swap load window the real ready signal will re-push options
    // and flush restores; a synthetic ready would drain the queue too early.
    if (view && this.mainWebviewReady) {
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
  refreshOnboardingFunnel(): Promise<void> {
    this.onboardingFunnelRerunRequested = true;
    return this.onboardingFunnelRefreshQueue.add(async () => {
      while (this.onboardingFunnelRerunRequested) {
        this.onboardingFunnelRerunRequested = false;
        await this.refreshOnboardingFunnelSerially();
      }
    });
  }

  private async refreshOnboardingFunnelSerially(): Promise<void> {
    const view = this.getMainModeView();
    // Mode === MAIN is not enough: after an HTML swap the document has not
    // installed its listener yet. Posting into that window drops messages, and
    // selectSetupAgent is edge-triggered so a later WEBVIEW_READY recompute
    // would not re-emit the selection. Treat mid-load like "no view".
    const canPost = view != null && this.mainWebviewReady;

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

    if (canPost) {
      this.postToWebview(view, {
        command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
        state: transition.state,
      });
    }

    if (transition.clearDeclined) {
      await setOnboardingDeclined(this.context.globalState, false);
    }
    // An off-view or mid-load advance consumes the transition edge (previous
    // latches to 'setup'), so remember the selection until a ready launcher
    // can receive it — otherwise a credential arriving while the panel is
    // hidden or still loading would leave the dropdown on the old agent.
    if (transition.selectSetupAgent && !canPost) {
      this.pendingSetupAgentSelection = true;
    }
    if (
      canPost &&
      (transition.selectSetupAgent ||
        (this.pendingSetupAgentSelection && transition.state === 'setup'))
    ) {
      this.pendingSetupAgentSelection = false;
      // Resolve the qualified registry key so the dropdown matches by value;
      // the plain name still resolves by label if the registry isn't loaded.
      const entry = getAgent('setup', AgentCategory.ToolUse);
      this.postToWebview(view, {
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
  private async refreshAgentOptions(): Promise<void> {
    const view = this.getMainModeView();
    if (!view) return;

    await refresh();
    const optionsData = await computeAgentOptionsData();
    this.postToWebview(view, {
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      optionsData,
    });
    this.postToWebview(view, {
      command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
      optionsData: await loadMainViewTeamOptions(),
    });
  }

  /**
   * Refresh model options only.
   * Called via texra.refreshAllOptions when model selection changes in Settings View.
   */
  private async refreshModelOptions(): Promise<void> {
    const view = this.getMainModeView();
    if (!view) return;

    const optionsDataByCategory = await loadMainViewModelOptions();
    this.postToWebview(view, {
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
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
    const fileWatcher = vscode.workspace.createFileSystemWatcher(filePattern);
    fileWatcher.onDidCreate(this.refreshFiles.bind(this));
    fileWatcher.onDidDelete(this.refreshFiles.bind(this));
    this.context.subscriptions.push(fileWatcher);
  }

  private setupAgentWatcher() {
    this.context.subscriptions.push(
      agentDirectories.watchAgentDirectories({
        pattern: '**/*.yaml',
        onEvent: () => this.debouncedRefreshAgentOptions(),
      }),
    );
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

    this.mainWebviewReady = false;
    webviewView.webview.html = this.contentProvider.getHtmlContent(
      webviewView.webview,
    );

    this._messageDisposable = webviewView.webview.onDidReceiveMessage(
      (message) => this.messageHandler.handleMessage(message, webviewView),
    );

    this._viewDisposables.add(
      webviewView.onDidDispose(this.cleanupView.bind(this)),
    );

    this.setupInitialState(webviewView);
  }

  protected override cleanupView(): void {
    this._messageDisposable?.dispose();
    this._messageDisposable = undefined;
    this.mainWebviewReady = false;
    if (getActiveSidebarView() === SIDEBAR_VIEWS.PROGRESS) {
      this._progressViewProvider?.resetSidebarReady();
    }
    setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
    super.cleanupView();
  }

  private setupInitialState(webviewView: vscode.WebviewView): void {
    // REQUEST_BASE_FILE is inbound-only (no outbound schema), so the
    // assertion passes it through unchecked.
    this.postToWebview(webviewView, {
      command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    });
    // Pending restores wait for WEBVIEW_READY (onWebviewReady → flushPendingState)
    // so they land after the launcher has installed its message listener.
  }

  /**
   * Sole deliverer of queued restores (see stateRestoreCommand). Called from
   * WEBVIEW_READY after the launcher document installs its listener, and from
   * showInSidebar when that document is already ready (no reload → no ready
   * re-fire). Mode === MAIN alone is not sufficient.
   */
  private flushPendingState(): void {
    if (!this.mainWebviewReady) return;
    const webviewView = this.getMainModeView();
    if (!webviewView) return;
    for (
      let pendingData = consumePendingState();
      pendingData;
      pendingData = consumePendingState()
    ) {
      const parsed = MainViewPersistedStateSchema.safeParse(pendingData.state);
      if (!parsed.success) {
        console.warn('Invalid pending state restore payload', parsed.error);
        continue;
      }
      this.postToWebview(webviewView, {
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state: parsed.data,
        executeImmediately: pendingData.executeImmediately,
      });
    }
  }

  // --- Mode switching ---

  public setProgressViewProvider(pvp: ProgressViewProvider): void {
    this._progressViewProvider = pvp;
  }

  public getWebviewView(): vscode.WebviewView | undefined {
    return this._view as vscode.WebviewView | undefined;
  }

  /**
   * Switch the single sidebar view between 'main' (launcher) and 'progress' content.
   * Swaps HTML and message listener so both bundles share one VS Code view slot.
   * Claiming the surface and swapping its content happen in one tick, so a
   * concurrent switch cannot land between them.
   */
  public switchMode(mode: SidebarView): void {
    const webviewView = this.getWebviewView();
    if (!webviewView || mode === getActiveSidebarView()) return;

    // Guard provider availability before mutating any state.
    if (mode === SIDEBAR_VIEWS.PROGRESS && !this._progressViewProvider) return;

    setActiveSidebarView(mode);
    this._messageDisposable?.dispose();
    // Any HTML swap invalidates the previous document's ready handshake.
    this.mainWebviewReady = false;

    if (mode === SIDEBAR_VIEWS.PROGRESS) {
      const pvp = this._progressViewProvider!;
      webviewView.webview.html = pvp
        .getContentProvider()
        .getHtmlContent(webviewView.webview);
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
    const alreadyMain = getActiveSidebarView() === SIDEBAR_VIEWS.MAIN;
    this.switchMode(SIDEBAR_VIEWS.MAIN);
    // Flush only when the current launcher document has already reported ready.
    // Mode switches from progress (and any mid-load window) wait for
    // WEBVIEW_READY so STATE_RESTORE is not posted into an unloading document.
    // flushPendingState also guards on mainWebviewReady; the check here avoids
    // a no-op call during the load window after an HTML swap.
    if (alreadyMain && this.mainWebviewReady) {
      this.flushPendingState();
    }
    await vscode.commands.executeCommand('texra.mainView.focus');
  }
}
