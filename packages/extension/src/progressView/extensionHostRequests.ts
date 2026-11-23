/**
 * The extension's half of its window (`openGuiWindow`): the verbs this host
 * performs, bound onto VS Code's commands, editors, pickers, and dialogs,
 * plus the few requests the extension answers its own way -- its tab
 * pop-out, its getting-started commands.
 * Everything else is the one shared body, which decides the order, the
 * guards, and the rejection wording for both GUI hosts. Each handler answers
 * exactly once with an outcome or a request error; a request the extension
 * does not perform is `Rejected` with its reason, never dropped.
 */
import * as vscode from 'vscode';
import { Effect, FiberHandle } from 'effect';

import { type WorkspaceRoots } from '@texra-ai/worldline';
import { type ProcessServices } from '@texra-ai/worldline/host';
import { withLogChannel, pathToLocationIn } from '@texra-ai/worldline/plugins';
import { toErrorMessage } from '@texra-ai/worldline/schemas';
import { setApiKey } from '@commands/api/apiKeyCommands';
import { cloneOverleafProject } from '@commands/git/gitCommands';
import { downloadArXivSource } from '@commands/latex/arXivCommands';
import { createSampleProject } from '@commands/system/sampleProjectCommands';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import { vscodeOpener } from '@frontend/hosts/VscodeExternalOpener';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import type { ShowBuilt } from '@frontend/latex/openBuild';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { askNotice, vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { openFilesDialog, quickPick } from '@frontend/ui/dialogs';
import { withVSCodeProgress } from '@frontend/ui/progress';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type { SubscriptionProviderId } from '@texra/controllers/modelAccess/subscriptionProviders';
import type { GettingStartedAction } from '@texra/shared/session/hostRequest';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import type {
  ConfirmQuestion,
  HostFailed,
  NoticeLevel,
} from '@texra/hosts/uiHosts';

import {
  TRANSCRIPT_EXPORT_FORMAT_CHOICES,
  TRANSCRIPT_EXPORT_PICK,
  type TranscriptExportOpenKind,
} from '@texra/controllers/progressView/exportTranscript';
import {
  hostFailed,
  hostFailure,
} from '@texra/controllers/session/hostCallFailure';
import type {
  OwnHostHandlers,
  SharedHostCommandBindings,
} from '@texra/controllers/session/openGuiWindow';
import {
  type HostCommandFailure,
  type RequestRefusal,
} from '@texra/controllers/session/hostCallFailure';

// Local file imports
import { handleCompare } from './compareFiles';
import { openFile } from './openFile';

const CHANNEL = 'ExtensionHostRequests';

export interface ExtensionHostRequestsOptions {
  readonly roots: WorkspaceRoots;
  /** "Show a built file", bound to this window's roots and the view's
   *  scope, so a close of the view cancels a PDF viewer open still
   *  waiting. */
  readonly showBuilt: ShowBuilt;
  readonly extensionPath: string;
  /** The extension's id, which names its getting-started walkthrough. */
  readonly extensionId: string;
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

/** The file a tab shows, by its absolute path: a text editor's, or a
 *  custom editor's (an image or a PDF); undefined for any other tab. */
function tabFile(input: unknown): string | undefined {
  return (input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputCustom) &&
    input.uri.scheme === 'file'
    ? input.uri.fsPath
    : undefined;
}

/** The editor's current file: the active text editor's document, else the
 *  active tab's file. */
const currentFile = Effect.sync(() => {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file') return doc.uri.fsPath;
  return (
    tabFile(vscode.window.tabGroups.activeTabGroup.activeTab?.input) ?? null
  );
});

/** Every file the editor has a tab open on. */
const openedFiles = Effect.sync(() =>
  vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) => tabFile(tab.input) ?? []),
);

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
  const { roots } = options;

  // The window's one comparison refresh: a newer comparison replaces it,
  // and the view's scope ends it.
  const diffRefresh = yield* FiberHandle.make();
  const at = (file: string) => pathToLocationIn(roots.workspace, file);

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
    openFiles: openFilesDialog,
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
    openExternal: (url) => vscodeOpener.openExternal(url),
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
    editor: {
      currentFile,
      openedFiles,
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
    ask: askNotice,
    // Each command is named, so a failure carries a tag, never a rejection.
    files: {
      openDiff: (base: string, edited: string, title: string) =>
        runHandler(
          'compare',
          handleCompare(at(base), at(edited), title, diffRefresh),
        ),
      // The host's members read `this`, so they cross the boundary bound.
      confirm: (question: ConfirmQuestion) => vscodeUi.confirm(question),
      openDirectory: revealFileInOS,
    },
    export: {
      pickFormat: quickPick(TRANSCRIPT_EXPORT_FORMAT_CHOICES, {
        title: TRANSCRIPT_EXPORT_PICK.title,
        placeHolder: TRANSCRIPT_EXPORT_PICK.prompt,
        ignoreFocusOut: true,
      }).pipe(Effect.map((choice) => choice?.format)),
      openPath: openExportPath,
    },
  };
});
