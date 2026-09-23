// The desktop's `host.request` handler (PRD one-fold-three-renderers, 8.3):
// every capability a surface asks its host for, one Zod-narrowed switch over
// the arms, mapped onto the window's dialogs, the preview host, the file
// pickers, and the paper's launch path. Each arm answers exactly once with
// an outcome or a request error; an arm the desktop does not perform is
// `Rejected` with its reason, never dropped.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Cause, Effect, Exit, FileSystem, SubscriptionRef } from 'effect';
import { presentAgentFailure, type SessionHandle } from '@agent/runtime';
import {
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { prepareSurfaceLaunch } from '@controllers/mainView/backend/MainViewRunLaunchController';
import type { ChatExportController } from '@controllers/progressView/ChatExportController';
import {
  ChatExportInputUnreadable,
  exportRunTranscript,
} from '@controllers/progressView/exportTranscript';
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
  RunConfigUnreadable,
  RunLaunchFailed,
  type WorkflowDiffRequest,
  type WorkflowFileOperationRequest,
} from '@controllers/session/hostRunActions';
import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import {
  handleSharedHostRequest,
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
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import type { AgentDirectoriesFailed, StateStore } from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import {
  sessionFsLayer,
  type GlobalStorageFs,
  type StorageFs,
  type WorkspaceFs,
} from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import {
  cloneRoundIndexed,
  type FileOpResult,
  type RunId,
} from '@shared/schemas';
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
import { toLogData } from './desktopLogUtils.js';
import {
  DesktopProgressFileActions,
  type DesktopLatexdiffWorkspaceScan,
} from './desktopProgressFileActions.js';
import {
  OnboardingCallFailed,
  type DesktopOnboardingIpc,
} from './desktopOnboardingIpc.js';
import type { PreviewUnavailable } from './desktopPreviewHost.js';
import type { DesktopAgentRun } from './desktopAgentRun.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';
import type { DesktopFileSelection } from './desktopFileSelection.js';

interface DesktopHostRequestsOptions {
  session: SessionHandle;
  /** The process stores the desktop root holds: the model catalog reads both,
   *  and the merge run reads the helper model from the state store. */
  secrets: PlatformSecrets;
  globalState: StateStore;
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
  /** Start the browser sign-in. The failure is the sign-in's own; the arm
   *  below names it for the request dialog. */
  signIn(): Effect.Effect<void, Error>;
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
  logger: {
    warn(message: string, data?: { data?: unknown }): void;
    error(message: string, data?: { data?: unknown }): void;
  };
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

const LATEXDIFF_CHANNEL = 'DesktopHostRequests';

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
  const { session, host, run, logger, runtime } = options;
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
      runAgentRequest: run.runAgentRequest,
      loadModelOptions: () =>
        Effect.flatMap(runtime.contextEffect, (context) =>
          Effect.provideContext(
            readModelAvailabilityInputs({
              ...session.roots,
              secrets: options.secrets,
            }).pipe(Effect.map(modelOptionsFrom)),
            context,
          ),
        ),
      // Only the "ask the user for a key" step is host-specific: on the
      // desktop that means opening the Models tab rather than a modal prompt.
      // The controller re-reads the secret store after this returns.
      promptForApiKey: () =>
        Effect.gen(function* () {
          postDesktopSettingsView(options.postToRenderer, 'models');
          yield* host.showInfoMessage(
            'Add a provider API key in Models, then use "Retry" on the request.',
          );
        }).pipe(
          Effect.catchTag(
            'NotificationFailed',
            (failure): Effect.Effect<void, ApiKeyPromptFailed> =>
              Effect.fail(
                new ApiKeyPromptFailed({
                  provider: undefined,
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
      globalState: options.globalState,
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
                : Effect.suspend(() => {
                    const error = Cause.squash(cause);
                    logger.error('Desktop merge run failed', {
                      data: toLogData(error),
                    });
                    const primaryError = primaryAgentError(error);
                    return presentAgentFailure(
                      session.interactions,
                      {
                        kind: classifyAgentError(primaryError),
                        message: `Merge failed: ${toErrorMessage(primaryError)}`,
                      },
                      { replayWhenAttached: true },
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
    Effect.gen(function* () {
      const context =
        runId === undefined
          ? undefined
          : yield* getLatexdiffRunContext(runId, editedFile);
      if (!context) {
        yield* fileActions.runLatexdiffFile(baseFile, editedFile);
        return;
      }
      yield* fileActions.diffAcceptedFilePair(baseFile, editedFile, context);
    }).pipe(
      Effect.mapError((cause) =>
        hostFailure('fileActions.runLatexdiffFile', cause),
      ),
    );

  /**
   * The run context a diff of an accepted file pair reads its per-round
   * outputs from: the run the sheet was opened on. Frozen here, not read
   * later: `getOutputFiles` reads the view's current level (#11402), and
   * this context crosses several awaits before anything enumerates it.
   */
  function getLatexdiffRunContext(runId: RunId, editedFile: string) {
    return Effect.gen(function* () {
      const config = yield* runActions.readConfig(runId);
      const outputsByRound = cloneRoundIndexed(
        runOutputs.getOutputFiles(runId),
      );
      const workspaceScan: DesktopLatexdiffWorkspaceScan | undefined = config
        ? {
            agent: config.agent,
            model: config.model,
            inputFile: config.inputFiles.at(0) ?? editedFile,
            // The run's output files, so multi-document runs resolved via the
            // run-dir or workspace scan diff every output.
            ...(config.outputFiles?.length
              ? { outputFiles: config.outputFiles }
              : {}),
          }
        : undefined;
      if (Object.keys(outputsByRound).length === 0 && !workspaceScan) {
        return undefined;
      }
      return {
        outputsByRound,
        runId,
        ...(workspaceScan && { workspaceScan }),
      };
    });
  }

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
      logError: (message, error) =>
        logger.error(message, { data: toLogData(error) }),
    },
    sendFollowUp: (runId, text) => runActions.sendFollowUp(runId, text),
  });

  const runWorkflowDiff = (request: WorkflowDiffRequest) =>
    Effect.gen(function* () {
      const { agent, model, inputFile } = request;
      if (!agent || !model || !inputFile) {
        return yield* Effect.fail(
          new Rejected({
            reason: 'Missing required configuration parameters for the diff.',
          }),
        );
      }
      yield* fileActions
        .diffStreamToolbarAction({
          outputsByRound: request.outputsByRound ?? {},
          runId: request.runId,
          workspaceScan: {
            agent,
            model,
            inputFile,
            outputFiles: request.outputFiles,
          },
        })
        .pipe(
          Effect.mapError((cause) =>
            hostFailure('fileActions.diffStreamToolbarAction', cause),
          ),
        );
    });

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
        logger.error(`Desktop ${operation} operation failed`, {
          data: toLogData(error),
        });
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
          const latexPreamble = await readFile(
            path.join(options.resourcesPath, 'templates', 'chatExport.tex'),
            'utf8',
          );
          return new Controller({
            session,
            latexPreamble,
          });
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
        reportDetail: (message) => logger.error(message),
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
          LATEXDIFF_CHANNEL,
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
    openDashboard: Effect.sync(() =>
      postDesktopSettingsView(options.postToRenderer),
    ),
    openSettings: (section, sessionType) =>
      Effect.sync(() =>
        postDesktopSettingsView(
          options.postToRenderer,
          section === 'teams' ? 'multi-agent' : section,
          sessionType === 'toolUse' ? 'toolUse' : undefined,
        ),
      ),
    // Only the "ask the user for a key" step is host-specific: on the
    // desktop that means opening the Models tab rather than a modal prompt.
    setApiKey: () =>
      Effect.sync(() =>
        postDesktopSettingsView(options.postToRenderer, 'models'),
      ),
    openApiKeyGuide: () =>
      options.openExternalUrl('https://texra.ai/guide/configuration.html'),
    openAgentSettings: (sessionType) =>
      Effect.sync(() =>
        postDesktopSettingsView(options.postToRenderer, 'agents', sessionType),
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
        postDesktopSettingsView(options.postToRenderer, 'tools'),
      ),
    signIn: Effect.suspend(() =>
      options
        .signIn()
        .pipe(Effect.mapError((cause) => hostFailure('signIn', cause))),
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
      openGettingStarted: Effect.suspend(() =>
        options.openExternalUrl(DESKTOP_DOCS_URL),
      ),
    },
    // One window per paper and no view-title menu, so nothing reads this.
    setActiveView: () => {},
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
      switch (request.kind) {
        case 'openFile':
        case 'openLabel':
        case 'openRunStorage':
        case 'exportTranscript':
        case 'restoreIntoLauncher':
        case 'resume':
        case 'runNew':
        case 'runCompileFixer':
        case 'useOwnApiKey':
        case 'latexdiff':
        case 'pack':
        case 'clean':
        case 'latexdiffs':
        case 'record':
        case 'openDashboard':
        case 'refreshCommits':
        case 'refreshFiles':
        case 'openSettings':
        case 'polish':
        case 'savePastedImage':
        case 'toolEdit':
        case 'setActiveView':
        case 'fileAction':
        case 'restoreProposalConfig':
        case 'apiKeyBanner':
        case 'agentConfigBanner':
        case 'recheckDependencies':
        case 'openInstallGuide':
        case 'signIn':
        case 'dismissBanner':
        case 'gettingStarted':
        case 'onboarding':
          return yield* handleSharedHostRequest(sharedRequests, request, port);
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
          yield* run
            .runValidated(launch)
            .pipe(
              Effect.mapError((cause) =>
                hostFailure('run.runValidated', cause),
              ),
            );
          return done;
        }
        case 'extractFigures':
          return yield* Effect.fail(notOnDesktop('Figure extraction'));
      }
    });
  }

  /**
   * The bridge's host-request port: the dispatch program plus the one dialog
   * a failed request presents before it is answered. The cause is squashed to
   * word the dialog and re-raised unchanged, so the bridge's
   * refusal-versus-defect fold sees what the failing arm produced.
   */
  function handleHostRequest(
    request: HostRequest,
    port: string,
  ): Effect.Effect<HostOutcome, HostRequestFailure, ProcessServices> {
    // Over this paper's rooted filesystems: an arm that writes under the
    // session's storage takes the view the layer above built from its roots.
    return Effect.provide(dispatch(request, port), sessionFiles).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        if (error instanceof Cancelled) return Effect.failCause(cause);
        // Request-scoped operations do not present. Every rejection, including
        // a capability refusal, reaches this one dialog before the response.
        // A lifted member is presented as what it rejected with: the tag names
        // the member, the classification reads the cause it carried, so the
        // dialog words the launcher's or the record read's own error exactly
        // as it did when that value reached here bare.
        const primaryError = primaryAgentError(
          error instanceof HostCallFailed ||
            error instanceof OnboardingCallFailed ||
            error instanceof RunLaunchFailed ||
            error instanceof RunConfigUnreadable ||
            error instanceof TranscriptExportFailed ||
            error instanceof ChatExportInputUnreadable
            ? error.cause
            : error,
        );
        const refusal =
          primaryError instanceof Rejected ||
          primaryError instanceof Unavailable
            ? primaryError
            : undefined;
        return presentAgentFailure(
          session.interactions,
          {
            kind: classifyAgentError(primaryError),
            message: refusal?.reason ?? toErrorMessage(primaryError),
            // A refused request's guide link (e.g. the launch's
            // file-management page) must survive into the host-owned
            // dialog (#11959).
            ...(refusal instanceof Rejected &&
              refusal.docsCommand && { docsCommand: refusal.docsCommand }),
          },
          { replayWhenAttached: true },
        ).pipe(Effect.andThen(Effect.failCause(cause)));
      }),
    );
  }

  return {
    handleHostRequest,
    closePort: draftRequests.closePort,
    dispose: draftRequests.dispose,
  };
}
