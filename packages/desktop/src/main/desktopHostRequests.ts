// The desktop's `host.request` handler (PRD one-fold-three-renderers, 8.3):
// every capability a surface asks its host for, one Zod-narrowed switch over
// the arms, mapped onto the window's dialogs, the preview host, the file
// pickers, and the paper's launch path. Each arm answers exactly once with
// an outcome or a request error; an arm the desktop does not perform is
// `Rejected` with its reason, never dropped.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { SubscriptionRef } from 'effect';
import {
  AgentConfigSchema,
  polishTextWithAI,
  type SessionHandle,
} from '@agent/runtime';
import { submitProgressFollowUp } from '@controllers/progressView/progressFollowUpSubmit';
import type { ChatExportController } from '@controllers/progressView/ChatExportController';
import { exportStreamTranscript } from '@controllers/progressView/exportTranscript';
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
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import { listWorkspaceFilesOfType } from '@controllers/session/workspaceFileOptions';
import { runCleanRunDir, runPackRunDir } from '@housekeeping/runDirOps';
import { computeModelOptionsData } from '@model/computeModelOptions';
import {
  cloneRoundIndexed,
  type ExecutionId,
  type FileOpResult,
  type StreamTabId,
} from '@shared/schemas';
import { buildMainViewExecuteMessage } from '@shared/mainView/executionFormState';
import type { HostRequest } from '@shared/session/hostRequest';
import { Rejected, Unavailable } from '@shared/session/requestErrors';
import type {
  HostOutcome,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';
import { startRecording, stopRecordingAndTranscribe } from '@tools/media/audio';
import {
  findTranscriptSpillFile,
  spillArtifactOpenFailedMessage,
  SPILL_ARTIFACT_DELETED_MESSAGE,
} from '@transcript/spillArtifacts';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
import type { DesktopShellActions } from './desktopShellIpc.js';
import type { DesktopAgentExecution } from './desktopAgentExecution.js';
import type { DesktopAgentExecutionHost } from './desktopAgentExecutionHost.js';
import type { DesktopFileSelection } from './desktopFileSelection.js';

interface DesktopHostRequestsOptions {
  session: SessionHandle;
  /** The session key the surface addresses this paper by. */
  sessionKey: string;
  host: DesktopAgentExecutionHost;
  execution: DesktopAgentExecution;
  files: DesktopFileSelection;
  snapshot: HostSnapshotSource;
  workspacePath: string | undefined;
  /** Packaged app resources root (`…/resources`), for export templates. */
  resourcesPath: string;
  postToRenderer(message: unknown): boolean | void;
  /** A host-initiated change to the surface (PRD 8.5). */
  postSurfaceAction(action: SurfaceActionMessage['action']): void;
  shell: Pick<
    DesktopShellActions,
    'signIn' | 'openAgentDirectory' | 'showFirstRunWalkthrough'
  >;
  onboarding: Pick<
    DesktopOnboardingIpc,
    | 'skipOnboarding'
    | 'skipSetup'
    | 'runSetup'
    | 'signInWithChatGpt'
    | 'openGettingStarted'
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
  handle(request: HostRequest): Promise<HostOutcome>;
  /** Stops a recording this window owns; the take is discarded. */
  dispose(): void;
}

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
  const { session, host, execution, logger } = options;
  const snapshots = session.snapshots;
  const view = () => SubscriptionRef.getUnsafe(session.view);

  const stream = (streamId: StreamTabId) => {
    const found = view().streams.get(streamId);
    if (!found) {
      throw new Unavailable({
        streamId,
        reason: 'The stream is no longer open.',
      });
    }
    return found;
  };

  const runActions = createHostRunActions({
    session,
    runExecutionRequest: (request, runOptions) =>
      execution.runExecutionRequest(request, {
        ...(runOptions?.preferHelperModel ? { preferHelperModel: true } : {}),
      }),
    runUntilStarted: async (request, runOptions) => {
      let started = false;
      await execution.runExecutionRequest(request, {
        ...(runOptions.copilotRouteOverride
          ? { copilotRouteOverride: runOptions.copilotRouteOverride }
          : {}),
        onRun: () => {
          started = true;
        },
      });
      return started;
    },
    loadModelOptions: () => computeModelOptionsData(),
    // Only the "ask the user for a key" step is host-specific: on the
    // desktop that means opening the Models tab rather than a modal prompt.
    // The controller re-reads the secret store after this returns.
    promptForApiKey: async () => {
      postDesktopSettingsView(
        (message) => options.postToRenderer(message),
        'models',
      );
      await host.showInfoMessage(
        'Add a provider API key in Models, then use "Retry" on the request.',
      );
    },
    showInfo: (message) => host.showInfoMessage(message),
    showWarning: (message) => host.showWarningMessage(message),
    showError: (message) => host.showErrorMessage(message),
    logError: (message, error) =>
      logger.error(message, { data: toLogData(error) }),
  });
  const { getRunMetadata } = runActions;

  const snapshotPort = {
    getActiveStream: () => '' as const,
    getRunMetadata,
    getOutputFiles: (streamId: StreamTabId) =>
      snapshots.getOutputFiles(streamId),
    getKnownWorkspaceOutputPaths: (streamId: StreamTabId) =>
      snapshots.getKnownFilePaths(streamId, { workspaceOnly: true }),
    preload: (streamId: StreamTabId) => snapshots.preload([streamId]),
  };

  const listWorkspaceCandidateFiles = async (): Promise<string[]> => {
    const workspacePath = options.workspacePath;
    if (!workspacePath) return [];
    const files = [
      ...(await listWorkspaceFilesOfType('input', workspacePath)),
      ...(await listWorkspaceFilesOfType('context', workspacePath)),
    ];
    return files.map((file) => path.resolve(workspacePath, file));
  };

  const fileActions = new DesktopProgressFileActions(host, {
    startExecution: (request) => {
      void execution
        .runValidated(request, { suppressErrorNotification: true })
        .catch((error: unknown) => {
          logger.error('Desktop merge execution failed', {
            data: toLogData(error),
          });
          void host.showErrorMessage(`Merge failed: ${toErrorMessage(error)}`);
        });
    },
    listWorkspaceCandidateFiles,
  });

  async function runLatexdiffFile(
    baseFile: string,
    editedFile: string,
    streamId?: StreamTabId,
  ): Promise<void> {
    const context =
      streamId === undefined
        ? undefined
        : await getLatexdiffRunContext(streamId, editedFile);
    if (!context) {
      await fileActions.runLatexdiffFile(baseFile, editedFile);
      return;
    }
    await fileActions.diffAcceptedFilePair(baseFile, editedFile, context);
  }

  /**
   * The run context a diff of an accepted file pair reads its per-round
   * outputs from: the stream the sheet was opened on. Frozen here, not read
   * later: `getOutputFiles` returns the store's live record (#11402), and
   * this context crosses several awaits before anything enumerates it.
   */
  async function getLatexdiffRunContext(
    streamId: StreamTabId,
    editedFile: string,
  ): Promise<DesktopLatexdiffRunContext | undefined> {
    await snapshots.preload([streamId]);
    const outputsByRound = cloneRoundIndexed(
      snapshots.getOutputFiles(streamId),
    );
    const { config, executionId } = getRunMetadata(streamId);
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
      ...(executionId && { executionId }),
      ...(workspaceScan && { workspaceScan }),
    };
  }

  const workflowFileActions = new ProgressWorkflowFileActionsController({
    state: snapshotPort,
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
      showError: async (message) => {
        await host.showErrorMessage(message);
      },
      logError: (message, error) =>
        logger.error(message, { data: toLogData(error) }),
    },
    // Programmatic send with no composer behind it (the workflow-file
    // "user modified the suggested output" note), so `acknowledge` is a
    // no-op: there is no draft to hand back.
    sendFollowUp: async (streamId, text) => {
      await submitProgressFollowUp({
        session,
        streamId,
        input: { text },
        acknowledge: () => {},
        showInfo: (message) => host.showInfoMessage(message),
      });
    },
  });

  async function runWorkflowDiff(request: WorkflowDiffRequest): Promise<void> {
    if (!request.agent || !request.model || !request.inputFile) {
      await host.showErrorMessage(
        'Missing required configuration parameters for the diff.',
      );
      return;
    }
    await fileActions.diffStreamToolbarAction({
      outputsByRound: request.outputsByRound ?? {},
      ...(request.runId && { executionId: request.runId }),
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
        await host.showErrorMessage(`Error during ${verb}: ${result.error}`);
        return;
    }
  }

  async function runWorkflowFileOperation(
    operation: WorkflowFileOperation,
    request: WorkflowFileOperationRequest,
  ): Promise<void> {
    const { verb, gerund } = operationLabel(operation);
    const { agent, model, inputFile, executionId } = request;
    if (!agent || !model || !inputFile) {
      await host.showErrorMessage(`Select an input file before ${gerund}.`);
      return;
    }
    if (!executionId) {
      await host.showErrorMessage(`Missing execution identity for ${verb}.`);
      return;
    }
    let result: FileOpResult;
    try {
      result =
        operation === 'pack'
          ? await runPackRunDir(
              executionId as ExecutionId,
              agent,
              model,
              inputFile,
            )
          : await runCleanRunDir(executionId as ExecutionId);
    } catch (error) {
      logger.error(`Desktop ${operation} operation failed`, {
        data: toLogData(error),
      });
      await host.showErrorMessage(
        `Error during ${operation}: ${toErrorMessage(error)}`,
      );
      return;
    }
    await reportFileOperationResult(operation, result, inputFile);
  }

  const workflowRunActions = new ProgressWorkflowRunActionsController({
    state: snapshotPort,
    runDiff: runWorkflowDiff,
    runFileOperation: runWorkflowFileOperation,
  });

  let chatExportControllerLoad: Promise<ChatExportController> | undefined;
  function getChatExportController(): Promise<ChatExportController> {
    chatExportControllerLoad ??=
      import('@controllers/progressView/ChatExportController')
        .then(async ({ ChatExportController: Controller }) => {
          const latexPreamble = await readFile(
            path.join(options.resourcesPath, 'templates', 'chatExport.tex'),
            'utf8',
          );
          return new Controller({ latexPreamble });
        })
        .catch((error: unknown) => {
          chatExportControllerLoad = undefined;
          throw error;
        });
    return chatExportControllerLoad;
  }

  async function exportTranscript(streamId: StreamTabId): Promise<void> {
    const { executionId } = stream(streamId);
    await exportStreamTranscript(executionId, {
      pickFormat: () => host.pickTranscriptExportFormat(),
      openPath: (filePath) => host.openPath(filePath),
      showInfo: (message) => host.showInfoMessage(message),
      showWarning: (message) => host.showWarningMessage(message),
      showError: (message) => host.showErrorMessage(message),
      reportDetail: (message) => logger.error(message),
      getController: getChatExportController,
      getTraceViewerTemplate: () =>
        path.join(options.resourcesPath, 'traceViewer', 'index.html'),
    });
  }

  /** A run's saved setup into the launcher (PRD 8.3, 8.5): the launch
   *  patch rides a surface action, and the launcher comes into view. */
  function restoreIntoLauncher(
    config: Parameters<typeof launchPatchOf>[0],
  ): void {
    options.postSurfaceAction({ kind: 'launch', patch: launchPatchOf(config) });
    options.postSurfaceAction({ kind: 'selectNew' });
  }

  async function openSpillArtifact(spillPath: string): Promise<void> {
    let file: string | undefined;
    try {
      await session.flushArtifacts();
      file = await findTranscriptSpillFile(spillPath);
    } catch (error) {
      await host.showErrorMessage(
        spillArtifactOpenFailedMessage(toErrorMessage(error)),
      );
      return;
    }
    if (!file) {
      await host.showErrorMessage(SPILL_ARTIFACT_DELETED_MESSAGE);
      return;
    }
    try {
      await host.openPath(file);
    } catch (error) {
      // The desktop preview host already surfaced its own "Failed to open
      // file" dialog before rethrowing, so reporting here would stack a
      // second dialog on the same failure (#10848). Log only.
      logger.warn('Failed to open the full output artifact', {
        data: toLogData(error),
      });
    }
  }

  // The one recorder per process; this window owns a take while `owned`.
  let owned: { target: string } | null = null;
  async function record(
    action: Extract<HostRequest, { kind: 'record' }>['action'],
  ): Promise<HostOutcome> {
    if (action.kind === 'start') {
      const result = await startRecording();
      if (!result.success) {
        throw new Rejected({
          reason: result.error ?? 'Recording could not start.',
        });
      }
      owned = { target: action.target };
      options.snapshot.setRecording({
        session: options.sessionKey,
        target: action.target,
      });
      return { kind: 'done' };
    }
    const transcription = stopRecordingAndTranscribe();
    owned = null;
    options.snapshot.setRecording(null);
    const result = await transcription;
    if (!result.success) {
      throw new Rejected({
        reason: result.error ?? 'Transcription failed.',
      });
    }
    return { kind: 'text', text: result.text };
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
        throw notOnDesktop('latexdiff against a commit');
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

  /** An output file's verbs on a workflow run's file list. */
  async function fileAction(
    request: Extract<HostRequest, { kind: 'fileAction' }>,
  ): Promise<void> {
    const base = request.base ?? undefined;
    switch (request.action) {
      case 'compareOriginal':
        await workflowFileActions.compareOriginal(request.file, base);
        return;
      case 'comparePrevious':
        await workflowFileActions.comparePrevious(
          request.file,
          request.prev ?? undefined,
        );
        return;
      case 'accept':
        await workflowFileActions.acceptFile(request.file, base);
        return;
      case 'merge':
        await workflowFileActions.mergeFile(request.file, base);
        return;
      case 'latexdiff':
        await workflowFileActions.latexdiffFile(request.file, base);
        return;
    }
  }

  async function agentConfigBanner(
    request: Extract<HostRequest, { kind: 'agentConfigBanner' }>,
  ): Promise<void> {
    switch (request.action) {
      case 'edit':
        postDesktopSettingsView(
          (message) => options.postToRenderer(message),
          'agents',
          request.sessionType === 'toolUse' ? 'toolUse' : 'workflow',
        );
        return;
      case 'dir':
        options.shell.openAgentDirectory(request.customDirSet === true);
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
        postDesktopSettingsView(
          (message) => options.postToRenderer(message),
          'models',
        );
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
        await options.onboarding.openGettingStarted();
        return;
    }
  }

  const notOnDesktop = (what: string) =>
    new Rejected({ reason: `${what} is not available in the desktop app.` });

  async function handle(request: HostRequest): Promise<HostOutcome> {
    const done: HostOutcome = { kind: 'done' };
    switch (request.kind) {
      case 'openFile':
        await host.openPath(request.path, request.line ?? undefined);
        return done;
      case 'openSpillArtifact':
        await openSpillArtifact(request.spillPath);
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
        stream(request.streamId);
        await workflowFileActions.openTaskStorage(request.streamId);
        return done;
      case 'exportTranscript':
        await exportTranscript(request.streamId);
        return done;
      case 'restoreIntoLauncher':
        restoreIntoLauncher(await runActions.restoreState(request.streamId));
        return done;
      case 'resume':
        await runActions.resume(request.streamId);
        return done;
      case 'runNew':
        await runActions.runNew(request.streamId);
        return done;
      case 'runCompileFixer':
        await runActions.runCompileFixer(request.streamId);
        return done;
      case 'useOwnApiKey':
        await runActions.useOwnApiKey(request);
        return done;
      case 'latexdiff':
        stream(request.streamId);
        await workflowRunActions.diffStream(request.streamId);
        return done;
      case 'pack':
      case 'clean':
        stream(request.streamId);
        await workflowRunActions.runFileOperation(
          request.streamId,
          request.kind,
        );
        return done;
      case 'latexdiffs':
        await latexdiffs(request);
        return done;
      case 'record':
        return record(request.action);
      case 'popOut':
      case 'popBack':
        throw notOnDesktop('Pop-out to editor');
      case 'openDashboard':
        postDesktopSettingsView((message) => options.postToRenderer(message));
        return done;
      case 'refreshCommits':
        await options.snapshot.refreshCommits();
        return done;
      case 'refreshFiles':
        await options.snapshot.refreshFiles();
        return done;
      case 'openSettings':
        postDesktopSettingsView(
          (message) => options.postToRenderer(message),
          request.section === 'teams' ? 'multi-agent' : request.section,
          request.sessionType === 'toolUse' ? 'toolUse' : undefined,
        );
        return done;
      case 'pickFiles': {
        if (request.fileType === 'base' || request.fileType === 'edited') {
          throw notOnDesktop(`A picker for ${request.fileType} files`);
        }
        const paths = await options.files.pickFiles(request.fileType);
        if (paths === null) throw new Rejected({ reason: 'No files chosen.' });
        return { kind: 'files', paths };
      }
      case 'useCurrentFile':
      case 'addOpenedFiles':
        throw notOnDesktop("The editor's current file");
      case 'attachDroppedFiles':
        return {
          kind: 'files',
          paths: options.files.relativize(request.paths),
        };
      case 'launch': {
        const { launch: form } = request;
        await execution.handleExecute(
          buildMainViewExecuteMessage({
            sessionType: form.sessionType,
            agent: form.agent,
            model: form.model,
            instruction: request.instruction,
            multiFiles: {
              inputFiles: form.inputFiles,
              contextFiles: form.contextFiles,
              mediaFiles: form.mediaFiles,
              outputFiles: form.outputFiles,
            },
            checkboxValues: form,
            session: {
              launchTarget: form.launchTarget,
              teamId: form.selectedTeamId || undefined,
              workingDirectory: form.workingDirectory || undefined,
            },
          }),
        );
        return done;
      }
      case 'polish': {
        const result = await polishTextWithAI(request.text, undefined, session);
        if (!result.success) {
          throw new Rejected({
            reason: result.error ?? 'Polishing failed.',
          });
        }
        return { kind: 'text', text: result.text };
      }
      case 'savePastedImage': {
        const fileName = await savePastedImageBase64(
          request.base64,
          request.fileName,
        );
        return { kind: 'savedImage', fileName };
      }
      case 'compileInputPdf':
        throw notOnDesktop('Compiling the input PDF');
      case 'extractFigures':
        throw notOnDesktop('Figure extraction');
      case 'toolEdit':
        execution.toolEditAction(
          request.requestId,
          request.action,
          request.feedback ?? undefined,
        );
        return done;
      case 'fileAction':
        stream(request.streamId);
        await fileAction(request);
        return done;
      case 'restoreProposalConfig': {
        const parsed = AgentConfigSchema.safeParse(request.proposal);
        if (!parsed.success) {
          logger.warn('Invalid proposal config', {
            data: { errors: parsed.error.issues },
          });
          throw new Rejected({
            reason: 'This proposal does not carry a restorable setup.',
          });
        }
        restoreIntoLauncher(parsed.data);
        return done;
      }
      case 'apiKeyBanner':
        if (request.action === 'set') {
          postDesktopSettingsView(
            (message) => options.postToRenderer(message),
            'models',
          );
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
        postDesktopSettingsView(
          (message) => options.postToRenderer(message),
          'tools',
        );
        return done;
      case 'signIn':
        options.shell.signIn();
        return done;
      case 'dismissBanner':
        options.snapshot.dismissBanner(request.banner);
        return done;
      case 'gettingStarted':
        if (request.action === 'openWalkthrough') {
          options.shell.showFirstRunWalkthrough();
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
    handle,
    dispose() {
      if (!owned) return;
      owned = null;
      void stopRecordingAndTranscribe().catch((error: unknown) =>
        logger.warn('Failed to stop the recording on window close', {
          data: toLogData(error),
        }),
      );
      options.snapshot.setRecording(null);
    },
  };
}
