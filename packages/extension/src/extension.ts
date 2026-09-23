// Node imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';
import { Cause, Data, Effect, Exit, Layer, Scope } from 'effect';

// Local imports
import { loadAgents } from '@agent/index';
import {
  createAgentResponseTextConnector,
  initializeDefaultSession,
  teardownDefaultSession,
  type SessionHandle,
} from '@agent/runtime';
import { callPort } from '@auth/authProgram';
import { AUTH_COMMANDS, AUTH_PROVIDER_ID } from '@auth/constants';
import { setRuntimeExtensionId } from '@auth/config';
import {
  createSupabaseAuth,
  unavailableSupabaseAuth,
  type SupabaseAuthShape,
} from '@auth/SupabaseAuth';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { setApiKey as apiSetApiKey } from '@commands/api/apiKeyCommands';
import { signIn as authSignIn } from '@commands/auth/authCommands';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import { createSampleProjectWithoutWorkspace } from '@commands/system/sampleProjectCommands';
import { tryResumeFromResumeData } from '@commands/agent/resumeFromResumeData';
import { isFileNotFoundError } from '@common/errors';
import { SIDEBAR_VIEWS, setActiveSidebarView } from '@common/webview';
import {
  disposeProcessRuntime,
  installProcessRuntime,
} from '@controllers/session/sessionLayer';
import { globalDatabaseLayer } from '@controllers/session/Database';
import {
  appStateStoreFromDatabase,
  openProjectStateStore,
} from '@controllers/session/appStateStore';
import { bootstrapHost } from '@controllers/hostBootstrap';
import { fromHost } from '@controllers/session/hostCallFailure';
import { emitAppSignal } from '@eventBus/AppSignals';
import { vscodeToolMissingReporter } from '@frontend/system/commandUtils';
import { subscribeAppSignal } from '@frontend/events/appSignalSubscriptions';
import { refreshApiKeyStatusBar } from '@frontend/statusBar/apiKeyStatusBar';
import { acquireVscodeLanguageModel } from '@frontend/lm/acquireVscodeLanguageModel';
import {
  initializeLatexSupport,
  registerAgentDirectoryRoots,
} from '@frontend/setup';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { FileLister } from '@frontend/files/fileLister';
import { StatusBarUsageTracker } from '@frontend/statusBar/StatusBarUsageTracker';
import { subscribeStatusBarSessionEvents } from '@frontend/statusBar/statusBarSessionEvents';
import { vscodeSetupPlatform } from '@frontend/vscodeSetupPlatform';
import { disposeDiffRefresh } from '@frontend/ui/diffView';
import { registerFileDecorations } from '@frontend/ui/fileDecorations';
import { registerWelcomeView } from '@frontend/ui/welcomeView';
import {
  SupabaseAuthProvider,
  AUTH_URI_HANDLER_NOT_INITIALIZED,
} from '@frontend/auth/SupabaseAuthProvider';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { SupabaseUriHandler } from '@frontend/auth/UriHandler';
import { createLanguageModelPort } from '@frontend/lm/createLanguageModelPort';
import { registerLanguageModelTools } from '@frontend/lm/registerLanguageModelTools';
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import { createVscodeLeanLanguageServices } from '@frontend/lean/VscodeIntegration';
import { resolveGitCommonRoot } from '@frontend/git/resolveGitRoot';
import { registerInlineCriticism } from '@frontend/latex/inlineCriticism';
import {
  getInlineCommentProvider,
  registerInlineComments,
} from '@frontend/comments/inlineComments';
import { createVsCodeLogSink } from '@frontend/vscode/vscodeLogSink';
import { VscodeSecrets } from '@frontend/vscode/vscodeSecrets';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { withLogChannel } from '@logger/effectLog';
import { createLog } from '@logger/logUtils';
import { setLogSink } from '@logger/logSink';
import { formatFatalErrorDetail } from '@logger/redaction';
import { invalidateApiKeyCache } from '@model/apiProviders';
import { invalidateRuntimeModelRegistry } from '@model/runtimeModelRegistry';
import { AppState, AgentDirectories } from '@platform/interfaces';
import type {
  AgentResumePort,
  LifecycleHost,
  ToolMissingHandler,
} from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import {
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
  type LanguageModelPort,
} from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import {
  RUNS_STORAGE_DIR,
  WorkspaceStorageProvider,
} from '@platform/defaults/workspaceStorage';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import { WorktreeStateStore } from '@platform/defaults/worktreeStateStore';
import { StorageFs, withSessionFs } from '@platform/rootedFs';
import {
  formatTexraApprovalPolicy,
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type { CommandId } from '@shared/commands/catalog';
import { GlobalDatabase } from '@shared/session/database';
import { usageLogLayer } from '@telemetry/UsageLogService';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';
import { refreshToolAvailability } from '@tools/toolAvailability';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  gitHubTokenRejectedMessage,
} from '@tools/github/githubAuth';
import { killActiveRecording } from '@tools/media/audio';
import { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { sessionStoreClearedMessage } from '@ui/copy/sessionStore';
import { readSettingFrom } from '@utils/config/platformSettings';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { registerCommands } from './commands';

const EXTENSION_CHANNEL = 'extension';
const log = createLog(EXTENSION_CHANNEL);

/** The TeXRA account provider and its URI handler could not be registered. */
class SupabaseAuthRegistrationFailed extends Data.TaggedError(
  'SupabaseAuthRegistrationFailed',
)<{ readonly cause: unknown }> {}

/**
 * The OAuth readiness gate the account plane's `isReady` probe awaits. Built
 * with the plane in `initVscodePlatform` and flipped by `registerSupabaseAuth`
 * once the URI handler is installed, so a sign-in attempted before that
 * reports the handler as not initialized.
 */
interface AuthReadinessGate {
  uriHandlerInstalled: boolean;
}

/** The workspace `.env` file could not be read into the process env. */
class WorkspaceEnvFileUnreadable extends Data.TaggedError(
  'WorkspaceEnvFileUnreadable',
)<{ readonly cause: unknown }> {}

let statusBarItem: vscode.StatusBarItem | undefined;
let apiKeyStatusBarItem: vscode.StatusBarItem | undefined;
// Re-instantiated on every activate(): the drain trips an internal
// idempotency flag, so a stale module-level instance would silently swallow
// handlers registered by a second activate() in the same process.
let lifecycleHost: LifecycleHost | undefined;
// VS Code invokes activation and deactivation separately. Only this entry
// reads back their shared runtime and project scope; consumers receive values.
let processRuntime: ProcessRuntime | undefined;
let projectScope: Scope.Closeable | undefined;
let extensionShutdownPromise: Promise<void> | undefined;

/**
 * The process runtime and the process roots, wired once for
 * both activation paths: the credential-only path without a folder and the
 * workspace path, which adds the ports only a folder can answer.
 *
 * Registered surfaces receive the ports and roots this entry owns.
 */
async function initVscodePlatform(
  context: vscode.ExtensionContext,
  lifecycle: LifecycleHost,
  workspaceRoot: string | undefined,
  gitRepoRoot: string | undefined,
  /** The session a resume request targets, read at request time: the
   *  platform must exist before `initializeDefaultSession` can run, so the
   *  session cannot be a value here. */
  getSession: () => SessionHandle,
  extras: {
    /** The editor's tool-missing UI, served as `ToolMissingReporter` below. */
    readonly toolMissingHandler?: ToolMissingHandler;
    /** The editor's LM bridge, served as `LanguageModel` below. */
    readonly languageModel?: LanguageModelPort;
  } = {},
): Promise<{
  secrets: PlatformSecrets;
  runtime: ProcessRuntime;
  auth: SupabaseAuthShape;
  authReadiness: AuthReadinessGate;
  roots: WorkspaceRoots;
}> {
  // `~/.texra` is one history across CLI/desktop/extension (#8622). The
  // process runtime precedes the config stores below, which open on it.
  const storage = new WorkspaceStorageProvider(
    DEFAULT_NODE_STORAGE_ROOT,
    workspaceRoot,
  );
  const secrets = new VscodeSecrets(context);
  const appState = Layer.effect(
    AppState,
    Effect.map(GlobalDatabase, (database) =>
      appStateStoreFromDatabase(storage.getGlobalStoragePath(), database),
    ),
  );
  const authReadiness: AuthReadinessGate = { uriHandlerInstalled: false };
  // A construction failure degrades to the unavailable plane instead of
  // failing activation: registration below records and reports the error, and
  // every probe answers signed-out.
  // The account plane and the process identity both resolve before the
  // runtime that serves them, on one pre-runtime run: an opener that uses the
  // synchronous `open` would otherwise face an asynchronous identity layer
  // build.
  const { auth, processStart } = await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* createSupabaseAuth({
        secrets,
        whenReady: () =>
          Effect.suspend(() =>
            authReadiness.uriHandlerInstalled
              ? Effect.void
              : Effect.fail(new Error(AUTH_URI_HANDLER_NOT_INITIALIZED)),
          ),
      }).pipe(
        Effect.catch((error) => Effect.succeed(unavailableSupabaseAuth(error))),
      );
      return { auth, processStart: yield* nodeProcesses.selfIdentity() };
    }),
  );
  // The resume port closes over the runtime installed just below: a resume
  // attempt runs on it, and the port is only invoked after activation has
  // returned. It is served as the runtime's `AgentResume` service.
  const agentResume: AgentResumePort = {
    tryResumeRun: (runId, recovery) =>
      tryResumeFromResumeData(runId, runtime, getSession(), recovery),
  };
  // Usage logging is a runtime service, not an authentication-provider
  // capability: it runs even when Supabase sign-in is not configured, as it
  // does on desktop and CLI, and the service itself decides which records can
  // be sent and preserves plan-accounting records for hosted routes.
  const extensionVersion =
    typeof context.extension.packageJSON?.version === 'string'
      ? context.extension.packageJSON.version
      : undefined;
  const runtime = installProcessRuntime({
    processStart: Effect.succeed(processStart),
    globalStorage: storage.getGlobalStoragePath(),
    secrets,
    appState,
    auth,
    // The editor's LM API on the workspace path, unavailable on the
    // credential-only one. The one defaulting site for this host.
    languageModel: extras.languageModel ?? UNAVAILABLE_LANGUAGE_MODEL_PORT,
    agentResume,
    agentDirectories: AgentDirectories.layer(agentDirectories),
    lifecycle,
    toolMissingReporter: extras.toolMissingHandler,
    setup: vscodeSetupPlatform,
    // The editor's language models, so the run layer binds `vscode-lm`
    // models on this host (R2); consent was granted from the settings view.
    editorModel: {
      acquire: (configuration) =>
        acquireVscodeLanguageModel(context, configuration),
    },
    // The Comments UI behind the `inline_comment` tool. The provider reads
    // the controller this host registers at activation, so it is a value
    // from module load; nothing about it waits on that registration.
    inlineComments: getInlineCommentProvider(),
    // Lean through the Lean 4 extension, not a direct `lake` pool.
    lean: Layer.effect(
      LeanLanguageServices,
      Effect.map(AppState, createVscodeLeanLanguageServices),
    ),
    usageLog: usageLogLayer({
      version: extensionVersion,
      editorType: vscode.env.appName || undefined,
    }),
    // The process's one handle on that same global root: the inquiry
    // threads, the update check and the CLI-shared input history read
    // through it for as long as this runtime lives.
    globalDatabase: globalDatabaseLayer(storage.getGlobalStoragePath()),
    // The Output channel owns filtering, so emit every level.
    minimumLogLevel: 'Trace',
  });
  processRuntime = runtime;
  const scope = Scope.makeUnsafe();
  projectScope = scope;
  const { globalState, workspaceState } = await runtime.runPromise(
    Effect.gen(function* () {
      const globalState = yield* AppState;
      const projectState = yield* openProjectStateStore(
        storage.getStoragePath(),
      );
      return {
        globalState,
        workspaceState: gitRepoRoot
          ? new WorktreeStateStore(projectState, globalState, gitRepoRoot)
          : projectState,
      };
    }).pipe(Scope.provide(scope)),
  );
  // VS Code restarts the extension host when the first workspace folder
  // changes, so the configuration stores stay pinned for this process.
  const config = new JsonConfigProvider(
    await runtime.runPromise(
      openTexraConfigStores(storage, workspaceRoot, (message) =>
        log.warn(message),
      ),
    ),
  );
  const roots = createNodeWorkspaceRoots({
    workspacePath: workspaceRoot,
    storage: storage.getStoragePath(),
    globalStorage: storage.getGlobalStoragePath(),
    config,
    workspaceState,
    globalState,
  });
  // Everything this process installs once after its roots exist, in the
  // order the shared bootstrap owns for all three hosts.
  await runtime.runPromise(
    bootstrapHost({
      host: 'vscode',
      roots,
      secrets,
      skills: { resourcesPath: path.join(context.extensionPath, 'resources') },
    }),
  );
  return { secrets, runtime, auth, authReadiness, roots };
}

function shutdownExtension(): Promise<void> {
  if (extensionShutdownPromise) return extensionShutdownPromise;

  const host = lifecycleHost;
  const runtime = processRuntime;
  const scope = projectScope;
  // `deactivate` is this host's R1 entry: one run for the drain and the
  // teardown that follows it however it ends. Not on the process runtime —
  // this is the path that disposes it.
  const shutdownPromise = Effect.runPromise(
    (host?.runShutdown ?? Effect.void).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          if (lifecycleHost === host) lifecycleHost = undefined;
          // Activation can fail before installing a runtime or a session.
          if (!runtime) return Effect.void;
          return teardownDefaultSession().pipe(
            Effect.ensuring(
              scope ? Scope.close(scope, Exit.void) : Effect.void,
            ),
            Effect.ensuring(disposeProcessRuntime(runtime)),
            Effect.ensuring(
              Effect.sync(() => {
                if (processRuntime === runtime) processRuntime = undefined;
                if (projectScope === scope) projectScope = undefined;
              }),
            ),
          );
        }),
      ),
    ),
  );
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
        `The extension host encountered an unrecoverable error: ${formatFatalErrorDetail(error)}`,
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

/**
 * Workspace-bound commands the getting-started walkthrough exposes as buttons.
 * Their links invoke one bridge command so a no-workspace click can explain
 * the prerequisite without firing the real command's `onCommand` completion
 * event.
 */
const WALKTHROUGH_COMMANDS_NEEDING_WORKSPACE = [
  EXTENSION_COMMANDS.RUN_SETUP_ASSISTANT,
  'texra.showMultiAgent',
  'texra.showMainView',
  'texra.extractTikzFigures',
  'texra.execute',
  'texra.showProgressView',
  'texra.cleanBuild',
] as const satisfies readonly CommandId[];

/** Internal command URI used by workspace-bound walkthrough links. */
const WALKTHROUGH_WORKSPACE_ACTION_COMMAND = 'texra.walkthroughWorkspaceAction';

async function explainWorkspaceRequired(
  extensionPath: string,
  runtime: ProcessRuntime,
): Promise<void> {
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
    await createSampleProjectWithoutWorkspace(extensionPath, runtime);
  }
}

function registerWalkthroughWorkspaceAction(
  context: vscode.ExtensionContext,
  hasSingleWorkspace: boolean,
  runtime: ProcessRuntime,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      WALKTHROUGH_WORKSPACE_ACTION_COMMAND,
      async (
        command: (typeof WALKTHROUGH_COMMANDS_NEEDING_WORKSPACE)[number],
      ) => {
        if (hasSingleWorkspace) {
          await vscode.commands.executeCommand(command);
          return;
        }
        await explainWorkspaceRequired(context.extensionPath, runtime);
      },
    ),
  );
}

/**
 * Register the TeXRA account (Supabase) authentication provider and its OAuth
 * URI handler. Both activation paths run this: signing in stores the session
 * in SecretStorage, which needs no workspace, so the welcome (no-folder) path
 * offers the same sign-in the full path does.
 */
function registerSupabaseAuth(
  context: vscode.ExtensionContext,
  secrets: PlatformSecrets,
  runtime: ProcessRuntime,
  auth: SupabaseAuthShape,
  authReadiness: AuthReadinessGate,
): void {
  runtime.runSync(
    Effect.try({
      try: () => {
        setRuntimeExtensionId(context.extension.id);
        const authProvider = new SupabaseAuthProvider(
          {
            showError: (msg) => void vscode.window.showErrorMessage(msg),
            showInfo: (msg) => void vscode.window.showInformationMessage(msg),
            showSignInPrompt: (reason) =>
              callPort(async () => {
                const action = await vscode.window.showWarningMessage(
                  reason === 'expired'
                    ? 'Your TeXRA session has expired. Please sign in again to access AI models and remote agents.'
                    : 'Your TeXRA session is no longer valid. Please sign in again to access AI models and remote agents.',
                  'Sign In',
                );
                if (action !== 'Sign In') return;
                await vscode.commands.executeCommand('texra.auth.signIn');
              }),
          },
          secrets,
          runtime,
          auth,
        );
        context.subscriptions.push(
          vscode.authentication.registerAuthenticationProvider(
            AUTH_PROVIDER_ID,
            'TeXRA Account',
            authProvider,
            { supportsMultipleAccounts: false },
          ),
        );

        const uriHandler = new SupabaseUriHandler();
        context.subscriptions.push(
          vscode.window.registerUriHandler(uriHandler),
        );
        authProvider.setUriHandler(uriHandler);
        // The account plane's readiness probe gates on this: the URI handler
        // is what an OAuth callback arrives at, so sign-in is not "ready"
        // before it is installed.
        authReadiness.uriHandlerInstalled = true;

        log.info('Supabase authentication provider registered');
      },
      catch: (cause) => new SupabaseAuthRegistrationFailed({ cause }),
    }).pipe(
      Effect.catchTag('SupabaseAuthRegistrationFailed', (failure) =>
        Effect.sync(() => {
          auth.setInitError(ensureError(failure.cause));
          log.error(
            `Failed to initialize Supabase authentication: ${toErrorMessage(failure.cause)}`,
          );
        }),
      ),
    ),
  );
}

export async function activate(context: vscode.ExtensionContext) {
  // No runtime exists yet here: `activateExtension` is the call that installs
  // one, and the cleanup below is what disposes it, so this fold runs on the
  // context-free runner (the program needs no services). `onError` runs the
  // cleanup on a failed activation only, and re-fails with the same cause.
  const activation = await Effect.runPromiseExit(
    Effect.promise(() => activateExtension(context)).pipe(
      Effect.onError(() =>
        lifecycleHost === undefined
          ? Effect.void
          : Effect.promise(() => shutdownExtension()).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  'Extension cleanup after failed activation failed',
                ).pipe(
                  Effect.annotateLogs({ data: Cause.squash(cause) }),
                  withLogChannel(EXTENSION_CHANNEL),
                  // No runtime exists to hold the diagnostics layer yet, so
                  // the entry needs it provided to reach the host's sink.
                  Effect.provide(effectDiagnosticsLayer('Trace')),
                ),
              ),
            ),
      ),
    ),
  );
  // The squashed cause is the activation's own thrown value, so the failure
  // VS Code reports keeps the original error and its stack.
  if (Exit.isFailure(activation)) throw Cause.squash(activation.cause);
}

async function activateExtension(context: vscode.ExtensionContext) {
  installUnhandledRejectionSurface(context.subscriptions);
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const hasSingleWorkspace = workspaceFolders?.length === 1;

  const lifecycle = createLifecycleHost();
  lifecycleHost = lifecycle;

  /**
   * The wiring both activation shapes settle once their platform exists, in
   * the order they settle it. One owner, so the credential-only path and the
   * workspace-backed path cannot drift apart.
   */
  const wirePostPlatform = (
    secrets: PlatformSecrets,
    runtime: ProcessRuntime,
    auth: SupabaseAuthShape,
    authReadiness: AuthReadinessGate,
    roots: WorkspaceRoots,
  ): void => {
    // After the platform above, which built the runtime the manager settles
    // its watcher rebuilds on.
    agentDirectories.initialize(
      roots.globalState,
      path.join(context.extensionPath, 'resources'),
      runtime,
    );
    registerSupabaseAuth(context, secrets, runtime, auth, authReadiness);
  };

  if (!hasSingleWorkspace) {
    registerWelcomeView(context);
    // Credential-only platform. Every sign-in path stores into SecretStorage
    // (the `Secrets` service) and the global `~/.texra` config — none of it
    // needs a folder — so the walkthrough's credential buttons work before
    // one is open. Agents still require the workspace-backed platform below;
    // opening a folder reloads the window into that path (welcomeView.ts).
    const { secrets, runtime, auth, authReadiness, roots } =
      await initVscodePlatform(
        context,
        lifecycle,
        undefined,
        undefined,
        // The credential-only path never initializes a session; a resume
        // request cannot arrive here because every run belongs to one.
        () => {
          throw new Error(
            'The credential-only activation has no session to resume into.',
          );
        },
      );
    wirePostPlatform(secrets, runtime, auth, authReadiness, roots);
    // The full command surface (including the workspace-backed
    // `texra.createSampleProject`) is only registered on the single-folder
    // path below, so the welcome view registers its own standalone variant:
    // a first-time user without a LaTeX project can create the sample and
    // land directly in a working workspace.
    context.subscriptions.push(
      vscode.commands.registerCommand(
        EXTENSION_COMMANDS.CREATE_SAMPLE_PROJECT,
        () =>
          createSampleProjectWithoutWorkspace(context.extensionPath, runtime),
      ),
      vscode.commands.registerCommand(
        EXTENSION_COMMANDS.OPEN_GETTING_STARTED,
        () => openGettingStarted(context.extension.id),
      ),
      vscode.commands.registerCommand(AUTH_COMMANDS.SIGN_IN, () =>
        runtime.runPromise(authSignIn),
      ),
      vscode.commands.registerCommand('texra.auth.chatgpt.signIn', () =>
        runtime.runPromise(
          signInWithSubscription(roots, 'welcomeView', 'chatgpt'),
        ),
      ),
      // No settings view exists before a folder is open, so there is no
      // credential surface to refresh after the key write.
      vscode.commands.registerCommand(EXTENSION_COMMANDS.SET_API_KEY, () =>
        apiSetApiKey(roots, secrets, () => Effect.void, runtime),
      ),
    );
    registerWalkthroughWorkspaceAction(context, false, runtime);
    return;
  }
  const rawWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!rawWorkspacePath) return;
  const workspaceRoot = canonicalizeWorkspacePath(rawWorkspacePath);

  Effect.runSync(
    Effect.try({
      try: () => process.loadEnvFile(path.join(workspaceRoot, '.env')),
      catch: (cause) => new WorkspaceEnvFileUnreadable({ cause }),
    }).pipe(
      // A workspace without a .env is the normal case; any other failure
      // (EACCES, ERR_INVALID_ARG_TYPE) stays loud instead of silently dropping
      // it: `runSync` throws the squashed defect, which is that same error.
      Effect.catchTag('WorkspaceEnvFileUnreadable', (failure) =>
        isFileNotFoundError(failure.cause)
          ? Effect.void
          : Effect.die(failure.cause),
      ),
    ),
  );
  setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
  const gitRepoRoot = await resolveGitCommonRoot(workspaceRoot);

  setLogSink(createVsCodeLogSink());
  // Deactivation releases the output channels with the sink, so a reload does
  // not leave a disposed host surface installed.
  context.subscriptions.push({ dispose: () => setLogSink(null) });
  const languageModel = createLanguageModelPort(context);
  const { secrets, runtime, auth, authReadiness, roots } =
    await initVscodePlatform(
      context,
      lifecycle,
      workspaceRoot,
      gitRepoRoot,
      // `runtimeSession` is created below; resume requests only arrive after
      // activation has composed it.
      () => runtimeSession,
      {
        languageModel,
        toolMissingHandler: vscodeToolMissingReporter,
      },
    );
  const { globalState } = roots;
  wirePostPlatform(secrets, runtime, auth, authReadiness, roots);
  // That registration precedes the fire-and-forget remote agent refresh below,
  // which reads the account plane's access token: with the provider in place
  // the refresh fetches the real catalog instead of short-circuiting on a null
  // token, so activation now performs that one background fetch.
  const invalidateLanguageModels = () => {
    invalidateRuntimeModelRegistry();
    emitAppSignal('languageModelsChanged', undefined);
  };
  context.subscriptions.push(
    languageModel.onDidChange(invalidateLanguageModels),
  );
  // The host entry holds the process runtime in a local and threads it to the
  // surfaces registered below, so code under `activate` settles its Effects on
  // the runtime it was handed instead of reading the global back.
  const runtimeSession = await runtime.runPromise(
    initializeDefaultSession({
      roots,
      responseTextProcessing: createTexraResponseTextProcessing(
        createAgentResponseTextConnector({ ...roots, secrets }, languageModel),
      ),
    }),
  );
  if (runtimeSession.storeCleared) {
    void vscode.window.showWarningMessage(
      sessionStoreClearedMessage(runtimeSession.storeCleared),
    );
  }
  // `disposeStatusListener` and `statusBarItem` are owned solely by
  // `context.subscriptions` (see the push near the end of `activate`), matching
  // `apiKeyStatusBarItem`. Registering them here too would double-dispose.
  registerRuntimeShutdownHandlers(lifecycle, {
    afterAgentShutdown: [killActiveRecording()],
    flushArtifacts: runtimeSession.settlePublications(),
    afterRunSettlement: [Effect.sync(() => disposeDiffRefresh())],
  });
  runtimeSession.setApprovalPolicy(
    await runtime.runPromise(
      readSettingFrom<TexraApprovalPolicy>(
        runtimeSession.roots,
        TEXRA_APPROVAL_POLICY_CONFIG_KEY,
      ),
    ),
  );
  // The run-storage directory of the session just initialized, through that
  // session's own storage view rather than a static that re-reads the root.
  await runtime.runPromise(
    withSessionFs(
      runtimeSession.roots,
      Effect.flatMap(Effect.service(StorageFs), (storageFs) =>
        storageFs.makeDirectory(RUNS_STORAGE_DIR, { recursive: true }),
      ),
    ),
  );
  FileLister.initialize(context, runtimeSession);

  // Order matters: registerAgentDirectoryRoots exposes the packaged built-in
  // directories, and loadAgents scans them.
  await runtime.runPromise(registerAgentDirectoryRoots(context));
  const agentIndex = await runtime.runPromiseExit(
    loadAgents({ includeRemote: false }),
  );
  if (Exit.isFailure(agentIndex)) {
    log.error(
      `Failed to initialize agent index: ${toErrorMessage(Cause.squash(agentIndex.cause))}`,
    );
  } else {
    runtime.runFork(
      loadAgents().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Remote agent refresh failed: ${toErrorMessage(Cause.squash(cause))}`,
          ).pipe(withLogChannel(EXTENSION_CHANNEL)),
        ),
      ),
    );
  }

  const progressViewProvider = new ProgressViewProvider(
    context,
    globalState,
    secrets,
    runtime,
    runtimeSession,
    Effect.suspend(() => apiKeyStatusRefresh()),
  );
  await runtime.runPromise(progressViewProvider.initialize());

  log.info('TeXRA extension activated');

  // Deferred off the activation tick: extendEnvPath() inside performs
  // synchronous glob probes of TeX install directories, which would
  // otherwise block activation on slow disks. (Never rejects — the body is
  // fully wrapped in try/catch.)
  setTimeout(() => void initializeLatexSupport(globalState, runtime), 0);
  registerCommands(
    context,
    globalState,
    progressViewProvider,
    secrets,
    runtime,
    runtimeSession,
  );
  registerWalkthroughWorkspaceAction(context, true, runtime);
  registerFileDecorations(context, runtime, runtimeSession);

  // VS Code's event emitters don't await async listeners, so we funnel
  // fire-and-forget async work through this program, which logs a failed
  // refresh instead of letting it become an unhandled rejection.
  const refreshToolAvailabilityLogged = (trigger: string) =>
    refreshToolAvailability({
      workspaceRoot: runtimeSession.roots.workspace,
      config: runtimeSession.roots.config,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          `Tool availability refresh failed (${trigger}): ${toErrorMessage(Cause.squash(cause))}`,
        ).pipe(withLogChannel(EXTENSION_CHANNEL)),
      ),
    );

  context.subscriptions.push(
    // The VS Code store's half of `credentialChanged`: SecretStorage reports
    // every committed write, other windows' included, so the signal and the
    // lookup-cache drop (another window never ran our finalizer) live here.
    context.secrets.onDidChange(({ key }) => {
      invalidateApiKeyCache();
      emitAppSignal('credentialChanged', { key });
    }),
    // The GitHub token gates the `github_subscription` tool group; re-probe so
    // the Tools tab and the next run's tool list see the new token presence.
    subscribeAppSignal(runtime, 'credentialChanged', ({ key }) => {
      if (key !== GITHUB_TOKEN_STORAGE_KEY) return;
      runtime.runFork(refreshToolAvailabilityLogged('secret change'));
    }),
    // Lean/LaTeX extension installed or removed → re-probe so the Tools tab
    // reflects the new state without the user clicking Re-check.
    vscode.extensions.onDidChange(() => {
      runtime.runFork(refreshToolAvailabilityLogged('extension change'));
    }),
    // Workspace folders opened/closed can flip `isGitRepository`, which
    // gates the GitHub PR subscription tool group. ProgressViewProvider owns
    // the ordered workspace-storage and native-config replacement.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      runtime.runFork(refreshToolAvailabilityLogged('workspace folder change'));
    }),
  );
  const gitHubAuthListener = subscribeAppSignal(
    runtime,
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
  context.subscriptions.push(gitHubAuthListener);
  await runtime.runPromise(
    registerInlineCriticism(context, runtime, runtimeSession, globalState),
  );
  registerInlineComments(context);

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
  // One refresh at a time, in request order, so the last refresh sees the
  // newest credential state and is the last one to update the UI. The
  // refresh starts inside the lane, so no started refresh waits there.
  const apiKeyStatusRefreshLanes = new Map<'refresh', PerKeyLane>();
  const apiKeyStatusRefresh = () =>
    withPerKeyLane(
      apiKeyStatusRefreshLanes,
      'refresh',
    )(
      refreshApiKeyStatusBar(roots, secrets, {
        setup: apiKeyStatusBarItem,
        tasks: statusBarItem,
      }),
    );
  const safeRefreshApiKeyStatus = (): Promise<void> =>
    runtime.runPromise(
      apiKeyStatusRefresh().pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `API key status refresh failed: ${toErrorMessage(Cause.squash(cause))}`,
          ).pipe(withLogChannel(EXTENSION_CHANNEL)),
        ),
      ),
    );
  void safeRefreshApiKeyStatus();
  // Without this listener the pill stayed on "Get Started" forever after
  // a sign-in or after the first API key was stored.
  onTexraAuthSessionsChanged(context, () => {
    void safeRefreshApiKeyStatus();
  });

  const statusBarUsageTracker = new StatusBarUsageTracker(runtimeSession);
  const updateStatusBarTooltip = () => {
    if (!statusBarItem) return;
    const policy = runtimeSession.approvalPolicy;
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
    const count = statusBarUsageTracker.activeRunCount;
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
    session: runtimeSession,
    tracker: statusBarUsageTracker,
    onStatusChanged: () => {
      updateStatusBarTooltip();
      updateStatusBarText();
    },
    // The snapshot store accumulates the per-round deltas; the tracker
    // projects the running runs' totals from it on each refresh.
    onUsageChanged: updateStatusBarTooltip,
    runtime,
  });
  // Paint the policy line immediately; otherwise the tooltip shows the
  // generic "Show TeXRA Tasks" text until the first status/usage event.
  updateStatusBarTooltip();
  // Approval-policy setting updates emit on this signal; the subscription
  // here is what makes the refresh reachable, so a missed subscribe is a
  // missing behavior rather than a silent no-op.
  const approvalPolicyTooltipRefresh = subscribeAppSignal(
    runtime,
    'approvalPolicyChanged',
    updateStatusBarTooltip,
  );

  // Surface curated research tools to VS Code's Language Model Tool API
  // (Copilot Chat `#texra_*` references).
  registerLanguageModelTools(context, runtime, runtimeSession);

  context.subscriptions.push(
    { dispose: disposeStatusListener },
    approvalPolicyTooltipRefresh,
    statusBarItem,
    // Registered here rather than through the shared command registry because
    // the handler closes over this activation's status-bar refresh queue.
    vscode.commands.registerCommand('texra.refreshApiKeyStatus', async () => {
      await runtime.runPromise(apiKeyStatusRefresh());
      // Credential facts changed (set/unset API key from any entry point —
      // palette, walkthrough, welcome card), so the onboarding funnel must
      // recompute too: the State 0 card has no other signal when a key is
      // added outside the main view's own round-trip.
      await runtime.runPromise(
        progressViewProvider
          .refreshOnboardingFunnel()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Onboarding funnel refresh failed: ${toErrorMessage(Cause.squash(cause))}`,
              ).pipe(withLogChannel(EXTENSION_CHANNEL)),
            ),
          ),
      );
    }),
  );

  // Gating commandPalette / keybindings / menus / views on `texra.activated`
  // keeps them hidden until every command handler is registered. This must run
  // after ALL `registerCommand` calls in this function (including the late one
  // for `texra.refreshApiKeyStatus`), otherwise palette entries can fire before
  // their handlers exist and produce "command not found" errors.
  await vscode.commands.executeCommand('setContext', 'texra.activated', true);

  const welcomeKey = 'texra.welcomeShown';
  if (!(await runtime.runPromise(globalState.get<boolean>(welcomeKey)))) {
    // Land first-run users on the main welcome card so the credential choice
    // (ChatGPT subscription first) is the first real action, then open the
    // walkthrough alongside for the rest of the onboarding tips.
    // A failure leaves the flag unset, so the welcome shows again next time.
    runtime.runFork(
      Effect.forEach(
        ['texra.showMainView', EXTENSION_COMMANDS.OPEN_GETTING_STARTED],
        (id) => fromHost(id, () => vscode.commands.executeCommand(id)),
        { discard: true },
      ).pipe(
        Effect.andThen(globalState.update(welcomeKey, true)),
        Effect.catchCause((cause) =>
          Effect.logWarning('Welcome failed', cause),
        ),
        withLogChannel(EXTENSION_CHANNEL),
      ),
    );
  }
}

export async function deactivate() {
  await shutdownExtension();
}
