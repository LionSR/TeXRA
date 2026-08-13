// Node imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';
import dotenv from 'dotenv';
import PQueue from 'p-queue';

// Local imports
import { loadAgents } from '@agent/index';
import { clearStoreCache, listExecutions } from '@agent/storage';
import { registerAgentFeatures } from '@agent/features';
import {
  defaultSession,
  initializeDefaultSession,
  initializePolishModel,
  teardownDefaultSession,
} from '@agent/runtime';
import { initializeGoalPrompts } from '@agent/goal/promptLoader';
import { AUTH_COMMANDS, AUTH_PROVIDER_ID } from '@auth/constants';
import {
  getAuthCallbackUri,
  isSupabaseConfigured,
  setExternalAuthCallbackResolver,
  setRuntimeExtensionId,
} from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { hasAnyUsableSetupCredential } from '@commands/setup/setupAssistantCommand';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import { createSampleProjectWithoutWorkspace } from '@commands/system/sampleProjectCommands';
import { tryResumeFromResumeData } from '@commands/agent/resumeFromResumeData';
import { globalSM, initializeStateManagers, workspaceSM } from '@common/state';
import { SIDEBAR_VIEWS, setActiveSidebarView } from '@common/webview';
import { installTexraModelAccess } from '@controllers/modelAccess/installTexraModelAccess';
import { appSignals } from '@eventBus/AppSignals';
import { SecretManager } from '@frontend/secretManager';
import {
  copyDefaultAgents,
  initializeLatexSupport,
  registerAgentDirectoryRoots,
} from '@frontend/setup';
import { runTerminalCommand } from '@frontend/setupTerminalRunner';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { FileLister } from '@frontend/files/fileLister';
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { subscribeStatusBarSessionEvents } from '@frontend/statusBar/statusBarSessionEvents';
import { disposeDiffRefresh } from '@frontend/ui/diffView';
import { registerFileDecorations } from '@frontend/ui/fileDecorations';
import { registerWelcomeView } from '@frontend/ui/welcomeView';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';
import { SupabaseUriHandler } from '@frontend/auth/UriHandler';
import { createLanguageModelPort } from '@frontend/lm/createLanguageModelPort';
import { registerLanguageModelTools } from '@frontend/lm/registerLanguageModelTools';
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import * as leanVscodeIntegration from '@frontend/lean/VscodeIntegration';
import { applyGitAuthorConfig } from '@frontend/git/gitAuthorSetup';
import { resolveGitCommonRoot } from '@frontend/git/resolveGitRoot';
import { registerInlineCriticism } from '@frontend/latex/inlineCriticism';
import {
  getInlineCommentProvider,
  registerInlineComments,
} from '@frontend/comments/inlineComments';
import { migrateLegacyVscodeStorage } from '@frontend/vscode/sharedStorageRoot';
import { VscodeSecrets } from '@frontend/vscode/vscodeSecrets';
import { createExtensionTexraConfig } from '@frontend/vscode/texraConfig';
import { texraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import * as logger from '@logger/logUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  migrateCopilotModelRouteSelections,
  refreshModelListStateIfNeeded,
} from '@model/modelListRefresh';
import { invalidateRuntimeModelRegistry } from '@model/runtimeModelRegistry';
import {
  NO_TOOL_AVAILABILITY_HOST,
  SHUTDOWN_PHASE,
  type LifecycleHost,
} from '@platform/interfaces';
import { initPlatform, platform } from '@platform/platform';
import { nodeFileLocks } from '@platform/defaults/fileLocks';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import {
  formatTexraApprovalPolicy,
  readPersistedTexraApprovalPolicy,
  TEXRA_APPROVAL_POLICY_OPTIONS,
} from '@shared/approvalPolicy';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { backfillFirstRunDone } from '@shared/state/onboardingState';
import { setRuntimeSkillSources } from '@skills/runtimeSkills';
import { defaultSkillSources } from '@skills/skillSources';
import { UsageLogService } from '@telemetry/UsageLogService';
import { registerAgentShutdownHandlers } from '@tools/agentCliSessionStores';
import { setSetupPlatform } from '@tools/setup';
import {
  refreshToolAvailability,
  seedDisabledToolDefaults,
} from '@tools/toolAvailability';
import { SharedIssuePollingSource } from '@tools/github/IssuePollingSource';
import { SharedPRPollingSource } from '@tools/github/PRPollingSource';
import { SharedRepoPollingSource } from '@tools/github/RepoPollingSource';
import { killActiveRecording } from '@tools/media/audio';
import { setLeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { setInlineCommentProvider } from '@tools/comment/InlineCommentTool';
import { ephemeralTranscriptWarning, StreamLogStore } from '@transcript';
import { StorageFS } from '@utils/files/storageFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { registerCommands } from './commands';

let statusBarItem: vscode.StatusBarItem | undefined;
let apiKeyStatusBarItem: vscode.StatusBarItem | undefined;
// Re-instantiated on every activate(): runShutdown() trips an internal
// idempotency flag, so a stale module-level instance would silently swallow
// handlers registered by a second activate() in the same process.
let lifecycleHost: LifecycleHost | undefined;

async function refreshApiKeyStatus() {
  if (!apiKeyStatusBarItem) {
    return;
  }

  // Use the same credential predicate as the setup assistant and onboarding
  // funnel. This keeps ChatGPT subscription, Researcher Access, and direct API
  // keys in agreement about whether the first-run CTA should remain visible.
  const exists = await hasAnyUsableSetupCredential();
  if (!exists) {
    statusBarItem?.hide();
    apiKeyStatusBarItem.text = '$(rocket) TeXRA: Get Started';
    apiKeyStatusBarItem.tooltip =
      'Click to run the setup assistant — sign in, use ChatGPT, or add an API key';
    apiKeyStatusBarItem.command = EXTENSION_COMMANDS.RUN_SETUP_ASSISTANT;
    apiKeyStatusBarItem.accessibilityInformation = {
      label: 'TeXRA setup, get started',
    };
    apiKeyStatusBarItem.show();
  } else {
    apiKeyStatusBarItem.hide();
    statusBarItem?.show();
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
      vscode.commands.registerCommand(
        EXTENSION_COMMANDS.CREATE_SAMPLE_PROJECT,
        () => createSampleProjectWithoutWorkspace(context.extensionPath),
      ),
      vscode.commands.registerCommand(
        EXTENSION_COMMANDS.OPEN_GETTING_STARTED,
        () => openGettingStarted(context.extension.id),
      ),
    );
    return;
  }
  const rawWorkspacePath = () =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const workspace = createNodeWorkspace(rawWorkspacePath);
  const workspaceRoot = workspace.getWorkspacePath();
  if (!workspaceRoot) return;

  dotenv.config({
    path: path.join(workspaceRoot, '.env'),
  });
  setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
  const gitRepoRoot = await resolveGitCommonRoot(workspaceRoot);

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
  // Shared `~/.texra` storage root (one history across CLI/desktop/extension,
  // #8622). Legacy `storageUri` data must finish moving before initPlatform()
  // makes the shared root reachable to readers.
  const storage = createNodeStorageProvider({
    workspacePath: () => workspace.getWorkspacePath(),
  });
  await migrateLegacyVscodeStorage(context, storage);
  const config = await createExtensionTexraConfig(
    storage,
    workspace.getWorkspacePath(),
  );
  // Shared by the `Platform` tool-availability port and the setup platform's
  // extensions port, which both answer the same question.
  const isVscodeExtensionInstalled = (id: string) =>
    vscode.extensions.getExtension(id) !== undefined;
  initPlatform({
    config,
    globalState: context.globalState,
    workspaceState: workspaceSM,
    fs: nodeFilesystem,
    workspace,
    storage,
    fileLocks: nodeFileLocks,
    secrets: new VscodeSecrets(context),
    lifecycle,
    agentDirectories,
    agentResume: {
      tryResumeStream: tryResumeFromResumeData,
    },
    toolAvailability: {
      ...NO_TOOL_AVAILABILITY_HOST,
      isVscodeExtensionInstalled,
    },
    languageModel,
    toolMissingHandler: async (message, openDocsCommand) => {
      const actions = openDocsCommand ? ['View Installation Guide'] : [];
      logger.error('extension', message);
      const choice = await vscode.window.showErrorMessage(message, ...actions);
      if (choice === 'View Installation Guide' && openDocsCommand) {
        const [command, ...args] = openDocsCommand.split(',');
        void vscode.commands.executeCommand(command, ...args);
      }
    },
  });
  // TeXRA's account plane (subscription relay + ChatGPT sign-in). Without this
  // the model layer is bring-your-own-key. See installTexraModelAccess.
  installTexraModelAccess();
  const invalidateLanguageModels = () => {
    invalidateRuntimeModelRegistry();
    invalidateModelOptionsCache();
    appSignals.emit('languageModelsChanged', undefined);
  };
  context.subscriptions.push(
    languageModel.onDidChangeModels(invalidateLanguageModels),
    languageModel.onDidChangeAccess(invalidateLanguageModels),
  );
  // A broken transcript directory must not abort activation: degrade to an
  // in-memory store and say so, exactly as the CLI TUI does. The degraded
  // session also cannot resume — nothing is persisted for a later run to pick
  // up, and `SessionHandle` skips restart repair on a non-persistent store.
  const transcripts = await StreamLogStore.openOrEphemeral();
  if (transcripts.mode.kind === 'ephemeral') {
    void vscode.window.showWarningMessage(
      ephemeralTranscriptWarning(transcripts.mode.reason),
    );
  }
  const runtimeSession = initializeDefaultSession({
    transcripts,
    responseTextProcessing: texraResponseTextProcessing,
  });
  await runtimeSession.waitUntilReady();
  runtimeSession.setApprovalPolicy(
    readPersistedTexraApprovalPolicy((key, fallback) =>
      platform().config.get(key, fallback),
    ),
  );
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
    runtimeSession.flushArtifacts(),
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

  // Seed first-install defaults (e.g. disabled tools) before anything writes
  // LAST_KNOWN_VERSION, so upgrading users are not affected.
  await seedDisabledToolDefaults(GlobalStateKey.LAST_KNOWN_VERSION);

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
    try {
      const hasPriorInstall =
        context.globalState.get<string>(GlobalStateKey.LAST_KNOWN_VERSION) !==
        undefined;
      const [hasCredential, hasRunHistory] = await Promise.all([
        // Same non-blank provider-key/server-side-key check used by the
        // funnel and setup launch preflight.
        hasAnyUsableSetupCredential().catch(() => false),
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
    } catch (err) {
      logger.warn(
        'extension',
        `Onboarding firstRunDone backfill failed: ${toErrorMessage(err)}`,
      );
    }
  }

  // The following startup steps touch independent state, so they run
  // concurrently to shorten activation. Within the agent branch the order
  // still matters: copyDefaultAgents populates the built-in directories,
  // registerAgentDirectoryRoots exposes them, and loadAgents scans them.
  await Promise.all([
    (async () => {
      await copyDefaultAgents(context);
      await registerAgentDirectoryRoots(context);
      try {
        await loadAgents({ includeRemote: false });
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
        await migrateCopilotModelRouteSelections(globalSM);
        if (!skipped) {
          if (previousVersion !== currentVersion) {
            logger.info(
              'extension',
              `Model list version changed (${previousVersion ?? 'none'} -> ${currentVersion}), updating model list`,
            );
          }
          logger.info('extension', 'Model list refresh completed successfully');
          if (added.length > 0 || removed.length > 0) {
            invalidateModelOptionsCache();
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
      const authProvider = new SupabaseAuthProvider({
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
        // Not redundant with the shutdown hook: VS Code skips deactivate()
        // when activate() throws, but always disposes subscriptions.
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

  const progressViewProvider = new ProgressViewProvider(
    context,
    config,
    workspace,
  );
  await progressViewProvider.initialize();

  logger.info('extension', 'TeXRA extension activated');

  // Deferred off the activation tick: extendEnvPath() inside performs
  // synchronous glob probes of TeX install directories, which would
  // otherwise block activation on slow disks. (Never rejects — the body is
  // fully wrapped in try/catch.)
  setTimeout(() => void initializeLatexSupport(), 0);
  const mainViewProvider = registerCommands(context);
  // Wire the two sidebar surfaces to each other before anything can invoke a
  // placement command: `texra.showProgressView` is registered above and is
  // also the status bar item's command, and a progress view without its main
  // view provider would claim the sidebar placement without swapping content.
  progressViewProvider.setMainViewProvider(mainViewProvider);
  mainViewProvider.setProgressViewProvider(progressViewProvider);
  registerFileDecorations(context);

  setLeanLanguageServices(leanVscodeIntegration);
  setSetupPlatform({
    host: 'extension',
    signIn: async () =>
      (await vscode.commands.executeCommand<boolean>(AUTH_COMMANDS.SIGN_IN)) ===
      true,
    commands: {
      invoke: (cmd, ...args) =>
        Promise.resolve(vscode.commands.executeCommand(cmd, ...args)),
    },
    extensions: {
      isInstalled: isVscodeExtensionInstalled,
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
    // gates the GitHub PR subscription tool group. ProgressViewProvider owns
    // the ordered workspace-storage and native-config replacement.
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
  registerInlineCriticism(context);
  registerInlineComments(context);
  setInlineCommentProvider(getInlineCommentProvider());
  applyGitAuthorConfig();

  statusBarItem = vscode.window.createStatusBarItem(
    'texra.taskStatus',
    vscode.StatusBarAlignment.Left,
  );
  statusBarItem.name = 'TeXRA Tasks';
  statusBarItem.command = 'texra.showProgressView';
  statusBarItem.text = '$(bracket-dot) TeXRA: Idle';
  statusBarItem.tooltip = 'Open the TeXRA Progress view';
  statusBarItem.accessibilityInformation = {
    label: 'TeXRA tasks, idle',
  };
  statusBarItem.show();

  apiKeyStatusBarItem = vscode.window.createStatusBarItem(
    'texra.setupStatus',
    vscode.StatusBarAlignment.Left,
  );
  apiKeyStatusBarItem.name = 'TeXRA Setup';
  context.subscriptions.push(apiKeyStatusBarItem);
  const apiKeyStatusRefreshQueue = new PQueue({ concurrency: 1 });
  // Serial execution ensures the last refresh sees the newest credential
  // state and is the last one to update the UI. `add` widens to
  // `T | void` to cover abort via signal/timeout; we pass neither, so the
  // task always runs and resolves with `void`.
  const queueApiKeyStatusRefresh = (): Promise<void> =>
    apiKeyStatusRefreshQueue.add(refreshApiKeyStatus) as Promise<void>;
  const safeRefreshApiKeyStatus = () =>
    queueApiKeyStatusRefresh().catch((err) =>
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
  context.subscriptions.push({
    dispose: appSignals.on('includedModelAccessChanged', () => {
      void safeRefreshApiKeyStatus();
    }),
  });

  const statusBarSession = defaultSession();
  const statusBarUsageTracker = new StatusBarUsageTracker(
    statusBarSession.status,
    statusBarSession.snapshots,
  );
  const updateStatusBarTooltip = () => {
    if (!statusBarItem) return;
    const policy = statusBarSession.approvalPolicy;
    const policyLabel =
      TEXRA_APPROVAL_POLICY_OPTIONS.find((option) => option.value === policy)
        ?.label ?? policy;
    const policyLine = `Approval policy: ${policyLabel} — ${formatTexraApprovalPolicy(policy)}`;
    const { cost, inputTokens, outputTokens } =
      statusBarUsageTracker.totalUsage;
    if (cost === 0 && inputTokens === 0 && outputTokens === 0) {
      statusBarItem.tooltip = `${policyLine}\n\nOpen the TeXRA Progress view`;
      return;
    }
    const tip = new vscode.MarkdownString(
      [
        policyLine,
        '',
        '| TeXRA usage | |',
        '| --- | ---: |',
        `| Cost | $${cost.toFixed(4)} |`,
        `| Input tokens | ${inputTokens.toLocaleString()} |`,
        `| Output tokens | ${outputTokens.toLocaleString()} |`,
        '',
        '*Click to open the Progress view*',
      ].join('\n'),
    );
    tip.isTrusted = false;
    statusBarItem.tooltip = tip;
  };
  const updateStatusBarText = () => {
    if (!statusBarItem) return;
    const count = statusBarUsageTracker.activeStreamCount;
    if (count > 1) {
      statusBarItem.text = `$(loading~spin) TeXRA: ${count} active`;
      statusBarItem.accessibilityInformation = {
        label: `TeXRA tasks, ${count} active`,
      };
    } else if (count === 1) {
      statusBarItem.text = '$(loading~spin) TeXRA: Running';
      statusBarItem.accessibilityInformation = {
        label: 'TeXRA tasks, one active',
      };
    } else {
      statusBarItem.text = '$(bracket-dot) TeXRA: Idle';
      statusBarItem.accessibilityInformation = {
        label: 'TeXRA tasks, idle',
      };
    }
  };

  const disposeStatusListener = subscribeStatusBarSessionEvents({
    session: statusBarSession,
    onStatusChanged: () => {
      updateStatusBarTooltip();
      updateStatusBarText();
    },
    // The snapshot store accumulates the per-round deltas; the tracker
    // projects the running streams' totals from it on each refresh.
    onUsageChanged: updateStatusBarTooltip,
  });
  // Paint the policy line immediately; otherwise the tooltip shows the
  // generic "Show TeXRA Tasks" text until the first status/usage event.
  updateStatusBarTooltip();
  // Workspace transitions and approval-policy setting updates emit on this
  // signal; the subscription here is what makes the refresh reachable, so a
  // missed subscribe is a missing behavior rather than a silent no-op.
  const disposeApprovalPolicyTooltipRefresh = appSignals.on(
    'approvalPolicyChanged',
    updateStatusBarTooltip,
  );

  // Surface curated research tools to VS Code's Language Model Tool API
  // (Copilot Chat `#texra_*` references).
  registerLanguageModelTools(context);

  context.subscriptions.push(
    { dispose: disposeStatusListener },
    { dispose: disposeApprovalPolicyTooltipRefresh },
    statusBarItem,
    // Registered here rather than through the shared command registry because
    // the handler closes over this activation's status-bar refresh queue.
    vscode.commands.registerCommand('texra.refreshApiKeyStatus', async () => {
      await queueApiKeyStatusRefresh();
      // Credential facts changed (set/unset API key from any entry point —
      // palette, walkthrough, welcome card), so the onboarding funnel must
      // recompute too: the State 0 card has no other signal when a key is
      // added outside the main view's own round-trip.
      await mainViewProvider.refreshOnboardingFunnel().catch((err) => {
        logger.warn(
          'extension',
          `Onboarding funnel refresh failed: ${toErrorMessage(err)}`,
        );
      });
    }),
  );

  // Gating commandPalette / keybindings / menus / views on `texra.activated`
  // keeps them hidden until every command handler is registered. This must run
  // after ALL `registerCommand` calls in this function (including the late one
  // for `texra.refreshApiKeyStatus`), otherwise palette entries can fire before
  // their handlers exist and produce "command not found" errors.
  await vscode.commands.executeCommand('setContext', 'texra.activated', true);

  const welcomeKey = 'texra.welcomeShown';
  if (!context.globalState.get<boolean>(welcomeKey)) {
    // Land first-run users on the main welcome card so the credential choice
    // (ChatGPT subscription first) is the first real action, then open the
    // walkthrough alongside for the rest of the onboarding tips.
    void vscode.commands
      .executeCommand('texra.showMainView')
      .then(() =>
        vscode.commands.executeCommand(EXTENSION_COMMANDS.OPEN_GETTING_STARTED),
      )
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
