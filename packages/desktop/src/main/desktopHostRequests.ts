// The desktop's `host.request` handler (PRD one-fold-three-renderers, 8.3):
// every capability a surface asks its host for, one Zod-narrowed switch over
// the arms, mapped onto the window's dialogs, the preview host, the file
// pickers, and the paper's launch path. Each arm answers exactly once with
// an outcome or a request error; an arm the desktop does not perform is
// `Rejected` with its reason, never dropped.

import path from 'node:path';

import { Cause, Effect, Exit, FileSystem, SubscriptionRef } from 'effect';
import { presentRunFailure, type SessionHandle } from '@agent/runtime';
import {
  launchApprovalOptions,
  prepareSurfaceLaunch,
} from '@controllers/mainView/backend/MainViewRunLaunchController';
import type { ChatExportController } from '@controllers/progressView/ChatExportController';
import { exportRunTranscript } from '@controllers/progressView/exportTranscript';
import { TranscriptExportFailed } from '@controllers/progressView/transcriptExportFailure';
import { ApiKeyPromptFailed } from '@controllers/progressView/ProgressApiKeyRetryController';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import {
  fromHost,
  HostCallFailed,
  hostFailure,
} from '@controllers/session/hostCallFailure';
import {
  createHostRunActions,
  type WorkflowDiffRequest,
  type WorkflowFileOperationRequest,
} from '@controllers/session/hostRunActions';
import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import {
  handleSharedHostRequest,
  isSharedHostRequest,
  type SharedHostRequestBindings,
  type SharedHostRequestPorts,
} from '@controllers/session/sharedHostRequests';
import { listWorkspaceFilesOfType } from '@controllers/session/workspaceFileOptions';
import { ExternalOpenFailed } from '@hosts/uiHosts';
import {
  latexdiffPackMessage,
  runPackLatexdiffvc,
} from '@housekeeping/packLatexdiffvc';
import { packRunOutputs, runCleanRunDir } from '@housekeeping/runDirOps';
import { LaTeXdiffService } from '@latex/latexdiff';
import { withLogChannel } from '@logger/effectLog';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import type { AgentDirectoriesFailed } from '@platform/interfaces';
import {
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
} from '@platform/processRuntime';
import {
  sessionFsLayer,
  type GlobalStorageFs,
  type StorageFs,
  type WorkspaceFs,
} from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import latexPreamble from '@resources/templates/chatExport.tex';
import { type FileOpResult, type RunId } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import {
  Cancelled,
  Rejected,
  Unavailable,
  type HostRequestFailure,
  type RequestRefusal,
} from '@shared/session/requestErrors';
import type {
  HostOutcome,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';

import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  pathToLocationIn,
} from '@utils/files/fileLocation';

import {
  DESKTOP_DOCS_URL,
  postDesktopSettingsView,
  vsCodeOnlyGettingStartedMessage,
} from '../shared/desktopCommandSurface.js';
import { DesktopProgressFileActions } from './desktopProgressFileActions.js';
import type { DesktopOnboardingIpc } from './desktopOnboardingIpc.js';
import type { PreviewUnavailable } from './desktopPreviewHost.js';
import type { DesktopAgentRun } from './desktopAgentRun.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';
import type { DesktopFileSelection } from './desktopFileSelection.js';

interface DesktopHostRequestsOptions {
  session: SessionHandle;
  /** The process secret store the model catalog reads. */
  secrets: PlatformSecrets;
  host: DesktopAgentRunHost;
  run: DesktopAgentRun;
  files: DesktopFileSelection;
  snapshot: HostSnapshotSource;
  draftRequests: HostDraftRequests;
  workspacePath: string | undefined;
  /** Packaged app resources root (`…/resources`), for export templates. */
  resourcesPath: string;
  postToRenderer(message: unknown): boolean | void;
  /** A host-initiated change to the surface (PRD 8.5). */
  postSurfaceAction(action: SurfaceActionMessage['action']): void;
  getCustomAgentDirectory(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  >;
  showFirstRunWalkthrough(): void;
  onboarding: Pick<
    DesktopOnboardingIpc,
    'skipOnboarding' | 'skipSetup' | 'runSetup' | 'signInWithChatGpt'
  >;
  openExternalUrl(url: string): Effect.Effect<void, PreviewUnavailable>;
  /** Re-probe the LaTeX toolchain. */
  recheckTools(): Effect.Effect<void, never, ProcessServices>;
  /** The process runtime this window was handed; every request arm below runs
   *  on it. */
  runtime: ProcessRuntime;
}

export interface DesktopHostRequests {
  handleHostRequest(
    request: HostRequest,
    port: string,
  ): Effect.Effect<HostOutcome, HostRequestFailure, ProcessServices>;
  closePort(port: string): void;
  /** Stops a recording this window owns; the take is discarded. */
  dispose(): void;
}

const CHANNEL = 'DesktopHostRequests';

type WorkflowFileOperation = 'pack' | 'clean';

function operationLabel(operation: WorkflowFileOperation): {
  verb: string;
  gerund: string;
} {
  return operation === 'pack'
    ? { verb: 'pack', gerund: 'packing' }
    : { verb: 'clean', gerund: 'cleaning' };
}

export function createDesktopHostRequests(
  options: DesktopHostRequestsOptions,
): DesktopHostRequests {
  const { session, host, run, runtime } = options;
  /** The rooted filesystems of this window's paper, for the housekeeping
   *  programs. An open session holds a snapshot of its roots for its whole
   *  lifetime, so the layer is built once from it here, never from an
   *  ambient store. */
  const sessionFiles = sessionFsLayer(session.roots);
  // Shared controllers propagate request failures to the dispatcher: the
  // notice IS the refusal the request answers with, and the request rethrows
  // it unchanged.
  const rejectRequestEffect = (reason: string): Effect.Effect<void, Rejected> =>
    Effect.fail(new Rejected({ reason }));
  const draftRequests = options.draftRequests.attach(session, (recording) => {
    // Recorder notifications can arrive outside a request fiber.
    runtime.runFork(options.snapshot.setRecording(recording));
  });
  const runActions = runtime.runSync(
    createHostRunActions({
      session,
      runValidated: run.runValidated,
      loadModelOptions: () =>
        withProcessServices(
          runtime,
          readModelAvailabilityInputs({
            ...session.roots,
            secrets: options.secrets,
          }).pipe(Effect.map(modelOptionsFrom)),
        ),
      // Only the "ask the user for a key" step is host-specific: on the
      // desktop that means opening the Models tab rather than a modal prompt.
      // The controller re-reads the secret store after this returns.
      promptForApiKey: (provider) =>
        Effect.gen(function* () {
          postDesktopSettingsView(options.postToRenderer, 'models/keys');
          yield* host.showInfoMessage(
            'Add a provider API key in Models, then use "Retry" on the request.',
          );
        }).pipe(
          Effect.catchTag(
            'NotificationFailed',
            (failure): Effect.Effect<void, ApiKeyPromptFailed> =>
              Effect.fail(
                new ApiKeyPromptFailed({
                  provider,
                  message:
                    'The desktop could not show the API key instruction.',
                  cause: failure.cause,
                }),
              ),
          ),
        ),
      showInfo: (message) => host.showInfoMessage(message),
      showWarning: (message) => host.showWarningMessage(message),
    }),
  );
  const { runOutputs } = runActions;

  /** The label scan's candidates, as the program that lists them: the
   *  file-actions port takes the window's services from the runtime it holds,
   *  so nothing settles here. */
  const listWorkspaceCandidateFiles = () =>
    Effect.suspend(() => {
      const workspacePath = options.workspacePath;
      if (!workspacePath) return Effect.succeed([]);
      return Effect.all([
        listWorkspaceFilesOfType('input', workspacePath),
        listWorkspaceFilesOfType('context', workspacePath),
      ]).pipe(
        Effect.map((files) =>
          files.flat().map((file) => path.resolve(workspacePath, file)),
        ),
      );
    });

  const fileActions = new DesktopProgressFileActions(
    {
      ...host,
      // The refusal is the notice: the member fails with the `Rejected` the
      // request answers with, exactly as the rejecting promise did.
      showErrorMessage: rejectRequestEffect,
    },
    {
      session,
      runtime,
      // The request schedules a merge; its later run failure belongs to this
      // lifecycle callback, after the request has already completed.
      startRun: (request) => {
        runtime.runFork(
          run.runValidated(request).pipe(
            Effect.catchCause((cause) =>
              // A window torn down mid-merge interrupts this fiber; that is
              // not a merge failure, so it is re-raised for the fork's own
              // interrupts-only silence rather than presented.
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.gen(function* () {
                    const error = Cause.squash(cause);
                    yield* Effect.logError('Desktop merge run failed').pipe(
                      Effect.annotateLogs({ data: error }),
                      withLogChannel(CHANNEL),
                    );
                    return yield* presentRunFailure(
                      session.interactions,
                      error,
                      'Merge failed: ',
                    );
                  }),
            ),
          ),
        );
      },
      listWorkspaceCandidateFiles,
    },
  );

  const runLatexdiffFile = (
    baseFile: string,
    editedFile: string,
    runId?: RunId,
  ): Effect.Effect<void, HostCallFailed | RequestRefusal> =>
    (runId === undefined
      ? fileActions.runLatexdiffFile(baseFile, editedFile)
      : fileActions.diffAcceptedFilePair(baseFile, editedFile, runId)
    ).pipe(
      Effect.mapError((cause) =>
        hostFailure('fileActions.runLatexdiffFile', cause),
      ),
    );

  const workflowFileActions = new ProgressWorkflowFileActionsController({
    state: runOutputs,
    storageRoot: session.roots.storage,
    host: {
      compareFiles: (baseFile, editedFile) =>
        fileActions.compareFiles(baseFile, editedFile),
      acceptEditedFile: (baseFile, editedFile) =>
        fileActions.acceptEditedFile(baseFile, editedFile),
      mergeFile: (baseFile, editedFile) =>
        fileActions.runMergeFile(baseFile, editedFile),
      latexdiffFile: (baseFile, editedFile) =>
        runLatexdiffFile(baseFile, editedFile),
      openDirectory: (directory) => host.openPath(directory),
      // An accepted-edit backup names an absolute path the controller already
      // resolved, so this reads through the process filesystem rather than a
      // rooted view that would refuse a path outside the workspace.
      readFile: (file) =>
        Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
          fs.readFileString(file),
        ),
      showInfo: (message) => host.showInfoMessage(message),
      showError: rejectRequestEffect,
    },
    sendFollowUp: (runId, text) => runActions.sendFollowUp(runId, text),
  });

  const runWorkflowDiff = (request: WorkflowDiffRequest) =>
    fileActions
      .diffStreamToolbarAction(request.runId)
      .pipe(
        Effect.mapError((cause) =>
          hostFailure('fileActions.diffStreamToolbarAction', cause),
        ),
      );

  const reportFileOperationResult = (
    operation: WorkflowFileOperation,
    result: FileOpResult,
    inputFile: string,
  ) =>
    Effect.gen(function* () {
      const { verb } = operationLabel(operation);
      switch (result.status) {
        case 'success': {
          const folder = result.outputFolder;
          let message = 'Output files cleaned.';
          if (operation === 'pack') {
            message = folder ? `Files packed into ${folder}` : 'Files packed.';
          }
          yield* host.showInfoMessage(message);
          return;
        }
        case 'noFiles':
          yield* host.showInfoMessage(
            `No files found to ${verb} for ${inputFile}`,
          );
          return;
        case 'error':
          return yield* Effect.fail(
            new Rejected({ reason: `Error during ${verb}: ${result.error}` }),
          );
      }
    });

  const runWorkflowFileOperation = (
    operation: WorkflowFileOperation,
    request: WorkflowFileOperationRequest,
  ) =>
    Effect.gen(function* () {
      const { verb, gerund } = operationLabel(operation);
      const { agent, model, inputFile, runId } = request;
      if (!agent || !model || !inputFile) {
        return yield* Effect.fail(
          new Rejected({ reason: `Select an input file before ${gerund}.` }),
        );
      }
      if (!runId) {
        return yield* Effect.fail(
          new Rejected({ reason: `Missing run identity for ${verb}.` }),
        );
      }
      const ran = yield* Effect.exit(
        operation === 'pack'
          ? packRunOutputs(request)
          : runCleanRunDir(runId as RunId),
      );
      if (Exit.isFailure(ran)) {
        const error = Cause.squash(ran.cause);
        yield* Effect.logError(`Desktop ${operation} operation failed`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
        );
        return yield* Effect.fail(
          new Rejected({
            reason: `Error during ${operation}: ${toErrorMessage(error)}`,
          }),
        );
      }
      yield* reportFileOperationResult(operation, ran.value, inputFile);
    });

  /**
   * The chat export controller, loaded on the first export so its module
   * graph — the formatters, the trace assembler, the LaTeX compiler — stays
   * out of app startup. The memo is the library's: a successful load is kept
   * for the window's life, and a failed one expires at once so the next
   * export retries. `runSync` only allocates the memo; the load runs inside
   * the export's own program.
   */
  const getChatExportController: Effect.Effect<
    ChatExportController,
    TranscriptExportFailed
  > = runtime.runSync(
    Effect.cachedWithTTL(
      Effect.tryPromise({
        try: async () => {
          const { ChatExportController: Controller } =
            await import('@controllers/progressView/ChatExportController');
          return new Controller({ session, latexPreamble });
        },
        catch: (cause) =>
          new TranscriptExportFailed({
            step: 'openController',
            message: toErrorMessage(cause),
            cause,
          }),
      }),
      (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0),
    ),
  );

  const exportTranscript = (runId: RunId) =>
    Effect.gen(function* () {
      if (!SubscriptionRef.getUnsafe(session.view).runs.has(runId)) {
        return yield* Effect.fail(
          new Unavailable({ runId, reason: 'The run is no longer open.' }),
        );
      }
      yield* exportRunTranscript(runId, {
        pickFormat: host.pickTranscriptExportFormat(),
        // The preview host has already shown its own notice; the port's
        // tag carries that refusal and its wording out unchanged.
        openPath: (filePath) =>
          host.openPath(filePath).pipe(
            Effect.mapError(
              (cause) =>
                new ExternalOpenFailed({
                  kind: 'path',
                  target: filePath,
                  message: toErrorMessage(cause),
                  cause,
                }),
            ),
          ),
        showInfo: (message) => host.showInfoMessage(message),
        showWarning: (message) => host.showWarningMessage(message),
        showError: rejectRequestEffect,
        getController: getChatExportController,
        getTraceViewerTemplate: () =>
          path.join(options.resourcesPath, 'traceViewer', 'index.html'),
      });
    });

  /**
   * The sheet's commit verbs, the dock's "latexdiff vs last commit" among
   * them: latexdiff-vc over the base file against a commit, and the pack
   * and clean housekeeping of what it produced. The diff opens in the PDF
   * tab through the build display, as a run's outputs do. The math markup is
   * left to `diffCommandExecutor`, which reads `LATEXDIFF_MATH_MARKUP`.
   */
  const latexdiffAgainstCommit = (
    action: 'latexdiffvc' | 'packLatexdiffvc' | 'cleanLatexdiffvc',
    baseFile: string,
    commit: string,
  ) =>
    Effect.gen(function* () {
      if (!baseFile) {
        return yield* Effect.fail(
          new Rejected({ reason: 'Choose a base file first.' }),
        );
      }
      const base = pathToLocationIn(session.roots.workspace, baseFile);
      if (action === 'latexdiffvc') {
        const result = yield* new LaTeXdiffService(
          CHANNEL,
          session.roots,
        ).runDiffVc(base, commit);
        if (!result.success) {
          return yield* Effect.fail(new Rejected({ reason: result.message }));
        }
        yield* host
          .openBuildDisplay(createExternalLocation(result.diffPath))
          .pipe(
            Effect.catch((cause) =>
              Effect.fail(hostFailure('host.openBuildDisplay', cause)),
            ),
          );
        return;
      }
      const packed = yield* runPackLatexdiffvc(
        baseFile,
        commit,
        action === 'cleanLatexdiffvc',
      );
      const message = latexdiffPackMessage(packed);
      if (message) yield* host.showInfoMessage(message);
    });

  /** This window's half of the shared body's binding table: every verb
   *  mapped onto the window's dialogs, its preview host, its settings view,
   *  and the paper's launch path. */
  const hostBindings: SharedHostRequestBindings = {
    openPath: (file, line) => host.openPath(file, line),
    openLabel: (label) =>
      fileActions
        .findAndOpenLabel(label)
        .pipe(
          Effect.mapError((cause) =>
            hostFailure('fileActions.findAndOpenLabel', cause),
          ),
        ),
    exportTranscript,
    surfaceAction: (action) => options.postSurfaceAction(action),
    // One window per paper: the two surface actions above are the whole
    // move into the launcher here, so there is no sidebar left to raise.
    showLauncher: Effect.void,
    runWorkflowDiff,
    runWorkflowFileOperation,
    latexdiffAgainstCommit,
    mergeFiles: (baseFile, editedFile) =>
      fileActions.runMergeFile(baseFile, editedFile),
    latexdiffFiles: (baseFile, editedFile) =>
      runLatexdiffFile(baseFile, editedFile),
    openSettings: (section) =>
      Effect.sync(() =>
        postDesktopSettingsView(
          options.postToRenderer,
          section
            ? ({ teams: 'agents/teams', models: 'models/models' } as const)[
                section
              ]
            : undefined,
        ),
      ),
    // Only the "ask the user for a key" step is host-specific: on the
    // desktop that means opening the Models tab rather than a modal prompt.
    setApiKey: Effect.sync(() =>
      postDesktopSettingsView(options.postToRenderer, 'models/keys'),
    ),
    openApiKeyGuide: Effect.suspend(() =>
      options.openExternalUrl('https://texra.ai/guide/configuration.html'),
    ),
    openAgentSettings: (sessionType) =>
      Effect.sync(() =>
        postDesktopSettingsView(
          options.postToRenderer,
          'agents/library',
          sessionType,
        ),
      ),
    openCustomAgentDirectory: Effect.gen(function* () {
      const directory = yield* options.getCustomAgentDirectory();
      yield* host.openPath(directory);
    }),
    openAgentDocs: Effect.suspend(() =>
      options.openExternalUrl(`${DESKTOP_DOCS_URL}#agents`),
    ),
    recheckDependencies: Effect.suspend(() => options.recheckTools()),
    openInstallGuide: () =>
      Effect.sync(() =>
        postDesktopSettingsView(options.postToRenderer, 'tools/tools'),
      ),
    gettingStarted: (action) =>
      action === 'openWalkthrough'
        ? Effect.sync(() => options.showFirstRunWalkthrough())
        : Effect.asVoid(
            host.showInfoMessage(vsCodeOnlyGettingStartedMessage(action)),
          ),
    onboarding: {
      signInChatGpt: Effect.suspend(() =>
        options.onboarding.signInWithChatGpt(),
      ),
      skip: Effect.suspend(() => options.onboarding.skipOnboarding()),
      runSetup: Effect.suspend(() => options.onboarding.runSetup()),
      skipSetup: Effect.suspend(() => options.onboarding.skipSetup()),
      // The card's "Open walkthrough" opens the in-app walkthrough, the
      // same one `gettingStarted('openWalkthrough')` above opens.
      openGettingStarted: Effect.sync(() => options.showFirstRunWalkthrough()),
    },
  };

  /** The arms both GUI hosts answer through one body, now that this window's
   *  ports are bound. */
  const sharedRequests: SharedHostRequestPorts = {
    runActions,
    workflowFileActions,
    snapshot: options.snapshot,
    draftRequests,
    toolEditApprovals: run.toolEditApprovals,
    host: hostBindings,
  };

  const notOnDesktop = (what: string) =>
    new Rejected({ reason: `${what} is not available in the desktop app.` });

  /**
   * One program per request: the arms this window performs its own way. Every
   * other kind reaches the one shared body, which owns the order, the guards,
   * and the refusal wording for both GUI hosts. The capabilities that still
   * answer with a promise are lifted once through `fromHost`, so the failure
   * channel is the value the arm failed or rejected with and no dispatch arm
   * re-enters the runtime between here and the bridge that runs this program
   * (a lifted capability may still run its own program behind its face).
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
      const done: HostOutcome = { kind: 'done' };
      if (isSharedHostRequest(request)) {
        return yield* handleSharedHostRequest(sharedRequests, request, port);
      }
      switch (request.kind) {
        case 'popOut':
        case 'popBack':
          return yield* Effect.fail(notOnDesktop('Pop-out to editor'));
        case 'pickFiles': {
          const { fileType } = request;
          if (fileType === 'base' || fileType === 'edited') {
            return yield* Effect.fail(
              notOnDesktop(`A picker for ${fileType} files`),
            );
          }
          const paths = yield* fromHost('files.pickFiles', () =>
            options.files.pickFiles(fileType),
          );
          if (paths === null) return yield* Effect.fail(new Cancelled());
          return { kind: 'files', paths };
        }
        case 'useCurrentFile':
        case 'addOpenedFiles':
          return yield* Effect.fail(notOnDesktop("The editor's current file"));
        case 'attachDroppedFiles': {
          const { paths: dropped, category } = request;
          return {
            kind: 'files',
            paths: yield* options.files.attachDroppedFiles(dropped, category),
          };
        }
        case 'launch': {
          const launch = yield* prepareSurfaceLaunch(
            request,
            host,
            session.roots.workspaceState,
            session.roots.storage,
          );
          const approval = launchApprovalOptions(request, session.approvals);
          yield* run
            .runValidated(launch, approval)
            .pipe(Effect.mapError((e) => hostFailure('run.runValidated', e)));
          return done;
        }
        case 'extractFigures':
          return yield* Effect.fail(notOnDesktop('Figure extraction'));
      }
    });
  }

  /**
   * The bridge's host-request port. A failure is answered as it is: the
   * surface shows a refusal with its guide link, and a launch that fails has
   * already been presented by the launch itself.
   */
  function handleHostRequest(
    request: HostRequest,
    port: string,
  ): Effect.Effect<HostOutcome, HostRequestFailure, ProcessServices> {
    // Over this paper's rooted filesystems: an arm that writes under the
    // session's storage takes the view the layer above built from its roots.
    return Effect.provide(dispatch(request, port), sessionFiles);
  }

  return {
    handleHostRequest,
    closePort: draftRequests.closePort,
    dispose: draftRequests.dispose,
  };
}
