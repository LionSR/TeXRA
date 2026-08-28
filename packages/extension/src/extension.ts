// Node imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';
import PQueue from 'p-queue';

// Local imports
import { loadAgents } from '@agent/index';
import { clearStoreCache, listExecutions } from '@agent/storage';
import { registerAgentFeatures } from '@agent/features';
import {
  agentResponseTextConnector,
  defaultSession,
  initializeBundledPrompts,
  initializeDefaultSession,
  teardownDefaultSession,
} from '@agent/runtime';
import { AUTH_COMMANDS, AUTH_PROVIDER_ID } from '@auth/constants';
import { setRuntimeExtensionId } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { setApiKey as apiSetApiKey } from '@commands/api/apiKeyCommands';
import { signIn as authSignIn } from '@commands/auth/authCommands';
import { hasAnyUsableSetupCredential } from '@commands/setup/setupAssistantCommand';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import { createSampleProjectWithoutWorkspace } from '@commands/system/sampleProjectCommands';
import { tryResumeFromResumeData } from '@commands/agent/resumeFromResumeData';
import { isFileNotFoundError } from '@common/errors';
import { SIDEBAR_VIEWS, setActiveSidebarView } from '@common/webview';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import { appSignals } from '@eventBus/AppSignals';
import { SecretManager } from '@frontend/secretManager';
import {
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
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { SupabaseUriHandler } from '@frontend/auth/UriHandler';
import { createLanguageModelPort } from '@frontend/lm/createLanguageModelPort';
import { registerLanguageModelTools } from '@frontend/lm/registerLanguageModelTools';
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import {
  clearVscodeLeanServerEntries,
  vscodeLeanLanguageServices,
} from '@frontend/lean/VscodeIntegration';
import { applyGitAuthorConfig } from '@frontend/git/gitAuthorSetup';
import { resolveGitCommonRoot } from '@frontend/git/resolveGitRoot';
import { registerInlineCriticism } from '@frontend/latex/inlineCriticism';
import {
  getInlineCommentProvider,
  registerInlineComments,
} from '@frontend/comments/inlineComments';
import { VscodeSecrets } from '@frontend/vscode/vscodeSecrets';
import { createExtensionTexraConfig } from '@frontend/vscode/texraConfig';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { createLog, setOutputChannelFactory } from '@logger/logUtils';
import { redactSecrets } from '@logger/redaction';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { refreshModelListAndLog } from '@model/modelListRefresh';
import { invalidateRuntimeModelRegistry } from '@model/runtimeModelRegistry';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import { initPlatform } from '@platform/platform';
import {
  bootstrapNodeAgentDirectories,
  createNodePlatform,
  initializeNodeRuntimeSkills,
} from '@platform/defaults/nodeHost';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorktreeStateStore } from '@platform/defaults/worktreeStateStore';
import {
  formatTexraApprovalPolicy,
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type { CommandId } from '@shared/commands/catalog';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { backfillFirstRunDone } from '@shared/state/onboardingState';
import { UsageLogService } from '@telemetry/UsageLogService';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';
import { setSetupPlatform } from '@tools/setup';
import {
  refreshToolAvailability,
  seedDisabledToolDefaults,
} from '@tools/toolAvailability';
import { gitHubTokenRejectedMessage } from '@tools/github/githubAuth';
import { killActiveRecording } from '@tools/media/audio';
import { setLeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { setInlineCommentProvider } from '@tools/comment/InlineCommentTool';
import { ephemeralTranscriptWarning, StreamLogStore } from '@transcript';
import { readPlatformSetting } from '@utils/config/platformSettings';
import { StorageFS } from '@utils/files/storageFS';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { registerCommands } from './commands';

const log = createLog('extension');
const authLog = createLog('SupabaseAuthProvider');

let statusBarItem: vscode.StatusBarItem | undefined;
let apiKeyStatusBarItem: vscode.StatusBarItem | undefined;
// Re-instantiated on every activate(): runShutdown() trips an internal
// idempotency flag, so a stale module-level instance would silently swallow
// handlers registered by a second activate() in the same process.
let lifecycleHost: LifecycleHost | undefined;
let extensionShutdownPromise: Promise<void> | undefined;

function shutdownExtension(): Promise<void> {
  if (extensionShutdownPromise) return extensionShutdownPromise;

  const host = lifecycleHost;
  const shutdownPromise = (async () => {
    try {
      await host?.runShutdown();
    } finally {
      if (lifecycleHost === host) lifecycleHost = undefined;
      teardownDefaultSession();
    }
  })();
  extensionShutdownPromise = shutdownPromise;
  const clearShutdownPromise = () => {
    if (extensionShutdownPromise === shutdownPromise) {
      extensionShutdownPromise = undefined;
    }
  };
  void shutdownPromise.then(clearShutdownPromise, clearShutdownPromise);
  return shutdownPromise;
}

function installUnhandledRejectionSurface(
  subscriptions: vscode.Disposable[],
): void {
  const report = (error: unknown) => {
    log.error('Unhandled extension-host rejection', { data: error });
    void vscode.window
      .showErrorMessage(
        `The extension host encountered an unrecoverable error: ${redactSecrets(toErrorMessage(error))}`,
      )
      .then(undefined, (notificationError: unknown) => {
        log.error('Failed to display unhandled rejection error', {
          data: notificationError,
        });
      });
    // Installing an unhandled-rejection listener otherwise suppresses Node's
    // default fatal path. The host must not continue after an unowned failure.
    setImmediate(() => {
      throw ensureError(error);
    });
  };
  process.on('unhandledRejection', report);
  subscriptions.push({
    dispose: () => process.off('unhandledRejection', report),
  });
}

async function refreshApiKeyStatus() {
  if (!apiKeyStatusBarItem) {
    return;
  }

  // Use the same credential predicate as the setup assistant and onboarding
  // funnel, so ChatGPT subscription and direct API keys agree about whether the
  // first-run CTA should remain visible. Account sign-in is deliberately not in
  // that set: it serves the remote-agent catalog, not model access.
  const exists = await hasAnyUsableSetupCredential();
  if (!exists) {
    statusBarItem?.hide();
    apiKeyStatusBarItem.text = '$(rocket) TeXRA: Get Started';
    apiKeyStatusBarItem.tooltip =
      'Click to run the setup assistant — use ChatGPT or add a provider key';
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

/**
 * Workspace-bound commands the getting-started walkthrough exposes as buttons.
 * The walkthrough opens right after install even when no folder is open — the
 * state where activation stops at the welcome view and never reaches
 * `registerCommands` — so without fallbacks every one of these buttons is a
 * dead click. The credential commands are registered for real in that state
 * (sign-in needs no folder); these need the workspace-backed platform, so each
 * fallback says why nothing can run yet and offers the two ways forward.
 */
const WALKTHROUGH_COMMANDS_NEEDING_WORKSPACE = [
  EXTENSION_COMMANDS.RUN_SETUP_ASSISTANT,
  'texra.showMultiAgent',
  'texra.showMainView',
  'texra.extractTikzFigures',
  'texra.execute',
  'texra.showProgressView',
  'texra.cleanOutput',
  'texra.cleanBuild',
] as const satisfies readonly CommandId[];

async function explainWorkspaceRequired(extensionPath: string): Promise<void> {
  const openFolder = 'Open Folder';
  const createSample = 'Create Sample Project';
  const choice = await vscode.window.showInformationMessage(
    'TeXRA agents run inside a single-folder workspace. Open your LaTeX project folder or create the sample project first.',
    openFolder,
    createSample,
  );
  if (choice === openFolder) {
    await vscode.commands.executeCommand('workbench.action.files.openFolder');
  } else if (choice === createSample) {
    await createSampleProjectWithoutWorkspace(extensionPath);
  }
}

/**
 * Register the TeXRA account (Supabase) authentication provider and its OAuth
 * URI handler. Both activation paths run this: signing in stores the session
 * in SecretStorage, which needs no workspace, so the welcome (no-folder) path
 * offers the same sign-in the full path does.
 */
function registerSupabaseAuth(context: vscode.ExtensionContext): void {
  try {
    setRuntimeExtensionId(context.extension.id);
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
              authLog.error(
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

    log.info('Supabase authentication provider registered');
  } catch (error) {
    SupabaseClient.setInitError(ensureError(error));
    log.error(
      `Failed to initialize Supabase authentication: ${toErrorMessage(error)}`,
    );
  }
}

export async function activate(context: vscode.ExtensionContext) {
  try {
    await activateExtension(context);
  } catch (activationError) {
    if (lifecycleHost !== undefined) {
      try {
        await shutdownExtension();
      } catch (cleanupError) {
        log.error('Extension cleanup after failed activation failed', {
          data: cleanupError,
        });
      }
    }
    throw activationError;
  }
}

async function activateExtension(context: vscode.ExtensionContext) {
  installUnhandledRejectionSurface(context.subscriptions);
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length !== 1) {
    registerWelcomeView(context);
    // Credential-only platform. Every sign-in path stores into SecretStorage
    // (`platform().secrets`) and the global `~/.texra` config — none of it
    // needs a folder — so the walkthrough's credential buttons work before
    // one is open. Agents still require the workspace-backed platform below;
    // opening a folder reloads the window into that path (welcomeView.ts).
    const lifecycle = createLifecycleHost({
      onError: (phase, error) =>
        log.error(`Lifecycle ${phase} handler failed`, { data: error }),
    });
    lifecycleHost = lifecycle;
    agentDirectories.initialize();
    const storage = createNodeStorageProvider();
    const config = await createExtensionTexraConfig(storage, undefined);
    initPlatform(
      createNodePlatform({
        config,
        globalState: context.globalState,
        workspaceState: context.workspaceState,
        getWorkspacePath: () => undefined,
        storage,
        secrets: new VscodeSecrets(context),
        lifecycle,
        agentDirectories,
        agentResume: {
          tryResumeStream: tryResumeFromResumeData,
        },
      }),
    );
    registerSupabaseAuth(context);
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
      vscode.commands.registerCommand(AUTH_COMMANDS.SIGN_IN, () =>
        authSignIn(),
      ),
      vscode.commands.registerCommand('texra.auth.chatgpt.signIn', () =>
        signInWithSubscription('welcomeView', 'chatgpt'),
      ),
      // No settings view exists before a folder is open, so there is no
      // credential surface to refresh after the key write.
      vscode.commands.registerCommand(EXTENSION_COMMANDS.SET_API_KEY, () =>
        apiSetApiKey(async () => {}),
      ),
      ...WALKTHROUGH_COMMANDS_NEEDING_WORKSPACE.map((command) =>
        vscode.commands.registerCommand(command, () =>
          explainWorkspaceRequired(context.extensionPath),
        ),
      ),
    );
    return;
  }
  const rawWorkspacePath = () =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const workspace = createNodeWorkspace(rawWorkspacePath);
  const workspaceRoot = workspace.getWorkspacePath();
  if (!workspaceRoot) return;

  try {
    process.loadEnvFile(path.join(workspaceRoot, '.env'));
  } catch (error) {
    // A workspace without a .env is the normal case; any other failure
    // (EACCES, ERR_INVALID_ARG_TYPE) stays loud instead of silently dropping it.
    if (!isFileNotFoundError(error)) throw error;
  }
  setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
  const gitRepoRoot = await resolveGitCommonRoot(workspaceRoot);

  agentDirectories.initialize();
  setOutputChannelFactory((name) => vscode.window.createOutputChannel(name));
  initializeBundledPrompts(path.join(context.extensionPath, 'resources'));
  const workspaceState = gitRepoRoot
    ? new WorktreeStateStore(
        context.workspaceState,
        context.globalState,
        gitRepoRoot,
      )
    : context.workspaceState;
  const lifecycle = createLifecycleHost({
    onError: (phase, error) =>
      log.error(`Lifecycle ${phase} handler failed`, {
        data: error,
      }),
  });
  lifecycleHost = lifecycle;
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => clearVscodeLeanServerEntries());
  const languageModel = createLanguageModelPort(context);
  // Shared `~/.texra` storage root (one history across CLI/desktop/extension,
  // #8622).
  const storage = createNodeStorageProvider({
    workspacePath: workspace.getWorkspacePath(),
  });
  const config = await createExtensionTexraConfig(
    storage,
    workspace.getWorkspacePath(),
  );
  // Shared by the `Platform` tool-availability port and the setup platform's
  // extensions port, which both answer the same question.
  const isVscodeExtensionInstalled = (id: string) =>
    vscode.extensions.getExtension(id) !== undefined;
  initPlatform(
    createNodePlatform({
      config,
      globalState: context.globalState,
      workspaceState,
      getWorkspacePath: rawWorkspacePath,
      storage,
      secrets: new VscodeSecrets(context),
      lifecycle,
      agentDirectories,
      agentResume: {
        tryResumeStream: tryResumeFromResumeData,
      },
      toolAvailability: { isVscodeExtensionInstalled },
      languageModel,
      toolMissingHandler: async (message, openDocsCommand) => {
        const actions = openDocsCommand ? ['View Installation Guide'] : [];
        log.error(message);
        const choice = await vscode.window.showErrorMessage(
          message,
          ...actions,
        );
        if (choice === 'View Installation Guide' && openDocsCommand) {
          const [command, ...args] = openDocsCommand.split(',');
          void vscode.commands.executeCommand(command, ...args);
        }
      },
    }),
  );
  // TeXRA's account probes (Codex/xAI subscription eligibility). Without this
  // the model layer is bring-your-own-key. See installTexraAccountProbes.
  installTexraAccountProbes();
  const invalidateLanguageModels = () => {
    invalidateRuntimeModelRegistry();
    invalidateModelOptionsCache();
    appSignals.emit('languageModelsChanged', undefined);
  };
  context.subscriptions.push(
    languageModel.onDidChange(invalidateLanguageModels),
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
    responseTextProcessing: createTexraResponseTextProcessing(
      agentResponseTextConnector,
    ),
  });
  // `disposeStatusListener` and `statusBarItem` are owned solely by
  // `context.subscriptions` (see the push near the end of `activate`), matching
  // `apiKeyStatusBarItem`. Registering them here too would double-dispose.
  registerRuntimeShutdownHandlers(lifecycle, {
    afterAgentShutdown: [
      () => killActiveRecording(),
      () => UsageLogService.dispose(),
    ],
    flushArtifacts: () => runtimeSession.flushArtifacts(),
    afterExecutionSettlement: [
      () => clearStoreCache(),
      () => disposeDiffRefresh(),
    ],
  });
  await runtimeSession.waitUntilReady();
  runtimeSession.setApprovalPolicy(
    readPlatformSetting<TexraApprovalPolicy>(TEXRA_APPROVAL_POLICY_CONFIG_KEY),
  );
  registerAgentFeatures();
  // The same Node-host skill wiring the CLI and desktop use, so
  // `AVAILABLE_SKILLS` is actually populated for tool-use agents in VS Code —
  // without this call `loadRuntimeSkillCatalog` always sees zero sources and
  // `texra.skills.enabled` has no observable effect (issue #7751 FS5).
  // (`initNodeAgentRuntime`, which registers the direct Lean adapter, stays
  // out: VS Code drives Lean through its own integration.)
  initializeNodeRuntimeSkills({
    cwd: workspaceRoot,
    resourcesPath: path.join(context.extensionPath, 'resources'),
  });
  await StorageFS.ensureDir(RUNS_STORAGE_DIR);
  FileLister.initialize(context);

  // Seed first-install defaults (e.g. disabled tools) before anything writes
  // LAST_KNOWN_VERSION, so upgrading users are not affected.
  await seedDisabledToolDefaults(GlobalStateKey.LAST_KNOWN_VERSION);

  // Onboarding-funnel backfill (PRD: agent-native onboarding): upgraders who
  // already have a credential or run history must never see the welcome card
  // or the preselected setup agent, so firstRunDone is backfilled once when
  // the flag first appears. Awaited: the main view's funnel derivation reads this flag
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
      // Neither probe is masked: a failed probe must not be recorded as
      // "false" in a one-shot key. A rejection lands in the catch below,
      // which logs the cause and leaves the key unset so the next
      // activation re-evaluates.
      const [hasCredential, hasRunHistory] = await Promise.all([
        // Same non-blank provider-key/server-side-key check used by the
        // funnel and setup launch preflight.
        hasAnyUsableSetupCredential(),
        listExecutions().then((entries) => entries.length > 0),
      ]);
      await backfillFirstRunDone(context.globalState, {
        hasCredential,
        hasPriorInstall,
        hasRunHistory,
      });
    } catch (err) {
      log.warn(
        `Onboarding firstRunDone backfill failed: ${toErrorMessage(err)}`,
      );
    }
  }

  // The following startup steps touch independent state, so they run
  // concurrently to shorten activation. Within the agent branch the order
  // still matters: the bundled-agent reconciliation populates the built-in
  // directories, registerAgentDirectoryRoots exposes them, and loadAgents
  // scans them.
  await Promise.all([
    (async () => {
      await bootstrapNodeAgentDirectories({
        channel: 'extension',
        resourcesPath: path.join(context.extensionPath, 'resources'),
        currentVersion: vscode.extensions.getExtension(context.extension.id)
          ?.packageJSON.version,
        versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
      });
      await registerAgentDirectoryRoots(context);
      try {
        await loadAgents({ includeRemote: false });
        void loadAgents().catch((err) => {
          log.warn(`Remote agent refresh failed: ${toErrorMessage(err)}`);
        });
      } catch (err) {
        log.error(`Failed to initialize agent index: ${toErrorMessage(err)}`);
      }
    })(),
    (async () => {
      try {
        const { currentVersion, previousVersion, skipped, messages } =
          await refreshModelListAndLog(context.globalState);
        if (!skipped) {
          if (previousVersion !== currentVersion) {
            log.info(
              `Model list version changed (${previousVersion ?? 'none'} -> ${currentVersion}), updating model list`,
            );
          }
          log.info('Model list refresh completed successfully');
        }
        for (const message of messages) log.info(message);
      } catch (err) {
        log.error(`Failed to refresh model list: ${toErrorMessage(err)}`);
      }
    })(),
  ]);

  registerSupabaseAuth(context);

  // Usage logging is a runtime service, not an authentication-provider
  // capability. Initialize it even when Supabase sign-in is not configured,
  // matching desktop and CLI; the service itself decides which records can be
  // sent and preserves plan-accounting records for hosted routes.
  const extensionVersion =
    typeof context.extension.packageJSON?.version === 'string'
      ? context.extension.packageJSON.version
      : undefined;
  try {
    UsageLogService.initialize(
      {},
      extensionVersion,
      vscode.env.appName || undefined,
    );
  } catch (error) {
    log.warn(`Failed to initialize usage logging: ${toErrorMessage(error)}`);
  }

  const progressViewProvider = new ProgressViewProvider(context);
  await progressViewProvider.initialize();

  log.info('TeXRA extension activated');

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

  setLeanLanguageServices(vscodeLeanLanguageServices);
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
    log.error(
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
      const rejected = gitHubTokenRejectedMessage(message);
      log.error(rejected);
      void vscode.window
        .showErrorMessage(rejected, 'Open Git settings')
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
      log.error(`API key status refresh failed: ${toErrorMessage(err)}`),
    );
  void safeRefreshApiKeyStatus();
  // Without this listener the pill stayed on "Get Started" forever after
  // a sign-in or after the first API key was stored.
  onTexraAuthSessionsChanged(context, () => {
    void safeRefreshApiKeyStatus();
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
  // Approval-policy setting updates emit on this signal; the subscription
  // here is what makes the refresh reachable, so a missed subscribe is a
  // missing behavior rather than a silent no-op.
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
        log.warn(`Onboarding funnel refresh failed: ${toErrorMessage(err)}`);
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
  await shutdownExtension();
}
