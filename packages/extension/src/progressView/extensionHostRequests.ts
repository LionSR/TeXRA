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

import {
  runAgent,
  validateRunRequest,
  type SessionHandle,
} from '@agent/runtime';
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
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import { runSignInCommand } from '@frontend/auth/signInCommand';
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
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { withSessionFs, WorkspaceFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import { presentLaunchedProgressRun } from '@progressView/progressNavigation';
import latexPreamble from '@resources/templates/chatExport.tex';
import {
  GETTING_STARTED_COMMANDS,
  isMultipleDocumentFileType,
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
  handleHostRequest(
    request: HostRequest,
    port: string,
  ): Effect.Effect<HostOutcome, unknown, ProcessServices>;
  closePort(port: string): void;
  /** Stops a recording this host owns; the take is discarded. */
  dispose(): void;
}

const done: HostOutcome = Object.freeze({ kind: 'done' } as const);

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

/** The typed notification surface the run-action ports, the launch host, and
 *  the transcript export ports take. */
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

  /** A host capability that still answers with a promise - a VS Code command,
   *  an editor API, a Promise-faced controller port - lifted verbatim: the
   *  rejection reaches the dispatcher as the value it was thrown with,
   *  exactly as `await` handed it over. */
  const fromHost = <A>(call: () => PromiseLike<A>): Effect.Effect<A, unknown> =>
    Effect.tryPromise({ try: call, catch: (error) => error });

  /** The native picker of each multi-file launcher list. */
  const multipleFilePickers = createFileSelectionPickers(session);

  /**
   * Validate an agent request and launch it directly: the port settled with
   * the run even through the old `texra.execute` command hop, and the hop's
   * only addition was a second Zod parse of the config `validateRunRequest`
   * already checked. The launch program takes its process services from this
   * runtime's context on the fiber that runs it, as the resume port's program
   * does.
   */
  const runAgentRequest: HostRunActionPorts['runAgentRequest'] = (
    request,
    runOptions = {},
  ) => {
    const validation = validateRunRequest(request);
    if (!validation.valid) {
      log.error(validation.message);
      return Effect.fail(new Rejected({ reason: validation.message }));
    }
    const { config, runId } = validation.request;
    const launch = runAgent(
      runId === undefined
        ? { kind: 'fresh', config }
        : { kind: 'resume', config, runId },
      {
        session,
        openWorkflowOutput: openFinalOutputIfAvailable,
        preferHelperModel: runOptions.preferHelperModel ?? false,
        ownApiKeyFallback: runOptions.ownApiKeyFallback,
        onRun: runOptions.onRun,
        onRunResolved: presentLaunchedProgressRun,
      },
    ).pipe(Effect.asVoid);
    return Effect.flatMap(runtime.contextEffect, (context) =>
      Effect.provideContext(launch, context),
    );
  };

  const runActions = runtime.runSync(
    createHostRunActions({
      session,
      runAgentRequest,
      loadModelOptions: () =>
        Effect.flatMap(runtime.contextEffect, (context) =>
          Effect.provideContext(
            readModelAvailabilityInputs({ secrets, globalState }).pipe(
              Effect.map(modelOptionsFrom),
            ),
            context,
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
      // The file-actions host port is still Promise-shaped, so the message
      // host is demoted here only.
      showInfo: (message) =>
        runtime.runPromise(messages.showInfoMessage(message)),
      showError: (message) =>
        runtime.runPromise(messages.showErrorMessage(message)),
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

  function exportTranscript(runId: RunId) {
    return withSessionFs(
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
        showInfo: (message) => messages.showInfoMessage(message),
        showWarning: (message) => messages.showWarningMessage(message),
        showError: (message) => messages.showErrorMessage(message),
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
    );
  }

  /** A run's saved setup into the launcher, and the launcher into view. */
  function restoreIntoLauncher(
    config: Parameters<typeof launchPatchOf>[0],
  ): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
      options.surfaceAction({ kind: 'launch', patch: launchPatchOf(config) });
      options.surfaceAction({ kind: 'selectNew' });
      yield* fromHost(() => options.showInSidebar());
    });
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
  function launch(
    request: Extract<HostRequest, { kind: 'launch' }>,
  ): Effect.Effect<void, unknown> {
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
          showInfoMessage: (message) => messages.showInfoMessage(message),
          // The team-availability dialog is still a Promise port shared with
          // the settings view, so it is lifted where it is passed.
          chooseTeamAvailability: async (unavailableNames) => {
            const prompt = teamAvailabilityPrompt(unavailableNames);
            return (
              (await chooseTeamAvailabilityViaDialog(prompt, {
                modal: false,
              })) ?? 'cancel'
            );
          },
          signInForRemoteAgentCatalog: runSignInCommand,
        },
        session.roots.workspaceState,
      );
      yield* fromHost(() => runCommand('texra.execute', prepared));
    });
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
          void runtime.runFork(
            messages.showInfoMessage(
              `Attached ${formatResultCount(attached.attachedCount, 'dropped file')}; skipped ${formatResultCount(attached.rejectedCount, 'unsupported, folder, or out-of-workspace item')}.`,
            ),
          );
        }
        return { kind: 'files', paths: attached.paths };
      }),
    );
  }

  /** The editor's current file into a launcher field. */
  function useCurrentFile(
    request: Extract<HostRequest, { kind: 'useCurrentFile' }>,
  ): Effect.Effect<HostOutcome, unknown, ProcessServices> {
    return Effect.gen(function* () {
      const currentOpenFile = yield* fromHost(() => getCurrentFile(session));
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
          const commitLabel = yield* fromHost(() =>
            runCommand<string | null>(
              'texra.findCommitInHistory',
              parsed.commitHash,
            ),
          );
          if (commitLabel) {
            options.surfaceAction({
              kind: 'launch',
              patch: { commit: parsed.commitHash },
            });
          } else {
            void runtime.runFork(
              messages.showInfoMessage(
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
            (yield* withSessionFs(
              session.roots,
              Effect.flatMap(Effect.service(WorkspaceFs), (workspaceFs) =>
                workspaceFs.exists(sourceLocation.relativePath),
              ),
            ));
          if (sourceExists) {
            yield* snapshot.refreshFiles;
            return { kind: 'files', paths: [parsed.sourcePath] };
          }
          void runtime.runFork(
            messages.showInfoMessage(
              `The base file ${parsed.sourcePath} could not be found. Keeping ${currentOpenFile} selected.`,
            ),
          );
        }
      }
      return { kind: 'files', paths: [currentOpenFile] };
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

  function agentConfigBanner(
    request: Extract<HostRequest, { kind: 'agentConfigBanner' }>,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
      switch (request.action) {
        case 'edit':
          yield* fromHost(() =>
            runCommand(
              'texra.showAgents',
              request.sessionType === 'toolUse' ? 'toolUse' : undefined,
            ),
          );
          return;
        case 'dir': {
          if (!request.customDirSet) {
            yield* fromHost(() => runCommand('texra.showAgents'));
            return;
          }
          const dir = yield* agentDirectories.custom();
          if (dir) {
            yield* fromHost(() =>
              vscode.commands.executeCommand(
                'revealFileInOS',
                vscode.Uri.file(dir),
              ),
            );
          }
          return;
        }
        case 'docs':
          yield* fromHost(() => runCommand('texra.openDoc', 'custom-agents'));
          return;
      }
    });
  }

  /** The four reads a new credential invalidates, refreshed together as the
   *  four promises were. */
  const refreshAfterCredentialChange = Effect.all(
    [
      fromHost(() =>
        vscode.commands.executeCommand('texra.refreshApiKeyStatus'),
      ),
      snapshot.refreshCatalogs,
      snapshot.refreshAuth,
      fromHost(() => options.refreshOnboardingFunnel()),
    ],
    { concurrency: 'unbounded', discard: true },
  );

  function onboarding(
    action: Extract<HostRequest, { kind: 'onboarding' }>['action'],
  ): Effect.Effect<void, unknown, ProcessServices> {
    return Effect.gen(function* () {
      switch (action) {
        case 'signInChatGpt':
          yield* fromHost(() =>
            signInWithSubscription(CHANNEL, 'chatgpt', runtime),
          );
          yield* refreshAfterCredentialChange;
          return;
        case 'setApiKey':
          yield* fromHost(() => runCommand('texra.setApiKey'));
          // SecretManager has no key-changed event, so the set-key flow's
          // completion is the explicit refresh point for the funnel.
          yield* fromHost(() => options.refreshOnboardingFunnel());
          return;
        case 'skip':
          yield* setOnboardingDeclined(options.globalState, true);
          yield* fromHost(() => options.refreshOnboardingFunnel());
          return;
        case 'runSetup':
          yield* fromHost(() => runCommand(GETTING_STARTED_COMMANDS.runSetup));
          yield* fromHost(() => options.refreshOnboardingFunnel());
          return;
        case 'skipSetup':
          yield* setFirstRunDone(options.globalState, true);
          yield* fromHost(() => options.refreshOnboardingFunnel());
          return;
        case 'openGettingStarted':
          yield* fromHost(() =>
            runCommand(GETTING_STARTED_COMMANDS.openWalkthrough),
          );
          return;
      }
    });
  }

  /**
   * One program per request. The arms are Effects; the capabilities that
   * still answer with a promise - the VS Code commands `runCommand` wraps,
   * the editor APIs, the Promise-faced controller ports - are lifted once
   * through `fromHost`, so no arm re-enters the runtime between here and the
   * bridge that runs this program.
   */
  function dispatch(
    request: HostRequest,
    port: string,
  ): Effect.Effect<HostOutcome, unknown, ProcessServices> {
    return Effect.gen(function* () {
      switch (request.kind) {
        case 'openFile':
          yield* fromHost(() =>
            runCommand(
              'texra.openFile',
              request.path,
              request.line ?? undefined,
            ),
          );
          return done;
        case 'openLabel': {
          const opened = yield* fromHost(() =>
            runCommand<boolean>('texra.openLabel', request.label, {
              notifyNotFound: false,
            }),
          );
          if (!opened) {
            return yield* Effect.fail(
              new Rejected({
                reason: `No file defines the label ${request.label}.`,
              }),
            );
          }
          return done;
        }
        case 'openTaskStorage':
          yield* fromHost(() =>
            workflowFileActions.openTaskStorage(request.runId),
          );
          return done;
        case 'exportTranscript':
          yield* exportTranscript(request.runId);
          return done;
        case 'restoreIntoLauncher':
          yield* restoreIntoLauncher(
            yield* runActions.restoreState(request.runId),
          );
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
          if (diff) {
            yield* fromHost(() => runCommand('texra.runLatexdiff', diff));
          }
          return done;
        }
        case 'pack':
        case 'clean': {
          const operation = yield* runActions.workflowFileOperationRequest(
            request.runId,
          );
          if (operation) {
            yield* fromHost(() =>
              runCommand(`texra.${request.kind}`, operation),
            );
          }
          return done;
        }
        case 'latexdiffs':
          yield* fromHost(() => latexdiffs(request));
          return done;
        case 'record':
        case 'polish':
        case 'savePastedImage':
          return yield* draftRequests.handle(request, port);
        case 'popOut':
          yield* fromHost(() => options.popOutToEditor());
          return done;
        case 'popBack':
          yield* fromHost(() => options.showInSidebar());
          return done;
        case 'openDashboard':
          yield* fromHost(() => runCommand('texra.showDashboard'));
          return done;
        case 'refreshCommits':
          yield* snapshot.refreshCommits;
          return done;
        case 'refreshFiles':
          yield* snapshot.refreshFiles;
          return done;
        case 'openSettings':
          switch (request.section) {
            case 'agents':
              yield* fromHost(() =>
                runCommand(
                  'texra.showAgents',
                  request.sessionType === 'toolUse' ? 'toolUse' : undefined,
                ),
              );
              return done;
            case 'models':
              yield* fromHost(() => runCommand('texra.showModels'));
              return done;
            case 'teams':
              yield* fromHost(() => runCommand('texra.showMultiAgent'));
              return done;
          }
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
          return yield* attachDroppedFiles(request);
        case 'launch':
          yield* launch(request);
          return done;
        case 'extractFigures':
          yield* fromHost(() => runCommand('texra.extractTikzFigures'));
          return done;
        case 'toolEdit':
          toolEditApprovals.handleAction({
            requestId: request.requestId,
            action: request.action,
            ...(request.feedback == null ? {} : { feedback: request.feedback }),
          });
          return done;
        case 'fileAction': {
          const config = yield* runActions.readConfig(request.runId);
          yield* fromHost(() => workflowFileActions.handle(request, config));
          return done;
        }
        case 'restoreProposalConfig':
          yield* restoreIntoLauncher(
            runActions.restoreProposal(request.proposal),
          );
          return done;
        case 'apiKeyBanner':
          if (request.action === 'set') {
            yield* fromHost(() =>
              runCommand('texra.setApiKey', request.provider ?? undefined),
            );
            yield* fromHost(() => options.refreshOnboardingFunnel());
            return done;
          }
          yield* fromHost(() =>
            vscode.env.openExternal(
              vscode.Uri.parse(
                (request.provider && getProviderKeyUrl(request.provider)) ||
                  'https://texra.ai/guide/installation#setting-up-api-keys',
              ),
            ),
          );
          return done;
        case 'agentConfigBanner':
          yield* agentConfigBanner(request);
          return done;
        case 'recheckDependencies':
          yield* fromHost(() => checkCoreDependencies(true));
          yield* snapshot.refreshHostBanners;
          return done;
        case 'openInstallGuide': {
          const docsCommand = getToolDocsCommand(request.tool);
          if (!docsCommand) {
            return yield* Effect.fail(
              new Rejected({
                reason: `No install guide is registered for ${request.tool}.`,
              }),
            );
          }
          const [command, ...args] = docsCommand.split(',');
          yield* fromHost(() => runCommand(command, ...args));
          return done;
        }
        case 'signIn': {
          const authenticated = yield* fromHost(() =>
            vscode.commands.executeCommand<boolean>(AUTH_COMMANDS.SIGN_IN),
          );
          if (authenticated) yield* refreshAfterCredentialChange;
          return done;
        }
        case 'dismissBanner':
          yield* snapshot.dismissBanner(request.banner);
          return done;
        case 'gettingStarted':
          yield* fromHost(() =>
            runCommand(GETTING_STARTED_COMMANDS[request.action]),
          );
          if (request.action === 'runSetup') {
            yield* fromHost(() => options.refreshOnboardingFunnel());
          }
          return done;
        case 'onboarding':
          yield* onboarding(request.action);
          return done;
        case 'setActiveView':
          // Only the sidebar port names the sidebar's state; the editor tab
          // has no view-title menu of its own.
          if (port === 'sidebar') setActiveSidebarView(request.view);
          return done;
      }
    });
  }

  return {
    // The bridge takes the dispatch program itself: it runs on the fiber the
    // webview's message pump already owns, and its failure reaches the
    // bridge's refusal-versus-defect fold as the value the arm carried.
    handleHostRequest: dispatch,
    closePort: draftRequests.closePort,
    dispose: draftRequests.dispose,
  };
}
