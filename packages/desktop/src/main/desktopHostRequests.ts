// The desktop's `host.request` handler (PRD one-fold-three-renderers, 8.3):
// every capability a surface asks its host for, one Zod-narrowed switch over
// the arms, mapped onto the window's dialogs, the preview host, the file
// pickers, and the paper's launch path. Each arm answers exactly once with
// an outcome or a request error; an arm the desktop does not perform is
// `Rejected` with its reason, never dropped.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Cause, Data, Effect, Exit, FileSystem, SubscriptionRef } from 'effect';
import { presentAgentFailure, type SessionHandle } from '@agent/runtime';
import {
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { prepareSurfaceLaunch } from '@controllers/mainView/backend/MainViewRunLaunchController';
import type { ChatExportController } from '@controllers/progressView/ChatExportController';
import { exportRunTranscript } from '@controllers/progressView/exportTranscript';
import { TranscriptExportFailed } from '@controllers/progressView/transcriptExportFailure';
import { ApiKeyPromptFailed } from '@controllers/progressView/ProgressApiKeyRetryController';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import {
  createHostRunActions,
  launchPatchOf,
  RunConfigUnreadable,
  RunLaunchFailed,
  type WorkflowDiffRequest,
  type WorkflowFileOperationRequest,
} from '@controllers/session/hostRunActions';
import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import { listWorkspaceFilesOfType } from '@controllers/session/workspaceFileOptions';
import { ExternalOpenFailed } from '@hosts/uiHosts';
import {
  latexdiffPackMessage,
  runPackLatexdiffvc,
} from '@housekeeping/packLatexdiffvc';
import { runCleanRunDir, runPackRunDir } from '@housekeeping/runDirOps';
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
  isRequestRefusal,
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
  type DesktopLatexdiffRunContext,
  type DesktopLatexdiffWorkspaceScan,
} from './desktopProgressFileActions.js';
import type { DesktopOnboardingIpc } from './desktopOnboardingIpc.js';
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
  signIn(): Promise<void>;
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
  recheckTools(): Promise<void>;
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

/**
 * A desktop capability that still answers with a promise rejected. `member`
 * names which one; `cause` is the value the promise rejected with, which the
 * request's dialog classifies and presents as it presented the bare rejection.
 */
class HostCallFailed extends Data.TaggedError('HostCallFailed')<{
  readonly member: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

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
  /** A host capability that still answers with a promise, lifted once and
   *  named: a refusal the callee already worded travels as itself, and every
   *  other rejection is tagged with the member it came from. `message` is the
   *  rejection's own text and `cause` the value it was thrown with, so the
   *  fold below and the bridge's log read exactly what `await` handed over. */
  const fromHost = <A>(
    member: string,
    call: () => Promise<A>,
  ): Effect.Effect<A, HostCallFailed | RequestRefusal> =>
    Effect.tryPromise({
      try: call,
      catch: (cause) =>
        isRequestRefusal(cause)
          ? cause
          : new HostCallFailed({
              member,
              message: toErrorMessage(cause),
              cause,
            }),
    });
  // Shared controllers propagate request failures to the dispatcher: the
  // notice IS the refusal the request answers with, and the request rethrows
  // it unchanged.
  const rejectRequestEffect = (reason: string): Effect.Effect<void, Rejected> =>
    Effect.fail(new Rejected({ reason }));
  const draftRequests = options.draftRequests.attach(session, (recording) =>
    options.snapshot.setRecording(recording),
  );

  const runActions = runtime.runSync(
    createHostRunActions({
      session,
      runAgentRequest: run.runAgentRequest,
      loadModelOptions: () =>
        Effect.flatMap(runtime.contextEffect, (context) =>
          Effect.provideContext(
            readModelAvailabilityInputs({
              secrets: options.secrets,
              globalState: options.globalState,
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

  const listWorkspaceCandidateFiles = async (): Promise<string[]> => {
    const workspacePath = options.workspacePath;
    if (!workspacePath) return [];
    const files = await runtime.runPromise(
      Effect.all([
        listWorkspaceFilesOfType('input', workspacePath),
        listWorkspaceFilesOfType('context', workspacePath),
      ]),
    );
    return files.flat().map((file) => path.resolve(workspacePath, file));
  };

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
          Effect.tryPromise({
            try: () => run.runValidated(request),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              Effect.suspend(() => {
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

  async function runLatexdiffFile(
    baseFile: string,
    editedFile: string,
    runId?: RunId,
  ): Promise<void> {
    const context =
      runId === undefined
        ? undefined
        : await getLatexdiffRunContext(runId, editedFile);
    if (!context) {
      await fileActions.runLatexdiffFile(baseFile, editedFile);
      return;
    }
    await fileActions.diffAcceptedFilePair(baseFile, editedFile, context);
  }

  /**
   * The run context a diff of an accepted file pair reads its per-round
   * outputs from: the run the sheet was opened on. Frozen here, not read
   * later: `getOutputFiles` reads the view's current level (#11402), and
   * this context crosses several awaits before anything enumerates it.
   */
  async function getLatexdiffRunContext(
    runId: RunId,
    editedFile: string,
  ): Promise<DesktopLatexdiffRunContext | undefined> {
    const config = await runtime.runPromise(runActions.readConfig(runId));
    const outputsByRound = cloneRoundIndexed(runOutputs.getOutputFiles(runId));
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
      // The round-aware diff still answers with a promise (its fallback folds
      // an `Exit` behind that face), so it keeps the one lift a foreign edge
      // gets.
      latexdiffFile: (baseFile, editedFile) =>
        fromHost('fileActions.runLatexdiffFile', () =>
          runLatexdiffFile(baseFile, editedFile),
        ),
      openDirectory: (directory) => host.openPath(directory),
      // An accepted-edit backup names an absolute path the controller already
      // resolved, so this reads through the process filesystem rather than a
      // rooted view that would refuse a path outside the workspace.
      readFile: (file) =>
        Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
          fs.readFileString(file),
        ),
      showInfo: (message) => host.showInfoMessage(message),
      // The refusal is the notice: the member fails with the `Rejected` the
      // request answers with.
      showError: (reason) => Effect.fail(new Rejected({ reason })),
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
      yield* fromHost('fileActions.diffStreamToolbarAction', () =>
        fileActions.diffStreamToolbarAction({
          outputsByRound: request.outputsByRound ?? {},
          runId: request.runId,
          workspaceScan: {
            agent,
            model,
            inputFile,
            outputFiles: request.outputFiles,
          },
        }),
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
        Effect.provide(
          operation === 'pack'
            ? runPackRunDir(runId as RunId, agent, model, inputFile)
            : runCleanRunDir(runId as RunId),
          sessionFiles,
        ),
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

  let chatExportControllerLoad: Promise<ChatExportController> | undefined;
  function getChatExportController(): Promise<ChatExportController> {
    chatExportControllerLoad ??= runtime
      .runPromiseExit(
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
          catch: (error) => error,
        }),
      )
      .then((exit) => {
        // A failed load clears the memo so the next export retries, and the
        // caller sees the original failure, not the fold's envelope.
        if (Exit.isFailure(exit)) {
          chatExportControllerLoad = undefined;
          throw Cause.squash(exit.cause);
        }
        return exit.value;
      });
    return chatExportControllerLoad;
  }

  const exportTranscript = (runId: RunId) =>
    Effect.gen(function* () {
      if (!SubscriptionRef.getUnsafe(session.view).runs.has(runId)) {
        return yield* Effect.fail(
          new Unavailable({ runId, reason: 'The run is no longer open.' }),
        );
      }
      yield* Effect.provide(
        exportRunTranscript(runId, {
          pickFormat: () => host.pickTranscriptExportFormat(),
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
        }),
        sessionFiles,
      );
    });

  /** A run's saved setup into the launcher (PRD 8.3, 8.5): the launch
   *  patch rides a surface action, and the launcher comes into view. */
  function restoreIntoLauncher(
    config: Parameters<typeof launchPatchOf>[0],
  ): void {
    options.postSurfaceAction({ kind: 'launch', patch: launchPatchOf(config) });
    options.postSurfaceAction({ kind: 'selectNew' });
  }

  /**
   * The sheet's commit verbs, the dock's "latexdiff vs last commit" among
   * them: latexdiff-vc over the base file against a commit, and the pack
   * and clean housekeeping of what it produced. The diff opens in the PDF
   * tab through the build display, as a run's outputs do. The math markup
   * is left to `diffCommandExecutor`, which reads the workspace's saved
   * `LATEXDIFF_MATH_MARKUP` for every host.
   */
  const latexdiffAgainstCommit = (
    action: 'latexdiffvc' | 'packLatexdiffvc' | 'cleanLatexdiffvc',
    baseFile: string | undefined,
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
        yield* fromHost('host.openBuildDisplay', () =>
          host.openBuildDisplay(createExternalLocation(result.diffPath)),
        );
        return;
      }
      const packed = yield* Effect.provide(
        runPackLatexdiffvc(baseFile, commit, action === 'cleanLatexdiffvc'),
        sessionFiles,
      );
      const message = latexdiffPackMessage(packed);
      if (message) yield* host.showInfoMessage(message);
    });

  /** The Tools sheet's verbs over the launcher's base and edited files. */
  const latexdiffs = (request: Extract<HostRequest, { kind: 'latexdiffs' }>) =>
    Effect.gen(function* () {
      const { action } = request;
      const baseFile = request.baseFile ?? undefined;
      const editedFile = request.editedFile ?? undefined;
      if (
        action === 'latexdiffvc' ||
        action === 'packLatexdiffvc' ||
        action === 'cleanLatexdiffvc'
      ) {
        yield* latexdiffAgainstCommit(
          action,
          baseFile,
          request.commit ?? 'HEAD',
        );
        return;
      }
      if (!baseFile || !editedFile) {
        return yield* Effect.fail(
          new Rejected({
            reason: 'Choose a base file and an edited file first.',
          }),
        );
      }
      switch (action) {
        case 'compare':
          yield* workflowFileActions.compareOriginal(editedFile, baseFile);
          return;
        case 'accept':
          yield* workflowFileActions.acceptFile(editedFile, baseFile);
          return;
        case 'merge':
          yield* fileActions.runMergeFile(baseFile, editedFile);
          return;
        case 'latexdiff':
          yield* fromHost('fileActions.runLatexdiffFile', () =>
            runLatexdiffFile(baseFile, editedFile),
          );
          return;
      }
    });

  const agentConfigBanner = (
    request: Extract<HostRequest, { kind: 'agentConfigBanner' }>,
  ) =>
    Effect.gen(function* () {
      switch (request.action) {
        case 'edit':
          postDesktopSettingsView(
            options.postToRenderer,
            'agents',
            request.sessionType === 'toolUse' ? 'toolUse' : 'workflow',
          );
          return;
        case 'dir': {
          if (request.customDirSet !== true) {
            postDesktopSettingsView(options.postToRenderer, 'agents');
            return;
          }
          const directory = yield* options.getCustomAgentDirectory();
          yield* host.openPath(directory);
          return;
        }
        case 'docs':
          yield* options.openExternalUrl(`${DESKTOP_DOCS_URL}#agents`);
          return;
      }
    });

  const onboarding = (
    action: Extract<HostRequest, { kind: 'onboarding' }>['action'],
  ) =>
    Effect.gen(function* () {
      switch (action) {
        case 'signInChatGpt':
          yield* fromHost('onboarding.signInWithChatGpt', () =>
            options.onboarding.signInWithChatGpt(),
          );
          return;
        case 'setApiKey':
          postDesktopSettingsView(options.postToRenderer, 'models');
          return;
        case 'skip':
          yield* fromHost('onboarding.skipOnboarding', () =>
            options.onboarding.skipOnboarding(),
          );
          return;
        case 'runSetup':
          yield* fromHost('onboarding.runSetup', () =>
            options.onboarding.runSetup(),
          );
          return;
        case 'skipSetup':
          yield* fromHost('onboarding.skipSetup', () =>
            options.onboarding.skipSetup(),
          );
          return;
        case 'openGettingStarted':
          yield* options.openExternalUrl(DESKTOP_DOCS_URL);
          return;
      }
    });

  const notOnDesktop = (what: string) =>
    new Rejected({ reason: `${what} is not available in the desktop app.` });

  /**
   * One program per request. The arms are Effects; the capabilities that
   * still answer with a promise are lifted once through `fromHost`, so the
   * failure channel is the value the arm failed or rejected with and no
   * dispatch arm re-enters the runtime between here and the bridge that runs
   * this program (a lifted capability may still run its own program behind
   * its promise face).
   */
  function dispatch(
    request: HostRequest,
    port: string,
  ): Effect.Effect<
    HostOutcome,
    HostRequestFailure,
    ProcessServices | StorageFs
  > {
    return Effect.gen(function* () {
      const done: HostOutcome = { kind: 'done' };
      switch (request.kind) {
        case 'openFile': {
          const { path: filePath, line } = request;
          yield* host.openPath(filePath, line ?? undefined);
          return done;
        }
        case 'openLabel': {
          const { label } = request;
          const opened = yield* fromHost('fileActions.findAndOpenLabel', () =>
            fileActions.findAndOpenLabel(label),
          );
          if (!opened) {
            return yield* Effect.fail(
              new Rejected({ reason: `No file defines the label ${label}.` }),
            );
          }
          return done;
        }
        case 'openRunStorage': {
          const { runId } = request;
          yield* workflowFileActions.openRunStorage(runId);
          return done;
        }
        case 'exportTranscript':
          yield* exportTranscript(request.runId);
          return done;
        case 'restoreIntoLauncher':
          restoreIntoLauncher(yield* runActions.restoreState(request.runId));
          return done;
        case 'resume':
          yield* runActions.resume(request.runId);
          return done;
        case 'runNew':
          yield* runActions.runNew(request.runId);
          return done;
        case 'runCompileFixer':
          yield* runActions.runCompileFixer(request.runId);
          return done;
        case 'useOwnApiKey':
          yield* runActions.useOwnApiKey(request);
          return done;
        case 'latexdiff': {
          const diff = yield* runActions.workflowDiffRequest(request.runId);
          if (diff) yield* runWorkflowDiff(diff);
          return done;
        }
        case 'pack':
        case 'clean': {
          const operation = yield* runActions.workflowFileOperationRequest(
            request.runId,
          );
          if (operation) {
            yield* runWorkflowFileOperation(request.kind, operation);
          }
          return done;
        }
        case 'latexdiffs':
          yield* latexdiffs(request);
          return done;
        case 'record':
        case 'polish':
        case 'savePastedImage':
          return yield* draftRequests.handle(request, port);
        case 'popOut':
        case 'popBack':
          return yield* Effect.fail(notOnDesktop('Pop-out to editor'));
        case 'openDashboard':
          postDesktopSettingsView(options.postToRenderer);
          return done;
        case 'refreshCommits':
          yield* options.snapshot.refreshCommits;
          return done;
        case 'refreshFiles':
          yield* options.snapshot.refreshFiles;
          return done;
        case 'openSettings':
          postDesktopSettingsView(
            options.postToRenderer,
            request.section === 'teams' ? 'multi-agent' : request.section,
            request.sessionType === 'toolUse' ? 'toolUse' : undefined,
          );
          return done;
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
            paths: yield* fromHost('files.attachDroppedFiles', () =>
              options.files.attachDroppedFiles(dropped, category),
            ),
          };
        }
        case 'launch': {
          const launch = yield* prepareSurfaceLaunch(
            request,
            host,
            session.roots.workspaceState,
            session.roots.storage,
          );
          yield* fromHost('run.runValidated', () => run.runValidated(launch));
          return done;
        }
        case 'extractFigures':
          return yield* Effect.fail(notOnDesktop('Figure extraction'));
        case 'toolEdit':
          yield* run.toolEditApprovals.handleAction({
            requestId: request.requestId,
            action: request.action,
            ...(request.feedback == null ? {} : { feedback: request.feedback }),
          });
          return done;
        case 'fileAction': {
          const fileAction = request;
          const config = yield* runActions.readConfig(fileAction.runId);
          yield* workflowFileActions.handle(fileAction, config);
          return done;
        }
        case 'restoreProposalConfig':
          restoreIntoLauncher(runActions.restoreProposal(request.proposal));
          return done;
        case 'apiKeyBanner':
          if (request.action === 'set') {
            postDesktopSettingsView(options.postToRenderer, 'models');
          } else {
            yield* options.openExternalUrl(
              'https://texra.ai/guide/configuration.html',
            );
          }
          return done;
        case 'agentConfigBanner':
          yield* agentConfigBanner(request);
          return done;
        case 'recheckDependencies':
          yield* fromHost('recheckTools', () => options.recheckTools());
          return done;
        case 'openInstallGuide':
          postDesktopSettingsView(options.postToRenderer, 'tools');
          return done;
        case 'signIn':
          yield* fromHost('signIn', () => options.signIn());
          return done;
        case 'dismissBanner':
          yield* options.snapshot.dismissBanner(request.banner);
          return done;
        case 'gettingStarted':
          if (request.action === 'openWalkthrough') {
            options.showFirstRunWalkthrough();
            return done;
          }
          yield* host.showInfoMessage(
            vsCodeOnlyGettingStartedMessage(request.action),
          );
          return done;
        case 'onboarding':
          yield* onboarding(request.action);
          return done;
        case 'setActiveView':
          // The desktop has one window per paper and no view-title menu.
          return done;
      }
    });
  }

  /**
   * The bridge's host-request port: the dispatch program plus the one dialog
   * a failed request presents before it is answered. The cause is squashed to
   * word the dialog and then re-raised unchanged, so the bridge's
   * refusal-versus-defect fold sees exactly what the failing arm produced —
   * a refusal as a refusal, a defect still a defect.
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
        // the member, the classification reads the cause it carried.
        // A tag that named an untyped channel carries the value it named, so
        // the dialog classifies and words the launcher's or the record read's
        // own error, as it did when that value reached here bare.
        const primaryError = primaryAgentError(
          error instanceof HostCallFailed ||
            error instanceof RunLaunchFailed ||
            error instanceof RunConfigUnreadable ||
            error instanceof TranscriptExportFailed
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
