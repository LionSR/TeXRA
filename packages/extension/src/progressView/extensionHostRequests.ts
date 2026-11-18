/**
 * The extension's half of its window (`openGuiWindow`): the verbs this host
 * performs, bound onto VS Code's commands, editors, pickers, and dialogs,
 * plus the few requests the extension answers its own way -- its file pickers,
 * its editor's current file, its tab pop-out, its getting-started commands.
 * Everything else is the one shared body, which decides the order, the
 * guards, and the rejection wording for both GUI hosts. Each handler answers
 * exactly once with an outcome or a request error; a request the extension
 * does not perform is `Rejected` with its reason, never dropped.
 */
import * as path from 'node:path';

import * as vscode from 'vscode';
import { Effect, FiberHandle } from 'effect';

import { type WorkspaceRoots } from '@texra-ai/harness';
import {
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
  pathToLocationIn,
} from '@texra-ai/harness/host';
import { withLogChannel, WorkspaceFs } from '@texra-ai/harness/plugins';
import { commitExists, workspaceRelativePath } from '@texra-ai/harness/node';
import { toErrorMessage, Rejected } from '@texra-ai/harness/schemas';
import { setApiKey } from '@commands/api/apiKeyCommands';
import { cloneOverleafProject } from '@commands/git/gitCommands';
import { downloadArXivSource } from '@commands/latex/arXivCommands';
import { createSampleProject } from '@commands/system/sampleProjectCommands';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import {
  openGuidePage,
  vscodeOpener,
} from '@frontend/hosts/VscodeExternalOpener';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import type { ShowBuilt } from '@frontend/latex/openBuild';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { openFilesDialog, quickPick } from '@frontend/ui/dialogs';
import { withVSCodeProgress } from '@frontend/ui/progress';
import { previewFinalOutput } from '@frontend/agents/finalOutputOpener';
import { parseVersionControlDiffFilename } from '@latex/latexdiff/diffFileNameManager';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type { SubscriptionProviderId } from '@texra/controllers/modelAccess/subscriptionProviders';
import type {
  GettingStartedAction,
  HostCommand,
} from '@texra/shared/session/hostRequest';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import type {
  ConfirmQuestion,
  HostFailed,
  NoticeLevel,
} from '@texra/hosts/uiHosts';

import { normalizeMainViewFileExtension } from '@texra/controllers/mainView/MainViewDroppedFilesController';
import {
  TRANSCRIPT_EXPORT_FORMAT_CHOICES,
  type TranscriptExportOpenKind,
} from '@texra/controllers/progressView/exportTranscript';
import { TranscriptExportFailed } from '@texra/controllers/progressView/transcriptExportFailure';
import {
  hostFailed,
  hostFailure,
} from '@texra/controllers/session/hostCallFailure';
import type { HostSnapshotSource } from '@texra/controllers/session/hostSnapshotSource';
import { pickLauncherFiles } from '@texra/controllers/session/launcherFilePicker';
import type {
  OwnHostHandlers,
  SharedHostCommandBindings,
} from '@texra/controllers/session/openGuiWindow';
import type { SessionBridge } from '@texra/controllers/session/SessionBridge';
import {
  type HostCommandFailure,
  type RequestRefusal,
} from '@texra/controllers/session/hostCallFailure';

// Local file imports
import { handleCompare } from './compareFiles';
import { getCurrentFile } from './fileSelection';
import { openFile } from './openFile';

const CHANNEL = 'ExtensionHostRequests';

export interface ExtensionHostRequestsOptions {
  readonly roots: WorkspaceRoots;
  /** "Show a built file", bound to this window's roots and the view's
   *  scope, so a close of the view cancels a PDF viewer open still
   *  waiting. */
  readonly showBuilt: ShowBuilt;
  /** The window's bridge and snapshot. */
  readonly bridge: SessionBridge;
  readonly snapshot: HostSnapshotSource;
  readonly extensionPath: string;
  /** The extension's id, which names its getting-started walkthrough. */
  readonly extensionId: string;
  /** The process runtime the extension root holds; every request handler
   *  that runs an Effect runs it here. */
  readonly runtime: ProcessRuntime;
  /** The settings view at a target (`texra.showDashboard`). */
  openSettings(
    target: SettingsTarget | undefined,
  ): Effect.Effect<void, Error, ProcessServices>;
  /** One subscription's sign-in as the settings view runs it, which tells
   *  the user how it ended and repaints what follows the account. */
  signInSubscription(
    providerId: SubscriptionProviderId,
  ): Effect.Effect<void, Error, ProcessServices>;
  /** The placement commands the sidebar and the editor tab share. */
  popOutToEditor(): Effect.Effect<void, HostCommandFailure, ProcessServices>;
  showInSidebar(): Effect.Effect<void, HostCommandFailure, ProcessServices>;
}

const done: HostOutcome = Object.freeze({ kind: 'done' } as const);

/** One of this extension's own command handlers, or a VS Code command, run
 *  in the handler's fiber: a typed failure or a defect is named and logged. */
function runHandler<A, E, R>(
  command: string,
  handler: Effect.Effect<A, E, R>,
): Effect.Effect<A, HostFailed | RequestRefusal, R> {
  const log = (failure: unknown) =>
    Effect.logError(`Command ${command} failed: ${toErrorMessage(failure)}`);
  return handler.pipe(
    Effect.mapError((cause) => hostFailure(command, cause)),
    Effect.tapError(log),
    Effect.tapDefect(log),
    withLogChannel(CHANNEL),
  );
}

/** Reveal `fsPath` in the OS file manager, with the command's own result
 *  discarded. */
function revealFileInOS(fsPath: string) {
  return Effect.asVoid(
    runHandler(
      'revealFileInOS',
      executeVscodeCommand('revealFileInOS', vscode.Uri.file(fsPath)),
    ),
  );
}

/** The export's open verb. The editor APIs behind it are thenables, so this
 *  is where they are lifted -- once, at the host boundary. */
const openExportPath = (
  filePath: string,
  kind: TranscriptExportOpenKind,
): Effect.Effect<void, HostFailed> => {
  const failed = (cause: unknown) => hostFailed('openPath', cause);
  const uri = vscode.Uri.file(filePath);
  if (kind === 'external') {
    // The opener also fails when VS Code declines the file.
    return vscodeOpener.openExternal(uri.toString());
  }
  if (kind === 'pdf') {
    return executeVscodeCommand('vscode.open', uri).pipe(
      Effect.asVoid,
      Effect.mapError(failed),
    );
  }
  return openFileInEditor(filePath).pipe(
    Effect.asVoid,
    Effect.mapError(failed),
  );
};

/** This window's half of its `openGuiWindow`, for the view's scope. */
export const createExtensionHostRequests = Effect.fn(
  'createExtensionHostRequests',
)(function* (options: ExtensionHostRequestsOptions) {
  const { snapshot, runtime, roots } = options;

  // The window's one comparison refresh: a newer comparison replaces it,
  // and the view's scope ends it.
  const diffRefresh = yield* FiberHandle.make();
  const at = (file: string) => pathToLocationIn(roots.workspace, file);
  // A file-action port's handler; the process services come from the runtime.
  const runFileAction = <A, E>(
    command: string,
    handler: Effect.Effect<A, E, ProcessServices>,
  ) => withProcessServices(runtime, runHandler(command, handler));

  function getOpenedFiles(): Effect.Effect<string[]> {
    const workspaceRoot = roots.workspace;
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
  const useCurrentFile = Effect.fn('useCurrentFile')(function* (
    request: Extract<HostCommand, { kind: 'useCurrentFile' }>,
  ) {
    const currentOpenFile = yield* getCurrentFile(roots);
    if (!currentOpenFile) {
      return yield* new Rejected({
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
        const found =
          roots.workspace !== undefined &&
          (yield* commitExists(roots.workspace, parsed.commitHash));
        if (found) {
          options.bridge.surfaceAction({
            kind: 'launch',
            patch: { commit: parsed.commitHash },
          });
        } else {
          yield* vscodeUi.notify(
            'info',
            `The commit ${parsed.commitHash} referenced by ${path.basename(currentOpenFile)} was not found in the repository history.`,
          );
        }
        const sourceLocation = pathToLocationIn(
          roots.workspace,
          parsed.sourcePath,
        );
        const sourceExists =
          sourceLocation.kind === 'workspace' &&
          (yield* Effect.flatMap(Effect.service(WorkspaceFs), (workspaceFs) =>
            workspaceFs.exists(sourceLocation.relativePath),
          ));
        if (sourceExists) {
          yield* snapshot.refreshFiles;
          return {
            kind: 'files',
            paths: [parsed.sourcePath],
          } satisfies HostOutcome;
        }
        yield* vscodeUi.notify(
          'info',
          `The base file ${parsed.sourcePath} could not be found. Keeping ${currentOpenFile} selected.`,
        );
      }
    }
    return {
      kind: 'files',
      paths: [currentOpenFile],
    } satisfies HostOutcome;
  });

  /** What each getting-started action runs. */
  const gettingStarted = (action: GettingStartedAction) => {
    switch (action) {
      case 'createSampleProject':
        return createSampleProject(options.extensionPath);
      case 'cloneOverleaf':
        return cloneOverleafProject();
      case 'downloadArxiv':
        return downloadArXivSource(roots);
    }
  };

  /** This host's half of the shared body's binding table: every verb mapped
   *  onto a VS Code command, an editor API, or the sidebar. */
  const bindings: SharedHostCommandBindings = {
    openPath: (file, line) => runHandler('openFile', openFile(file, line)),
    pickFiles: (fileType) =>
      pickLauncherFiles(roots.workspace, fileType, openFilesDialog),
    latexdiff: {
      openDiffs: ([first, ...rest]) =>
        first === undefined
          ? Effect.void
          : runHandler(
              'openLatexdiffs',
              options.showBuilt([at(first), ...rest.map(at)], {
                preserveFocus: true,
              }),
            ),
      withProgress: (title, task) =>
        withVSCodeProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: false,
          },
          task,
        ),
    },
    openSettings: (target) =>
      runHandler('openSettings', options.openSettings(target)),
    // The key store announces the write (`credentialChanged`), which the
    // launcher's credential check and catalogs follow.
    setApiKey: (provider) =>
      runHandler('setApiKey', setApiKey(roots, provider)),
    // A link VS Code declines or cannot open is answered as a rejection, so
    // the view shows which URL did not open.
    openExternal: (url) =>
      vscodeOpener
        .openExternal(url)
        .pipe(
          Effect.mapError((failed) => new Rejected({ reason: failed.message })),
        ),
    // The banner refresh probes the dependencies again; the banner shows
    // what is missing.
    // Every dependency the banner lists installs from the one guide page.
    openInstallGuide: runHandler('openDoc', openGuidePage('installation')),
    onboarding: {
      signInChatGpt: runHandler(
        'signInChatGpt',
        // Suspended: the settings view this waits for is asked when the
        // card's program runs, not when this table is built.
        Effect.suspend(() => options.signInSubscription('chatgpt')),
      ),
      openGettingStarted: runHandler(
        'openGettingStarted',
        openGettingStarted(options.extensionId),
      ),
    },
  };

  /**
   * The requests this host performs its own way. The capabilities that still
   * answer with a promise - VS Code commands, the editor APIs - are lifted
   * once (`executeVscodeCommand`), and this extension's own
   * commands run as the programs behind them, so no handler re-enters the
   * runtime between here and the bridge that runs this program.
   */
  const own: OwnHostHandlers = {
    popOut: () => Effect.as(options.popOutToEditor(), done),
    popBack: () => Effect.as(options.showInSidebar(), done),
    useCurrentFile: (request) => useCurrentFile(request),
    addOpenedFiles: (request) =>
      Effect.map(getOpenedFiles(), (opened): HostOutcome => {
        const allowed = new Set(
          getIncludedExtensions(request.fileType).map(
            normalizeMainViewFileExtension,
          ),
        );
        return {
          kind: 'files',
          paths:
            allowed.size > 0
              ? opened.filter((file) =>
                  allowed.has(normalizeMainViewFileExtension(file)),
                )
              : opened,
        };
      }),
    gettingStarted: (request) =>
      Effect.as(
        runHandler(request.action, gettingStarted(request.action)),
        done,
      ),
  };

  return {
    bindings,
    own,
    // The host's members read `this`, so they cross the boundary bound.
    notify: (level: NoticeLevel, message: string) =>
      vscodeUi.notify(level, message),
    openFinalOutput: previewFinalOutput,
    // Each command is named, so a failure carries a tag, never a rejection.
    files: {
      openDiff: (base: string, edited: string, title: string) =>
        runFileAction(
          'compare',
          handleCompare(at(base), at(edited), title, diffRefresh),
        ),
      // The host's members read `this`, so they cross the boundary bound.
      confirm: (question: ConfirmQuestion) => vscodeUi.confirm(question),
      openDirectory: revealFileInOS,
    },
    export: {
      // A refusal to show the pick is worded into the export's tag.
      pickFormat: quickPick(TRANSCRIPT_EXPORT_FORMAT_CHOICES, {
        title: 'Export transcript',
        placeHolder: 'Choose a format',
        ignoreFocusOut: true,
      }).pipe(
        Effect.map((choice) => choice?.format),
        Effect.mapError(
          (error) =>
            new TranscriptExportFailed({
              message: error.message,
              cause: error.cause,
            }),
        ),
      ),
      openPath: openExportPath,
    },
  };
});
