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
  tryDefaultSession,
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
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
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
import { installUnhandledRejectionSurface } from '@frontend/system/unhandledRejectionSurface';
import { subscribeAppSignal } from '@frontend/events/appSignalSubscriptions';
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
import { createVscodeLeanLanguageServices } from '@frontend/lean/VscodeIntegration';
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
import { setLogSink } from '@logger/logSink';
import { AppState, AgentDirectories } from '@platform/interfaces';
import type { AgentResumePort, ToolMissingHandler } from '@platform/interfaces';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@platform/processRuntime';
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
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import { openWorktreeStateStore } from '@platform/defaults/worktreeStateStore';
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
import { gitHubTokenRejectedMessage } from '@tools/github/githubAuth';
import { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';
import { readSettingFrom } from '@utils/config/platformSettings';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { registerCommands } from './commands';

const EXTENSION_CHANNEL = 'extension';

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
// VS Code invokes activation and deactivation separately. Only this entry
// reads back the scope the activation program ran in: its finalizer is the
// process's shutdown drain, so closing it is deactivation.
let activationScope: Scope.Closeable | undefined;

/**
 * The process runtime and the process roots, wired once for
 * both activation paths: the credential-only path without a folder and the
 * workspace path, which adds the ports only a folder can answer.
 *
 * Registered surfaces receive the ports and roots this entry owns. The
 * process's shutdown drain is a finalizer of the activation scope, added the
 * moment the runtime it releases exists.
 */
const initVscodePlatform = Effect.fn('initVscodePlatform')(function* (
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
  extras: {
    /** The editor's tool-missing UI, served as `ToolMissingReporter` below. */
    readonly toolMissingHandler?: ToolMissingHandler;
    /** The editor's LM bridge, served as `LanguageModel` below. */
    readonly languageModel?: LanguageModelPort;
  } = {},
) {
  // `~/.texra` is one history across CLI/desktop/extension (#8622). The
  // process runtime precedes the config stores below, which open on it.
  const storage = resolveWorkspaceStoragePath(
    DEFAULT_NODE_STORAGE_ROOT,
    workspaceRoot,
  );
  const globalStorage = resolveGlobalStoragePath(DEFAULT_NODE_STORAGE_ROOT);
  const secrets = new VscodeSecrets(context);
  const appState = Layer.effect(
    AppState,
    Effect.map(GlobalDatabase, (database) =>
      appStateStoreFromDatabase(globalStorage, database),
    ),
  );
  const authReadiness: AuthReadinessGate = { uriHandlerInstalled: false };
  // Built on every activate(): the drain trips an internal idempotency flag,
  // so a lifecycle kept from an earlier activate() in the same process would
  // silently swallow the handlers this one registers.
  const lifecycle = createLifecycleHost();
  // A construction failure degrades to the unavailable plane instead of
  // failing activation: registration below records and reports the error, and
  // every probe answers signed-out.
  // The account plane resolves before the runtime that serves it; the
  // process identity is the runtime's own layer, built by its first run.
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
  // The resume port closes over the runtime installed just below: a resume
  // attempt runs on it, and the port is only invoked after activation has
  // returned. It is served as the runtime's `AgentResume` service. The
  // session it resumes into is the workspace path's default session; the
  // credential-only path never initializes one, and a resume request cannot
  // arrive there because every run belongs to one.
  const agentResume: AgentResumePort = {
    tryResumeRun: (runId, recovery) => {
      const session = tryDefaultSession();
      return session
        ? tryResumeFromResumeData(runId, runtime, session, recovery)
        : Effect.die(
            new Error(
              'The credential-only activation has no session to resume into.',
            ),
          );
    },
  };
  // Usage logging is a runtime service, not an authentication-provider
  // capability: it runs even when Supabase sign-in is not configured, as it
  // does on desktop and CLI, and the service itself decides which records can
  // be sent.
  const extensionVersion =
    typeof context.extension.packageJSON?.version === 'string'
      ? context.extension.packageJSON.version
      : undefined;
  const runtime = installProcessRuntime({
    processStart: nodeProcesses.selfIdentity(),
    globalStorage,
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
    globalDatabase: globalDatabaseLayer(globalStorage),
    // The Output channel owns filtering, so emit every level.
    minimumLogLevel: 'Trace',
  });
  const projectScope = yield* Scope.make();
  // `disposeStatusListener` and `statusBarItem` are owned solely by
  // `context.subscriptions` (see the push near the end of activation),
  // matching the setup pill. Registering them here too would
  // double-dispose. The session is initialized on the workspace path only;
  // the credential-only path has none to flush or release.
  registerRuntimeShutdownHandlers(lifecycle, {
    flushArtifacts: Effect.suspend(
      () => tryDefaultSession()?.settlePublications() ?? Effect.void,
    ),
    afterRunSettlement: [Effect.sync(() => disposeDiffRefresh())],
    releaseSessions: teardownDefaultSession().pipe(
      Effect.ensuring(Scope.close(projectScope, Exit.void)),
    ),
    disposeRuntime: disposeProcessRuntime(runtime),
  });
  yield* Effect.addFinalizer(() => lifecycle.runShutdown);
  return yield* withProcessServices(
    runtime,
    Effect.gen(function* () {
      const globalState = yield* AppState;
      const projectState = yield* openProjectStateStore(storage).pipe(
        Scope.provide(projectScope),
      );
      // VS Code restarts the extension host when the first workspace folder
      // changes, so the configuration stores stay pinned for this process.
      const config = new JsonConfigProvider(
        yield* openTexraConfigStores(
          DEFAULT_NODE_STORAGE_ROOT,
          workspaceRoot,
          (message) =>
            runtime.runFork(
              Effect.logWarning(message).pipe(
                withLogChannel(EXTENSION_CHANNEL),
              ),
            ),
        ),
      );
      const roots = createNodeWorkspaceRoots({
        workspacePath: workspaceRoot,
        storage,
        globalStorage,
        config,
        workspaceState: workspaceRoot
          ? yield* openWorktreeStateStore(
              projectState,
              globalState,
              workspaceRoot,
            )
          : projectState,
        globalState,
      });
      // Everything this process installs once after its roots exist, in the
      // order the shared bootstrap owns for all three hosts.
      yield* bootstrapHost({
        host: 'vscode',
        roots,
        secrets,
        skills: {
          resourcesPath: path.join(context.extensionPath, 'resources'),
        },
      });
      // After the runtime, which the manager settles its watcher rebuilds on.
      agentDirectories.initialize(
        globalState,
        path.join(context.extensionPath, 'resources'),
        runtime,
      );
      yield* registerSupabaseAuth(
        context,
        secrets,
        runtime,
        auth,
        authReadiness,
      );
      return { secrets, runtime, roots };
    }),
  );
});

/**
 * Workspace-bound commands the getting-started walkthrough exposes as buttons.
 * Their links invoke one bridge command so a no-workspace click can explain
 * the prerequisite without firing the real command's `onCommand` completion
 * event.
 */
const WALKTHROUGH_COMMANDS_NEEDING_WORKSPACE = [
  EXTENSION_COMMANDS.CLONE_OVERLEAF_PROJECT,
  EXTENSION_COMMANDS.DOWNLOAD_ARXIV_SOURCE,
  EXTENSION_COMMANDS.RUN_SETUP_ASSISTANT,
  'texra.showMainView',
  'texra.showTools',
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
) {
  return Effect.try({
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
      context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
      authProvider.setUriHandler(uriHandler);
      // The account plane's readiness probe gates on this: the URI handler
      // is what an OAuth callback arrives at, so sign-in is not "ready"
      // before it is installed.
      authReadiness.uriHandlerInstalled = true;
    },
    catch: (cause) => new SupabaseAuthRegistrationFailed({ cause }),
  }).pipe(
    Effect.andThen(
      Effect.logInfo('Supabase authentication provider registered'),
    ),
    Effect.catchTag('SupabaseAuthRegistrationFailed', ({ cause }) => {
      auth.setInitError(ensureError(cause));
      return Effect.logError(
        `Failed to initialize Supabase authentication: ${toErrorMessage(cause)}`,
      );
    }),
    withLogChannel(EXTENSION_CHANNEL),
  );
}

export async function activate(context: vscode.ExtensionContext) {
  // This host's R1 entry: one program from `activate` to the last
  // registration, on the context-free runner because it is what installs the
  // process runtime. A failed activation closes its scope, which runs the
  // same shutdown drain deactivation does, and re-fails with the same cause.
  const scope = Scope.makeUnsafe();
  activationScope = scope;
  const activation = await Effect.runPromiseExit(
    activateExtension(context).pipe(
      Scope.provide(scope),
      Effect.onError(() =>
        Scope.close(scope, Exit.void).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(
              'Extension cleanup after failed activation failed',
            ).pipe(
              Effect.annotateLogs({ data: Cause.squash(cause) }),
              withLogChannel(EXTENSION_CHANNEL),
              // The runtime that held the diagnostics layer is gone, so the
              // entry needs it provided to reach the host's sink.
              Effect.provide(effectDiagnosticsLayer('Trace')),
            ),
          ),
        ),
      ),
    ),
  );
  // The squashed cause is the activation's own failure, so the error VS Code
  // reports keeps the original error and its stack.
  if (Exit.isFailure(activation)) throw Cause.squash(activation.cause);
}

const activateExtension = Effect.fn('activateExtension')(function* (
  context: vscode.ExtensionContext,
) {
  installUnhandledRejectionSurface(context.subscriptions);
  if (vscode.workspace.workspaceFolders?.length !== 1) {
    registerWelcomeView(context);
    // Credential-only platform. Every sign-in path stores into SecretStorage
    // (the `Secrets` service) and the global `~/.texra` config — none of it
    // needs a folder — so the walkthrough's credential buttons work before
    // one is open. Agents still require the workspace-backed platform below;
    // opening a folder reloads the window into that path (welcomeView.ts).
    const { secrets, runtime, roots } = yield* initVscodePlatform(
      context,
      undefined,
    );
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
        runtime.runPromise(apiSetApiKey(roots, secrets, () => Effect.void)),
      ),
    );
    registerWalkthroughWorkspaceAction(context, false, runtime);
    return;
  }
  const rawWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!rawWorkspacePath) return;
  const workspaceRoot = canonicalizeWorkspacePath(rawWorkspacePath);

  yield* Effect.try({
    try: () => process.loadEnvFile(path.join(workspaceRoot, '.env')),
    catch: (cause) => new WorkspaceEnvFileUnreadable({ cause }),
  }).pipe(
    // A workspace without a .env is the normal case; any other failure
    // (EACCES, ERR_INVALID_ARG_TYPE) stays loud instead of silently dropping
    // it: activation fails with that same error.
    Effect.catchTag('WorkspaceEnvFileUnreadable', (failure) =>
      isFileNotFoundError(failure.cause)
        ? Effect.void
        : Effect.die(failure.cause),
    ),
  );
  setLogSink(createVsCodeLogSink());
  // Deactivation releases the output channels with the sink, so a reload does
  // not leave a disposed host surface installed.
  context.subscriptions.push({ dispose: () => setLogSink(null) });
  const languageModel = createLanguageModelPort(context);
  const { secrets, runtime, roots } = yield* initVscodePlatform(
    context,
    workspaceRoot,
    { languageModel, toolMissingHandler: vscodeToolMissingReporter },
  );
  // The host entry holds the process runtime in a local and threads it to the
  // surfaces registered below, so code under `activate` settles its Effects on
  // the runtime it was handed instead of reading the global back.
  yield* withProcessServices(
    runtime,
    activateWorkspace(context, languageModel, secrets, runtime, roots),
  );
  // Off the activation tick: extendEnvPath() runs synchronous glob probes.
  yield* withProcessServices(
    runtime,
    initializeLatexSupport(roots.globalState),
  ).pipe(Effect.delay('0 millis'), Effect.forkScoped);
});

/** The workspace path's activation, over the process runtime it just built. */
const activateWorkspace = Effect.fn('activateWorkspace')(function* (
  context: vscode.ExtensionContext,
  languageModel: LanguageModelPort,
  secrets: PlatformSecrets,
  runtime: ProcessRuntime,
  roots: WorkspaceRoots,
) {
  const { globalState } = roots;
  // The account provider the platform registered precedes the
  // fire-and-forget remote agent refresh below,
  // which reads the account plane's access token: with the provider in place
  // the refresh fetches the real catalog instead of short-circuiting on a null
  // token, so activation now performs that one background fetch.
  context.subscriptions.push(
    languageModel.onDidChange(() =>
      emitAppSignal('languageModelsChanged', undefined),
    ),
  );
  const runtimeSession = yield* initializeDefaultSession({
    roots,
    responseTextProcessing: createTexraResponseTextProcessing(
      createAgentResponseTextConnector({ ...roots, secrets }, languageModel),
    ),
  });
  if (runtimeSession.storeMovedAside) {
    void vscode.window.showWarningMessage(
      sessionStoreMovedAsideMessage(runtimeSession.storeMovedAside),
    );
  }
  runtimeSession.setApprovalPolicy(
    yield* readSettingFrom<TexraApprovalPolicy>(
      runtimeSession.roots,
      TEXRA_APPROVAL_POLICY_CONFIG_KEY,
    ),
  );
  // The run-storage directory of the session just initialized, through that
  // session's own storage view rather than a static that re-reads the root.
  yield* withSessionFs(
    runtimeSession.roots,
    Effect.flatMap(Effect.service(StorageFs), (storageFs) =>
      storageFs.makeDirectory(WORKSPACE_STORAGE_LAYOUT.runs, {
        recursive: true,
      }),
    ),
  );
  FileLister.initialize(context, runtimeSession);

  // Order matters: registerAgentDirectoryRoots exposes the packaged built-in
  // directories, and loadAgents scans them.
  yield* registerAgentDirectoryRoots(context);
  const agentIndexLoaded = yield* loadAgents({ includeRemote: false }).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.logError(
        `Failed to initialize agent index: ${toErrorMessage(Cause.squash(cause))}`,
      ).pipe(withLogChannel(EXTENSION_CHANNEL), Effect.as(false)),
    ),
  );
  if (agentIndexLoaded) {
    // Process-lifetime: activation does not wait on the remote catalog.
    yield* Effect.forkDetach(
      loadAgents().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Remote agent refresh failed: ${toErrorMessage(Cause.squash(cause))}`,
          ).pipe(withLogChannel(EXTENSION_CHANNEL)),
        ),
      ),
    );
  }

  // The setup pill: shown only while the host snapshot's API-key banner is,
  // the one credential answer the welcome card also reads (a ChatGPT
  // subscription and a direct API key count alike). The welcome card in the
  // TeXRA panel is the one home for that choice.
  const setupPill = vscode.window.createStatusBarItem(
    'texra.setupStatus',
    vscode.StatusBarAlignment.Left,
  );
  setupPill.name = 'TeXRA Setup';
  setupPill.text = '$(rocket) TeXRA: Get Started';
  setupPill.tooltip =
    'Connect a model: sign in with ChatGPT or add a provider API key';
  setupPill.command = EXTENSION_COMMANDS.SHOW_MAIN_VIEW;
  setupPill.accessibilityInformation = { label: 'TeXRA setup, get started' };
  context.subscriptions.push(setupPill);
  const progressViewProvider = new ProgressViewProvider(
    context,
    globalState,
    secrets,
    runtime,
    runtimeSession,
    (banner) => (banner.visible ? setupPill.show() : setupPill.hide()),
  );
  yield* Effect.andThen(
    progressViewProvider.initialize(),
    Effect.logInfo('TeXRA extension activated'),
  ).pipe(withLogChannel(EXTENSION_CHANNEL));

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
    // every committed write, other windows' included, so the signal lives here.
    context.secrets.onDidChange(({ key }) => {
      emitAppSignal('credentialChanged', { key });
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
  yield* registerInlineCriticism(context, runtime, runtimeSession, roots);
  yield* registerLanguageModelTools(context, runtime, runtimeSession);
  registerInlineComments(context);

  statusBarItem = vscode.window.createStatusBarItem(
    'texra.taskStatus',
    vscode.StatusBarAlignment.Left,
  );
  statusBarItem.name = 'TeXRA Tasks';
  statusBarItem.command = 'texra.showProgressView';
  // Shown only while a run is active (`updateStatusBarText`).

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
      statusBarItem.tooltip = `${policyLine}\n\nClick to show TeXRA sessions`;
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
        '*Click to show TeXRA sessions*',
      ].join('\n'),
    );
    tip.isTrusted = false;
    statusBarItem.tooltip = tip;
  };
  const updateStatusBarText = () => {
    if (!statusBarItem) return;
    const count = statusBarUsageTracker.activeRunCount;
    if (statusBarUsageTracker.activity === 'approval') {
      statusBarItem.text = '$(bell-dot) TeXRA: Waiting for you';
      statusBarItem.accessibilityInformation = {
        label: 'TeXRA tasks, waiting for you',
      };
    } else if (count > 1) {
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
      // Nothing running: no pill. The setup pill covers the first run.
      statusBarItem.hide();
      return;
    }
    statusBarItem.show();
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

  context.subscriptions.push(
    { dispose: disposeStatusListener },
    approvalPolicyTooltipRefresh,
    statusBarItem,
    // Registered here rather than through the shared command registry because
    // the handler closes over this activation's status-bar refresh queue.
    // A credential changed outside the panel's own round trip (palette,
    // walkthrough, a tool): the API-key banner, and with it the setup pill
    // and the onboarding funnel, re-read.
    vscode.commands.registerCommand('texra.refreshApiKeyStatus', () =>
      runtime.runPromise(progressViewProvider.refreshApiKeyStatus),
    ),
  );

  // Gating commandPalette / keybindings / menus / views on `texra.activated`
  // keeps them hidden until every command handler is registered. This must run
  // after ALL `registerCommand` calls in this function (including the late one
  // for `texra.refreshApiKeyStatus`), otherwise palette entries can fire before
  // their handlers exist and produce "command not found" errors.
  yield* Effect.tryPromise({
    try: () =>
      vscode.commands.executeCommand('setContext', 'texra.activated', true),
    catch: ensureError,
  });

  const welcomeKey = 'texra.welcomeShown';
  if (!(yield* globalState.get<boolean>(welcomeKey))) {
    // Land first-run users on the welcome card in the TeXRA panel: the one
    // onboarding surface that opens by itself. It links the walkthrough.
    // A failure leaves the flag unset, so the welcome shows again next time.
    yield* Effect.forkDetach(
      fromHost('texra.showMainView', () =>
        vscode.commands.executeCommand('texra.showMainView'),
      ).pipe(
        Effect.andThen(globalState.update(welcomeKey, true)),
        Effect.catchCause((cause) =>
          Effect.logWarning('Welcome failed', cause),
        ),
        withLogChannel(EXTENSION_CHANNEL),
      ),
    );
  }
});

export async function deactivate() {
  if (activationScope) {
    await Effect.runPromise(Scope.close(activationScope, Exit.void));
  }
}
