// Node imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';
import {
  Cause,
  type Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Result,
  Schema,
  Scope,
  Stream,
} from 'effect';

// Local imports
import { Sessions, WorkspaceRoots } from '@texra-ai/harness';
import {
  AppState,
  type ProcessRuntime,
  type ProcessServices,
  type GlobalValues,
  withProcessServices,
  StateStores,
  ToolAvailability,
} from '@texra-ai/harness/host';
import {
  withLogChannel,
  Settings,
  emitAppSignal,
} from '@texra-ai/harness/plugins';
import { withForkFailureReporting } from '@texra-ai/harness/transcript';
import {
  openNodeWorkspaceRoots,
  canonicalizeWorkspaceRoot,
  effectDiagnosticsLayer,
  FileSecrets,
  secretsDirectory,
  setLogSink,
} from '@texra-ai/harness/node';
import { toErrorMessage, type StateKey } from '@texra-ai/harness/schemas';
import { appSignalStream } from '@texra-ai/harness/host';
import { setApiKey as apiSetApiKey } from '@commands/api/apiKeyCommands';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import { createSampleProjectWithoutWorkspace } from '@commands/system/sampleProjectCommands';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import {
  executeVscodeCommand,
  safeExecuteCommand,
} from '@frontend/system/commandUtils';
import { installUnhandledRejectionSurface } from '@frontend/system/unhandledRejectionSurface';
import { initializeLatexSupport } from '@frontend/setup';
import { taskStatusBar } from '@frontend/statusBar/taskStatusBar';
import { vscodeSetupPlatform } from '@frontend/vscodeSetupPlatform';
import { vscodeEditorIntegration } from '@frontend/vscodeEditorIntegration';
import {
  announce,
  showLoggedMessageWithDocs,
} from '@frontend/ui/errorHandlingUtils';
import { registerFileDecorations } from '@frontend/ui/fileDecorations';
import { registerWelcomeView } from '@frontend/ui/welcomeView';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { createVscodeLeanLanguageServices } from '@frontend/lean/VscodeIntegration';
import { followInlineCriticism } from '@frontend/latex/inlineCriticism';
import {
  inlineCommentProvider,
  registerInlineComments,
} from '@frontend/comments/inlineComments';
import { createVsCodeLogSink } from '@frontend/vscode/vscodeLogSink';
import { telemetryNoticeIfDue } from '@telemetry/telemetryNotice';
import { openTexraConfigStores } from '@texra/platform/defaults/nodeStores';
import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import {
  settingsTabByCommand,
  type ExtensionCommandId,
} from '@texra/shared/commands/catalog';
import { serviceProjectState } from '@texra/controllers/server/serviceSession';
import { openProjectSession } from '@texra/controllers/session/openProjectSession';
import type { ServiceLink } from '@texra/controllers/server/client';
import { texraProcessLayer } from '@texra/controllers/texraProcessLayer';
import { HostWindows } from '@texra/controllers/server/hostWindows';
import { gitHubTokenRejectedMessage } from '@texra/tools/github/githubAuth';
import { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import type { GuiSession } from '@texra/controllers/session/openGuiWindow';
import { reachExtensionService } from './common/extensionService';

// Local file imports
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import { registerCommands } from './commands';
import type { SettingsViewProvider } from './settingsView/SettingsViewProvider';

const EXTENSION_CHANNEL = 'extension';

/** Set once the first-run welcome card has been shown. */
const WELCOME_SHOWN_KEY = {
  key: 'welcomeShown',
  slot: 'globalState',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
} as const satisfies StateKey<boolean>;

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
    /** The background service this window is a client of: reached once
     *  the runtime that serves its record exists. A window that reaches it
     *  reads the project's state there and opens no project store. */
    readonly service?: Effect.Effect<
      ServiceLink,
      Error,
      Scope.Scope | GlobalValues
    >;
  } = {},
) {
  // Usage logging is anonymous: a runtime service with no account behind it.
  const extensionVersion =
    typeof context.extension.packageJSON?.version === 'string'
      ? context.extension.packageJSON.version
      : undefined;
  const managed = withForkFailureReporting(
    ManagedRuntime.make(
      texraProcessLayer({
        name: 'vscode',
        inquiryPanel: true,
        // The Comments UI behind the `inline_comment` tool. The provider reads
        // the controller this host registers at activation, so it is a value
        // from module load; nothing about it waits on that registration.
        inlineComments: inlineCommentProvider,
        // Lean through the Lean 4 extension, not a direct `lake` pool.
        lean: Layer.effect(
          LeanLanguageServices,
          Effect.map(AppState, createVscodeLeanLanguageServices),
        ),
        // The editor's commands and terminal, for the setup tools.
        setup: vscodeSetupPlatform,
        // The editor's extensions, for the setup tools and the Lean 4 probe.
        editor: vscodeEditorIntegration,
        // `~/.texra`: one history across CLI, desktop and extension.
        storageRoot: defaultNodeStorageRoot(),
        resourcesPath: path.join(context.extensionPath, 'resources'),
        agentIssues: showLoggedMessageWithDocs,
        usageLog: {
          version: extensionVersion,
          editorType: vscode.env.appName || undefined,
          // VS Code's own telemetry setting, read live: it overrides ours.
          hostTelemetryEnabled: () => vscode.env.isTelemetryEnabled,
        },
        // The Output channel owns filtering, so emit every level.
        minimumLogLevel: 'Trace',
        // The window's own reads (credential status, model discovery) see
        // the workspace's `.env`, as its tasks do, without it ever being
        // merged into the extension host's shared `process.env`.
        workspace: workspaceRoot,
      }),
    ),
  );
  const runtime: ProcessRuntime = managed;
  // The activation scope's finalizers are this host's shutdown, run in the
  // reverse of their registration: every session closes first (registered
  // at the end of activation), then the host's own resources, then the
  // project scope, and the runtime last of all. The status-bar refresh and
  // the app-signal listeners are fibers of this scope, so they end before
  // any of those; the task pill's item is owned solely by
  // `context.subscriptions` (`taskStatusBar`), matching the setup pill.
  yield* Effect.addFinalizer(() => runtime.disposeEffect);
  const projectScope = yield* Scope.make();
  // The window's session closes before the project state it reads.
  yield* Effect.addFinalizer(() =>
    withProcessServices(
      runtime,
      Effect.flatMap(Sessions, (sessions) => sessions.closeAll),
    ).pipe(Effect.ensuring(Scope.close(projectScope, Exit.void))),
  );
  return yield* withProcessServices(
    managed,
    Effect.gen(function* () {
      const reached: Result.Result<ServiceLink, Error> =
        extras.service === undefined || workspaceRoot === undefined
          ? Result.fail(new Error('a window with no folder uses no service'))
          : // Held with the project state it serves: after the sessions
            // that read it close, before the runtime its reconnects use.
            yield* Effect.result(
              extras.service.pipe(Scope.provide(projectScope)),
            );
      // VS Code restarts the extension host when the first workspace folder
      // changes, so the configuration stores stay pinned for this process.
      const config = yield* openTexraConfigStores(
        TEXRA_SETTINGS.catalog,
        defaultNodeStorageRoot(),
        workspaceRoot,
        (message) => {
          runtime.runFork(
            Effect.logWarning(message).pipe(
              withLogChannel(EXTENSION_CHANNEL),
              Effect.andThen(vscodeUi.notify('warning', message)),
            ),
          );
        },
      );
      const roots = yield* openNodeWorkspaceRoots({
        workspaceRoot,
        storageRoot: defaultNodeStorageRoot(),
        config,
        ...(Result.isSuccess(reached) &&
          workspaceRoot !== undefined && {
            workspaceState: serviceProjectState(reached.success, workspaceRoot),
          }),
        stateStores: yield* StateStores,
        globalState: yield* AppState,
      }).pipe(Scope.provide(projectScope));
      // The one-time telemetry notice, one information message; VS Code's own
      // switch being off means nothing is sent, so nothing to announce.
      const notice = vscode.env.isTelemetryEnabled
        ? yield* telemetryNoticeIfDue(roots.config)
        : null;
      if (notice) yield* Effect.forkDetach(vscodeUi.notify('info', notice));
      return { runtime, roots, hosts: yield* HostWindows, reached };
    }),
  );
});

/**
 * The commands a window without a single folder registers, since nothing they
 * do needs a workspace: the walkthrough's credential and sample buttons work
 * before a folder is open. The full command surface is registered only on the
 * single-folder path, so these are standalone variants of its rows.
 */
const NO_FOLDER_COMMANDS = {
  // A first-time user without a LaTeX project can create the sample and land
  // directly in a working workspace.
  'texra.createSampleProject': (context) =>
    createSampleProjectWithoutWorkspace(context.extensionPath),
  'texra.openGettingStarted': (context) =>
    openGettingStarted(context.extension.id),
  'texra.auth.chatgpt.signIn': (_context, roots) =>
    signInWithSubscription(roots, 'chatgpt').pipe(
      withLogChannel('welcomeView'),
    ),
  'texra.setApiKey': (_context, roots) => apiSetApiKey(roots),
} satisfies Partial<
  Record<
    ExtensionCommandId,
    (
      context: vscode.ExtensionContext,
      roots: WorkspaceRoots,
    ) => Effect.Effect<unknown, Error, ProcessServices | Sessions>
  >
>;

/**
 * The commands that need a folder. The getting-started walkthrough's buttons
 * for them invoke one bridge command, so a no-workspace click can explain the
 * prerequisite without firing the real command's `onCommand` completion event.
 */
type WalkthroughCommandNeedingWorkspace = Exclude<
  ExtensionCommandId,
  keyof typeof NO_FOLDER_COMMANDS
>;

/** Internal command URI used by workspace-bound walkthrough links. */
const WALKTHROUGH_WORKSPACE_ACTION_COMMAND = 'texra.walkthroughWorkspaceAction';

const explainWorkspaceRequired = Effect.fn('explainWorkspaceRequired')(
  function* (extensionPath: string) {
    const openFolder = 'Open Folder';
    const createSample = 'Create Sample Project';
    const choice = yield* vscodeUi.ask(
      'info',
      'TeXRA agents run inside a single-folder workspace. Open your LaTeX project folder or create the sample project first.',
      { items: [openFolder, createSample] },
    );
    if (choice === openFolder) {
      yield* safeExecuteCommand('workbench.action.files.openFolder');
    } else if (choice === createSample) {
      yield* createSampleProjectWithoutWorkspace(extensionPath);
    }
  },
  withLogChannel(EXTENSION_CHANNEL),
);

function registerWalkthroughWorkspaceAction(
  context: vscode.ExtensionContext,
  hasSingleWorkspace: boolean,
  runtime: ProcessRuntime,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      WALKTHROUGH_WORKSPACE_ACTION_COMMAND,
      (command: WalkthroughCommandNeedingWorkspace) =>
        hasSingleWorkspace
          ? vscode.commands.executeCommand(command)
          : runtime.runPromise(explainWorkspaceRequired(context.extensionPath)),
    ),
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
  yield* installUnhandledRejectionSurface(context.extensionPath);
  if (vscode.workspace.workspaceFolders?.length !== 1) {
    // Credential-only platform. Every sign-in path stores into the shared
    // secrets file (the `Secrets` service) and the global `~/.texra` config — none of it
    // needs a folder — so the walkthrough's credential buttons work before
    // one is open. Agents still require the workspace-backed platform below;
    // opening a folder reloads the window into that path (welcomeView.ts).
    const { runtime, roots } = yield* initVscodePlatform(context, undefined);
    registerWelcomeView(context, runtime);
    for (const [id, command] of Object.entries(NO_FOLDER_COMMANDS)) {
      context.subscriptions.push(
        vscode.commands.registerCommand(id, () =>
          runtime.runPromise(command(context, roots)),
        ),
      );
    }
    registerWalkthroughWorkspaceAction(context, false, runtime);
    return;
  }
  const rawWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!rawWorkspacePath) return;
  const workspaceRoot = canonicalizeWorkspaceRoot(rawWorkspacePath);

  setLogSink(createVsCodeLogSink());
  // Deactivation releases the output channels with the sink, so a reload does
  // not leave a disposed host surface installed.
  context.subscriptions.push({ dispose: () => setLogSink(null) });
  // A folder's window is a client of the one background service, so its
  // tasks keep running when it closes and other windows and terminals see
  // them. Decided once: a reconnect never re-enters it.
  const { runtime, roots, hosts, reached } = yield* initVscodePlatform(
    context,
    workspaceRoot,
    {
      service: reachExtensionService(context.extensionPath),
    },
  );
  // The host entry holds the process runtime in a local and threads it to the
  // surfaces registered below, so code under `activate` settles its Effects on
  // the runtime it was handed instead of reading the global back.
  // The activation scope carries the shutdown: the workspace activation
  // registers its own finalizers there.
  const activationScope = yield* Scope.Scope;
  yield* withProcessServices(
    runtime,
    activateWorkspace(context, runtime, roots, hosts, reached).pipe(
      Effect.provideService(Scope.Scope, activationScope),
    ),
  );
  // Off the activation tick: withExtendedPath() runs synchronous glob probes.
  yield* withProcessServices(
    runtime,
    initializeLatexSupport(roots.globalState),
  ).pipe(Effect.delay('0 millis'), Effect.forkScoped);
});

/** The workspace path's activation, over the process runtime it just built. */
const activateWorkspace = Effect.fn('activateWorkspace')(function* (
  context: vscode.ExtensionContext,
  runtime: ProcessRuntime,
  roots: WorkspaceRoots,
  hosts: Context.Service.Shape<typeof HostWindows>,
  /** The background service, as the activation reached it once. */
  reached: Result.Result<ServiceLink, Error>,
) {
  const { globalState } = roots;
  // A window of the service opens no session of its own: no store, run
  // or claims. Only a window that cannot reach the service runs its
  // tasks here, and says so once. While the link is down, the service's
  // session answers with the offline refusal.
  const warn = (message: string) =>
    Effect.asVoid(Effect.forkDetach(vscodeUi.notify('warning', message)));
  const windowSession: GuiSession = yield* openProjectSession(
    roots,
    Result.isSuccess(reached) ? reached.success : undefined,
    warn,
  ).pipe(Effect.provideService(HostWindows, hosts));
  if (Result.isFailure(reached)) {
    const reason = `TeXRA runs this window's tasks here only, so other windows and terminals will not see them: ${reached.failure.message}`;
    yield* Effect.logWarning(reason).pipe(withLogChannel(EXTENSION_CHANNEL));
    yield* warn(reason);
  }
  const { session } = windowSession;

  // The setup pill: shown only while no credential is usable, the one
  // credential answer the "Connect a model" card also reads (a ChatGPT
  // subscription and a direct API key count alike). It runs setup, which
  // brings that card, the one home for the choice, into view first.
  const setupPill = vscode.window.createStatusBarItem(
    'texra.setupStatus',
    vscode.StatusBarAlignment.Left,
  );
  setupPill.name = 'TeXRA Setup';
  setupPill.text = '$(rocket) TeXRA: Get Started';
  setupPill.tooltip =
    'Connect a model: sign in with ChatGPT or add a provider API key';
  setupPill.command = 'texra.runSetupAssistant' satisfies ExtensionCommandId;
  setupPill.accessibilityInformation = { label: 'TeXRA setup, get started' };
  context.subscriptions.push(setupPill);
  // The settings view is built with the commands, after the progress view
  // that opens it, so the progress view waits for it.
  const settingsView = yield* Deferred.make<SettingsViewProvider>();
  const progressViewProvider = yield* ProgressViewProvider.make(
    context,
    globalState,
    runtime,
    roots,
    windowSession,
    (target) =>
      Effect.flatMap(Deferred.await(settingsView), (view) =>
        view.showSettingsView(target),
      ),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(progressViewProvider.credentialUsable, (usable) =>
      Effect.sync(() => (usable ? setupPill.hide() : setupPill.show())),
    ),
  );
  yield* Effect.logInfo('TeXRA extension activated').pipe(
    withLogChannel(EXTENSION_CHANNEL),
  );
  // Registered last, so the first thing the activation scope's close runs:
  // every session stops and settles its runs before the view and the host
  // resources registered above tear down around them.
  yield* Effect.addFinalizer(() =>
    Effect.asVoid(Effect.flatMap(Sessions, (sessions) => sessions.closeAll)),
  );

  const settingsViewProvider = registerCommands(
    context,
    progressViewProvider,
    runtime,
    roots,
    session,
  );
  yield* Deferred.succeed(settingsView, settingsViewProvider);
  registerWalkthroughWorkspaceAction(context, true, runtime);
  // Keys another window or the service writes reach this one's surfaces.
  yield* Effect.forkScoped(
    FileSecrets.watch(secretsDirectory(defaultNodeStorageRoot()), (key) =>
      emitAppSignal('credentialChanged', { key }),
    ),
  );
  yield* registerFileDecorations(context, session);

  // VS Code's event emitters don't await async listeners, so we funnel
  // fire-and-forget async work through this program, which logs a failed
  // refresh instead of letting it become an unhandled rejection.
  const refreshToolAvailabilityLogged = (trigger: string) =>
    Effect.flatMap(ToolAvailability, (availability) =>
      availability.refresh(roots),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          `Tool availability refresh failed (${trigger}): ${toErrorMessage(Cause.squash(cause))}`,
        ).pipe(withLogChannel(EXTENSION_CHANNEL)),
      ),
    );

  context.subscriptions.push(
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
  // Activation-lifetime listeners run in the activation scope, which ends
  // them when the extension deactivates.
  // Each prompt runs in its own child fiber, so a second rejection doesn't
  // wait behind an unanswered notification, and closing the scope interrupts
  // any prompt still open.
  const openSettings = 'Open Git settings';
  yield* Effect.forkScoped(
    appSignalStream('githubTokenInvalid').pipe(
      Stream.runForEach(({ message }) =>
        announce(
          vscodeUi.ask('error', gitHubTokenRejectedMessage(message), {
            items: [openSettings],
          }),
          undefined,
        ).pipe(
          Effect.flatMap((choice) =>
            choice === openSettings
              ? settingsViewProvider
                  .showSettingsView(
                    settingsTabByCommand['texra.showGitSettings'],
                  )
                  .pipe(
                    Effect.ignore({
                      log: 'Warn',
                      message: 'Opening the Git settings',
                    }),
                  )
              : Effect.void,
          ),
          withLogChannel(EXTENSION_CHANNEL),
          Effect.forkChild,
        ),
      ),
    ),
    { startImmediately: true },
  );
  yield* Effect.forkScoped(followInlineCriticism(session, roots));
  registerInlineComments(context);

  yield* taskStatusBar(context, session, roots.config);

  // Gating commandPalette / keybindings / menus / views on `texra.activated`
  // keeps them hidden until every command handler is registered. This must run
  // after ALL `registerCommand` calls in this function, otherwise palette
  // entries can fire before their handlers exist and produce "command not
  // found" errors.
  yield* executeVscodeCommand('setContext', 'texra.activated', true);
  if (!(yield* Settings.state(globalState, WELCOME_SHOWN_KEY))) {
    // First-run welcome card; a failure leaves the flag unset, so it repeats.
    yield* Effect.forkScoped(
      progressViewProvider.showLauncher().pipe(
        Effect.andThen(globalState.update(WELCOME_SHOWN_KEY.key, true)),
        // Scope close interrupts this fiber; that is not a failed welcome.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning('Welcome failed', cause),
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
