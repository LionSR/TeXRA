// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';
import dotenv from 'dotenv';

// Local imports - core
import { initPlatform, platform } from '@platform/platform';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import { NO_TOOL_AVAILABILITY_HOST } from '@platform/interfaces';
import { UsageLogService } from '@telemetry/UsageLogService';
import { seedRosterFromDefaultTeam } from '@controllers/onboarding/defaultTeamSeeding';
import { defaultSkillSources, setRuntimeSkillSources } from '@skills/index';
import { StreamLogStore } from '@transcript';
import { loadAgents } from '@agent/index';
import { clearStoreCache, listExecutions } from '@agent/storage';
import { registerAgentFeatures } from '@agent/features';
import { initializeGoalPrompts } from '@agent/goal/promptLoader';
import {
  defaultSession,
  initializeDefaultSession,
  teardownDefaultSession,
} from '@agent/runtime/SessionHandle';
import { registerAgentShutdownHandlers } from '@agent/runtime/agentShutdown';
import { initializePolishModel } from '@agent/runtime/polishModel';
import {
  getServerSideKeyService,
  initializeServerSideKeyAccess,
} from '@auth/serverKeys';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  getAuthCallbackUri,
  isSupabaseConfigured,
  setExternalAuthCallbackResolver,
  setRuntimeExtensionId,
} from '@auth/config';
import { AUTH_COMMANDS, AUTH_PROVIDER_ID } from '@auth/constants';
import { hasAnyUsableSetupCredential } from '@commands/setup';
import {
  isResumeInFlight,
  tryResumeFromSnapshot,
} from '@commands/agent/resumeFromSnapshot';
import { createSampleProjectWithoutWorkspace } from '@commands/system/sampleProjectCommands';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import { SIDEBAR_VIEWS, setActiveSidebarView } from '@common/webview';
import { globalSM, initializeStateManagers, workspaceSM } from '@common/state';
import { appSignals } from '@eventBus/AppSignals';
import { SecretManager } from '@frontend/secretManager';
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
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { subscribeStatusBarSessionEvents } from '@frontend/statusBar/statusBarSessionEvents';
import { killActiveRecording } from '@frontend/media/audio';
import { disposeDiffRefresh } from '@frontend/ui/diffView';
import { registerFileDecorations } from '@frontend/ui/fileDecorations';
import { registerWelcomeView } from '@frontend/ui/welcomeView';
import { initializeNativeToolEditApproval } from '@frontend/approval/nativeToolEditApproval';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';
import { SupabaseUriHandler } from '@frontend/auth/UriHandler';
import { registerAgentEventListeners } from '@frontend/events/agentEventListeners';
import { createLanguageModelPort } from '@frontend/lm/createLanguageModelPort';
import { registerLanguageModelTools } from '@frontend/lm/registerLanguageModelTools';
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import * as leanVscodeIntegration from '@frontend/lean/VscodeIntegration';
import { applyGitAuthorConfig } from '@frontend/git/gitAuthorSetup';
import { resolveGitCommonRoot } from '@frontend/git/resolveGitRoot';
import { getLinterMessages } from '@frontend/latex/linter';
import {
  pushManualCriticism,
  registerInlineCriticism,
} from '@frontend/latex/inlineCriticism';
import {
  getInlineCommentProvider,
  registerInlineComments,
} from '@frontend/comments/inlineComments';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { VscodeFileSystem } from '@frontend/vscode/vscodeFileSystem';
import { VscodeWorkspace } from '@frontend/vscode/vscodeWorkspace';
import { VscodeStorage } from '@frontend/vscode/vscodeStorage';
import { VscodeSecrets } from '@frontend/vscode/vscodeSecrets';
import { VscodeConfigProvider } from '@frontend/vscode/vscodeConfig';
import * as logger from '@logger/logUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { refreshModelListStateIfNeeded } from '@model/modelListRefresh';
import { invalidateRuntimeModelRegistry } from '@model/runtimeModelRegistry';
import { backfillFirstRunDone } from '@shared/state/onboardingState';
import { migrateLegacyGlobalBashApprovalOverride } from '@shared/settingsView/handlers/approvalHandlers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { setOpenPdfOpener } from '@tools/OpenPdfTool';
import { refreshToolAvailability } from '@tools/toolAvailability';
import { createDefaultSetupPlatform, setSetupPlatform } from '@tools/setup';
import {
  SharedPRPollingSource,
  SharedRepoPollingSource,
  SharedIssuePollingSource,
} from '@tools/github';
import { setInlineCommentProvider } from '@tools/comment/InlineCommentTool';
import { setLeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { setOpenBuildDisplay } from '@tools/approval/latexPreview';
import { StorageFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

  // Use the same credential predicate as the setup assistant and onboarding
  // funnel. This keeps ChatGPT subscription, Researcher Access, and direct API
  // keys in agreement about whether the first-run CTA should remain visible.
  const exists = await hasAnyUsableSetupCredential();
  if (!exists) {
    apiKeyStatusBarItem.text = '$(rocket) TeXRA: Get Started';
    apiKeyStatusBarItem.tooltip =
      'Click to run the setup assistant — sign in, use ChatGPT, or add an API key';
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
    // The full command surface (including the workspace-backed
    // `texra.createSampleProject`) is only registered on the single-folder
    // path below, so the welcome view registers its own standalone variant:
    // a first-time user without a LaTeX project can create the sample and
    // land directly in a working workspace.
    context.subscriptions.push(
      vscode.commands.registerCommand('texra.createSampleProject', () =>
        createSampleProjectWithoutWorkspace(context.extensionPath),
      ),
      vscode.commands.registerCommand('texra.openGettingStarted', () =>
        openGettingStarted(context.extension.id),
      ),
    );
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
  logger.setOutputChannelFactory((name) =>
    vscode.window.createOutputChannel(name),
  );
  initializePolishModel(
    path.join(
      context.extensionPath,
      'resources',
      'templates',
      'instructionPolish.yaml',
    ),
  );
  initializeGoalPrompts(
    path.join(context.extensionPath, 'resources', 'goal', 'goal.yaml'),
  );
  initializeStateManagers(context, gitRepoRoot);
  const lifecycle = createLifecycleHost({
    onError: (phase, error) =>
      logger.error('extension', `Lifecycle ${phase} handler failed`, {
        data: error,
      }),
  });
  lifecycleHost = lifecycle;
  const languageModel = createLanguageModelPort(context);
  initPlatform({
    config: new VscodeConfigProvider(),
    globalState: context.globalState,
    workspaceState: workspaceSM,
    fs: new VscodeFileSystem(),
    workspace: new VscodeWorkspace(),
    storage: new VscodeStorage(context),
    secrets: new VscodeSecrets(context),
    lifecycle,
    agentDirectories,
    agentResume: {
      tryResumeStream: (streamId) => tryResumeFromSnapshot(streamId),
      isResumeInFlight: (streamId) => isResumeInFlight(streamId),
    },
    toolAvailability: {
      ...NO_TOOL_AVAILABILITY_HOST,
      isVscodeExtensionInstalled: (id) =>
        vscode.extensions.getExtension(id) !== undefined,
    },
    languageModel,
    linter: getLinterMessages,
    addCriticismSink: (payload) => {
      const accepted = pushManualCriticism({
        absolutePath: payload.absolutePath,
        line: payload.line,
        message: payload.message,
        severity: payload.severity,
        confidence: payload.confidence,
      });
      return { accepted, resolvedPath: payload.absolutePath };
    },
    toolMissingHandler: async (message, openDocsCommand) => {
      const actions = openDocsCommand ? ['View Installation Guide'] : [];
      logger.error('extension', message);
      const choice = await vscode.window.showErrorMessage(message, ...actions);
      if (choice === 'View Installation Guide' && openDocsCommand) {
        const [command, ...args] = openDocsCommand.split(',');
        void vscode.commands.executeCommand(command, ...args);
      }
    },
    toolNotificationHandler: (message, actionCommand, actionLabel) => {
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
    },
  });
  const invalidateLanguageModels = () => {
    invalidateRuntimeModelRegistry();
    invalidateModelOptionsCache();
  };
  context.subscriptions.push(
    languageModel.onDidChangeModels(invalidateLanguageModels),
    languageModel.onDidChangeAccess(invalidateLanguageModels),
  );
  initializeDefaultSession({ transcripts: await StreamLogStore.open() });
  registerAgentFeatures();
  // Mirrors the CLI/desktop Node-host wiring (`nodeHost.ts`'s
  // `initializeNodeRuntimeSkills`, inlined here rather than imported so the
  // extension bundle doesn't also pull in that module's Lean direct-adapter
  // import) so `AVAILABLE_SKILLS` is actually populated for tool-use agents in
  // VS Code — without this call `loadRuntimeSkillCatalog` always sees zero
  // sources and `texra.skills.enabled` has no observable effect (issue #7751
  // FS5).
  setRuntimeSkillSources(
    defaultSkillSources({
      cwd: workspaceRoot,
      resourcesPath: path.join(context.extensionPath, 'resources'),
    }),
  );
  // `disposeStatusListener` and `statusBarItem` are owned solely by
  // `context.subscriptions` (see the push near the end of `activate`), matching
  // `apiKeyStatusBarItem`. Registering them here too would double-dispose.
  registerAgentShutdownHandlers(lifecycle);
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => killActiveRecording());
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => UsageLogService.dispose());
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    progressViewProviderInstance?.flushState(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => clearStoreCache());
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
    SharedPRPollingSource.disposeAll(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
    SharedRepoPollingSource.disposeAll(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
    SharedIssuePollingSource.disposeAll(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
    appSignals.emit('extensionDeactivating', undefined),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => disposeDiffRefresh());
  await StorageFS.ensureDir(RUNS_STORAGE_DIR);
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
      getAccessToken: () => SupabaseClient.getRelayAccessToken(),
    },
  );

  // Seed first-install defaults (e.g. disabled tools) before anything writes
  // LAST_KNOWN_VERSION, so upgrading users are not affected.
  await initializeToolDefaults();

  // Onboarding-funnel backfill (PRD: agent-native onboarding): upgraders who
  // already have a credential or run history must never see the welcome card
  // or the setup auto-start, so firstRunDone is backfilled once when the flag
  // first appears. Awaited: the main view's funnel derivation reads this flag
  // at webview-ready, and awaiting here closes the only read-before-backfill
  // window. One-shot in practice — once the key exists the probes are skipped.
  if (
    context.globalState.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE) ===
    undefined
  ) {
    await (async () => {
      const hasPriorInstall =
        context.globalState.get<string>(GlobalStateKey.LAST_KNOWN_VERSION) !==
        undefined;
      const [hasCredential, hasRunHistory] = await Promise.all([
        // Same non-blank provider-key/server-side-key check used by the
        // funnel and setup launch preflight.
        hasAnyUsableSetupCredential().catch(() => false),
        // listExecutions() owns legacy migration and filters invalid storage
        // entries, so extension and CLI backfill classify history identically.
        listExecutions().then(
          (entries) => entries.length > 0,
          () => false,
        ),
      ]);
      await backfillFirstRunDone(context.globalState, {
        hasCredential,
        hasPriorInstall,
        hasRunHistory,
      });
    })().catch((err) =>
      logger.warn(
        'extension',
        `Onboarding firstRunDone backfill failed: ${toErrorMessage(err)}`,
      ),
    );
  }

  // The following startup steps touch independent state, so they run
  // concurrently to shorten activation. Within the agent branch the order
  // still matters: copyDefaultAgents populates the built-in directories,
  // registerAgentDirectoryRoots exposes them, and loadAgents scans them.
  await Promise.all([
    // Per-key idempotent copy of LaTeX/compile/diff settings from VS Code
    // config to TeXRA workspace storage. Safe to run on every activation —
    // a key already in workspaceSM is left untouched.
    migrateLatexConfigToStorage(),
    // One-shot per-workspace migration of a legacy global-scope bash-approval
    // override left over from before #7148 unified the write scope to
    // workspace (issue #7169). Safe to run on every activation — the
    // workspace-scoped marker makes it a no-op after the first run.
    migrateLegacyGlobalBashApprovalOverride({
      workspaceState: workspaceSM,
      config: platform().config,
    }),
    (async () => {
      await copyDefaultAgents(context);
      await registerAgentDirectoryRoots(context);
      try {
        await loadAgents({ includeRemote: false });
        // Seed a never-configured workspace's roster from the user-level
        // default team, falling back to the built-in Physicist team. Needs
        // the local registry, hence sequenced after the bundled-agent scan
        // and before activation completes so the first launcher render is
        // already scoped without waiting on remote agent fetches.
        try {
          await seedRosterFromDefaultTeam({
            globalState: context.globalState,
            workspaceState: workspaceSM,
          });
        } catch (err) {
          logger.warn(
            'extension',
            `Default-team roster seeding failed: ${toErrorMessage(err)}`,
          );
        }
        void loadAgents().catch((err) => {
          logger.warn(
            'extension',
            `Remote agent refresh failed: ${toErrorMessage(err)}`,
          );
        });
      } catch (err) {
        logger.error(
          'extension',
          `Failed to initialize agent index: ${toErrorMessage(err)}`,
        );
      }
    })(),
    (async () => {
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
    })(),
  ]);

  try {
    setRuntimeExtensionId(context.extension.id);
    setExternalAuthCallbackResolver(async () => {
      const baseCallbackUri = vscode.Uri.parse(
        getAuthCallbackUri(vscode.env.uriScheme),
      );
      const externalUri = await vscode.env.asExternalUri(baseCallbackUri);

      // asExternalUri adds a ?state= routing token in Codespaces; carrying it on
      // fullUrl (used as redirectTo) is what routes the callback back into the
      // editor. skipEncoding (toString(true)) so auth-js's encodeURIComponent
      // over redirectTo does not double-encode the already percent-encoded
      // token; double-encoding corrupts it and the callback never returns
      // (silent timeout).
      return { fullUrl: externalUri.toString(true) };
    });

    if (!isSupabaseConfigured()) {
      logger.warn(
        'extension',
        'Supabase authentication is enabled but credentials are not configured. Please configure credentials in src/auth/config.ts before building.',
      );
    } else {
      const authProvider = new SupabaseAuthProvider(context, {
        showError: (msg) => void vscode.window.showErrorMessage(msg),
        showInfo: (msg) => void vscode.window.showInformationMessage(msg),
        showSignInPrompt: async (reason) => {
          const message =
            reason === 'expired'
              ? 'Your TeXRA session has expired. Please sign in again to access AI models and remote agents.'
              : 'Your TeXRA session is no longer valid. Please sign in again to access AI models and remote agents.';
          const action = await vscode.window.showWarningMessage(
            message,
            'Sign In',
          );
          if (action === 'Sign In') {
            await vscode.commands
              .executeCommand('texra.auth.signIn')
              .then(undefined, (err: unknown) =>
                logger.error(
                  'SupabaseAuthProvider',
                  `Failed to trigger sign-in: ${toErrorMessage(err)}`,
                ),
              );
          }
        },
      });
      context.subscriptions.push(
        vscode.authentication.registerAuthenticationProvider(
          AUTH_PROVIDER_ID,
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
  // Deferred off the activation tick: extendEnvPath() inside performs
  // synchronous glob probes of TeX install directories, which would
  // otherwise block activation on slow disks. (Never rejects — the body is
  // fully wrapped in try/catch.)
  setTimeout(() => void configureLatexSettings(), 0);
  registerCommands(context);
  registerFileDecorations(context);

  initializeNativeToolEditApproval(context, extensionAgentRuntimeHost);
  setLeanLanguageServices(leanVscodeIntegration);
  setOpenPdfOpener(async ({ location, preserveFocus }) => {
    await vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.file(location.absolutePath),
      {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus,
      } satisfies vscode.TextDocumentShowOptions,
    );
  });
  const defaultSetupPlatform = createDefaultSetupPlatform();
  setSetupPlatform({
    ...defaultSetupPlatform,
    auth: {
      ...defaultSetupPlatform.auth,
      signIn: async () =>
        (await vscode.commands.executeCommand<boolean>(
          AUTH_COMMANDS.SIGN_IN,
        )) === true,
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
    terminal: {
      runCommand: (args) => runTerminalCommand(args),
    },
  });
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
      // Re-probe so any subscribed UI (Tools tab) reflects the new token
      // presence; getGitHubToken() now reads SecretStorage live (no cache).
      void refreshToolAvailability().catch(logRefreshFailure('secret change'));
    }),
    // Lean/LaTeX extension installed or removed → re-probe so the Tools tab
    // reflects the new state without the user clicking Re-check.
    vscode.extensions.onDidChange(() => {
      void refreshToolAvailability().catch(
        logRefreshFailure('extension change'),
      );
    }),
    // Workspace folders opened/closed can flip `isGitRepository`, which
    // gates the GitHub PR subscription tool group.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshToolAvailability().catch(
        logRefreshFailure('workspace folder change'),
      );
    }),
  );
  const disposeGitHubAuthListener = appSignals.on(
    'githubTokenInvalid',
    ({ message }) => {
      logger.error('extension', `GitHub token rejected: ${message}`);
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
  setOpenBuildDisplay(openBuildDisplayIfTex);
  registerInlineCriticism(context);
  registerInlineComments(context);
  setInlineCommentProvider(getInlineCommentProvider());
  applyGitAuthorConfig();

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
  onTexraAuthSessionsChanged(context, () => {
    void safeRefreshApiKeyStatus();
  });
  context.subscriptions.push(
    getServerSideKeyService().onDidChangeModelAccess(() => {
      void safeRefreshApiKeyStatus();
    }),
  );

  const statusBarUsageTracker = new StatusBarUsageTracker();
  const updateStatusBarTooltip = () => {
    if (!statusBarItem) return;
    const { cost, inputTokens, outputTokens } =
      statusBarUsageTracker.totalUsage;
    if (cost === 0 && inputTokens === 0 && outputTokens === 0) {
      statusBarItem.tooltip = 'Show TeXRA Tasks';
      return;
    }
    const tip = new vscode.MarkdownString(
      [
        '| TeXRA usage | |',
        '| --- | ---: |',
        `| Cost | $${cost.toFixed(4)} |`,
        `| Input tokens | ${inputTokens.toLocaleString()} |`,
        `| Output tokens | ${outputTokens.toLocaleString()} |`,
        '',
        '*Click to open the TeXRA task board*',
      ].join('\n'),
    );
    tip.isTrusted = false;
    statusBarItem.tooltip = tip;
  };
  const updateStatusBarText = () => {
    if (!statusBarItem) return;
    const count = statusBarUsageTracker.activeStreamCount;
    if (count > 1) {
      statusBarItem.text = `$(loading) TeXRA: ${count} active`;
    } else if (count === 1) {
      statusBarItem.text = '$(loading) TeXRA: Running';
    } else {
      statusBarItem.text = '$(bracket-dot) TeXRA: Idle';
    }
  };

  disposeStatusListener = subscribeStatusBarSessionEvents({
    session: defaultSession(),
    tracker: statusBarUsageTracker,
    onStatusChanged: () => {
      updateStatusBarTooltip();
      updateStatusBarText();
    },
    // UsageMonitor emits per-round deltas; the tracker accumulates them.
    onUsageChanged: updateStatusBarTooltip,
  });

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

  // Surface curated research tools to VS Code's Language Model Tool API
  // (Copilot Chat `#texra_*` references). No-op on hosts without the API.
  registerLanguageModelTools(context);

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
    vscode.commands.registerCommand('texra.refreshApiKeyStatus', async () => {
      await refreshApiKeyStatus();
      // Credential facts changed (set/unset API key from any entry point —
      // palette, walkthrough, welcome card), so the onboarding funnel must
      // recompute too: the State 0 card has no other signal when a key is
      // added outside the main view's own round-trip.
      const mainViewProvider = getMainViewProvider();
      if (mainViewProvider) {
        await mainViewProvider.refreshOnboardingFunnel().catch(() => {});
      }
    }),
  );

  const mainViewProvider = getMainViewProvider();
  if (mainViewProvider) {
    progressViewProvider.setSidebarWebviewGetter(
      () => mainViewProvider.getWebviewView()?.webview,
    );
    progressViewProvider.setMainViewProvider(mainViewProvider);
    mainViewProvider.setProgressViewProvider(progressViewProvider);
  }

  // Gating commandPalette / keybindings / menus / views on `texra.activated`
  // keeps them hidden until every command handler is registered. This must run
  // after ALL `registerCommand` calls in this function (including the late ones
  // for `texra.showMainView` and `texra.toggleView`), otherwise palette entries
  // can fire before their handlers exist and produce "command not found" errors.
  await vscode.commands.executeCommand('setContext', 'texra.activated', true);

  const welcomeKey = 'texra.welcomeShown';
  if (!context.globalState.get<boolean>(welcomeKey)) {
    // Land first-run users on the main welcome card so the credential choice
    // (ChatGPT subscription first) is the first real action, then open the
    // walkthrough alongside for the rest of the onboarding tips.
    void vscode.commands
      .executeCommand('texra.showMainView')
      .then(() => vscode.commands.executeCommand('texra.openGettingStarted'))
      .then(() => context.globalState.update(welcomeKey, true));
  }
}

export async function deactivate() {
  const host = lifecycleHost;
  lifecycleHost = undefined;
  try {
    leanVscodeIntegration.clearVscodeLeanServerEntries();
    await host?.runShutdown();
  } finally {
    teardownDefaultSession();
  }
}
