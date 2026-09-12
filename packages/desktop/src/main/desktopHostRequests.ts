// The desktop's `host.request` handler (PRD one-fold-three-renderers, 8.3):
// every capability a surface asks its host for, one Zod-narrowed switch over
// the arms, mapped onto the window's dialogs, the preview host, the file
// pickers, and the paper's launch path. Each arm answers exactly once with
// an outcome or a request error; an arm the desktop does not perform is
// `Rejected` with its reason, never dropped.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Cause, Effect, Exit, SubscriptionRef } from 'effect';
import { presentAgentFailure, type SessionHandle } from '@agent/runtime';
import {
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { prepareSurfaceLaunch } from '@controllers/mainView/backend/MainViewRunLaunchController';
import type { ChatExportController } from '@controllers/progressView/ChatExportController';
import { exportRunTranscript } from '@controllers/progressView/exportTranscript';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import {
  ProgressWorkflowRunActionsController,
  type WorkflowDiffRequest,
  type WorkflowFileOperation,
  type WorkflowFileOperationRequest,
} from '@controllers/progressView/ProgressWorkflowRunActionsController';
import {
  createHostRunActions,
  launchPatchOf,
} from '@controllers/session/hostRunActions';
import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import { listWorkspaceFilesOfType } from '@controllers/session/workspaceFileOptions';
import {
  latexdiffPackMessage,
  runPackLatexdiffvc,
} from '@housekeeping/packLatexdiffvc';
import { runCleanRunDir, runPackRunDir } from '@housekeeping/runDirOps';
import { LaTeXdiffService } from '@latex/latexdiff';
import { computeModelOptionsData } from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
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
} from '@shared/session/requestErrors';
import type {
  HostOutcome,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';

import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  pathToLocation,
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
  getCustomAgentDirectory(): Promise<string>;
  showFirstRunWalkthrough(): void;
  onboarding: Pick<
    DesktopOnboardingIpc,
    'skipOnboarding' | 'skipSetup' | 'runSetup' | 'signInWithChatGpt'
  >;
  openExternalUrl(url: string): Promise<void>;
  /** Re-probe the LaTeX toolchain. */
  recheckTools(): Promise<void>;
  logger: {
    warn(message: string, data?: { data?: unknown }): void;
    error(message: string, data?: { data?: unknown }): void;
  };
}

export interface DesktopHostRequests {
  handle(request: HostRequest, port: string): Promise<HostOutcome>;
  closePort(port: string): void;
  /** Stops a recording this window owns; the take is discarded. */
  dispose(): void;
}

const LATEXDIFF_CHANNEL = 'DesktopHostRequests';

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
  const { session, host, run, logger } = options;
  // The window's handle on the process runtime, taken once here rather than
  // re-fetched at each of the request arms below.
  const runtime = effectRuntime();
  // Shared controllers propagate request failures to the dispatcher.
  const rejectRequest = async (reason: string): Promise<never> => {
    throw new Rejected({ reason });
  };
  const draftRequests = options.draftRequests.attach(session, (recording) =>
    options.snapshot.setRecording(recording),
  );
  const requireOpenRun = (runId: RunId): void => {
    if (!SubscriptionRef.getUnsafe(session.view).runs.has(runId)) {
      throw new Unavailable({
        runId,
        reason: 'The run is no longer open.',
      });
    }
  };

  const runActions = runtime.runSync(
    createHostRunActions({
      session,
      runAgentRequest: run.runAgentRequest,
      loadModelOptions: () =>
        computeModelOptionsData({
          secrets: options.secrets,
          globalState: options.globalState,
        }),
      // Only the "ask the user for a key" step is host-specific: on the
      // desktop that means opening the Models tab rather than a modal prompt.
      // The controller re-reads the secret store after this returns.
      promptForApiKey: async () => {
        postDesktopSettingsView(options.postToRenderer, 'models');
        await host.showInfoMessage(
          'Add a provider API key in Models, then use "Retry" on the request.',
        );
      },
      showInfo: (message) => host.showInfoMessage(message),
      showWarning: (message) => host.showWarningMessage(message),
    }),
  );
  const { runOutputs } = runActions;

  const listWorkspaceCandidateFiles = async (): Promise<string[]> => {
    const workspacePath = options.workspacePath;
    if (!workspacePath) return [];
    const files = [
      ...(await listWorkspaceFilesOfType('input', workspacePath)),
      ...(await listWorkspaceFilesOfType('context', workspacePath)),
    ];
    return files.map((file) => path.resolve(workspacePath, file));
  };

  const fileActions = new DesktopProgressFileActions(
    { ...host, showErrorMessage: rejectRequest },
    {
      session,
      globalState: options.globalState,
      // The request schedules a merge; its later run failure belongs to this
      // lifecycle callback, after the request has already completed.
      startRun: (request) => {
        runtime.runFork(
          Effect.tryPromise({
            try: () => run.runValidated(request),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                logger.error('Desktop merge run failed', {
                  data: toLogData(error),
                });
                const primaryError = primaryAgentError(error);
                presentAgentFailure(
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
      openLabel: (label) => fileActions.findAndOpenLabel(label),
      readFile: (file) => readFile(file, 'utf8'),
      showInfo: async (message) => {
        await host.showInfoMessage(message);
      },
      showError: rejectRequest,
      logError: (message, error) =>
        logger.error(message, { data: toLogData(error) }),
    },
    sendFollowUp: (runId, text) =>
      runtime.runPromise(runActions.sendFollowUp(runId, text)),
  });

  async function runWorkflowDiff(request: WorkflowDiffRequest): Promise<void> {
    if (!request.agent || !request.model || !request.inputFile) {
      throw new Rejected({
        reason: 'Missing required configuration parameters for the diff.',
      });
    }
    await fileActions.diffStreamToolbarAction({
      outputsByRound: request.outputsByRound ?? {},
      runId: request.runId,
      workspaceScan: {
        agent: request.agent,
        model: request.model,
        inputFile: request.inputFile,
        outputFiles: request.outputFiles,
      },
    });
  }

  async function reportFileOperationResult(
    operation: WorkflowFileOperation,
    result: FileOpResult,
    inputFile: string,
  ): Promise<void> {
    const { verb } = operationLabel(operation);
    switch (result.status) {
      case 'success': {
        const folder = result.outputFolder;
        let message = 'Output files cleaned.';
        if (operation === 'pack') {
          message = folder ? `Files packed into ${folder}` : 'Files packed.';
        }
        await host.showInfoMessage(message);
        return;
      }
      case 'noFiles':
        await host.showInfoMessage(
          `No files found to ${verb} for ${inputFile}`,
        );
        return;
      case 'error':
        throw new Rejected({ reason: `Error during ${verb}: ${result.error}` });
    }
  }

  async function runWorkflowFileOperation(
    operation: WorkflowFileOperation,
    request: WorkflowFileOperationRequest,
  ): Promise<void> {
    const { verb, gerund } = operationLabel(operation);
    const { agent, model, inputFile, runId } = request;
    if (!agent || !model || !inputFile) {
      throw new Rejected({ reason: `Select an input file before ${gerund}.` });
    }
    if (!runId) {
      throw new Rejected({ reason: `Missing run identity for ${verb}.` });
    }
    const ran = await runtime.runPromiseExit(
      Effect.tryPromise({
        try: () =>
          operation === 'pack'
            ? runPackRunDir(runId as RunId, agent, model, inputFile)
            : runCleanRunDir(runId as RunId),
        catch: (error) => error,
      }),
    );
    if (Exit.isFailure(ran)) {
      const error = Cause.squash(ran.cause);
      logger.error(`Desktop ${operation} operation failed`, {
        data: toLogData(error),
      });
      throw new Rejected({
        reason: `Error during ${operation}: ${toErrorMessage(error)}`,
      });
    }
    await reportFileOperationResult(operation, ran.value, inputFile);
  }

  const workflowRunActions = new ProgressWorkflowRunActionsController({
    state: runOutputs,
    runDiff: runWorkflowDiff,
    runFileOperation: runWorkflowFileOperation,
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

  async function exportTranscript(runId: RunId): Promise<void> {
    requireOpenRun(runId);
    await runtime.runPromise(
      exportRunTranscript(runId, {
        pickFormat: () => host.pickTranscriptExportFormat(),
        openPath: (filePath) => host.openPath(filePath),
        showInfo: (message) => host.showInfoMessage(message),
        showWarning: (message) => host.showWarningMessage(message),
        showError: rejectRequest,
        reportDetail: (message) => logger.error(message),
        getController: getChatExportController,
        getTraceViewerTemplate: () =>
          path.join(options.resourcesPath, 'traceViewer', 'index.html'),
      }),
    );
  }

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
  async function latexdiffAgainstCommit(
    action: 'latexdiffvc' | 'packLatexdiffvc' | 'cleanLatexdiffvc',
    baseFile: string | undefined,
    commit: string,
  ): Promise<void> {
    if (!baseFile) {
      throw new Rejected({ reason: 'Choose a base file first.' });
    }
    const base = pathToLocation(baseFile);
    if (action === 'latexdiffvc') {
      const result = await runtime.runPromise(
        new LaTeXdiffService(LATEXDIFF_CHANNEL).runDiffVc(base, commit),
      );
      if (!result.success) throw new Rejected({ reason: result.message });
      await host.openBuildDisplay(createExternalLocation(result.diffPath));
      return;
    }
    const packed = await runPackLatexdiffvc(
      baseFile,
      commit,
      action === 'cleanLatexdiffvc',
    );
    const message = latexdiffPackMessage(packed);
    if (message) await host.showInfoMessage(message);
  }

  /** The Tools sheet's verbs over the launcher's base and edited files. */
  async function latexdiffs(
    request: Extract<HostRequest, { kind: 'latexdiffs' }>,
  ): Promise<void> {
    const baseFile = request.baseFile ?? undefined;
    const editedFile = request.editedFile ?? undefined;
    switch (request.action) {
      case 'latexdiffvc':
      case 'packLatexdiffvc':
      case 'cleanLatexdiffvc':
        await latexdiffAgainstCommit(
          request.action,
          baseFile,
          request.commit ?? 'HEAD',
        );
        return;
      default:
        break;
    }
    if (!baseFile || !editedFile) {
      throw new Rejected({
        reason: 'Choose a base file and an edited file first.',
      });
    }
    switch (request.action) {
      case 'compare':
        await workflowFileActions.compareOriginal(editedFile, baseFile);
        return;
      case 'accept':
        await workflowFileActions.acceptFile(editedFile, baseFile);
        return;
      case 'merge':
        await fileActions.runMergeFile(baseFile, editedFile);
        return;
      case 'latexdiff':
        await runLatexdiffFile(baseFile, editedFile);
        return;
    }
  }

  async function agentConfigBanner(
    request: Extract<HostRequest, { kind: 'agentConfigBanner' }>,
  ): Promise<void> {
    switch (request.action) {
      case 'edit':
        postDesktopSettingsView(
          options.postToRenderer,
          'agents',
          request.sessionType === 'toolUse' ? 'toolUse' : 'workflow',
        );
        return;
      case 'dir':
        if (request.customDirSet === true) {
          await host.openPath(await options.getCustomAgentDirectory());
        } else {
          postDesktopSettingsView(options.postToRenderer, 'agents');
        }
        return;
      case 'docs':
        await options.openExternalUrl(`${DESKTOP_DOCS_URL}#agents`);
        return;
    }
  }

  async function onboarding(
    action: Extract<HostRequest, { kind: 'onboarding' }>['action'],
  ): Promise<void> {
    switch (action) {
      case 'signInChatGpt':
        await options.onboarding.signInWithChatGpt();
        return;
      case 'setApiKey':
        postDesktopSettingsView(options.postToRenderer, 'models');
        return;
      case 'skip':
        await options.onboarding.skipOnboarding();
        return;
      case 'runSetup':
        await options.onboarding.runSetup();
        return;
      case 'skipSetup':
        await options.onboarding.skipSetup();
        return;
      case 'openGettingStarted':
        await options.openExternalUrl(DESKTOP_DOCS_URL);
        return;
    }
  }

  const notOnDesktop = (what: string) =>
    new Rejected({ reason: `${what} is not available in the desktop app.` });

  async function dispatch(
    request: HostRequest,
    port: string,
  ): Promise<HostOutcome> {
    const done: HostOutcome = { kind: 'done' };
    switch (request.kind) {
      case 'openFile':
        await host.openPath(request.path, request.line ?? undefined);
        return done;
      case 'openLabel': {
        const opened = await fileActions.findAndOpenLabel(request.label);
        if (!opened) {
          throw new Rejected({
            reason: `No file defines the label ${request.label}.`,
          });
        }
        return done;
      }
      case 'openTaskStorage':
        await workflowFileActions.openTaskStorage(request.runId);
        return done;
      case 'exportTranscript':
        await exportTranscript(request.runId);
        return done;
      case 'restoreIntoLauncher':
        restoreIntoLauncher(
          await runtime.runPromise(runActions.restoreState(request.runId)),
        );
        return done;
      case 'resume':
        await runtime.runPromise(runActions.resume(request.runId));
        return done;
      case 'runNew':
        await runtime.runPromise(runActions.runNew(request.runId));
        return done;
      case 'runCompileFixer':
        await runtime.runPromise(runActions.runCompileFixer(request.runId));
        return done;
      case 'useOwnApiKey':
        await runtime.runPromise(runActions.useOwnApiKey(request));
        return done;
      case 'latexdiff': {
        const config = await runtime.runPromise(
          runActions.readConfig(request.runId),
        );
        await workflowRunActions.diffStream(request.runId, config);
        return done;
      }
      case 'pack':
      case 'clean': {
        const config = await runtime.runPromise(
          runActions.readConfig(request.runId),
        );
        await workflowRunActions.runFileOperation(
          request.runId,
          request.kind,
          config,
        );
        return done;
      }
      case 'latexdiffs':
        await latexdiffs(request);
        return done;
      case 'record':
      case 'polish':
      case 'savePastedImage':
        return runtime.runPromise(draftRequests.handle(request, port));
      case 'popOut':
      case 'popBack':
        throw notOnDesktop('Pop-out to editor');
      case 'openDashboard':
        postDesktopSettingsView(options.postToRenderer);
        return done;
      case 'refreshCommits':
        await runtime.runPromise(options.snapshot.refreshCommits);
        return done;
      case 'refreshFiles':
        await runtime.runPromise(options.snapshot.refreshFiles);
        return done;
      case 'openSettings':
        postDesktopSettingsView(
          options.postToRenderer,
          request.section === 'teams' ? 'multi-agent' : request.section,
          request.sessionType === 'toolUse' ? 'toolUse' : undefined,
        );
        return done;
      case 'pickFiles': {
        if (request.fileType === 'base' || request.fileType === 'edited') {
          throw notOnDesktop(`A picker for ${request.fileType} files`);
        }
        const paths = await options.files.pickFiles(request.fileType);
        if (paths === null) throw new Cancelled();
        return { kind: 'files', paths };
      }
      case 'useCurrentFile':
      case 'addOpenedFiles':
        throw notOnDesktop("The editor's current file");
      case 'attachDroppedFiles':
        return {
          kind: 'files',
          paths: await options.files.attachDroppedFiles(
            request.paths,
            request.category,
          ),
        };
      case 'launch':
        await run.runValidated(
          await runtime.runPromise(prepareSurfaceLaunch(request, host)),
        );
        return done;
      case 'extractFigures':
        throw notOnDesktop('Figure extraction');
      case 'toolEdit':
        run.toolEditApprovals.handleAction({
          requestId: request.requestId,
          action: request.action,
          ...(request.feedback == null ? {} : { feedback: request.feedback }),
        });
        return done;
      case 'fileAction': {
        const config = await runtime.runPromise(
          runActions.readConfig(request.runId),
        );
        await workflowFileActions.handle(request, config);
        return done;
      }
      case 'restoreProposalConfig':
        await restoreIntoLauncher(runActions.restoreProposal(request.proposal));
        return done;
      case 'apiKeyBanner':
        if (request.action === 'set') {
          postDesktopSettingsView(options.postToRenderer, 'models');
        } else {
          await options.openExternalUrl(
            'https://texra.ai/guide/configuration.html',
          );
        }
        return done;
      case 'agentConfigBanner':
        await agentConfigBanner(request);
        return done;
      case 'recheckDependencies':
        await options.recheckTools();
        return done;
      case 'openInstallGuide':
        postDesktopSettingsView(options.postToRenderer, 'tools');
        return done;
      case 'signIn':
        await options.signIn();
        return done;
      case 'dismissBanner':
        options.snapshot.dismissBanner(request.banner);
        return done;
      case 'gettingStarted':
        if (request.action === 'openWalkthrough') {
          options.showFirstRunWalkthrough();
          return done;
        }
        await host.showInfoMessage(
          vsCodeOnlyGettingStartedMessage(request.action),
        );
        return done;
      case 'onboarding':
        await onboarding(request.action);
        return done;
      case 'setActiveView':
        // The desktop has one window per paper and no view-title menu.
        return done;
    }
  }

  return {
    async handle(request, port) {
      const exit = await runtime.runPromiseExit(
        Effect.tryPromise({
          try: () => dispatch(request, port),
          catch: (error) => error,
        }),
      );
      if (Exit.isSuccess(exit)) return exit.value;

      const error = Cause.squash(exit.cause);
      if (error instanceof Cancelled) throw error;
      // Request-scoped operations do not present. Every rejection, including
      // a capability refusal, reaches this one dialog before the response.
      const primaryError = primaryAgentError(error);
      await presentAgentFailure(
        session.interactions,
        {
          kind: classifyAgentError(primaryError),
          message:
            primaryError instanceof Rejected ||
            primaryError instanceof Unavailable
              ? primaryError.reason
              : toErrorMessage(primaryError),
        },
        { replayWhenAttached: true },
      );
      throw error;
    },
    closePort: draftRequests.closePort,
    dispose: draftRequests.dispose,
  };
}
