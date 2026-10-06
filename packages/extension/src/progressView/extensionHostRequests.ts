/**
 * The extension's `host.request` handler (PRD one-fold-three-renderers,
 * 8.3): the verbs this host performs, bound onto VS Code's commands,
 * editors, pickers, and dialogs, plus the few arms the extension answers its
 * own way -- its file pickers, its editor's current file, its tab pop-out,
 * its launch command. Everything else is the one shared body in
 * `sharedHostRequests.ts`, which decides the order, the guards, and the
 * refusal wording for both GUI hosts. Each arm answers exactly once with an
 * outcome or a request error; an arm the extension does not perform is
 * `Rejected` with its reason, never dropped.
 */
import * as path from 'node:path';

import * as vscode from 'vscode';
import { Effect, FileSystem } from 'effect';

import {
  AgentDirectories,
  type StateStore,
  type StateReadFailed,
  type StateWriteFailed,
  Cancelled,
  Rejected,
  type HostRequestFailure,
  type RequestRefusal,
  PlatformSecrets,
  LanguageModel,
} from '@texra-ai/harness';
import type { SessionHandle } from '@agent/runtime';
import {
  handleLatexdiff,
  handleLatexdiffCommitAction,
  handleRunLatexdiff,
} from '@commands/latex/latexdiffCommands';
import {
  handleAcceptEdited,
  handleCompare,
} from '@commands/latex/compareCommands';
import { handlePack } from '@commands/housekeeping/packCommands';
import { handleClean } from '@commands/housekeeping/cleanCommands';
import { findCommitInHistory } from '@commands/git/gitCommands';
import { openFile, openLabel } from '@commands/files/openFileCommands';
import {
  createFileSelectionPickers,
  getCurrentFile,
} from '@commands/files/fileSelectionCommands';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { handleMerge } from '@commands/agent/mergeCommands';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import { parseVersionControlDiffFilename } from '@latex/latexdiff/diffFileNameManager';
import { withLogChannel } from '@logger/effectLog';
import { withSessionFs, WorkspaceFs, type StorageFs } from '@platform/rootedFs';
import {
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
} from '@platform/processRuntime';
import latexPreamble from '@resources/templates/chatExport.tex';
import type { HostRequest } from '@shared/session/hostRequest';
import {
  GETTING_STARTED_COMMANDS,
  isMultipleDocumentFileType,
  type RunId,
} from '@shared/schemas';
import type {
  HostOutcome,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { ExternalOpenFailed } from '@texra/hosts/uiHosts';

import type { ToolEditApprovalController } from '@texra/controllers/approval/ToolEditApprovalController';
import { normalizeMainViewFileExtension } from '@texra/controllers/mainView/MainViewDroppedFilesController';
import { ChatExportController } from '@texra/controllers/progressView/ChatExportController';
import {
  exportRunTranscript,
  TRANSCRIPT_EXPORT_FORMAT_CHOICES,
  type TranscriptExportOpenKind,
} from '@texra/controllers/progressView/exportTranscript';
import { ApiKeyPromptFailed } from '@texra/controllers/progressView/ProgressApiKeyRetryController';
import { ProgressWorkflowFileActionsController } from '@texra/controllers/progressView/ProgressWorkflowFileActionsController';
import { TranscriptExportFailed } from '@texra/controllers/progressView/transcriptExportFailure';
import {
  fromHost,
  hostFailure,
  type HostCallFailed,
} from '@texra/controllers/session/hostCallFailure';
import type { HostDraftRequests } from '@texra/controllers/session/hostDraftRequests';
import {
  createHostRunActions,
  type HostRunActionPorts,
} from '@texra/controllers/session/hostRunActions';
import type { HostSnapshotSource } from '@texra/controllers/session/hostSnapshotSource';
import type { SessionBackend } from '@texra/controllers/session/sessionBackend';
import {
  handleSharedHostRequest,
  isSharedHostRequest,
  type SharedHostRequestBindings,
  type SharedHostRequestPorts,
} from '@texra/controllers/session/sharedHostRequests';
import { loadModelOptions } from '@texra/model/setupCredentialAccess';
import { checkCoreDependencies } from '@texra/utils/system/checkCoreDependencies';
import { getToolDocsCommand } from '@texra/utils/system/toolChecks';
import {
  locateInWorkspace,
  workspaceRelativePath,
} from '@utils/files/workspaceFS';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const CHANNEL = 'ExtensionHostRequests';

interface ExtensionHostRequestsOptions {
  readonly session: SessionHandle;
  /** Where this window's runs run: the session here, or the service's. */
  readonly backend: SessionBackend;
  readonly extensionPath: string;
  readonly globalState: StateStore;
  /** The process secret store the extension root holds (model availability). */
  readonly secrets: PlatformSecrets;
  readonly snapshot: HostSnapshotSource;
  readonly draftRequests: HostDraftRequests;
  readonly toolEditApprovals: ToolEditApprovalController;
  /** The process runtime the extension root holds; every request arm that
   *  settles an Effect runs it here. */
  readonly runtime: ProcessRuntime;
  /** A host-initiated change to the surface (PRD 8.5). */
  surfaceAction(action: SurfaceActionMessage['action']): void;
  /** Select a run this window just launched (the launch's `onRunResolved`). */
  presentLaunchedRun(runId: RunId): void;
  /** The placement commands the sidebar and the editor tab share. */
  popOutToEditor(): Effect.Effect<void, HostRequestFailure, ProcessServices>;
  showInSidebar(): Effect.Effect<void, HostRequestFailure, ProcessServices>;
  /** The onboarding funnel recomputes after an action that changes its
   *  inputs (a key stored, a sign-in, the setup assistant run). */
  readonly refreshApiKeyStatus: Effect.Effect<void, Error, ProcessServices>;
  refreshOnboardingFunnel(): Effect.Effect<
    void,
    StateReadFailed | StateWriteFailed,
    LanguageModel
  >;
}

interface ExtensionHostRequests {
  handleHostRequest(
    request: HostRequest,
    port: string,
  ): Effect.Effect<HostOutcome, HostRequestFailure, ProcessServices>;
  closePort(port: string): void;
  /** Stops a recording this host owns; the take is discarded. */
  dispose(): void;
}

const done: HostOutcome = Object.freeze({ kind: 'done' } as const);

const logCommandFailure =
  (command: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) => {
    const log = (failure: unknown) =>
      Effect.logError(
        `Command ${command} failed: ${toErrorMessage(failure)}`,
      ).pipe(withLogChannel(CHANNEL));
    return self.pipe(Effect.tapError(log), Effect.tapDefect(log));
  };

/** A VS Code command lifted once through `fromHost`, named by the command,
 *  with its failure logged before it travels on. */
function runCommand<T = void>(
  command: string,
  ...args: unknown[]
): Effect.Effect<T | undefined, HostCallFailed | RequestRefusal> {
  return fromHost(command, () =>
    vscode.commands.executeCommand<T | undefined>(command, ...args),
  ).pipe(logCommandFailure(command));
}

/** One of this extension's own command handlers, run in the arm's fiber
 *  rather than through `vscode.commands.executeCommand`: a typed failure or a
 *  defect is named and logged as a command's is. */
function runHandler<A, E, R>(
  command: string,
  handler: Effect.Effect<A, E, R>,
): Effect.Effect<A, HostCallFailed | RequestRefusal, R> {
  return handler.pipe(
    Effect.mapError((cause) => hostFailure(command, cause)),
    logCommandFailure(command),
  );
}

/** A VS Code command as a verb of the shared binding table: lifted once,
 *  named, and with the command's own result discarded. */
function commandVerb(command: string, ...args: unknown[]) {
  return Effect.asVoid(runCommand(command, ...args));
}

/** This window's `host.request` handler over its ports. */
export function createExtensionHostRequests(
  options: ExtensionHostRequestsOptions,
): ExtensionHostRequests {
  const {
    session,
    backend,
    snapshot,
    toolEditApprovals,
    secrets,
    globalState,
    runtime,
  } = options;
  const draftRequests = options.draftRequests.attach(session, (recording) => {
    // Recorder notifications can arrive outside a request fiber.
    runtime.runFork(options.snapshot.setRecording(recording));
  });

  /** The native picker of each multi-file launcher list. */
  const multipleFilePickers = createFileSelectionPickers(session);

  /**
   * Launch a validated fresh request through the window's backend, here or
   * in the service, and open its final output once it ends: the surface's
   * launch and the shared run actions both reach it. The launch program
   * takes its process services from this runtime's context on the fiber
   * that runs it.
   */
  const runValidated: HostRunActionPorts['runValidated'] = (
    request,
    runOptions = {},
  ) => {
    const launch = backend
      .launch(request, {
        preferHelperModel: runOptions.preferHelperModel ?? false,
        ownApiKeyFallback: runOptions.ownApiKeyFallback,
        approveDelegatedWork: runOptions.approveDelegatedWork,
        onRun: runOptions.onRun,
        onRunResolved: options.presentLaunchedRun,
      })
      .pipe(Effect.flatMap(openFinalOutputIfAvailable(session.roots)));
    return withProcessServices(runtime, launch);
  };

  const runActions = runtime.runSync(
    createHostRunActions({
      session,
      backend,
      runValidated,
      openWorkflowOutput: (result) =>
        withProcessServices(
          runtime,
          openFinalOutputIfAvailable(session.roots)(result),
        ),
      loadModelOptions: () =>
        withProcessServices(
          runtime,
          loadModelOptions({ ...session.roots, secrets }),
        ),
      // The set-key quick pick is a VS Code command: it either runs or
      // faults, so its rejection is the one failure, as `ApiKeyPromptFailed`.
      promptForApiKey: (provider) =>
        runCommand(EXTENSION_COMMANDS.SET_API_KEY, provider).pipe(
          Effect.mapError(
            (failure) =>
              new ApiKeyPromptFailed({
                provider,
                message: 'The host could not ask for a provider API key.',
                cause: failure,
              }),
          ),
        ),
      showInfo: (message) => vscodeUi.showInfoMessage(message),
      showWarning: (message) => vscodeUi.showWarningMessage(message),
    }),
  );

  const { runOutputs } = runActions;
  const at = (file: string) => pathToLocationIn(session.roots.workspace, file);
  // A file-action port's handler; the process services come from the runtime.
  const runFileAction = <A, E>(
    command: string,
    handler: Effect.Effect<A, E, ProcessServices>,
  ) => withProcessServices(runtime, runHandler(command, handler));

  const workflowFileActions = new ProgressWorkflowFileActionsController({
    state: runOutputs,
    storageRoot: session.roots.storage,
    host: {
      // Each command is named, so a failure carries a tag, never a rejection.
      compareFiles: (base, edited) =>
        runFileAction('compare', handleCompare(at(base), at(edited))),
      acceptEditedFile: (base, edited, copyMeta) =>
        runFileAction(
          'acceptEdited',
          handleAcceptEdited(at(base), at(edited), copyMeta),
        ),
      mergeFile: (base, edited) =>
        runFileAction('merge', handleMerge(session, base, edited)),
      latexdiffFile: (base, edited) =>
        runFileAction('latexdiff', handleLatexdiff(session, base, edited)),
      openDirectory: (directory) =>
        runCommand('revealFileInOS', vscode.Uri.file(directory)),
      // An accepted-edit backup names an absolute workspace path the
      // controller already resolved, so this reads through the process
      // filesystem rather than a rooted view that would refuse a path the
      // user picked outside the workspace.
      readFile: (file) =>
        Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
          Effect.map(fs.readFileString(file), normalizeLineEndings),
        ),
      showInfo: (message) => vscodeUi.showInfoMessage(message),
      showError: (message) => vscodeUi.showErrorMessage(message),
    },
    sendFollowUp: (runId, text) => runActions.sendFollowUp(runId, text),
  });

  let chatExportController: ChatExportController | undefined;

  /** The export port's open verb. The editor APIs behind it are thenables, so
   *  this is where they are lifted -- once, at the host boundary. */
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
      return Effect.tryPromise({
        try: () => vscode.commands.executeCommand('vscode.open', uri),
        catch: failed,
      }).pipe(Effect.asVoid);
    }
    return openFileInEditor(filePath).pipe(
      Effect.asVoid,
      Effect.mapError(failed),
    );
  };

  /** The transcript export, over the session's rooted filesystems the
   *  dispatch root already provided. */
  function exportTranscript(runId: RunId) {
    return exportRunTranscript(runId, {
      // The quick pick is a thenable, so it is lifted here -- once, at the
      // host boundary -- and its refusal is worded into the export's tag.
      pickFormat: Effect.tryPromise({
        try: async () =>
          (
            await vscode.window.showQuickPick(
              TRANSCRIPT_EXPORT_FORMAT_CHOICES,
              {
                title: 'Export transcript',
                placeHolder: 'Choose a format',
                ignoreFocusOut: true,
              },
            )
          )?.format,
        catch: (cause) =>
          new TranscriptExportFailed({
            step: 'pickFormat',
            message: toErrorMessage(cause),
            cause,
          }),
      }),
      openPath: openExportPath,
      showInfo: (message) => vscodeUi.showInfoMessage(message),
      showWarning: (message) => vscodeUi.showWarningMessage(message),
      showError: (message) => vscodeUi.showErrorMessage(message),
      getController: Effect.sync(
        () =>
          (chatExportController ??= new ChatExportController({
            session,
            latexPreamble,
          })),
      ),
      getTraceViewerTemplate: () =>
        path.join(
          options.extensionPath,
          'resources',
          'traceViewer',
          'index.html',
        ),
    });
  }

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
    const workspaceRoot = session.roots.workspace;
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
      const currentOpenFile = yield* getCurrentFile(session);
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
            findCommitInHistory(session, parsed.commitHash),
          );
          if (commitLabel) {
            options.surfaceAction({
              kind: 'launch',
              patch: { commit: parsed.commitHash },
            });
          } else {
            runtime.runFork(
              vscodeUi.showInfoMessage(
                `The commit ${parsed.commitHash} referenced by ${path.basename(currentOpenFile)} was not found in the repository history.`,
              ),
            );
          }
          const sourceLocation = locateInWorkspace(
            session.roots.workspace,
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
          runtime.runFork(
            vscodeUi.showInfoMessage(
              `The base file ${parsed.sourcePath} could not be found. Keeping ${currentOpenFile} selected.`,
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

  /** This host's half of the shared body's binding table: every verb mapped
   *  onto a VS Code command, an editor API, or the sidebar. */
  const hostBindings: SharedHostRequestBindings = {
    openPath: (file, line) =>
      runHandler('openFile', openFile(session, file, line)),
    openLabel: (label) => runHandler('openLabel', openLabel(session, label)),
    exportTranscript: (runId) => Effect.asVoid(exportTranscript(runId)),
    surfaceAction: (action) => options.surfaceAction(action),
    showInfo: (message) => vscodeUi.showInfoMessage(message),
    admitLaunch,
    runWorkflowDiff: (diff) =>
      runHandler('runLatexdiff', handleRunLatexdiff(session, diff)),
    runWorkflowFileOperation: (operation, request) =>
      runHandler(
        operation,
        operation === 'pack' ? handlePack(request) : handleClean(request),
      ),
    latexdiffAgainstCommit: (action, baseFile, commit) =>
      runHandler(
        action,
        handleLatexdiffCommitAction(session, action, baseFile, commit),
      ),
    openSettings: (section) => {
      if (section === 'teams') return commandVerb('texra.showTeamSettings');
      if (section === 'models') return commandVerb('texra.showModels');
      if (section === 'plugins')
        return commandVerb('texra.showDashboard', 'plugins');
      if (section === 'general')
        return commandVerb('texra.showDashboard', 'general/approval');
      return commandVerb('texra.showDashboard');
    },
    // SecretManager has no key-changed event, so the set-key flow's
    // completion is the explicit refresh point for the funnel.
    setApiKey: commandVerb('texra.setApiKey').pipe(
      Effect.andThen(refreshOnboardingFunnel),
    ),
    openApiKeyGuide: Effect.asVoid(
      fromHost('env.openExternal', () =>
        vscode.env.openExternal(
          vscode.Uri.parse(
            'https://texra.ai/guide/installation#setting-up-api-keys',
          ),
        ),
      ),
    ),
    openAgentSettings: commandVerb('texra.showAgents'),
    openCustomAgentDirectory: Effect.gen(function* () {
      const dir = yield* (yield* AgentDirectories).custom();
      if (dir) yield* commandVerb('revealFileInOS', vscode.Uri.file(dir));
    }),
    openAgentDocs: commandVerb('texra.openDoc', 'custom-agents'),
    recheckDependencies: Effect.gen(function* () {
      yield* checkCoreDependencies(true);
      yield* snapshot.refreshHostBanners;
    }),
    openInstallGuide: (tool) =>
      Effect.gen(function* () {
        const docsCommand = getToolDocsCommand(tool);
        if (!docsCommand) {
          return yield* Effect.fail(
            new Rejected({
              reason: `No install guide is registered for ${tool}.`,
            }),
          );
        }
        const [command, ...args] = docsCommand.split(',');
        yield* runCommand(command, ...args);
      }),
    gettingStarted: (action) =>
      Effect.gen(function* () {
        yield* commandVerb(GETTING_STARTED_COMMANDS[action]);
        if (action === 'runSetup') {
          yield* refreshOnboardingFunnel;
        }
      }),
    onboarding: {
      signInChatGpt: Effect.gen(function* () {
        yield* signInWithSubscription(session.roots, CHANNEL, 'chatgpt');
        yield* refreshAfterCredentialChange;
      }),
      skip: Effect.gen(function* () {
        yield* setOnboardingDeclined(globalState, true);
        yield* refreshOnboardingFunnel;
      }),
      runSetup: Effect.gen(function* () {
        yield* commandVerb(GETTING_STARTED_COMMANDS.runSetup);
        yield* refreshOnboardingFunnel;
      }),
      skipSetup: Effect.gen(function* () {
        yield* setFirstRunDone(globalState, true);
        yield* refreshOnboardingFunnel;
      }),
      openGettingStarted: commandVerb(GETTING_STARTED_COMMANDS.openWalkthrough),
    },
  };

  /** The arms both GUI hosts answer through one body, now that this host's
   *  ports are bound. */
  const sharedRequests: SharedHostRequestPorts = {
    runActions,
    workflowFileActions,
    snapshot,
    draftRequests,
    toolEditApprovals,
    session,
    host: hostBindings,
  };

  /**
   * One program per request. Every arm this host performs its own way is
   * here; the rest reach the shared body above. The capabilities that still
   * answer with a promise - the VS Code commands `runCommand` wraps, the
   * editor APIs, the Promise-faced controller ports - are lifted once
   * through `fromHost`, so no arm re-enters the runtime between here and the
   * bridge that runs this program.
   */
  function dispatch(
    request: HostRequest,
    port: string,
  ): Effect.Effect<
    HostOutcome,
    HostRequestFailure,
    ProcessServices | StorageFs | WorkspaceFs
  > {
    return Effect.gen(function* () {
      if (isSharedHostRequest(request)) {
        return yield* handleSharedHostRequest(sharedRequests, request, port);
      }
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
        case 'extractFigures':
          yield* commandVerb('texra.extractTikzFigures');
          return done;
        case 'workspaceFile':
          return yield* Effect.fail(
            new Rejected({ reason: 'The file editor is a desktop feature.' }),
          );
      }
    });
  }

  return {
    // The bridge takes the dispatch program itself: it runs on the fiber the
    // webview's message pump already owns, and its failure reaches the
    // bridge's refusal-versus-defect fold as the value the arm carried. Over
    // this session's rooted filesystems: the root a request writes under is
    // chosen here, at the host edge, not read at the depth that writes --
    // once, for the whole dispatch.
    handleHostRequest: (request, port) =>
      withSessionFs(session.roots, dispatch(request, port)),
    closePort: draftRequests.closePort,
    dispose: draftRequests.dispose,
  };
}
