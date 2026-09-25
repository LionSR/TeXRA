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

import { runAgent, type SessionHandle } from '@agent/runtime';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import {
  createFileSelectionPickers,
  getCurrentFile,
} from '@commands/files/fileSelectionCommands';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { teamAvailabilityPrompt } from '@common/teams/TeamPlan';
import type { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import {
  attachDroppedFiles,
  normalizeMainViewFileExtension,
} from '@controllers/mainView/MainViewDroppedFilesController';
import { prepareSurfaceLaunch } from '@controllers/mainView/backend/MainViewRunLaunchController';
import { ChatExportController } from '@controllers/progressView/ChatExportController';
import {
  exportRunTranscript,
  TRANSCRIPT_EXPORT_FORMAT_CHOICES,
  type TranscriptExportOpenKind,
} from '@controllers/progressView/exportTranscript';
import { TranscriptExportFailed } from '@controllers/progressView/transcriptExportFailure';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { ApiKeyPromptFailed } from '@controllers/progressView/ProgressApiKeyRetryController';
import {
  fromHost,
  hostFailure,
  type HostCallFailed,
} from '@controllers/session/hostCallFailure';
import {
  createHostRunActions,
  type HostRunActionPorts,
} from '@controllers/session/hostRunActions';
import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import {
  handleSharedHostRequest,
  isSharedHostRequest,
  type SharedHostRequestBindings,
  type SharedHostRequestPorts,
} from '@controllers/session/sharedHostRequests';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import { runSignInCommand } from '@frontend/auth/signInCommand';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { chooseTeamAvailabilityViaDialog } from '@frontend/ui/dialogs';
import { ExternalOpenFailed } from '@hosts/uiHosts';
import { parseVersionControlDiffFilename } from '@latex/latexdiff/diffFileNameManager';
import { withLogChannel } from '@logger/effectLog';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import type {
  StateStore,
  StateReadFailed,
  StateWriteFailed,
} from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import {
  withProcessServices,
  type AgentCatalogServices,
  type ProcessRuntime,
  type ProcessServices,
} from '@platform/processRuntime';
import { withSessionFs, WorkspaceFs, type StorageFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import { presentLaunchedProgressRun } from '@progressView/progressNavigation';
import latexPreamble from '@resources/templates/chatExport.tex';
import {
  GETTING_STARTED_COMMANDS,
  isMultipleDocumentFileType,
  type RunId,
} from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import {
  Cancelled,
  Rejected,
  type HostRequestFailure,
  type RequestRefusal,
} from '@shared/session/requestErrors';
import type {
  HostOutcome,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';

import { toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';
import {
  locateInWorkspace,
  workspaceRelativePath,
} from '@utils/files/workspaceFS';
import { checkCoreDependencies } from '@utils/system/checkCoreDependencies';
import { getToolDocsCommand } from '@utils/system/toolUtils';
import {
  formatResultCount,
  normalizeLineEndings,
} from '@utils/text/stringUtils';

const CHANNEL = 'ExtensionHostRequests';

interface ExtensionHostRequestsOptions {
  readonly session: SessionHandle;
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

/** A VS Code command lifted once through `fromHost`, named by the command,
 *  with its failure logged before it travels on. */
function runCommand<T = void>(
  command: string,
  ...args: unknown[]
): Effect.Effect<T | undefined, HostCallFailed | RequestRefusal> {
  return fromHost(command, () =>
    vscode.commands.executeCommand<T | undefined>(command, ...args),
  ).pipe(
    Effect.tapError((failure) =>
      Effect.logError(
        `Command ${command} failed: ${toErrorMessage(failure)}`,
      ).pipe(withLogChannel(CHANNEL)),
    ),
  );
}

/** A VS Code command as a verb of the shared binding table: lifted once,
 *  named, and with the command's own result discarded. */
function commandVerb(command: string, ...args: unknown[]) {
  return Effect.asVoid(runCommand(command, ...args));
}

/** The typed notification surface the run-action ports, the launch host, and
 *  the transcript export ports take. */
export function createExtensionHostRequests(
  options: ExtensionHostRequestsOptions,
): ExtensionHostRequests {
  const {
    session,
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
   * Launch a validated request directly, as the desktop's `runValidated`
   * does: the surface's launch and the shared run actions both reach
   * `runAgent` here. The launch program takes its process services from this
   * runtime's context on the fiber that runs it, as the resume port's program
   * does.
   */
  const runValidated: HostRunActionPorts['runValidated'] = (
    { config, runId },
    runOptions = {},
  ) => {
    const launch = runAgent(
      runId === undefined
        ? { kind: 'fresh', config }
        : { kind: 'resume', config, runId },
      {
        session,
        openWorkflowOutput: (result) =>
          openFinalOutputIfAvailable(session.roots, result),
        preferHelperModel: runOptions.preferHelperModel ?? false,
        ownApiKeyFallback: runOptions.ownApiKeyFallback,
        onRun: runOptions.onRun,
        onRunResolved: presentLaunchedProgressRun,
      },
    ).pipe(Effect.asVoid);
    return withProcessServices(runtime, launch);
  };

  const runActions = runtime.runSync(
    createHostRunActions({
      session,
      runValidated,
      loadModelOptions: () =>
        withProcessServices(
          runtime,
          readModelAvailabilityInputs({
            ...session.roots,
            secrets,
          }).pipe(Effect.map(modelOptionsFrom)),
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

  const workflowFileActions = new ProgressWorkflowFileActionsController({
    state: runOutputs,
    storageRoot: session.roots.storage,
    host: {
      // Each VS Code command is a foreign edge: one lift, named, so the
      // port's failure channel carries a tag and never a bare rejection.
      compareFiles: (baseFile, editedFile) =>
        runCommand(
          'texra.compare',
          pathToLocationIn(session.roots.workspace, baseFile),
          pathToLocationIn(session.roots.workspace, editedFile),
        ),
      acceptEditedFile: (baseFile, editedFile, copyMeta) =>
        runCommand<boolean>(
          'texra.acceptEdited',
          pathToLocationIn(session.roots.workspace, baseFile),
          pathToLocationIn(session.roots.workspace, editedFile),
          copyMeta,
        ),
      mergeFile: (baseFile, editedFile) =>
        runCommand('texra.merge', baseFile, editedFile),
      latexdiffFile: (baseFile, editedFile) =>
        runCommand('texra.latexdiff', undefined, baseFile, editedFile),
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
  ): Effect.Effect<void, ExternalOpenFailed> =>
    Effect.tryPromise({
      try: async () => {
        const uri = vscode.Uri.file(filePath);
        if (kind === 'external') {
          await vscode.env.openExternal(uri);
          return;
        }
        if (kind === 'pdf') {
          await vscode.commands.executeCommand('vscode.open', uri);
          return;
        }
        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document, { preview: false });
      },
      catch: (cause) =>
        new ExternalOpenFailed({
          kind: 'path',
          target: filePath,
          message: toErrorMessage(cause),
          cause,
        }),
    });

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

  /** The launcher's Send: the surface's selections through the shared
   *  launch preparation, then the one launch command. */
  function launch(
    request: Extract<HostRequest, { kind: 'launch' }>,
  ): Effect.Effect<
    void,
    HostCallFailed | RequestRefusal | StateReadFailed,
    AgentCatalogServices
  > {
    return Effect.gen(function* () {
      const { launch: form } = request;
      const requestedWorkingDirectory = form.workingDirectory.trim();
      if (
        requestedWorkingDirectory &&
        !vscode.workspace.workspaceFolders?.some(
          (folder) =>
            path.resolve(folder.uri.fsPath) ===
            path.resolve(requestedWorkingDirectory),
        )
      ) {
        return yield* Effect.fail(
          new Rejected({
            reason:
              'Choose one of the open workspace folders as the working directory.',
          }),
        );
      }
      const prepared = yield* prepareSurfaceLaunch(
        request,
        {
          showInfoMessage: (message) => vscodeUi.showInfoMessage(message),
          // A dismissed launch notification is a cancellation here; the
          // settings view keeps `undefined` as "ask again".
          chooseTeamAvailability: (unavailableNames) =>
            chooseTeamAvailabilityViaDialog(
              teamAvailabilityPrompt(unavailableNames),
              { modal: false },
            ).pipe(Effect.map((choice) => choice ?? 'cancel')),
          signInForRemoteAgentCatalog: runSignInCommand,
        },
        session.roots.workspaceState,
        session.roots.storage,
      );
      yield* runValidated(prepared).pipe(
        Effect.mapError((cause) => hostFailure('runValidated', cause)),
      );
    });
  }

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

  function attachDropped(
    request: Extract<HostRequest, { kind: 'attachDroppedFiles' }>,
  ) {
    return attachDroppedFiles(
      session.roots.workspace,
      request.paths,
      getIncludedExtensions(request.category),
    ).pipe(
      Effect.tap((attached) =>
        attached.attachedCount > 0 && attached.rejectedCount > 0
          ? Effect.forkDetach(
              vscodeUi.showInfoMessage(
                `Attached ${formatResultCount(attached.attachedCount, 'dropped file')}; skipped ${formatResultCount(attached.rejectedCount, 'unsupported, folder, or out-of-workspace item')}.`,
              ),
            )
          : Effect.void,
      ),
      Effect.map((attached): HostOutcome => ({
        kind: 'files',
        paths: attached.paths,
      })),
    );
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
          const commitLabel = yield* runCommand<string | null>(
            'texra.findCommitInHistory',
            parsed.commitHash,
          );
          if (commitLabel) {
            options.surfaceAction({
              kind: 'launch',
              patch: { commit: parsed.commitHash },
            });
          } else {
            void runtime.runFork(
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
          void runtime.runFork(
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
    openPath: (file, line) => commandVerb('texra.openFile', file, line),
    openLabel: (label) =>
      Effect.map(
        runCommand<boolean>('texra.openLabel', label, {
          notifyNotFound: false,
        }),
        (opened) => opened === true,
      ),
    exportTranscript: (runId) => Effect.asVoid(exportTranscript(runId)),
    surfaceAction: (action) => options.surfaceAction(action),
    showLauncher: Effect.suspend(() => options.showInSidebar()),
    runWorkflowDiff: (diff) => commandVerb('texra.runLatexdiff', diff),
    runWorkflowFileOperation: (operation, request) =>
      commandVerb(`texra.${operation}`, request),
    latexdiffAgainstCommit: (action, baseFile, commit) =>
      action === 'latexdiffvc'
        ? commandVerb('texra.latexdiffvc', undefined, baseFile, commit)
        : commandVerb(
            `texra.${action}`,
            undefined,
            baseFile,
            commit,
            action === 'cleanLatexdiffvc',
          ),
    mergeFiles: (baseFile, editedFile) =>
      commandVerb('texra.merge', baseFile, editedFile),
    latexdiffFiles: (baseFile, editedFile) =>
      commandVerb('texra.latexdiff', undefined, baseFile, editedFile),
    openSettings: (section, sessionType) => {
      if (section === 'agents')
        return commandVerb(
          'texra.showAgents',
          sessionType === 'toolUse' ? 'toolUse' : undefined,
        );
      return commandVerb(
        section === 'models' ? 'texra.showModels' : 'texra.showMultiAgent',
      );
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
    openAgentSettings: (sessionType) =>
      commandVerb(
        'texra.showAgents',
        sessionType === 'toolUse' ? 'toolUse' : undefined,
      ),
    openCustomAgentDirectory: Effect.gen(function* () {
      const dir = yield* agentDirectories.custom();
      if (dir) {
        yield* fromHost('revealFileInOS', () =>
          vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(dir),
          ),
        );
      }
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
        case 'attachDroppedFiles':
          return yield* attachDropped(request);
        case 'launch':
          yield* launch(request);
          return done;
        case 'extractFigures':
          yield* commandVerb('texra.extractTikzFigures');
          return done;
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
