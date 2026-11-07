/**
 * The extension's half of its window (`openGuiWindow`): the verbs this host
 * performs, bound onto VS Code's commands, editors, pickers, and dialogs,
 * plus the few arms the extension answers its own way -- its file pickers,
 * its editor's current file, its tab pop-out, its getting-started commands.
 * Everything else is the one shared body, which decides the order, the
 * guards, and the refusal wording for both GUI hosts. Each arm answers
 * exactly once with an outcome or a request error; an arm the extension
 * does not perform is `Rejected` with its reason, never dropped.
 */
import * as path from 'node:path';

import * as vscode from 'vscode';
import { Effect, FiberHandle, Scope } from 'effect';

import { Rejected, type Session, type WorkspaceRoots } from '@texra-ai/harness';
import {
  type StateStore,
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
  withLogChannel,
  WorkspaceFs,
  pathToLocationIn,
} from '@texra-ai/harness/host';
import { workspaceRelativePath } from '@texra-ai/harness/node';
import { toErrorMessage, type AgentConfig } from '@texra-ai/harness/schemas';
import { setApiKey } from '@commands/api/apiKeyCommands';
import { cloneOverleafProject } from '@commands/git/gitCommands';
import { downloadArXivSource } from '@commands/latex/arXivCommands';
import { launchSetupAssistant } from '@commands/setup/setupAssistantCommand';
import { createSampleProject } from '@commands/system/sampleProjectCommands';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import { openGuidePage } from '@frontend/hosts/VscodeExternalOpener';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { openBuilt } from '@frontend/latex/openBuild';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { quickPick } from '@frontend/ui/dialogs';
import { withVSCodeProgress } from '@frontend/ui/progress';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { previewFinalOutput } from '@frontend/agents/finalOutputOpener';
import { parseVersionControlDiffFilename } from '@latex/latexdiff/diffFileNameManager';
import latexPreamble from '@resources/templates/chatExport.tex';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@texra/controllers/onboarding/onboardingFunnel';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type {
  GettingStartedAction,
  HostRequest,
} from '@texra/shared/session/hostRequest';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import { HostFailed, type NoticeLevel } from '@texra/hosts/uiHosts';

import { normalizeMainViewFileExtension } from '@texra/controllers/mainView/MainViewDroppedFilesController';
import {
  TRANSCRIPT_EXPORT_FORMAT_CHOICES,
  type TranscriptExportOpenKind,
} from '@texra/controllers/progressView/exportTranscript';
import { TranscriptExportFailed } from '@texra/controllers/progressView/transcriptExportFailure';
import {
  fromHost,
  hostFailure,
} from '@texra/controllers/session/hostCallFailure';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import type { HostSnapshotSource } from '@texra/controllers/session/hostSnapshotSource';
import type {
  OwnHostArms,
  SharedHostRequestBindings,
} from '@texra/controllers/session/openGuiWindow';
import type { SessionBridge } from '@texra/controllers/session/SessionBridge';
import type { WindowHost } from '@texra/controllers/server/windowHost';
import {
  type HostRequestFailure,
  type RequestRefusal,
} from '@texra/controllers/session/hostCallFailure';

// Local file imports
import { handleCompare } from './compareFiles';
import { createFileSelectionPickers, getCurrentFile } from './fileSelection';
import { findCommitInHistory } from './findCommit';
import { openFile } from './openFile';

const CHANNEL = 'ExtensionHostRequests';

interface ExtensionHostRequestsOptions {
  /** Where this window's runs run: the session here, or the service's. */
  readonly runSession: Session;
  readonly roots: WorkspaceRoots;
  /** The window's bridge and snapshot. */
  readonly bridge: SessionBridge;
  readonly snapshot: HostSnapshotSource;
  /** What this window does for its project's runs. */
  readonly window: WindowHost;
  readonly extensionPath: string;
  /** The extension's id, which names its getting-started walkthrough. */
  readonly extensionId: string;
  readonly globalState: StateStore;
  /** The process runtime the extension root holds; every request arm that
   *  settles an Effect runs it here. */
  readonly runtime: ProcessRuntime;
  /** The settings view at a target (`texra.showDashboard`). */
  openSettings(
    target: SettingsTarget | undefined,
  ): Effect.Effect<void, Error, ProcessServices>;
  /** Bring the "Connect a model" card into view (the setup assistant's
   *  answer when no credential is usable). */
  showConnectModel(): Effect.Effect<void, Error, ProcessServices>;
  /** Reveal the task list (`texra.showProgressView`). */
  showProgressView(): Effect.Effect<void, Error>;
  /** Reveal the task list for a run this window just started, or name the
   *  run in a toast when it cannot (the run actions' `revealProgress`). */
  readonly revealProgress: (config: AgentConfig) => Effect.Effect<void, Error>;
  /** The window's launcher (`HostRunActions.runValidated`), which the setup
   *  assistant's run starts through; it is there once the window has opened,
   *  so the run waits for it. */
  readonly launcher: Effect.Effect<HostRunActions['runValidated']>;
  /** The placement commands the sidebar and the editor tab share. */
  popOutToEditor(): Effect.Effect<void, HostRequestFailure, ProcessServices>;
  showInSidebar(): Effect.Effect<void, HostRequestFailure, ProcessServices>;
}

const done: HostOutcome = Object.freeze({ kind: 'done' } as const);

/** One of this extension's own command handlers, or a VS Code command, run
 *  in the arm's fiber: a typed failure or a defect is named and logged. */
function runHandler<A, E, R>(
  command: string,
  handler: Effect.Effect<A, E, R>,
): Effect.Effect<A, HostFailed | RequestRefusal, R> {
  const log = (failure: unknown) =>
    Effect.logError(
      `Command ${command} failed: ${toErrorMessage(failure)}`,
    ).pipe(withLogChannel(CHANNEL));
  return handler.pipe(
    Effect.mapError((cause) => hostFailure(command, cause)),
    Effect.tapError(log),
    Effect.tapDefect(log),
  );
}

/** Reveal `fsPath` in the OS file manager, with the command's own result
 *  discarded. */
function revealFileInOS(fsPath: string) {
  return Effect.asVoid(
    runHandler(
      'revealFileInOS',
      executeVscodeCommand('revealFileInOS', vscode.Uri.file(fsPath)),
    ),
  );
}

/** The export's open verb. The editor APIs behind it are thenables, so this
 *  is where they are lifted -- once, at the host boundary. */
const openExportPath = (
  filePath: string,
  kind: TranscriptExportOpenKind,
): Effect.Effect<void, HostFailed> => {
  const failed = (cause: unknown) =>
    new HostFailed({
      member: 'openPath',
      message: toErrorMessage(cause),
      cause,
    });
  const uri = vscode.Uri.file(filePath);
  if (kind === 'external') {
    return Effect.tryPromise({
      try: () => vscode.env.openExternal(uri),
      catch: failed,
    }).pipe(Effect.asVoid);
  }
  if (kind === 'pdf') {
    return executeVscodeCommand('vscode.open', uri).pipe(
      Effect.asVoid,
      Effect.mapError(failed),
    );
  }
  return openFileInEditor(filePath).pipe(
    Effect.asVoid,
    Effect.mapError(failed),
  );
};

/** This window's half of its `openGuiWindow`, for the view's scope. */
export const createExtensionHostRequests = Effect.fn(
  'createExtensionHostRequests',
)(function* (options: ExtensionHostRequestsOptions) {
  const { runSession, snapshot, globalState, runtime, roots } = options;

  /** The native picker of each multi-file launcher list. */
  const multipleFilePickers = createFileSelectionPickers(roots);
  // The window's one comparison refresh: a newer comparison replaces it,
  // and the view's scope ends it.
  const diffRefresh = yield* FiberHandle.make();
  /** A file action that schedules a PDF viewer opens it in the view's
   *  scope, so a close of the view cancels a delayed open. */
  const scope = yield* Scope.Scope;
  const inViewScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Scope.Scope, scope);
  const at = (file: string) => pathToLocationIn(roots.workspace, file);
  // A file-action port's handler; the process services come from the runtime.
  const runFileAction = <A, E>(
    command: string,
    handler: Effect.Effect<A, E, ProcessServices>,
  ) => withProcessServices(runtime, runHandler(command, handler));

  function getOpenedFiles(): Effect.Effect<string[]> {
    const workspaceRoot = roots.workspace;
    if (!workspaceRoot) {
      return Effect.logWarning('No workspace path found for opened files').pipe(
        withLogChannel(CHANNEL),
        Effect.as([]),
      );
    }
    const fileUris = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => tab.input)
      .filter(
        (input): input is vscode.TabInputText | vscode.TabInputCustom =>
          input instanceof vscode.TabInputText ||
          input instanceof vscode.TabInputCustom,
      )
      .map((input) => input.uri)
      .filter((uri) => uri.scheme === 'file');
    return Effect.succeed([
      ...new Set(
        fileUris.map((uri) => workspaceRelativePath(workspaceRoot, uri.fsPath)),
      ),
    ]);
  }

  /** The editor's current file into a launcher field. */
  const useCurrentFile = Effect.fn('useCurrentFile')(function* (
    request: Extract<HostRequest, { kind: 'useCurrentFile' }>,
  ) {
    const currentOpenFile = yield* getCurrentFile(roots);
    if (!currentOpenFile) {
      return yield* new Rejected({
        reason:
          'No file is currently open or the file is not part of the workspace.',
      });
    }
    // Opening a latexdiff artifact (`paper-diff1234abcd.tex`) as the base
    // file selects the file it was derived from instead, when that file is
    // still on disk, and its commit rides onto the launcher.
    if (request.fileType === 'base') {
      const parsed = parseVersionControlDiffFilename(currentOpenFile);
      if (parsed) {
        const commitLabel = yield* runHandler(
          'findCommitInHistory',
          findCommitInHistory(roots, parsed.commitHash),
        );
        if (commitLabel) {
          options.bridge.surfaceAction({
            kind: 'launch',
            patch: { commit: parsed.commitHash },
          });
        } else {
          yield* Effect.forkDetach(
            vscodeUi.notify(
              'info',
              `The commit ${parsed.commitHash} referenced by ${path.basename(currentOpenFile)} was not found in the repository history.`,
            ),
          );
        }
        const sourceLocation = pathToLocationIn(
          roots.workspace,
          parsed.sourcePath,
        );
        const sourceExists =
          sourceLocation.kind === 'workspace' &&
          (yield* Effect.flatMap(Effect.service(WorkspaceFs), (workspaceFs) =>
            workspaceFs.exists(sourceLocation.relativePath),
          ));
        if (sourceExists) {
          yield* snapshot.refreshFiles;
          return {
            kind: 'files',
            paths: [parsed.sourcePath],
          } satisfies HostOutcome;
        }
        yield* Effect.forkDetach(
          vscodeUi.notify(
            'info',
            `The base file ${parsed.sourcePath} could not be found. Keeping ${currentOpenFile} selected.`,
          ),
        );
      }
    }
    return {
      kind: 'files',
      paths: [currentOpenFile],
    } satisfies HostOutcome;
  });

  /** The reads a new credential invalidates: the credential, which the
   *  funnel and the banner follow, and the catalogs. */
  const refreshAfterCredentialChange = Effect.all(
    [snapshot.refreshHostBanners, snapshot.refreshCatalogs],
    { concurrency: 'unbounded', discard: true },
  );

  /** What each getting-started action runs. */
  const gettingStarted = (action: GettingStartedAction) => {
    switch (action) {
      case 'createSampleProject':
        return createSampleProject(options.extensionPath);
      case 'cloneOverleaf':
        return cloneOverleafProject();
      case 'downloadArxiv':
        return downloadArXivSource(roots);
    }
  };

  /** This host's half of the shared body's binding table: every verb mapped
   *  onto a VS Code command, an editor API, or the sidebar. */
  const bindings: SharedHostRequestBindings = {
    openPath: (file, line) => runHandler('openFile', openFile(file, line)),
    // The picker reports its own failures where they happen and answers
    // `null`, as it does for a cancel.
    pickFiles: (fileType) => multipleFilePickers[fileType](),
    latexdiff: {
      // The diffs' PDF viewer opens in the view's scope, so a close of the
      // view cancels an open still waiting.
      openDiffs: ([first, ...rest]) =>
        first === undefined
          ? Effect.void
          : runHandler(
              'openLatexdiffs',
              inViewScope(
                openBuilt(roots, [at(first), ...rest.map(at)], {
                  preserveFocus: true,
                }),
              ),
            ),
      withProgress: (title, task) =>
        withVSCodeProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: false,
          },
          task,
        ),
    },
    openSettings: (target) =>
      runHandler('openSettings', options.openSettings(target)),
    // SecretManager has no key-changed event, so the set-key flow's
    // completion is the explicit point to check the credential again.
    setApiKey: (provider) =>
      runHandler('setApiKey', setApiKey(roots, provider)).pipe(
        Effect.andThen(snapshot.refreshHostBanners),
      ),
    openExternal: (url) =>
      Effect.asVoid(
        fromHost('env.openExternal', () =>
          vscode.env.openExternal(vscode.Uri.parse(url)),
        ),
      ),
    // The banner refresh probes the dependencies again; the banner shows
    // what is missing.
    recheckDependencies: snapshot.refreshHostBanners,
    // Every dependency the banner lists installs from the one guide page.
    openInstallGuide: runHandler('openDoc', openGuidePage('installation')),
    onboarding: {
      signInChatGpt: Effect.gen(function* () {
        yield* signInWithSubscription(roots, CHANNEL, 'chatgpt');
        yield* refreshAfterCredentialChange;
      }),
      // The snapshot follows the flags it reads.
      skip: setOnboardingDeclined(globalState, true),
      runSetup: Effect.flatMap(options.launcher, (launcher) =>
        runHandler(
          'runSetupAssistant',
          launchSetupAssistant(
            roots,
            runSession,
            launcher,
            options.showConnectModel(),
            options.showProgressView(),
          ),
        ),
      ),
      skipSetup: setFirstRunDone(globalState),
      openGettingStarted: runHandler(
        'openGettingStarted',
        openGettingStarted(options.extensionId),
      ),
    },
  };

  /**
   * The arms this host performs its own way. The capabilities that still
   * answer with a promise - VS Code commands, the editor APIs - are lifted
   * once (`executeVscodeCommand`, `fromHost`), and this extension's own
   * commands run as the programs behind them, so no arm re-enters the
   * runtime between here and the bridge that runs this program.
   */
  const own: OwnHostArms = {
    popOut: () => Effect.as(options.popOutToEditor(), done),
    popBack: () => Effect.as(options.showInSidebar(), done),
    useCurrentFile: (request) => useCurrentFile(request),
    addOpenedFiles: (request) =>
      Effect.map(getOpenedFiles(), (opened): HostOutcome => {
        const allowed = new Set(
          getIncludedExtensions(request.fileType).map(
            normalizeMainViewFileExtension,
          ),
        );
        return {
          kind: 'files',
          paths:
            allowed.size > 0
              ? opened.filter((file) =>
                  allowed.has(normalizeMainViewFileExtension(file)),
                )
              : opened,
        };
      }),
    gettingStarted: (request) =>
      Effect.as(
        runHandler(request.action, gettingStarted(request.action)),
        done,
      ),
  };

  return {
    bindings,
    own,
    window: options.window,
    // The host's members read `this`, so they cross the boundary bound.
    notify: (level: NoticeLevel, message: string) =>
      vscodeUi.notify(level, message),
    runs: {
      revealProgress: options.revealProgress,
      openFinalOutput: previewFinalOutput,
    },
    // Each command is named, so a failure carries a tag, never a rejection.
    files: {
      openDiff: (base: string, edited: string, title: string) =>
        runFileAction(
          'compare',
          handleCompare(at(base), at(edited), title, diffRefresh),
        ),
      confirmAccept: (message: string) =>
        vscodeUi.confirm({ message, action: 'Replace file' }),
      openDirectory: revealFileInOS,
    },
    export: {
      // A refusal to show the pick is worded into the export's tag.
      pickFormat: quickPick(TRANSCRIPT_EXPORT_FORMAT_CHOICES, {
        title: 'Export transcript',
        placeHolder: 'Choose a format',
        ignoreFocusOut: true,
      }).pipe(
        Effect.map((choice) => choice?.format),
        Effect.mapError(
          (error) =>
            new TranscriptExportFailed({
              message: error.message,
              cause: error.cause,
            }),
        ),
      ),
      openPath: openExportPath,
      latexPreamble,
      resourcesPath: path.join(options.extensionPath, 'resources'),
    },
  };
});
