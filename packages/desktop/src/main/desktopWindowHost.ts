// How one window presents things: its dialogs, its preview and diff hosts,
// its browser hand-offs and its error reports. Built once per window; the
// project bindings, the settings surface and the shell all present through it
// rather than each reaching for Electron's `dialog` and `shell`.

import { app, dialog, shell, type BrowserWindow } from 'electron';
import { Cause, Effect } from 'effect';

import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import {
  ExternalOpenFailed,
  type NotificationFailed,
} from '@texra/hosts/uiHosts';
import {
  INSTRUCTION_ACTION,
  type InstructionAction,
} from '@ui/copy/instructionActions';
import { texraGuideUrl } from '@ui/copy/guide';
import { postDesktopSettingsView } from '../shared/desktopCommandSurface.js';
import { createDesktopDialogs } from './desktopDialogs.js';
import { createDesktopDiffHost } from './desktopDiffHost.js';
import { createDesktopPreviewHost } from './desktopPreviewHost.js';
import { DESKTOP_RELEASES_PAGE_URL } from './desktopUpdateChecker.js';
import type { ProcessRuntime } from '@texra-ai/harness/host';
import type { DesktopProject } from './desktopProjects.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';
import type { DesktopHostBridge } from './hostBridge.js';
import type { DesktopSpawn } from './desktopWindows.js';

export type DesktopWindowHost = ReturnType<typeof createDesktopWindowHost>;

export function createDesktopWindowHost(options: {
  window: BrowserWindow;
  runtime: ProcessRuntime;
  spawn: DesktopSpawn;
  /** The renderer's push channels, installed before anything can post. */
  bridge: DesktopHostBridge;
}) {
  const { window, runtime, spawn, bridge } = options;
  const post = (message: unknown): void => bridge.postToRenderer(message);

  const dialogs = createDesktopDialogs(window, {
    openGuide: (docsPage) => openExternalInBackground(texraGuideUrl(docsPage)),
    dispatchInstructionAction: (action) => dispatchInstructionAction(action),
  });
  const { showErrorMessage, showInfoMessage, showWarningMessage } = dialogs;

  const reportBackgroundError = (error: unknown) => {
    console.error('Desktop background operation failed:', error);
  };
  const reportAsyncError = (error: unknown) => {
    console.error('Desktop asynchronous operation failed:', error);
    spawn(
      showErrorMessage(
        `A desktop operation failed: ${toErrorMessage(error)}`,
      ).pipe(
        Effect.catch((notificationError: NotificationFailed) =>
          Effect.sync(() => {
            console.error(
              'Failed to display desktop asynchronous operation error:',
              notificationError,
            );
          }),
        ),
      ),
    );
  };

  /** A program whose failure or defect reaches the async-error report; an
   *  interrupt is its window closing, and reports nothing. */
  const reported = <E, R>(
    program: Effect.Effect<void, E, R>,
  ): Effect.Effect<void, never, R> =>
    Effect.catchCause(program, (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.sync(() => reportAsyncError(Cause.squash(cause))),
    );

  // One preview host, which never presents: a caller that shows its own
  // failure (a session request, at its dispatcher) yields it as it is, and
  // one that leaves it to the window (a menu, a run's tool) wraps it in
  // `presented`.
  const previewHost = createDesktopPreviewHost({
    shell,
    runtime,
    postToRenderer: post,
  });
  const diffHost = createDesktopDiffHost({ runtime, postToRenderer: post });

  /** Run `program`, showing its failure in the window's error dialog first;
   *  the failure still reaches the caller. A dialog that cannot be shown is
   *  logged. */
  const presented = <A, E extends { readonly message: string }, R>(
    program: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    program.pipe(
      Effect.tapError((error) =>
        showErrorMessage(error.message).pipe(
          Effect.catch((notificationError: NotificationFailed) =>
            Effect.sync(() =>
              console.error(
                'Failed to display a desktop error:',
                notificationError,
              ),
            ),
          ),
        ),
      ),
    );

  /**
   * Open a documentation URL without keeping the caller waiting; the browser
   * never opening is reported, not swallowed. This report names the
   * documentation URL rather than the address the shell refused.
   */
  const openExternalInBackground = (url: string): void => {
    spawn(
      previewHost.openExternal(url).pipe(
        Effect.mapError(
          (cause) =>
            new ExternalOpenFailed({
              target: url,
              message: 'The documentation URL could not be opened.',
              cause,
            }),
        ),
        // The handler's parameter is the whole error type this expression can
        // carry, so a second failure added here fails to compile instead of
        // reading as a documentation URL that would not open.
        Effect.catch((error: ExternalOpenFailed) =>
          Effect.sync(() => reportBackgroundError(error)),
        ),
      ),
    );
  };
  const dispatchInstructionAction = (action: InstructionAction): void => {
    switch (action) {
      case INSTRUCTION_ACTION.SET_API_KEY:
        postDesktopSettingsView(post, 'models/keys');
        return;
      case INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE:
        openExternalInBackground(texraGuideUrl('configuration'));
        return;
      case INSTRUCTION_ACTION.OPEN_MODELS_DOC:
        openExternalInBackground(texraGuideUrl('models'));
        return;
    }
  };

  /**
   * Await a host dialog the caller has already started, reporting rather than
   * raising its failure: a dialog that could not be shown must not fail the
   * run behind it. The caller still awaits the dialog, as it did before.
   */
  const awaitOrReport = (
    started: Effect.Effect<void, NotificationFailed>,
  ): Effect.Effect<void> =>
    started.pipe(
      Effect.catchTag('NotificationFailed', (error) =>
        Effect.sync(() => reportBackgroundError(error)),
      ),
    );

  return {
    window,
    post,
    /** A session-protocol push: the session port's `send`. */
    postSession: bridge.postSession,
    dialogs,
    previewHost,
    /** `openExternal`, its failure the caller's to present. */
    openExternalUrl: previewHost.openExternal,
    presented,
    reportAsyncError,
    reported,
    reportBackgroundError,
    showDiscardDialog: () =>
      dialog.showMessageBoxSync(window, {
        type: 'warning',
        buttons: ['Keep Editing', 'Discard Changes'],
        defaultId: 0,
        cancelId: 0,
        title: 'Unsaved Changes',
        message: 'There are unsaved editor changes.',
        detail: 'Discard the changes and continue?',
      }),
    /** Tell the user a newer release exists. It opens the known-constant
     *  releases page rather than any network-provided URL, so an
     *  unauthenticated API response can never influence what
     *  `shell.openExternal` opens. */
    announceRelease: Effect.fn('announceRelease')(function* (release: {
      version: string;
    }): Effect.fn.Return<void, Error> {
      const { response } = yield* Effect.tryPromise({
        try: () =>
          dialog.showMessageBox(window, {
            type: 'info',
            message: `TeXRA ${release.version} is available (you have ${app.getVersion()}).`,
            buttons: ['Download', 'Later'],
            defaultId: 0,
            cancelId: 1,
          }),
        catch: ensureError,
      });
      if (response === 0)
        yield* Effect.tryPromise({
          try: () => shell.openExternal(DESKTOP_RELEASES_PAGE_URL),
          catch: ensureError,
        });
    }),
    /** The folder the user picked, or undefined when they cancelled. */
    pickFolder: (
      title: string,
      defaultPath: string,
      properties: Array<'openDirectory' | 'createDirectory'>,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const result = await dialog.showOpenDialog(window, {
            title,
            defaultPath,
            properties,
          });
          return result.canceled ? undefined : result.filePaths[0];
        },
        catch: ensureError,
      }),
    /** The files the user picked, or undefined when they cancelled. */
    openFileDialog: (dialogOptions: {
      title: string;
      defaultPath?: string;
      filters: Array<{ name: string; extensions: string[] }>;
      allowMultiple?: boolean;
    }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await dialog.showOpenDialog(window, {
            title: dialogOptions.title,
            defaultPath: dialogOptions.defaultPath,
            filters: dialogOptions.filters,
            properties: dialogOptions.allowMultiple
              ? ['openFile', 'multiSelections']
              : ['openFile'],
          });
          return result.canceled ? undefined : result.filePaths;
        },
        catch: ensureError,
      }),
    /**
     * What one project's runs present through: its dialogs name that project,
     * and its diff and build views are addressed by its own storage root,
     * because the window shows several open projects at once. A session's
     * requests present errors at their dispatcher, so the request-side hosts
     * are the ones that do not.
     */
    forProject(project: DesktopProject) {
      const { roots } = project;
      const name = project.display.name;
      const diff = diffHost.inProject(roots);
      const dialogsOfProject: Omit<
        DesktopAgentRunHost,
        'openBuildDisplay' | 'openDiff'
      > = {
        openPath: (filePath) => presented(previewHost.openPath(filePath)),
        confirmAcceptFile: (message) =>
          dialogs.confirmDialog({
            message,
            confirmLabel: 'Replace file',
            project: name,
          }),
        // Presentation failures are reported, never raised: a run must not
        // fail because a dialog could not be shown. The caller still awaits
        // the dialog, as it did before.
        showInfoMessage: (message) =>
          awaitOrReport(showInfoMessage(message, name)),
        showWarningMessage: (message) => showWarningMessage(message, name),
        showErrorMessage: (message) =>
          awaitOrReport(showErrorMessage(message, name)),
        showErrorDialog: (message, docsPage) =>
          awaitOrReport(dialogs.showErrorDialog(message, docsPage, name)),
        showInstructionDialog: (message, actions) =>
          awaitOrReport(dialogs.showInstructionDialog(message, actions, name)),
        pickTranscriptExportFormat: () =>
          dialogs.pickTranscriptExportFormat(name),
      };
      return {
        run: {
          ...dialogsOfProject,
          openDiff: diff.openDiff,
          openBuildDisplay: (location) =>
            presented(previewHost.openBuildDisplayIn(roots)(location)),
        } satisfies DesktopAgentRunHost,
        // The tool-edit preview presents its own failures.
        toolEditPreview: {
          openPath: previewHost.openPath,
          openBuildDisplay: previewHost.openBuildDisplayIn(roots),
          openDiff: diff.openDiff,
          closeDiff: diff.closeDiff,
        },
      };
    },
  };
}
