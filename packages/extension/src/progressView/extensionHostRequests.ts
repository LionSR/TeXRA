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

import {
  Cancelled,
  Rejected,
  type HostRequestFailure,
  type RequestRefusal,
  type Run,
  type Session,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import {
  AgentDirectories,
  type StateStore,
  type StateReadFailed,
  type StateWriteFailed,
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
  withLogChannel,
  WorkspaceFs,
  pathToLocationIn,
} from '@texra-ai/harness/host';
import { workspaceRelativePath } from '@texra-ai/harness/node';
import {
  toErrorMessage,
  type AgentConfig,
  type RunEndResult,
  type RunId,
} from '@texra-ai/harness/schemas';
import {
  handleLatexdiff,
  handleLatexdiffCommitAction,
  handleRunLatexdiff,
} from '@commands/latex/latexdiffCommands';
import {
  handleAcceptEdited,
  handleCompare,
} from '@commands/latex/compareCommands';
import { findCommitInHistory } from '@commands/git/gitCommands';
import { openFile, openLabel } from '@commands/files/openFileCommands';
import {
  createFileSelectionPickers,
  getCurrentFile,
} from '@commands/files/fileSelectionCommands';
import { setApiKey } from '@commands/api/apiKeyCommands';
import { cloneOverleafProject } from '@commands/git/gitCommands';
import { downloadArXivSource } from '@commands/latex/arXivCommands';
import { launchSetupAssistant } from '@commands/setup/setupAssistantCommand';
import { createSampleProject } from '@commands/system/sampleProjectCommands';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import { openGuidePage } from '@frontend/hosts/VscodeExternalOpener';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { quickPick } from '@frontend/ui/dialogs';
import { announce } from '@frontend/ui/errorHandlingUtils';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import { parseVersionControlDiffFilename } from '@latex/latexdiff/diffFileNameManager';
import latexPreamble from '@resources/templates/chatExport.tex';
import type { AcceptCopyMeta } from '@texra/shared/plugins/documentOutputs';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@texra/controllers/onboarding/onboardingFunnel';
import { isMultipleDocumentFileType } from '@texra/shared/launcher/fileTypes';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type {
  GettingStartedAction,
  HostRequest,
} from '@texra/shared/session/hostRequest';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import { ExternalOpenFailed } from '@texra/hosts/uiHosts';

import { normalizeMainViewFileExtension } from '@texra/controllers/mainView/MainViewDroppedFilesController';
import {
  TRANSCRIPT_EXPORT_FORMAT_CHOICES,
  type TranscriptExportOpenKind,
} from '@texra/controllers/progressView/exportTranscript';
import { ApiKeyPromptFailed } from '@texra/controllers/progressView/ProgressApiKeyRetryController';
import { TranscriptExportFailed } from '@texra/controllers/progressView/transcriptExportFailure';
import {
  fromHost,
  hostFailure,
  type HostCallFailed,
} from '@texra/controllers/session/hostCallFailure';
import type { HostSnapshotSource } from '@texra/controllers/session/hostSnapshotSource';
import type {
  OwnHostRequest,
  SharedHostRequestBindings,
} from '@texra/controllers/session/openGuiWindow';
import type { SessionBridge } from '@texra/controllers/session/SessionBridge';
import type { WindowHost } from '@texra/controllers/server/windowHost';
import { checkCoreDependencies } from '@texra/utils/system/checkCoreDependencies';
import { getToolDocsPage } from '@texra/utils/system/toolChecks';
import { texraGuideUrl } from '@ui/copy/guide';
import type { ApiKeyProviderId } from '@texra-ai/llm';

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
  /** Select a run this window just launched (the run actions' `launched`). */
  presentLaunchedRun(runId: RunId): void;
  /** The placement commands the sidebar and the editor tab share. */
  popOutToEditor(): Effect.Effect<void, HostRequestFailure, ProcessServices>;
  showInSidebar(): Effect.Effect<void, HostRequestFailure, ProcessServices>;
  /** The onboarding funnel recomputes after an action that changes its
   *  inputs (a key stored, a sign-in, the setup assistant run). */
  readonly refreshApiKeyStatus: Effect.Effect<void, Error, ProcessServices>;
  refreshOnboardingFunnel(): Effect.Effect<
    void,
    StateReadFailed | StateWriteFailed
  >;
}

const done: HostOutcome = Object.freeze({ kind: 'done' } as const);

/** One of this extension's own command handlers, or a VS Code command, run
 *  in the arm's fiber: a typed failure or a defect is named and logged. */
function runHandler<A, E, R>(
  command: string,
  handler: Effect.Effect<A, E, R>,
): Effect.Effect<A, HostCallFailed | RequestRefusal, R> {
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
): Effect.Effect<void, ExternalOpenFailed> => {
  const failed = (cause: unknown) =>
    new ExternalOpenFailed({
      kind: 'path',
      target: filePath,
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

  /** A working directory outside the open workspace folders cannot launch. */
  const admitLaunch: SharedHostRequestBindings['admitLaunch'] = (form) => {
    const requestedWorkingDirectory = form.workingDirectory.trim();
    return requestedWorkingDirectory &&
      !vscode.workspace.workspaceFolders?.some(
        (folder) =>
          path.resolve(folder.uri.fsPath) ===
          path.resolve(requestedWorkingDirectory),
      )
      ? Effect.fail(
          new Rejected({
            reason:
              'Choose one of the open workspace folders as the working directory.',
          }),
        )
      : Effect.void;
  };

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
  function useCurrentFile(
    request: Extract<HostRequest, { kind: 'useCurrentFile' }>,
  ) {
    return Effect.gen(function* () {
      const currentOpenFile = yield* getCurrentFile(roots);
      if (!currentOpenFile) {
        return yield* Effect.fail(
          new Rejected({
            reason:
              'No file is currently open or the file is not part of the workspace.',
          }),
        );
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
              announce(
                CHANNEL,
                vscodeUi.showInfoMessage(
                  `The commit ${parsed.commitHash} referenced by ${path.basename(currentOpenFile)} was not found in the repository history.`,
                ),
                undefined,
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
            return { kind: 'files', paths: [parsed.sourcePath] } as HostOutcome;
          }
          yield* Effect.forkDetach(
            announce(
              CHANNEL,
              vscodeUi.showInfoMessage(
                `The base file ${parsed.sourcePath} could not be found. Keeping ${currentOpenFile} selected.`,
              ),
              undefined,
            ),
          );
        }
      }
      return { kind: 'files', paths: [currentOpenFile] } as HostOutcome;
    });
  }

  function pickFiles(
    request: Extract<HostRequest, { kind: 'pickFiles' }>,
  ): Effect.Effect<HostOutcome, Rejected | Cancelled> {
    const { fileType } = request;
    const pick = isMultipleDocumentFileType(fileType)
      ? multipleFilePickers[fileType]
      : undefined;
    if (!pick) {
      return Effect.fail(
        new Rejected({
          reason: `A picker for ${fileType} files is not available; choose one from the list.`,
        }),
      );
    }
    // The picker reports its own failures where they happen and answers
    // `null`, so the only outcomes left here are a selection and a cancel.
    return pick().pipe(
      Effect.flatMap((selected) =>
        selected
          ? Effect.succeed<HostOutcome>({ kind: 'files', paths: selected })
          : Effect.fail(new Cancelled()),
      ),
    );
  }

  /** The onboarding funnel recomputed after an action that changed its
   *  inputs. */
  const refreshOnboardingFunnel = Effect.suspend(() =>
    options.refreshOnboardingFunnel(),
  );

  /** The reads a new credential invalidates: the API-key banner with the
   *  funnel that reads it, and the catalogs. */
  const refreshAfterCredentialChange = Effect.all(
    [
      options.refreshApiKeyStatus.pipe(
        Effect.mapError((cause) => hostFailure('refreshApiKeyStatus', cause)),
      ),
      snapshot.refreshCatalogs,
    ],
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
    openLabel: (label) => runHandler('openLabel', openLabel(roots, label)),
    admitLaunch,
    runWorkflowDiff: (diff) =>
      runHandler(
        'runLatexdiff',
        inViewScope(handleRunLatexdiff(roots, runSession, diff)),
      ),
    latexdiffAgainstCommit: (action, baseFile, commit) =>
      runHandler(
        action,
        inViewScope(
          handleLatexdiffCommitAction(roots, action, baseFile, commit),
        ),
      ),
    openSettings: (target) =>
      runHandler('openSettings', options.openSettings(target)),
    // SecretManager has no key-changed event, so the set-key flow's
    // completion is the explicit refresh point for the funnel.
    setApiKey: runHandler('setApiKey', setApiKey(roots)).pipe(
      Effect.andThen(refreshOnboardingFunnel),
    ),
    openGuide: (page, anchor) =>
      Effect.asVoid(
        fromHost('env.openExternal', () =>
          vscode.env.openExternal(
            vscode.Uri.parse(texraGuideUrl(page, anchor)),
          ),
        ),
      ),
    openCustomAgentDirectory: Effect.gen(function* () {
      const dir = yield* (yield* AgentDirectories).custom();
      if (dir) yield* revealFileInOS(dir);
    }),
    recheckDependencies: Effect.gen(function* () {
      yield* checkCoreDependencies(true);
      yield* snapshot.refreshHostBanners;
    }),
    openInstallGuide: Effect.fn('extensionHostRequests.openInstallGuide')(
      function* (tool) {
        const page = getToolDocsPage(tool);
        if (!page) {
          return yield* Effect.fail(
            new Rejected({
              reason: `No install guide is registered for ${tool}.`,
            }),
          );
        }
        yield* runHandler('openDoc', openGuidePage(page));
      },
    ),
    onboarding: {
      signInChatGpt: Effect.gen(function* () {
        yield* signInWithSubscription(roots, CHANNEL, 'chatgpt');
        yield* refreshAfterCredentialChange;
      }),
      skip: Effect.gen(function* () {
        yield* setOnboardingDeclined(globalState, true);
        yield* refreshOnboardingFunnel;
      }),
      runSetup: Effect.gen(function* () {
        yield* runHandler(
          'runSetupAssistant',
          launchSetupAssistant(
            roots,
            runSession,
            (runId) => Effect.sync(() => options.presentLaunchedRun(runId)),
            options.showConnectModel(),
            options.showProgressView(),
          ),
        );
        yield* refreshOnboardingFunnel;
      }),
      // The provider's `firstRunDone` follower refreshes the funnel.
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
  const own = (request: OwnHostRequest) =>
    Effect.gen(function* () {
      switch (request.kind) {
        case 'popOut':
          yield* options.popOutToEditor();
          return done;
        case 'popBack':
          yield* options.showInSidebar();
          return done;
        case 'pickFiles':
          return yield* pickFiles(request);
        case 'useCurrentFile':
          return yield* useCurrentFile(request);
        case 'addOpenedFiles': {
          const allowed = new Set(
            getIncludedExtensions(request.fileType).map(
              normalizeMainViewFileExtension,
            ),
          );
          const opened = yield* getOpenedFiles();
          const outcome: HostOutcome = {
            kind: 'files',
            paths:
              allowed.size > 0
                ? opened.filter((file) =>
                    allowed.has(normalizeMainViewFileExtension(file)),
                  )
                : opened,
          };
          return outcome;
        }
        case 'gettingStarted':
          yield* runHandler(request.action, gettingStarted(request.action));
          return done;
        case 'workspaceFile':
          return yield* Effect.fail(
            new Rejected({ reason: 'The file editor is a desktop feature.' }),
          );
      }
    });

  return {
    bindings,
    own,
    window: options.window,
    showInfoMessage: vscodeUi.showInfoMessage,
    showWarningMessage: vscodeUi.showWarningMessage,
    runs: {
      launched: (run: Run) =>
        Effect.sync(() => options.presentLaunchedRun(run.runId)),
      openFinalOutput: (config: AgentConfig, result: RunEndResult) =>
        withProcessServices(
          runtime,
          openFinalOutputIfAvailable(roots, config)(result),
        ),
      // The set-key prompt either runs or faults, so its failure is the one
      // failure, as `ApiKeyPromptFailed`.
      promptForApiKey: (provider: ApiKeyProviderId) =>
        runHandler('setApiKey', setApiKey(roots, provider)).pipe(
          Effect.mapError(
            (failure) =>
              new ApiKeyPromptFailed({
                provider,
                message: 'The host could not ask for a provider API key.',
                cause: failure,
              }),
          ),
        ),
    },
    // Each command is named, so a failure carries a tag, never a rejection.
    files: {
      compareFiles: (base: string, edited: string) =>
        runFileAction(
          'compare',
          handleCompare(at(base), at(edited), diffRefresh),
        ),
      acceptEditedFile: (
        base: string,
        edited: string,
        copyMeta?: AcceptCopyMeta,
      ) =>
        runFileAction(
          'acceptEdited',
          handleAcceptEdited(at(base), at(edited), copyMeta),
        ),
      latexdiffFile: (base: string, edited: string) =>
        runFileAction(
          'latexdiff',
          inViewScope(handleLatexdiff(roots, base, edited)),
        ),
      openDirectory: (directory: string) => revealFileInOS(directory),
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
              step: 'pickFormat',
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
