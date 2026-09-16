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
import { Data, Effect, FileSystem } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import {
  validateRunRequest,
  type RunRequest,
} from '@agent/core/state/runRequests';
import { AUTH_COMMANDS } from '@auth/constants';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import {
  createFileSelectionPickers,
  getCurrentFile,
} from '@commands/files/fileSelectionCommands';
import { setActiveSidebarView } from '@common/webview';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { teamAvailabilityPrompt } from '@common/teams/TeamPlan';
import type { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import {
  attachDroppedPaths,
  normalizeMainViewFileExtension,
} from '@controllers/mainView/MainViewDroppedFilesController';
import { prepareSurfaceLaunch } from '@controllers/mainView/backend/MainViewRunLaunchController';
import { ChatExportController } from '@controllers/progressView/ChatExportController';
import {
  exportRunTranscript,
  TRANSCRIPT_EXPORT_FORMAT_CHOICES,
  type TranscriptExportOpenKind,
} from '@controllers/progressView/exportTranscript';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { ApiKeyPromptFailed } from '@controllers/progressView/ProgressApiKeyRetryController';
import {
  createHostRunActions,
  type HostRunActionPorts,
  launchPatchOf,
} from '@controllers/session/hostRunActions';
import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { VscodeMessageHost } from '@frontend/hosts/VscodeMessageHost';
import { chooseTeamAvailabilityViaDialog } from '@frontend/ui/dialogs';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { parseVersionControlDiffFilename } from '@latex/latexdiff/diffFileNameManager';
import { createLog } from '@logger/logUtils';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import { withSessionFs, WorkspaceFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import latexPreamble from '@resources/templates/chatExport.tex';
import {
  GETTING_STARTED_COMMANDS,
  isMultipleDocumentFileType,
  type MultipleDocumentFileType,
  type RunId,
} from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { Cancelled, Rejected } from '@shared/session/requestErrors';
import type {
  HostOutcome,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';

import { getProviderKeyUrl } from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocation } from '@utils/files/fileLocation';
import {
  locateInWorkspace,
  workspaceRelativePath,
} from '@utils/files/workspaceFS';
import {
  checkCoreDependencies,
  getToolDocsCommand,
} from '@utils/system/toolUtils';
import {
  formatResultCount,
  normalizeLineEndings,
} from '@utils/text/stringUtils';

const CHANNEL = 'ExtensionHostRequests';
const log = createLog(CHANNEL);

/** A dropped `file:` path Node could not read as a URL. */
class DropPathUndecodable extends Data.TaggedError('DropPathUndecodable')<{
  readonly message: string;
}> {}

/** A dropped path the workspace file system could not stat. */
class DropFileUnreadable extends Data.TaggedError('DropFileUnreadable')<{
  readonly message: string;
}> {}

/** A native file picker that failed instead of answering. */
class FilePickerFailed extends Data.TaggedError('FilePickerFailed')<{
  readonly message: string;
}> {}

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
  popOutToEditor(): Promise<void>;
  showInSidebar(): Promise<void>;
  /** The onboarding funnel recomputes after an action that changes its
   *  inputs (a key stored, a sign-in, the setup assistant run). */
  refreshOnboardingFunnel(): Promise<void>;
}

interface ExtensionHostRequests {
  handle(request: HostRequest, port: string): Promise<HostOutcome>;
  closePort(port: string): void;
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

/** The typed notification surface the run-action ports and launch host take. */
const messages = new VscodeMessageHost();

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
  const draftRequests = options.draftRequests.attach(session, (recording) =>
    options.snapshot.setRecording(recording),
  );

  /** The native picker of each multi-file launcher list. */
  const multipleFilePickers: Record<
    MultipleDocumentFileType,
    () => Promise<string[] | null>
  > = createFileSelectionPickers(session);

  /** Validate an agent request and run it through the one launch command. */
  async function runAgentRequest(
    request: RunRequest,
    runOptions: Parameters<HostRunActionPorts['runAgentRequest']>[1] = {},
  ): Promise<void> {
    const validation = validateRunRequest(request);
    if (!validation.valid) {
      log.error(validation.message);
      throw new Rejected({ reason: validation.message });
    }
    await runCommand('texra.execute', {
      ...validation.request,
      ...runOptions,
    });
  }

  const runActions = runtime.runSync(
    createHostRunActions({
      session,
      runAgentRequest,
      loadModelOptions: async () =>
        modelOptionsFrom(
          await runtime.runPromise(
            readModelAvailabilityInputs({ secrets, globalState }),
          ),
        ),
      // The set-key quick pick is a VS Code command: it either runs or
      // faults, so its rejection is the one failure, as `ApiKeyPromptFailed`.
      promptForApiKey: (provider) =>
        Effect.tryPromise({
          try: () => runCommand(EXTENSION_COMMANDS.SET_API_KEY, provider),
          catch: (cause) =>
            new ApiKeyPromptFailed({
              provider,
              message: 'The host could not ask for a provider API key.',
              cause,
            }),
        }),
      showInfo: (message) => messages.showInfoMessage(message),
      showWarning: (message) => messages.showWarningMessage(message),
    }),
  );

  const { runOutputs } = runActions;

  const workflowFileActions = new ProgressWorkflowFileActionsController({
    state: runOutputs,
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
      // An accepted-edit backup names an absolute workspace path the
      // controller already resolved, so this reads through the process
      // filesystem rather than a rooted view that would refuse a path the
      // user picked outside the workspace.
      readFile: (file) =>
        runtime.runPromise(
          Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
            Effect.map(fs.readFileString(file), normalizeLineEndings),
          ),
        ),
      showInfo,
      showError,
      logError: (message, error) => {
        log.error(message, {
          data: error instanceof Error ? error : undefined,
        });
      },
    },
    sendFollowUp: (runId, text) =>
      runtime.runPromise(runActions.sendFollowUp(runId, text)),
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

  async function exportTranscript(runId: RunId): Promise<void> {
    await runtime.runPromise(
      withSessionFs(
        session.roots,
        exportRunTranscript(runId, {
          pickFormat: async () =>
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
          openPath: openExportPath,
          showInfo,
          showWarning,
          showError,
          reportDetail: (message, data) => log.error(message, { data }),
          getController: () =>
            Promise.resolve(
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
        }),
      ),
    );
  }

  /** A run's saved setup into the launcher, and the launcher into view. */
  async function restoreIntoLauncher(
    config: Parameters<typeof launchPatchOf>[0],
  ): Promise<void> {
    options.surfaceAction({ kind: 'launch', patch: launchPatchOf(config) });
    options.surfaceAction({ kind: 'selectNew' });
    await options.showInSidebar();
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
        await runCommand('texra.merge', baseFile, editedFile);
        return;
      case 'latexdiff':
        await runCommand('texra.latexdiff', undefined, baseFile, editedFile);
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
    const prepared = await runtime.runPromise(
      prepareSurfaceLaunch(
        request,
        {
          showInfoMessage: (message) => messages.showInfoMessage(message),
          chooseTeamAvailability: async (unavailableNames) => {
            const prompt = teamAvailabilityPrompt(unavailableNames);
            return (
              (await chooseTeamAvailabilityViaDialog(prompt, {
                modal: false,
              })) ?? 'cancel'
            );
          },
          signInForRemoteAgentCatalog: async () =>
            Boolean(
              await vscode.commands.executeCommand<boolean>(
                AUTH_COMMANDS.SIGN_IN,
              ),
            ),
        },
        session.roots.workspaceState,
      ),
    );
    await runCommand('texra.execute', prepared);
  }

  function getOpenedFiles(): string[] {
    const workspaceRoot = session.roots.workspace;
    if (!workspaceRoot) {
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
      ...new Set(
        fileUris.map((uri) => workspaceRelativePath(workspaceRoot, uri.fsPath)),
      ),
    ];
  }

  /** One dropped path as a workspace-relative file, or `null` when it is
   *  not one. A path that does not decode as a URL stands as its raw text,
   *  and a file the workspace cannot stat is not a file here; both say so
   *  in the debug log. */
  function resolveWorkspaceDropFile(
    rawPath: string,
  ): Effect.Effect<string | null> {
    return Effect.gen(function* () {
      const trimmed = rawPath.trim();
      const decodedPath = trimmed.startsWith('file:')
        ? yield* Effect.try({
            try: () => fileURLToPath(trimmed),
            catch: (cause) =>
              new DropPathUndecodable({ message: toErrorMessage(cause) }),
          }).pipe(
            Effect.catchTag('DropPathUndecodable', (error) =>
              Effect.sync(() => {
                log.debug(
                  `Dropped path is not a file URL: ${trimmed}: ${error.message}`,
                );
                return trimmed;
              }),
            ),
          )
        : trimmed;
      const resolved = locateInWorkspace(session.roots.workspace, decodedPath);
      if (resolved.kind !== 'workspace') return null;
      return yield* Effect.tryPromise({
        try: () =>
          vscode.workspace.fs.stat(vscode.Uri.file(resolved.absolutePath)),
        catch: (cause) =>
          new DropFileUnreadable({ message: toErrorMessage(cause) }),
      }).pipe(
        Effect.map((stat) =>
          (stat.type & vscode.FileType.File) === 0
            ? null
            : resolved.relativePath,
        ),
        Effect.catchTag('DropFileUnreadable', (error) =>
          Effect.sync(() => {
            log.debug(
              `Dropped file could not be read: ${decodedPath}: ${error.message}`,
            );
            return null;
          }),
        ),
      );
    });
  }

  function attachDroppedFiles(
    request: Extract<HostRequest, { kind: 'attachDroppedFiles' }>,
  ): Effect.Effect<HostOutcome> {
    return Effect.forEach(
      request.paths,
      (rawPath) => resolveWorkspaceDropFile(rawPath),
      { concurrency: 'unbounded' },
    ).pipe(
      Effect.map((paths): HostOutcome => {
        const attached = attachDroppedPaths(
          paths,
          getIncludedExtensions(request.category),
        );
        if (attached.attachedCount > 0 && attached.rejectedCount > 0) {
          void showInfo(
            `Attached ${formatResultCount(attached.attachedCount, 'dropped file')}; skipped ${formatResultCount(attached.rejectedCount, 'unsupported, folder, or out-of-workspace item')}.`,
          );
        }
        return { kind: 'files', paths: attached.paths };
      }),
    );
  }

  /** The editor's current file into a launcher field. */
  async function useCurrentFile(
    request: Extract<HostRequest, { kind: 'useCurrentFile' }>,
  ): Promise<HostOutcome> {
    const currentOpenFile = await getCurrentFile(session);
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
        const sourceLocation = locateInWorkspace(
          session.roots.workspace,
          parsed.sourcePath,
        );
        const sourceExists =
          sourceLocation.kind === 'workspace' &&
          (await runtime.runPromise(
            withSessionFs(
              session.roots,
              Effect.flatMap(Effect.service(WorkspaceFs), (workspaceFs) =>
                workspaceFs.exists(sourceLocation.relativePath),
              ),
            ),
          ));
        if (sourceExists) {
          await runtime.runPromise(snapshot.refreshFiles);
          return { kind: 'files', paths: [parsed.sourcePath] };
        }
        void showInfo(
          `The base file ${parsed.sourcePath} could not be found. Keeping ${currentOpenFile} selected.`,
        );
      }
    }
    return { kind: 'files', paths: [currentOpenFile] };
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
    return Effect.tryPromise({
      try: () => pick(),
      catch: (cause) =>
        new FilePickerFailed({ message: toErrorMessage(cause) }),
    }).pipe(
      // The picker's failure is shown where it happened, then refused with
      // the text it carried. The notice itself is the window's, so a window
      // that cannot show it is a defect here, as it was before.
      Effect.catchTag('FilePickerFailed', (error) =>
        Effect.promise(() =>
          showLoggedErrorMessage(CHANNEL, `Error selecting ${fileType}`, error),
        ).pipe(
          Effect.andThen(Effect.fail(new Rejected({ reason: error.message }))),
        ),
      ),
      Effect.flatMap((selected) =>
        selected
          ? Effect.succeed<HostOutcome>({ kind: 'files', paths: selected })
          : Effect.fail(new Cancelled()),
      ),
    );
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
        const dir = await runtime.runPromise(agentDirectories.custom());
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
      runtime.runPromise(snapshot.refreshCatalogs),
      runtime.runPromise(snapshot.refreshAuth),
      options.refreshOnboardingFunnel(),
    ]);
  }

  async function onboarding(
    action: Extract<HostRequest, { kind: 'onboarding' }>['action'],
  ): Promise<void> {
    switch (action) {
      case 'signInChatGpt':
        await signInWithSubscription(CHANNEL, 'chatgpt', runtime);
        await refreshAfterCredentialChange();
        return;
      case 'setApiKey':
        await runCommand('texra.setApiKey');
        // SecretManager has no key-changed event, so the set-key flow's
        // completion is the explicit refresh point for the funnel.
        await options.refreshOnboardingFunnel();
        return;
      case 'skip':
        await runtime.runPromise(
          setOnboardingDeclined(options.globalState, true),
        );
        await options.refreshOnboardingFunnel();
        return;
      case 'runSetup':
        await runCommand(GETTING_STARTED_COMMANDS.runSetup);
        await options.refreshOnboardingFunnel();
        return;
      case 'skipSetup':
        await runtime.runPromise(setFirstRunDone(options.globalState, true));
        await options.refreshOnboardingFunnel();
        return;
      case 'openGettingStarted':
        await runCommand(GETTING_STARTED_COMMANDS.openWalkthrough);
        return;
    }
  }

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
        await workflowFileActions.openTaskStorage(request.runId);
        return done;
      case 'exportTranscript':
        await exportTranscript(request.runId);
        return done;
      case 'restoreIntoLauncher':
        await restoreIntoLauncher(
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
        const diff = await runtime.runPromise(
          runActions.workflowDiffRequest(request.runId),
        );
        if (diff) await runCommand('texra.runLatexdiff', diff);
        return done;
      }
      case 'pack':
      case 'clean': {
        const operation = await runtime.runPromise(
          runActions.workflowFileOperationRequest(request.runId),
        );
        if (operation) await runCommand(`texra.${request.kind}`, operation);
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
        await options.popOutToEditor();
        return done;
      case 'popBack':
        await options.showInSidebar();
        return done;
      case 'openDashboard':
        await runCommand('texra.showDashboard');
        return done;
      case 'refreshCommits':
        await runtime.runPromise(snapshot.refreshCommits);
        return done;
      case 'refreshFiles':
        await runtime.runPromise(snapshot.refreshFiles);
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
        return runtime.runPromise(pickFiles(request));
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
        return runtime.runPromise(attachDroppedFiles(request));
      case 'launch':
        await launch(request);
        return done;
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
        await runtime.runPromise(snapshot.refreshHostBanners);
        return done;
      case 'openInstallGuide': {
        const docsCommand = getToolDocsCommand(request.tool);
        if (!docsCommand) {
          throw new Rejected({
            reason: `No install guide is registered for ${request.tool}.`,
          });
        }
        const [command, ...args] = docsCommand.split(',');
        await runCommand(command, ...args);
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
        await runtime.runPromise(snapshot.dismissBanner(request.banner));
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
    closePort: draftRequests.closePort,
    dispose: draftRequests.dispose,
  };
}
