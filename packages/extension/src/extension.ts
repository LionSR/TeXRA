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
import { Sessions, WorkspaceRoots } from '@texra-ai/worldline';
import {
  type ProcessRuntime,
  type ProcessServices,
  type ScopedFork,
  scopedFork,
  withProcessServices,
} from '@texra-ai/worldline/host';
import {
  withLogChannel,
  Settings,
  type GlobalValues,
} from '@texra-ai/worldline/plugins';
import { withForkFailureReporting } from '@texra-ai/worldline/transcript';
import {
  canonicalizeWorkspaceRoot,
  effectDiagnosticsLayer,
  setLogSink,
} from '@texra-ai/worldline/node';
import { decodingDefault, type StateKey } from '@texra-ai/worldline/schemas';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import { createSampleProjectWithoutWorkspace } from '@commands/system/sampleProjectCommands';
import { askNotice, vscodeUi } from '@frontend/hosts/VscodeUiHost';
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
  reportingFailure,
  showLoggedErrorMessage,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { registerFileDecorations } from '@frontend/ui/fileDecorations';
import { registerWelcomeView } from '@frontend/ui/welcomeView';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import {
  announceSignIn,
  subscriptionProvider,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import { makeInlineCriticism } from '@frontend/latex/inlineCriticism';
import { makeInlineComments } from '@frontend/comments/inlineComments';
import { createVsCodeLogSink } from '@frontend/vscode/vscodeLogSink';
import { telemetryNoticeIfDue } from '@telemetry/telemetryNotice';
import { HostTelemetrySwitch } from '@telemetry/UsageLogService';
import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';
import type { CommandId } from '@texra/shared/commands/catalog';
import {
  openGlobalConfig,
  openProjectRoots,
  openProjectSession,
} from '@texra/controllers/session/openProjectSession';
import {
  reachBundledService,
  ServiceUnavailable,
  type ServiceLink,
} from '@texra/controllers/server/client';
import { texraProcessLayer } from '@texra/controllers/texraProcessLayer';
import { HostWindows } from '@texra/controllers/server/hostWindows';
import { followGitHubTokenRejections } from '@texra/controllers/session/windowNotices';
import type { GuiSession } from '@texra/controllers/session/openGuiWindow';

// Local file imports
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import {
  registerCommands,
  registerHandlers,
  setApiKeyHandler,
} from './commands';
import type { SettingsViewProvider } from './settingsView/SettingsViewProvider';

const EXTENSION_CHANNEL = 'extension';

/** Set once the first-run welcome card has been shown. */
const WELCOME_SHOWN_KEY = {
  key: 'welcomeShown',
  slot: 'globalState',
  schema: decodingDefault(Schema.Boolean, false),
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
  // The Comments UI behind the `inline_comment` tool, for a folder's window:
  // agents run only there.
  const inlineComments =
    workspaceRoot === undefined ? undefined : yield* makeInlineComments;
  const managed = withForkFailureReporting(
    ManagedRuntime.make(
      texraProcessLayer({
        name: 'vscode',
        inlineComments,
        // The editor's commands and terminal, for the setup tools.
        setup: vscodeSetupPlatform,
        // The editor's extensions, for the setup tools.
        editor: vscodeEditorIntegration,
        // `~/.texra`: one history across CLI, desktop and extension.
        storageRoot: defaultNodeStorageRoot(),
        resourcesPath: path.join(context.extensionPath, 'resources'),
        usageLog: {
          version: extensionVersion,
          editorType: vscode.env.appName || undefined,
        },
        // The Output channel owns filtering, so emit every level.
        minimumLogLevel: 'Trace',
        // The window's own reads (credential status, model discovery) see
        // the workspace's `.env`, as its tasks do, without it ever being
        // merged into the extension host's shared `process.env`.
        workspace: workspaceRoot,
      }).pipe(
        // VS Code's own telemetry setting, read live: it overrides ours.
        Layer.provideMerge(
          Layer.succeed(HostTelemetrySwitch)(
            () => vscode.env.isTelemetryEnabled,
          ),
        ),
      ),
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
  // Every VS Code callback of the activation starts its work here: the
  // activation scope's close ends it before the runtime goes, and a
  // callback after deactivation starts nothing.
  const activationScope = yield* Scope.Scope;
  const fork = yield* withProcessServices(
    managed,
    scopedFork<ProcessServices | Sessions>().pipe(
      Effect.provideService(Scope.Scope, activationScope),
    ),
  );
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
          ? Result.fail(
              new ServiceUnavailable({
                reason: 'a window with no folder uses no service',
              }),
            )
          : // Held with the project state it serves: after the sessions
            // that read it close, before the runtime its reconnects use.
            yield* Effect.result(
              extras.service.pipe(Scope.provide(projectScope)),
            );
      // VS Code restarts the extension host when the first workspace folder
      // changes, so the configuration stores stay pinned for this process.
      // Forked: a notification waits for the person, and activation does not.
      const warn = (message: string) =>
        Effect.sync(() => fork(vscodeUi.notify('warning', message)));
      const roots = yield* openProjectRoots(
        defaultNodeStorageRoot(),
        workspaceRoot,
        yield* openGlobalConfig(defaultNodeStorageRoot(), warn),
        Result.getOrUndefined(reached),
        warn,
      ).pipe(Scope.provide(projectScope));
      // The one-time telemetry notice, one information message.
      const notice = yield* telemetryNoticeIfDue(roots.config);
      if (notice) yield* vscodeUi.notify('info', notice);
      return { runtime, fork, roots, hosts: yield* HostWindows, reached };
    }),
  );
});

/**
 * The commands a window without a single folder registers, since nothing they
 * do needs a workspace: the walkthrough's credential and sample buttons work
 * before a folder is open. The full command surface is registered only on the
 * single-folder path, so these are standalone variants of its rows.
 */
const noFolderCommands = (
  context: vscode.ExtensionContext,
  roots: WorkspaceRoots,
) =>
  ({
    // A first-time user without a LaTeX project can create the sample and
    // land directly in a working workspace.
    'texra.createSampleProject': () =>
      createSampleProjectWithoutWorkspace(context.extensionPath),
    'texra.openGettingStarted': () => openGettingStarted(context.extension.id),
    // This window has no settings view to tell the user how the sign-in
    // ended, so the command does, in the same sentence.
    'texra.auth.chatgpt.signIn': () =>
      announceSignIn(
        'chatgpt',
        signInWithSubscription(roots, 'chatgpt'),
        showLoggedInfoMessage,
      ).pipe(
        // A defect is reported like a failure, as the settings body reports
        // one; an interrupt is the window closing, not a failed sign-in.
        reportingFailure((error) =>
          showLoggedErrorMessage(
            ACCOUNT_OUTCOME.signInFailed(
              subscriptionProvider('chatgpt').displayName,
            ),
            error,
          ),
        ),
        withLogChannel('welcomeView'),
      ),
    'texra.setApiKey': setApiKeyHandler(roots),
  }) as const;

/**
 * The commands that need a folder. The getting-started walkthrough's buttons
 * for them invoke one bridge command, so a no-workspace click can explain the
 * prerequisite without firing the real command's `onCommand` completion event.
 */
type WalkthroughCommandNeedingWorkspace = Exclude<
  CommandId,
  keyof ReturnType<typeof noFolderCommands>
>;

/** Internal command URI used by workspace-bound walkthrough links. */
const WALKTHROUGH_WORKSPACE_ACTION_COMMAND = 'texra.walkthroughWorkspaceAction';

const explainWorkspaceRequired = Effect.fn('explainWorkspaceRequired')(
  function* (extensionPath: string) {
    const openFolder = 'Open Folder';
    const createSample = 'Create Sample Project';
    const choice = yield* vscodeUi.ask(
      'info',
      'Open a single project folder or create the sample project first.',
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
  run: (command: WalkthroughCommandNeedingWorkspace) => unknown,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(WALKTHROUGH_WORKSPACE_ACTION_COMMAND, run),
  );
}

export async function activate(context: vscode.ExtensionContext) {
  // This host's one root program, from `activate` to the last
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
              Effect.annotateLogs({ data: cause }),
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
    const { runtime, fork, roots } = yield* initVscodePlatform(
      context,
      undefined,
    );
    registerWelcomeView(context, fork);
    registerHandlers(
      context,
      runtime,
      fork,
      roots,
      noFolderCommands(context, roots),
    );
    registerWalkthroughWorkspaceAction(context, () =>
      runtime.runPromise(explainWorkspaceRequired(context.extensionPath)),
    );
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
  const { runtime, fork, roots, hosts, reached } = yield* initVscodePlatform(
    context,
    workspaceRoot,
    {
      // Started, when none answers, from the bundle the extension ships,
      // with VS Code's own runtime as Node.
      service: reachBundledService(
        defaultNodeStorageRoot(),
        context.extensionPath,
      ),
    },
  );
  // The host entry holds the process runtime in a local and threads it to the
  // surfaces registered below, so code under `activate` runs its Effects on
  // the runtime it was handed instead of reading the global back.
  // The activation scope carries the shutdown: the workspace activation
  // registers its own finalizers there.
  const activationScope = yield* Scope.Scope;
  yield* withProcessServices(
    runtime,
    activateWorkspace(context, runtime, fork, roots, hosts, reached).pipe(
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
  /** The activation's run function for VS Code callbacks. */
  fork: ScopedFork<ProcessServices | Sessions>,
  roots: WorkspaceRoots,
  hosts: Context.Service.Shape<typeof HostWindows>,
  /** The background service, as the activation reached it once. */
  reached: Result.Result<ServiceLink, Error>,
) {
  const { globalState } = roots;
  // A window of the service opens no session of its own: no store, run
  // or claims. Only a window that cannot reach the service runs its
  // tasks here, and its banner says so. While the link is down, the
  // service's session answers with the offline refusal.
  const windowSession: GuiSession = yield* openProjectSession(
    roots,
    reached,
    (message) => vscodeUi.notify('warning', message),
  ).pipe(Effect.provideService(HostWindows, hosts));
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
  setupPill.command = 'texra.runSetupAssistant' satisfies CommandId;
  setupPill.accessibilityInformation = { label: 'TeXRA setup, get started' };
  context.subscriptions.push(setupPill);
  // The settings view is built with the commands, after the progress view
  // that opens it, so the progress view waits for it.
  const settingsView = yield* Deferred.make<SettingsViewProvider>();
  // The criticism diagnostics this window's follower shows and its editor
  // tools add to.
  const criticism = makeInlineCriticism();
  const progressViewProvider = yield* ProgressViewProvider.make(
    context,
    runtime,
    roots,
    windowSession,
    criticism.add,
    {
      openSettings: (target) =>
        Effect.flatMap(Deferred.await(settingsView), (view) =>
          view.showSettingsView(target),
        ),
      signInSubscription: (providerId) =>
        Effect.flatMap(Deferred.await(settingsView), (view) =>
          view.signInSubscription(providerId),
        ),
    },
  );
  yield* Effect.forkScoped(
    Stream.runForEach(
      progressViewProvider.window.snapshot.credentialUsable,
      (usable) =>
        Effect.sync(() => (usable ? setupPill.hide() : setupPill.show())),
    ),
  );
  yield* Effect.logInfo('TeXRA extension activated').pipe(
    withLogChannel(EXTENSION_CHANNEL),
  );
  // Registered last, so the first thing the activation scope's close runs:
  // every session stops and finishes its runs before the view and the host
  // resources registered above tear down around them.
  yield* Effect.addFinalizer(() =>
    Effect.asVoid(Effect.flatMap(Sessions, (sessions) => sessions.closeAll)),
  );

  const settingsViewProvider = registerCommands(
    context,
    progressViewProvider,
    runtime,
    fork,
    roots,
  );
  yield* Deferred.succeed(settingsView, settingsViewProvider);
  registerWalkthroughWorkspaceAction(context, (command) =>
    vscode.commands.executeCommand(command),
  );
  yield* registerFileDecorations(context, session);

  // Activation-lifetime listeners run in the activation scope, which ends
  // them when the extension deactivates.
  yield* Effect.forkScoped(
    followGitHubTokenRejections(askNotice, (target) =>
      settingsViewProvider.showSettingsView(target),
    ),
    { startImmediately: true },
  );
  yield* Effect.forkScoped(criticism.follow(session, roots));

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
