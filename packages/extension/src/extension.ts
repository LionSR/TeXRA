// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import dotenv from 'dotenv';

// Local imports - core
import { initPlatform } from '@platform/platform';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
} from '@platform/interfaces/lifecycle';
import { loadAgents, setAgentDirectories } from '@agent/index';
import { clearStoreCache } from '@agent/storage';
import { setDefaultAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { killBackgroundProcesses } from '@agent/runtime/executionRegistry';
import { initializePolishModel } from '@agent/runtime/polishModel';
import {
  getServerSideKeyService,
  initializeServerSideKeyAccess,
} from '@auth/serverKeys';
import { SupabaseClient } from '@auth/SupabaseClient';
import { SupabaseAuthProvider } from '@auth/SupabaseAuthProvider';
import { SupabaseUriHandler } from '@auth/UriHandler';
import {
  getAuthCallbackUri,
  isSupabaseConfigured,
  setExternalAuthCallbackResolver,
  setRuntimeExtensionId,
} from '@auth/config';
import { getAuthStatus } from '@auth/authCommands';
import { toErrorMessage } from '@common/errors';
import { SIDEBAR_VIEWS, setActiveSidebarView } from '@common/webview';
import {
  globalSM,
  initializeStateManagers,
  workspaceSM,
  WorkspaceStateKey,
} from '@common/state';
import { isTerminalStatus } from '@common/constants/streamStatus';
import { bus } from '@eventBus/ProgressEventBus';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import {
  copyDefaultAgents,
  configureLatexSettings,
  initializeToolDefaults,
  migrateLatexConfigToStorage,
  registerAgentDirectoryRoots,
} from '@frontend/setup';
import { runTerminalCommand } from '@frontend/setupTerminalRunner';
import { agentDirectories } from '@frontend/agents';
import { FileLister } from '@frontend/files';
import { killActiveRecording } from '@frontend/media/audio';
import { disposeDiffRefresh } from '@frontend/ui/diffView';
import { registerFileDecorations } from '@frontend/ui/fileDecorations';
import { registerWelcomeView } from '@frontend/ui/welcomeView';
import { initializeNativeToolEditApproval } from '@frontend/approval/nativeToolEditApproval';
import { registerAgentEventListeners } from '@frontend/events/agentEventListeners';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import * as leanVscodeIntegration from '@frontend/lean/VscodeIntegration';
import { applyGitAuthorConfig } from '@frontend/git/gitAuthorSetup';
import { resolveGitCommonRoot } from '@frontend/git/resolveGitRoot';
import { getLinterMessages } from '@frontend/latex/linter';
import {
  pushManualCriticism,
  registerInlineCriticism,
} from '@frontend/latex/inlineCriticism';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { VscodeFileSystem } from '@frontend/vscode/vscodeFileSystem';
import { VscodeWorkspace } from '@frontend/vscode/vscodeWorkspace';
import { VscodeStorage } from '@frontend/vscode/vscodeStorage';
import { VscodeSecrets } from '@frontend/vscode/vscodeSecrets';
import { VscodeConfigProvider } from '@frontend/vscode/vscodeConfig';
import * as logger from '@logger/logUtils';
import { UsageLogService } from '@logger/UsageLogService';
import { refreshModelListStateIfNeeded } from '@model/modelListRefresh';
import { STREAM_STATUS, type StreamStatus } from '@shared/schemas';
import { interruptAllCodexSessions } from '@tools/codex';
import { setExtensionChecker } from '@tools/externalToolDefs';
import { refreshToolAvailability } from '@tools/toolAvailability';
import { setSetupPlatform } from '@tools/setup';
import {
  setGitHubTokenProvider,
  prPollingSource,
  repoPollingSource,
  issuePollingSource,
} from '@tools/github';
import { setToolNotificationHandler } from '@tools/toolUnavailableNotification';
import { setAddCriticismSink } from '@tools/AddCriticismTool';
import { setLinterProvider } from '@tools/DiagnosticsTool';
import { setLeanVscodeServices } from '@tools/lean/leanVscodeServices';
import { setOpenBuildDisplay } from '@tools/approval/latexPreview';
import { StorageFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { setToolMissingHandler } from '@utils/system';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';

// Local imports - components
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { registerCommands, getMainViewProvider } from './commands';

let statusBarItem: vscode.StatusBarItem | undefined;
let apiKeyStatusBarItem: vscode.StatusBarItem | undefined;
let disposeStatusListener: (() => void) | undefined;
let progressViewProviderInstance: ProgressViewProvider | undefined;
// Re-instantiated on every activate(): runShutdown() trips an internal
// idempotency flag, so a stale module-level instance would silently swallow
// handlers registered by a second activate() in the same process.
let lifecycleHost: LifecycleHost | undefined;

async function refreshApiKeyStatus() {
  if (!apiKeyStatusBarItem) {
    return;
  }

  // Check if reminders are enabled
  const showReminders = getConfig<boolean>(
    'texra.ui.showApiKeyReminders',
    true,
  );

  if (!showReminders) {
    apiKeyStatusBarItem.hide();
    return;
  }

  // `anyApiKeyExists()` already falls back to `canUseServerSideKeys()`
  // internally. Don't catch here: a transient probe failure shouldn't
  // regress a signed-in user to the "Get Started" CTA — let the outer
  // wrapper log it and leave the pill in its prior state.
  const exists = await SecretManager.anyApiKeyExists();
  if (!exists) {
    apiKeyStatusBarItem.text = '$(rocket) TeXRA: Get Started';
    apiKeyStatusBarItem.tooltip =
      'Click to run the setup assistant — sign in for free or add an API key';
    apiKeyStatusBarItem.command = 'texra.runSetupAssistant';
    apiKeyStatusBarItem.show();
  } else {
    apiKeyStatusBarItem.hide();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length !== 1) {
    registerWelcomeView(context);
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  dotenv.config({
    path: path.join(workspaceRoot, '.env'),
  });
  await setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
  const gitRepoRoot = await resolveGitCommonRoot(workspaceRoot);

  SecretManager.initialize(context);
  agentDirectories.initialize(context);
  setAgentDirectories(agentDirectories);
  logger.setOutputChannelFactory((name) =>
    vscode.window.createOutputChannel(name),
  );
  initializePolishModel(context.extensionPath);
  initializeStateManagers(context, gitRepoRoot);
  const lifecycle = createLifecycleHost({
    onError: (phase, error) =>
      logger.error('extension', `Lifecycle ${phase} handler failed`, {
        data: error,
      }),
  });
  lifecycleHost = lifecycle;
  initPlatform({
    config: new VscodeConfigProvider(),
    globalState: context.globalState,
    workspaceState: workspaceSM,
    log: logger,
    fs: new VscodeFileSystem(),
    workspace: new VscodeWorkspace(),
    storage: new VscodeStorage(context),
    secrets: new VscodeSecrets(context),
    lifecycle,
  });
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => disposeStatusListener?.());
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => killBackgroundProcesses());
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    interruptAllCodexSessions(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => killActiveRecording());
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => UsageLogService.dispose());
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    progressViewProviderInstance?.flushState(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => clearStoreCache());
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => prPollingSource.disposeAll());
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => repoPollingSource.disposeAll());
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
    issuePollingSource.disposeAll(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
    bus.emit('extensionDeactivating', undefined),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => disposeDiffRefresh());
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => statusBarItem?.dispose());
  setDefaultAgentRuntimeHost(extensionAgentRuntimeHost);
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  FileLister.initialize(context);
  initializeServerSideKeyAccess(
    {
      state: context.globalState,
      subscriptions: context.subscriptions,
      logger,
    },
    {
      isAuthenticated: () => SupabaseClient.isAuthenticated(),
      getUserTier: () => SupabaseClient.getUserTier(),
      getAccessToken: () => SupabaseClient.getAccessToken(),
    },
  );

  // Seed first-install defaults (e.g. disabled tools) before anything writes
  // LAST_KNOWN_VERSION, so upgrading users are not affected.
  await initializeToolDefaults();

  // Per-key idempotent copy of LaTeX/compile/diff settings from VS Code
  // config to TeXRA workspace storage. Safe to run on every activation —
  // a key already in workspaceSM is left untouched.
  await migrateLatexConfigToStorage();

  // Copy default agents before loading the agent index so built-in agents
  // are available when the index scans directories
  await copyDefaultAgents(context);

  // Expose agent directories to file tools via the external-roots allowlist.
  // Must run after copyDefaultAgents so the built-in directories exist.
  await registerAgentDirectoryRoots(context);

  try {
    const { added, currentVersion, previousVersion, removed, skipped } =
      await refreshModelListStateIfNeeded(globalSM);
    if (!skipped) {
      logger.info(
        'extension',
        `Model list version changed (${previousVersion ?? 'none'} -> ${currentVersion}), updating model list`,
      );
      logger.info('extension', 'Model list refresh completed successfully');
      if (added.length > 0 || removed.length > 0) {
        logger.info(
          'extension',
          `Refreshed enabled models: added [${added.join(', ')}], removed [${removed.join(', ')}]`,
        );
      }
    }
  } catch (err) {
    logger.error(
      'extension',
      `Failed to refresh model list: ${toErrorMessage(err)}`,
    );
  }

  loadAgents().catch((err) => {
    logger.error(
      'extension',
      `Failed to initialize agent index: ${toErrorMessage(err)}`,
    );
  });

  try {
    setRuntimeExtensionId(context.extension.id);
    setExternalAuthCallbackResolver(async () => {
      const baseCallbackUri = vscode.Uri.parse(
        getAuthCallbackUri(vscode.env.uriScheme),
      );
      const externalUri = await vscode.env.asExternalUri(baseCallbackUri);
      const vscodeState = new URLSearchParams(externalUri.query).get('state');
      const baseUrl = `${externalUri.scheme}://${externalUri.authority}${externalUri.path}`;

      return { baseUrl, vscodeState, fullUrl: externalUri.toString() };
    });

    if (!isSupabaseConfigured()) {
      logger.warn(
        'extension',
        'Supabase authentication is enabled but credentials are not configured. Please configure credentials in src/auth/config.ts before building.',
      );
    } else {
      const authProvider = new SupabaseAuthProvider(context);
      context.subscriptions.push(
        vscode.authentication.registerAuthenticationProvider(
          'texra-supabase',
          'TeXRA Account',
          authProvider,
          { supportsMultipleAccounts: false },
        ),
      );

      const uriHandler = new SupabaseUriHandler();
      context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
      authProvider.setUriHandler(uriHandler);

      logger.info('extension', 'Supabase authentication provider registered');

      try {
        const extensionVersion =
          typeof context.extension.packageJSON?.version === 'string'
            ? context.extension.packageJSON.version
            : undefined;
        const editorType = vscode.env.appName || undefined;
        UsageLogService.initialize({}, extensionVersion, editorType);
        context.subscriptions.push({
          dispose: () => void UsageLogService.dispose(),
        });
      } catch (usageError) {
        logger.warn(
          'extension',
          `Usage logging service failed to initialize: ${toErrorMessage(usageError)}`,
        );
      }
    }
  } catch (error) {
    const initError =
      error instanceof Error ? error : new Error(toErrorMessage(error));
    SupabaseClient.setInitError(initError);
    logger.error(
      'extension',
      `Failed to initialize Supabase authentication: ${toErrorMessage(error)}`,
    );
  }

  const progressViewProvider = new ProgressViewProvider(context);
  progressViewProviderInstance = progressViewProvider;
  await progressViewProvider.initialize();

  logger.info('extension', 'TeXRA extension activated');

  await progressViewProvider.cleanupTasksAfterRestart();
  configureLatexSettings();
  registerCommands(context);
  registerFileDecorations(context);

  initializeNativeToolEditApproval(context, extensionAgentRuntimeHost);
  setLeanVscodeServices(leanVscodeIntegration);
  setExtensionChecker((id) => vscode.extensions.getExtension(id) !== undefined);
  setToolMissingHandler(async (message, openDocsCommand) => {
    const actions = openDocsCommand ? ['View Installation Guide'] : [];
    const choice = await vscode.window.showErrorMessage(message, ...actions);
    if (choice === 'View Installation Guide' && openDocsCommand) {
      const [command, ...args] = openDocsCommand.split(',');
      void vscode.commands.executeCommand(command, ...args);
    }
  });
  setSetupPlatform({
    secrets: {
      providers: SecretManager.API_PROVIDERS,
      setApiKey: (provider, key) =>
        SecretManager.set(
          SecretManager.getApiKeySecretName(provider as ApiProvider),
          key,
        ),
      deleteApiKey: (provider) =>
        SecretManager.delete(
          SecretManager.getApiKeySecretName(provider as ApiProvider),
        ),
      apiKeyExists: (provider) =>
        SecretManager.apiKeyExists(provider as ApiProvider),
      hasUsableApiKey: (provider) =>
        SecretManager.hasUsableApiKey(provider as ApiProvider),
      storedApiKeyExists: async (provider) => {
        const stored = await SecretManager.get(
          SecretManager.getApiKeySecretName(provider as ApiProvider),
        );
        return stored !== undefined;
      },
      anyApiKeyExists: async () => {
        // Shared SecretManager.anyApiKeyExists reports true for
        // PROVIDER_API_KEY="" — a common stale-env case. For setup
        // tools (probe/verify) and setup-launch preflight, "any key
        // present" must mean "launchable", so require at least one
        // provider with a non-blank key (or server-side access).
        const usable = await Promise.all(
          SecretManager.API_PROVIDERS.map((p) =>
            SecretManager.hasUsableApiKey(p),
          ),
        );
        if (usable.some(Boolean)) return true;
        return getServerSideKeyService().canUseServerSideKeys();
      },
      gitHubTokenExists: () => SecretManager.gitHubTokenExists(),
    },
    commands: {
      invoke: (cmd, ...args) =>
        Promise.resolve(vscode.commands.executeCommand(cmd, ...args)),
    },
    extensions: {
      isInstalled: (id) => vscode.extensions.getExtension(id) !== undefined,
      install: async (id) => {
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          id,
        );
      },
    },
    auth: {
      getStatus: () => getAuthStatus(),
    },
    config: {
      get: (key) => {
        // Defense in depth: the only consumers today validate keys before
        // reaching here, but the adapter is documented as `texra.*`-scoped
        // and a future tool wiring through `platform.config` should not be
        // able to read arbitrary VS Code settings by accident.
        if (!key.startsWith('texra.')) {
          throw new Error(
            `Setup config adapter is scoped to texra.* keys; refused: ${key}`,
          );
        }
        return vscode.workspace.getConfiguration(undefined, null).get(key);
      },
      update: async (key, value, target) => {
        if (!key.startsWith('texra.')) {
          throw new Error(
            `Setup config adapter is scoped to texra.* keys; refused: ${key}`,
          );
        }
        const scope =
          target === 'workspace'
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await vscode.workspace
          .getConfiguration(undefined, null)
          .update(key, value, scope);
      },
    },
    terminal: {
      runCommand: (args) => runTerminalCommand(args),
    },
  });
  // GitHub token lives in SecretStorage (managed via the Git settings tab).
  // The tool layer only supports a synchronous token lookup, so we cache here
  // and refresh on secret changes.
  let cachedGitHubToken: string | undefined;
  const refreshGitHubToken = async () => {
    cachedGitHubToken = await SecretManager.getGitHubToken();
  };
  setGitHubTokenProvider(() => cachedGitHubToken);
  void refreshGitHubToken();
  // VS Code's event emitters don't await async listeners, so we funnel
  // fire-and-forget async work through this helper to log rejections
  // instead of letting them become unhandled promise rejections.
  const logRefreshFailure = (trigger: string) => (err: unknown) => {
    logger.error(
      'extension',
      `Tool availability refresh failed (${trigger}): ${toErrorMessage(err)}`,
    );
  };

  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key !== SecretManager.GITHUB_TOKEN_KEY) return;
      // Refresh the cached token first so availability checks see the
      // new value, then re-probe so any subscribed UI (Tools tab) and
      // the runtime cache pick up the change automatically.
      void (async () => {
        await refreshGitHubToken();
        await refreshToolAvailability(extensionAgentRuntimeHost);
      })().catch(logRefreshFailure('secret change'));
    }),
    // Lean/LaTeX extension installed or removed → re-probe so the Tools tab
    // reflects the new state without the user clicking Re-check.
    vscode.extensions.onDidChange(() => {
      void refreshToolAvailability(extensionAgentRuntimeHost).catch(
        logRefreshFailure('extension change'),
      );
    }),
    // Workspace folders opened/closed can flip `isGitRepository`, which
    // gates the GitHub PR subscription tool group.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshToolAvailability(extensionAgentRuntimeHost).catch(
        logRefreshFailure('workspace folder change'),
      );
    }),
  );
  const disposeGitHubAuthListener = bus.on(
    'githubTokenInvalid',
    ({ message }) => {
      void vscode.window
        .showErrorMessage(
          `GitHub token rejected: ${message}`,
          'Open Git settings',
        )
        .then((choice) => {
          if (choice === 'Open Git settings') {
            void vscode.commands.executeCommand('texra.showGitSettings');
          }
        });
    },
  );
  context.subscriptions.push({ dispose: disposeGitHubAuthListener });
  setLinterProvider(getLinterMessages);
  setOpenBuildDisplay(openBuildDisplayIfTex);
  registerInlineCriticism(context);
  setAddCriticismSink((payload) => {
    const accepted = pushManualCriticism({
      absolutePath: payload.absolutePath,
      line: payload.line,
      message: payload.message,
      severity: payload.severity,
      confidence: payload.confidence,
    });
    return { accepted, resolvedPath: payload.absolutePath };
  });
  applyGitAuthorConfig();

  setToolNotificationHandler((message, actionCommand, actionLabel) => {
    if (actionCommand) {
      const label = actionLabel ?? 'Open Tools Dashboard';
      void vscode.window
        .showInformationMessage(message, label)
        .then((choice) => {
          if (choice === label) {
            void vscode.commands.executeCommand(actionCommand);
          }
        });
    } else {
      void vscode.window.showInformationMessage(message);
    }
  });

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  statusBarItem.command = 'texra.showProgressView';
  statusBarItem.text = '$(bracket-dot) TeXRA: Idle';
  statusBarItem.tooltip = 'Show TeXRA Tasks';
  statusBarItem.show();

  apiKeyStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  context.subscriptions.push(apiKeyStatusBarItem);
  const safeRefreshApiKeyStatus = () =>
    refreshApiKeyStatus().catch((err) =>
      logger.error(
        'extension',
        `API key status refresh failed: ${toErrorMessage(err)}`,
      ),
    );
  void safeRefreshApiKeyStatus();
  // Without these listeners the pill stayed on "Get Started" forever after
  // a Researcher Access sign-in or after the first API key was stored.
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'texra-supabase') {
        void safeRefreshApiKeyStatus();
      }
    }),
    getServerSideKeyService().onDidChangeModelAccess(() => {
      void safeRefreshApiKeyStatus();
    }),
  );

  const runningStreams = new Set<string>();
  const updateStatusBarText = () => {
    const count = runningStreams.size;
    if (count > 1) {
      statusBarItem!.text = `$(loading) TeXRA: ${count} active`;
    } else if (count === 1) {
      statusBarItem!.text = '$(loading) TeXRA: Running';
    } else {
      statusBarItem!.text = '$(bracket-dot) TeXRA: Idle';
    }
  };

  disposeStatusListener = bus.on(
    'updateStreamStatus',
    ({ streamId, status }: { streamId: string; status: StreamStatus }) => {
      if (status === STREAM_STATUS.RUNNING) {
        runningStreams.add(streamId);
      } else if (isTerminalStatus(status)) {
        runningStreams.delete(streamId);
      }
      updateStatusBarText();
    },
  );

  const showMainView = async () => {
    const mvp = getMainViewProvider();
    if (mvp) {
      await mvp.showInSidebar();
      return;
    }
    // Fallback when MainViewProvider is not yet registered
    await setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
    await vscode.commands.executeCommand('texra.mainView.focus');
  };

  const agentEventDisposable = registerAgentEventListeners();

  context.subscriptions.push(
    agentEventDisposable,
    { dispose: disposeStatusListener },
    statusBarItem,
    // `texra.showMainView` keeps its bespoke registration here because the
    // handler closes over the `MainViewProvider` and the late-bound sidebar
    // fallback. `texra.toggleView` migrated to the shared command registry
    // in #3781 batch 4 — its action only needs module-level state
    // (`getActiveSidebarView()`) so it doesn't need a closure into
    // `activate()`.
    vscode.commands.registerCommand('texra.showMainView', showMainView),
    vscode.commands.registerCommand(
      'texra.refreshApiKeyStatus',
      refreshApiKeyStatus,
    ),
  );

  const mainViewProvider = getMainViewProvider();
  if (mainViewProvider) {
    progressViewProvider.setSidebarWebviewGetter(
      () => mainViewProvider.getWebviewView()?.webview,
    );
    progressViewProvider.setMainViewProvider(mainViewProvider);
    mainViewProvider.setProgressViewProvider(progressViewProvider);
  }

  // Gating UI contributions (commandPalette / keybindings / menus / walkthroughs
  // / views) on `texra.activated` keeps them hidden until every command handler
  // is registered. This must run after ALL `registerCommand` calls in this
  // function (including the late ones for `texra.showMainView` and
  // `texra.toggleView`), otherwise palette entries can fire before their
  // handlers exist and produce "command not found" errors. It must also run
  // BEFORE the welcome walkthrough is opened below, because the walkthrough
  // itself is gated on `texra.activated`.
  await vscode.commands.executeCommand('setContext', 'texra.activated', true);

  const welcomeKey = 'texra.welcomeShown';
  if (!context.globalState.get<boolean>(welcomeKey)) {
    // Opening the VS Code walkthrough is enough — its first step is the
    // setup assistant CTA, so don't double up with a popup.
    void vscode.commands
      .executeCommand('texra.openGettingStarted')
      .then(() => context.globalState.update(welcomeKey, true));
  }
}

export async function deactivate() {
  const host = lifecycleHost;
  lifecycleHost = undefined;
  await host?.runShutdown();
}
