/**
 * The extension's `host.request` handler (PRD one-fold-three-renderers,
 * 8.3): every capability a surface asks its host for, one Zod-narrowed
 * switch over the arms, mapped onto VS Code's commands, editors, pickers,
 * and dialogs. Each arm answers exactly once with an outcome or a request
 * error; an arm the extension does not perform is `Rejected` with its
 * reason, never dropped.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as vscode from 'vscode';

import {
  AgentConfigSchema,
  polishTextWithAI,
  type SessionHandle,
} from '@agent/runtime';
import {
  validateExecutionRequest,
  type ExecutionRequest,
} from '@agent/core/state/executionRequests';
import { AUTH_COMMANDS } from '@auth/constants';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { setActiveSidebarView } from '@common/webview';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { teamAvailabilityPrompt } from '@common/teams/TeamPlan';
import type { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import {
  MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES,
  normalizeMainViewFileExtension,
  planMainViewDroppedFileAttachments,
} from '@controllers/mainView/MainViewDroppedFilesController';
import { prepareMainViewExecutionLaunch } from '@controllers/mainView/backend/MainViewExecutionLaunchController';
import { ChatExportController } from '@controllers/progressView/ChatExportController';
import {
  exportStreamTranscript,
  TRANSCRIPT_EXPORT_FORMAT_CHOICES,
  type TranscriptExportOpenKind,
} from '@controllers/progressView/exportTranscript';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { ProgressWorkflowRunActionsController } from '@controllers/progressView/ProgressWorkflowRunActionsController';
import {
  createHostRunActions,
  launchPatchOf,
} from '@controllers/session/hostRunActions';
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import { submitProgressFollowUp } from '@controllers/progressView/progressFollowUpSubmit';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import {
  FILE_SELECTION_COMMAND_IDS,
  MULTIPLE_FILE_COMMANDS,
} from '@frontend/files/fileSelectionRegistry';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { parseVersionControlDiffFilename } from '@latex/latexdiff/diffFileNameManager';
import { createLog } from '@logger/logUtils';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { platform } from '@platform/platform';
import latexPreamble from '@resources/templates/chatExport.tex';
import {
  GETTING_STARTED_COMMANDS,
  isMultipleDocumentFileType,
  type StreamTabId,
} from '@shared/schemas';
import { buildMainViewExecuteMessage } from '@shared/mainView/executionFormState';
import type { HostRequest } from '@shared/session/hostRequest';
import { Rejected, Unavailable } from '@shared/session/requestErrors';
import type {
  HostOutcome,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { startRecording, stopRecordingAndTranscribe } from '@tools/media/audio';
import {
  findTranscriptSpillFile,
  spillArtifactOpenFailedMessage,
  SPILL_ARTIFACT_DELETED_MESSAGE,
} from '@transcript/spillArtifacts';
import { getProviderKeyUrl } from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import {
  checkCoreDependencies,
  getToolDocsCommand,
} from '@utils/system/toolUtils';
import { formatResultCount } from '@utils/text/stringUtils';

const CHANNEL = 'ExtensionHostRequests';
const log = createLog(CHANNEL);

export interface ExtensionHostRequestsOptions {
  readonly session: SessionHandle;
  readonly sessionKey: string;
  readonly extensionPath: string;
  readonly globalState: vscode.Memento;
  readonly snapshot: HostSnapshotSource;
  readonly toolEditApprovals: ToolEditApprovalController;
  /** A host-initiated change to the surface (PRD 8.5). */
  surfaceAction(action: SurfaceActionMessage['action']): void;
  /** The placement commands the sidebar and the editor tab share. */
  popOutToEditor(): Promise<void>;
  showInSidebar(): Promise<void>;
  /** The onboarding funnel recomputes after an action that changes its
   *  inputs (a key stored, a sign-in, the setup assistant run). */
  refreshOnboardingFunnel(): Promise<void>;
}

export interface ExtensionHostRequests {
  handle(request: HostRequest, port: string): Promise<HostOutcome>;
  /** Stops a recording this host owns; the take is discarded. */
  dispose(): void;
}

const done: HostOutcome = { kind: 'done' };

function runCommand<T = void>(
  command: string,
  ...args: unknown[]
): Promise<T | undefined> {
  return Promise.resolve(
    vscode.commands.executeCommand<T>(command, ...args),
  ).then(
    (result) => result,
    (error: unknown) => {
      log.error(`Command ${command} failed: ${toErrorMessage(error)}`);
      throw error;
    },
  );
}

const showInfo = async (message: string): Promise<void> => {
  await vscode.window.showInformationMessage(message);
};
const showWarning = async (message: string): Promise<void> => {
  await vscode.window.showWarningMessage(message);
};
const showError = async (message: string): Promise<void> => {
  await vscode.window.showErrorMessage(message);
};

export function createExtensionHostRequests(
  options: ExtensionHostRequestsOptions,
): ExtensionHostRequests {
  const { session, snapshot, toolEditApprovals } = options;

  /** Validate an agent request and run it through the one launch command. */
  async function runExecutionRequest(
    request: ExecutionRequest,
    runOptions: { preferHelperModel?: boolean } = {},
  ): Promise<void> {
    const validation = validateExecutionRequest(request);
    if (!validation.valid) {
      log.error(validation.message);
      throw new Rejected({ reason: validation.message });
    }
    await runCommand('texra.execute', {
      ...validation.request,
      ...(runOptions.preferHelperModel ? { preferHelperModel: true } : {}),
    });
  }

  const runActions = createHostRunActions({
    session,
    runExecutionRequest,
    runUntilStarted(request, runOptions) {
      const validation = validateExecutionRequest(request);
      if (!validation.valid) {
        log.error(validation.message);
        return showError(validation.message).then(() => false);
      }
      // Whichever of `onRun` and the command's own settlement lands first
      // wins: a promise ignores every resolve after the first.
      return new Promise<boolean>((resolve) => {
        void runCommand<boolean>('texra.execute', {
          ...validation.request,
          ...runOptions,
          onRun: () => resolve(true),
        }).then(
          (completed) => resolve(completed === true),
          () => resolve(false),
        );
      });
    },
    loadModelOptions: () => computeModelOptionsData(),
    promptForApiKey: async (provider) => {
      await runCommand(EXTENSION_COMMANDS.SET_API_KEY, provider);
    },
    showInfo,
    showWarning,
    showError,
    logError: (message, error) => log.error(message, { data: error }),
  });

  const snapshotPort = {
    getActiveStream: () => '' as const,
    getRunMetadata: runActions.getRunMetadata,
    getOutputFiles: (streamId: StreamTabId) =>
      session.snapshots.getOutputFiles(streamId),
    getKnownWorkspaceOutputPaths: (streamId: StreamTabId) =>
      session.snapshots.getKnownFilePaths(streamId, { workspaceOnly: true }),
    preload: (streamId: StreamTabId) => session.snapshots.preload([streamId]),
  };

  const workflowFileActions = new ProgressWorkflowFileActionsController({
    state: snapshotPort,
    host: {
      compareFiles: (baseFile, editedFile) =>
        runCommand(
          'texra.compare',
          pathToLocation(baseFile),
          pathToLocation(editedFile),
        ),
      acceptEditedFile: (baseFile, editedFile, copyMeta) =>
        runCommand<boolean>(
          'texra.acceptEdited',
          pathToLocation(baseFile),
          pathToLocation(editedFile),
          copyMeta,
        ),
      mergeFile: (baseFile, editedFile) =>
        runCommand('texra.merge', baseFile, editedFile),
      latexdiffFile: (baseFile, editedFile) =>
        runCommand('texra.latexdiff', undefined, baseFile, editedFile),
      openDirectory: (directory) =>
        runCommand('revealFileInOS', vscode.Uri.file(directory)),
      openLabel: (label) =>
        runCommand<boolean>('texra.openLabel', label, {
          notifyNotFound: false,
        }).then((result) => result ?? false),
      readFile: (file) => AbsoluteFS.read(file),
      showInfo,
      showError,
      logError: (message, error) => {
        log.error(message, {
          data: error instanceof Error ? error : undefined,
        });
      },
    },
    // Programmatic send with no composer behind it (the workflow-file "user
    // modified the suggested output" note), so `acknowledge` is a no-op:
    // there is no draft to hand back.
    sendFollowUp: async (streamId, text) => {
      await submitProgressFollowUp({
        session,
        streamId,
        input: { text },
        acknowledge: () => {},
        showInfo: showWarning,
      });
    },
  });

  const workflowRunActions = new ProgressWorkflowRunActionsController({
    state: snapshotPort,
    runDiff: async (request) => {
      await runCommand('texra.runLatexdiff', request);
    },
    runFileOperation: async (operation, request) => {
      await runCommand(`texra.${operation}`, request);
    },
  });

  let chatExportController: ChatExportController | undefined;

  async function openExportPath(
    filePath: string,
    kind: TranscriptExportOpenKind,
  ): Promise<void> {
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
  }

  async function exportTranscript(streamId: StreamTabId): Promise<void> {
    const executionId = runActions.getRunMetadata(streamId).executionId;
    if (!executionId) {
      throw new Unavailable({
        streamId,
        reason: 'This run has no transcript to export.',
      });
    }
    await exportStreamTranscript(executionId, {
      pickFormat: async () =>
        (
          await vscode.window.showQuickPick(TRANSCRIPT_EXPORT_FORMAT_CHOICES, {
            title: 'Export transcript',
            placeHolder: 'Choose a format',
            ignoreFocusOut: true,
          })
        )?.format,
      openPath: openExportPath,
      showInfo,
      showWarning,
      showError,
      reportDetail: (message, data) => log.error(message, { data }),
      getController: () =>
        Promise.resolve(
          (chatExportController ??= new ChatExportController({
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

  async function openSpillArtifact(spillPath: string): Promise<void> {
    let file: string | undefined;
    try {
      await session.flushArtifacts();
      file = await findTranscriptSpillFile(spillPath);
    } catch (error) {
      throw new Rejected({
        reason: spillArtifactOpenFailedMessage(toErrorMessage(error)),
      });
    }
    if (!file) throw new Rejected({ reason: SPILL_ARTIFACT_DELETED_MESSAGE });
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(file),
    );
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /** A run's saved setup into the launcher, and the launcher into view. */
  async function restoreIntoLauncher(
    config: Parameters<typeof launchPatchOf>[0],
  ): Promise<void> {
    options.surfaceAction({ kind: 'launch', patch: launchPatchOf(config) });
    options.surfaceAction({ kind: 'selectNew' });
    await options.showInSidebar();
  }

  // The one recorder per process; this host owns a take while `owned`.
  let owned = false;
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
      owned = true;
      snapshot.setRecording({
        session: options.sessionKey,
        target: action.target,
      });
      return done;
    }
    owned = false;
    snapshot.setRecording(null);
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Transcribing',
        cancellable: false,
      },
      () => stopRecordingAndTranscribe(),
    );
    if (!result.success) {
      throw new Rejected({ reason: result.error ?? 'Transcription failed.' });
    }
    return { kind: 'text', text: result.text };
  }

  /** The Tools sheet's verbs over the launcher's base and edited files. */
  async function latexdiffs(
    request: Extract<HostRequest, { kind: 'latexdiffs' }>,
  ): Promise<void> {
    const baseFile = request.baseFile ?? '';
    const editedFile = request.editedFile ?? '';
    const commit = request.commit ?? 'HEAD';
    switch (request.action) {
      case 'latexdiffvc':
        await runCommand('texra.latexdiffvc', undefined, baseFile, commit);
        return;
      case 'packLatexdiffvc':
      case 'cleanLatexdiffvc':
        await runCommand(
          `texra.${request.action}`,
          undefined,
          baseFile,
          commit,
          request.action === 'cleanLatexdiffvc',
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
        await runCommand('texra.merge', baseFile, undefined, editedFile);
        return;
      case 'latexdiff':
        await runCommand('texra.latexdiff', undefined, baseFile, editedFile);
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

  /** The launcher's Send: the surface's selections through the shared
   *  launch preparation, then the one launch command. */
  async function launch(
    request: Extract<HostRequest, { kind: 'launch' }>,
  ): Promise<void> {
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
      throw new Rejected({
        reason:
          'Choose one of the open workspace folders as the working directory.',
      });
    }
    const message = buildMainViewExecuteMessage({
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
        workingDirectory: requestedWorkingDirectory || undefined,
      },
    });
    const prepared = await prepareMainViewExecutionLaunch(message, {
      chooseTeamAvailability: async (unavailableNames) => {
        const prompt = teamAvailabilityPrompt(unavailableNames);
        const choice = await vscode.window.showWarningMessage(
          prompt.message,
          ...prompt.actions.map((action) => action.label),
        );
        return (
          prompt.actions.find((action) => action.label === choice)?.choice ??
          'cancel'
        );
      },
      signInForRemoteAgentCatalog: async () =>
        Boolean(
          await vscode.commands.executeCommand<boolean>(AUTH_COMMANDS.SIGN_IN),
        ),
    });
    if (prepared.status === 'cancelled') {
      throw new Rejected({ reason: 'The launch was cancelled.' });
    }
    if (prepared.status === 'error') {
      const { docsCommand } = prepared;
      if (docsCommand) {
        const openDocs = 'Open file management guide';
        void vscode.window
          .showErrorMessage(prepared.message, openDocs)
          .then((choice) => {
            if (choice === openDocs) {
              void vscode.commands.executeCommand('texra.openDoc', docsCommand);
            }
          });
      }
      throw new Rejected({ reason: prepared.message });
    }
    if (prepared.infoMessage) void showInfo(prepared.infoMessage);
    await runCommand('texra.execute', prepared.request);
  }

  function getOpenedFiles(): string[] {
    if (!WorkspaceFS.getPath()) {
      log.warn('No workspace path found for opened files');
      return [];
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
    return [
      ...new Set(fileUris.map((uri) => WorkspaceFS.relativePath(uri.fsPath))),
    ];
  }

  async function resolveWorkspaceDropFile(
    rawPath: string,
  ): Promise<string | null> {
    const trimmed = rawPath.trim();
    let decodedPath = trimmed;
    if (trimmed.startsWith('file:')) {
      try {
        decodedPath = fileURLToPath(trimmed);
      } catch (error) {
        log.debug(
          `Dropped path is not a file URL: ${trimmed}: ${toErrorMessage(error)}`,
        );
      }
    }
    const resolved = WorkspaceFS.locatePath(decodedPath);
    if (resolved.kind !== 'workspace') return null;
    try {
      const stat = await vscode.workspace.fs.stat(
        vscode.Uri.file(resolved.absolutePath),
      );
      if ((stat.type & vscode.FileType.File) === 0) return null;
      return resolved.relativePath;
    } catch (error) {
      log.debug(
        `Dropped file could not be read: ${decodedPath}: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  async function attachDroppedFiles(
    request: Extract<HostRequest, { kind: 'attachDroppedFiles' }>,
  ): Promise<HostOutcome> {
    const paths = await Promise.all(
      request.paths.map((rawPath) => resolveWorkspaceDropFile(rawPath)),
    );
    const plan = planMainViewDroppedFileAttachments({
      paths,
      allowedExtensions: {
        input: getIncludedExtensions('input'),
        context: getIncludedExtensions('context'),
        media: getIncludedExtensions('media'),
      },
      target: request.category,
    });
    const attached = MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES.flatMap(
      (fileType) => plan.filesByCategory[fileType],
    );
    if (plan.attachedCount > 0 && plan.rejectedCount > 0) {
      void showInfo(
        `Attached ${formatResultCount(plan.attachedCount, 'dropped file')}; skipped ${formatResultCount(plan.rejectedCount, 'unsupported, folder, or out-of-workspace item')}.`,
      );
    } else if (plan.attachedCount === 0 && plan.rejectedCount > 0) {
      throw new Rejected({
        reason:
          'No dropped files were attached. Use regular files inside this workspace with supported TeXRA extensions.',
      });
    }
    return { kind: 'files', paths: [...attached] };
  }

  /** The editor's current file into a launcher field. */
  async function useCurrentFile(
    request: Extract<HostRequest, { kind: 'useCurrentFile' }>,
  ): Promise<HostOutcome> {
    const currentOpenFile = await runCommand<string>(
      FILE_SELECTION_COMMAND_IDS.getCurrentFile,
    );
    if (!currentOpenFile) {
      throw new Rejected({
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
        const commitLabel = await runCommand<string | null>(
          'texra.findCommitInHistory',
          parsed.commitHash,
        );
        if (commitLabel) {
          options.surfaceAction({
            kind: 'launch',
            patch: { commit: parsed.commitHash },
          });
        } else {
          void showInfo(
            `The commit ${parsed.commitHash} referenced by ${path.basename(currentOpenFile)} was not found in the repository history.`,
          );
        }
        if (await WorkspaceFS.exists(parsed.sourcePath)) {
          await snapshot.refreshFiles();
          return { kind: 'files', paths: [parsed.sourcePath] };
        }
        void showInfo(
          `The base file ${parsed.sourcePath} could not be found. Keeping ${currentOpenFile} selected.`,
        );
      }
    }
    return { kind: 'files', paths: [currentOpenFile] };
  }

  async function pickFiles(
    request: Extract<HostRequest, { kind: 'pickFiles' }>,
  ): Promise<HostOutcome> {
    const { fileType } = request;
    const commands = isMultipleDocumentFileType(fileType)
      ? MULTIPLE_FILE_COMMANDS.get(fileType)
      : undefined;
    if (!commands) {
      throw new Rejected({
        reason: `A picker for ${fileType} files is not available; choose one from the list.`,
      });
    }
    let selected: string[] | undefined;
    try {
      selected = await vscode.commands.executeCommand<string[]>(
        commands.selectCommand,
      );
    } catch (error) {
      await showLoggedErrorMessage(
        CHANNEL,
        `Error selecting ${fileType}`,
        error,
      );
      throw new Rejected({ reason: toErrorMessage(error) });
    }
    if (!selected) throw new Rejected({ reason: 'No files chosen.' });
    return { kind: 'files', paths: selected };
  }

  async function agentConfigBanner(
    request: Extract<HostRequest, { kind: 'agentConfigBanner' }>,
  ): Promise<void> {
    switch (request.action) {
      case 'edit':
        await runCommand(
          'texra.showAgents',
          request.sessionType === 'toolUse' ? 'toolUse' : undefined,
        );
        return;
      case 'dir': {
        if (!request.customDirSet) {
          await runCommand('texra.showAgents');
          return;
        }
        const dir = await agentDirectories.custom();
        if (dir) {
          await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(dir),
          );
        }
        return;
      }
      case 'docs':
        await runCommand('texra.openDoc', 'custom-agents');
        return;
    }
  }

  async function refreshAfterCredentialChange(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand('texra.refreshApiKeyStatus'),
      snapshot.refreshCatalogs(),
      snapshot.refreshAuth(),
      options.refreshOnboardingFunnel(),
    ]);
  }

  async function onboarding(
    action: Extract<HostRequest, { kind: 'onboarding' }>['action'],
  ): Promise<void> {
    switch (action) {
      case 'signInChatGpt':
        await signInWithSubscription(CHANNEL, 'chatgpt');
        await refreshAfterCredentialChange();
        return;
      case 'setApiKey':
        await runCommand('texra.setApiKey');
        // SecretManager has no key-changed event, so the set-key flow's
        // completion is the explicit refresh point for the funnel.
        await options.refreshOnboardingFunnel();
        return;
      case 'skip':
        await setOnboardingDeclined(options.globalState, true);
        await options.refreshOnboardingFunnel();
        return;
      case 'runSetup':
        await runCommand(GETTING_STARTED_COMMANDS.runSetup);
        await options.refreshOnboardingFunnel();
        return;
      case 'skipSetup':
        await setFirstRunDone(options.globalState, true);
        await options.refreshOnboardingFunnel();
        return;
      case 'openGettingStarted':
        await runCommand(GETTING_STARTED_COMMANDS.openWalkthrough);
        return;
    }
  }

  const notOnExtension = (what: string) =>
    new Rejected({ reason: `${what} is not available in VS Code yet.` });

  async function handle(
    request: HostRequest,
    port: string,
  ): Promise<HostOutcome> {
    switch (request.kind) {
      case 'openFile':
        await runCommand(
          'texra.openFile',
          request.path,
          request.line ?? undefined,
        );
        return done;
      case 'openSpillArtifact':
        await openSpillArtifact(request.spillPath);
        return done;
      case 'openLabel': {
        const opened = await runCommand<boolean>(
          'texra.openLabel',
          request.label,
          {
            notifyNotFound: false,
          },
        );
        if (!opened) {
          throw new Rejected({
            reason: `No file defines the label ${request.label}.`,
          });
        }
        return done;
      }
      case 'openTaskStorage':
        await workflowFileActions.openTaskStorage(request.streamId);
        return done;
      case 'exportTranscript':
        await exportTranscript(request.streamId);
        return done;
      case 'restoreIntoLauncher':
        await restoreIntoLauncher(
          await runActions.restoreState(request.streamId),
        );
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
        await workflowRunActions.diffStream(request.streamId);
        return done;
      case 'pack':
      case 'clean':
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
        await options.popOutToEditor();
        return done;
      case 'popBack':
        await options.showInSidebar();
        return done;
      case 'openDashboard':
        await runCommand('texra.showDashboard');
        return done;
      case 'refreshCommits':
        await snapshot.refreshCommits();
        return done;
      case 'refreshFiles':
        await snapshot.refreshFiles();
        return done;
      case 'openSettings':
        switch (request.section) {
          case 'agents':
            await runCommand(
              'texra.showAgents',
              request.sessionType === 'toolUse' ? 'toolUse' : undefined,
            );
            return done;
          case 'models':
            await runCommand('texra.showModels');
            return done;
          case 'teams':
            await runCommand('texra.showMultiAgent');
            return done;
        }
        return done;
      case 'pickFiles':
        return pickFiles(request);
      case 'useCurrentFile':
        return useCurrentFile(request);
      case 'addOpenedFiles': {
        const allowed = new Set(
          getIncludedExtensions(request.fileType).map(
            normalizeMainViewFileExtension,
          ),
        );
        const opened = getOpenedFiles();
        return {
          kind: 'files',
          paths:
            allowed.size > 0
              ? opened.filter((file) =>
                  allowed.has(normalizeMainViewFileExtension(file)),
                )
              : opened,
        };
      }
      case 'attachDroppedFiles':
        return attachDroppedFiles(request);
      case 'launch':
        await launch(request);
        return done;
      case 'polish': {
        const result = await polishTextWithAI(request.text, undefined, session);
        if (!result.success) {
          throw new Rejected({ reason: result.error ?? 'Polishing failed.' });
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
        throw notOnExtension('Compiling the input PDF');
      case 'extractFigures':
        await runCommand('texra.extractTikzFigures');
        return done;
      case 'toolEdit':
        toolEditApprovals.handleAction({
          requestId: request.requestId,
          action: request.action,
          ...(request.feedback == null ? {} : { feedback: request.feedback }),
        });
        return done;
      case 'fileAction':
        await fileAction(request);
        return done;
      case 'restoreProposalConfig': {
        const parsed = AgentConfigSchema.safeParse(request.proposal);
        if (!parsed.success) {
          log.warn('Invalid proposal config', { data: parsed.error.issues });
          throw new Rejected({
            reason: 'This proposal does not carry a restorable setup.',
          });
        }
        await restoreIntoLauncher(parsed.data);
        return done;
      }
      case 'apiKeyBanner':
        if (request.action === 'set') {
          await runCommand('texra.setApiKey', request.provider ?? undefined);
          await options.refreshOnboardingFunnel();
          return done;
        }
        await vscode.env.openExternal(
          vscode.Uri.parse(
            (request.provider && getProviderKeyUrl(request.provider)) ||
              'https://texra.ai/guide/installation#setting-up-api-keys',
          ),
        );
        return done;
      case 'agentConfigBanner':
        await agentConfigBanner(request);
        return done;
      case 'recheckDependencies':
        await checkCoreDependencies(true);
        await snapshot.refreshHostBanners();
        return done;
      case 'openInstallGuide': {
        const docsCommand = getToolDocsCommand(request.tool);
        if (!docsCommand) {
          throw new Rejected({
            reason: `No install guide is registered for ${request.tool}.`,
          });
        }
        const [command, ...args] = docsCommand.split(',');
        await runCommand(command, args);
        return done;
      }
      case 'signIn': {
        const authenticated = await vscode.commands.executeCommand<boolean>(
          AUTH_COMMANDS.SIGN_IN,
        );
        if (authenticated) await refreshAfterCredentialChange();
        return done;
      }
      case 'dismissBanner':
        if (request.banner === 'login') {
          await platform().globalState.update(
            GlobalStateKey.LOGIN_BANNER_DISMISSED,
            true,
          );
        }
        snapshot.dismissBanner(request.banner);
        return done;
      case 'gettingStarted':
        await runCommand(GETTING_STARTED_COMMANDS[request.action]);
        if (request.action === 'runSetup') {
          await options.refreshOnboardingFunnel();
        }
        return done;
      case 'onboarding':
        await onboarding(request.action);
        return done;
      case 'setActiveView':
        // Only the sidebar port names the sidebar's state; the editor tab
        // has no view-title menu of its own.
        if (port === 'sidebar') setActiveSidebarView(request.view);
        return done;
    }
  }

  return {
    handle,
    dispose() {
      if (!owned) return;
      owned = false;
      void stopRecordingAndTranscribe().catch((error: unknown) =>
        log.warn(
          `Failed to stop the recording on dispose: ${toErrorMessage(error)}`,
        ),
      );
      snapshot.setRecording(null);
    },
  };
}
