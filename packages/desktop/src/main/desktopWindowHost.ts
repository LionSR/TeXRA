// How one window presents things: its dialogs, its preview and diff hosts,
// its browser hand-offs and its error reports. Built once per window; the
// project bindings, the settings surface and the shell all present through it
// rather than each reaching for Electron's `dialog` and `shell`.

import { app, dialog, shell, type BrowserWindow } from 'electron';
import { Cause, Effect } from 'effect';

import { ExternalOpenFailed, type NotificationFailed } from '@hosts/uiHosts';
import type { ProcessRuntime } from '@platform/processRuntime';
import { INSTRUCTION_ACTION, type InstructionAction } from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { postDesktopSettingsView } from '../shared/desktopCommandSurface.js';
import { createDesktopDialogs } from './desktopDialogs.js';
import { createDesktopDiffHost } from './desktopDiffHost.js';
import { createDesktopPreviewHost } from './desktopPreviewHost.js';
import { DESKTOP_RELEASES_PAGE_URL } from './desktopUpdateChecker.js';
import type { DesktopProject } from './desktopProjects.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';
import type { DesktopAgentRunOptions } from './desktopAgentRun.js';
import type { DesktopSpawn } from './desktopWindows.js';

export type DesktopWindowHost = ReturnType<typeof createDesktopWindowHost>;

export function createDesktopWindowHost(options: {
  window: BrowserWindow;
  runtime: ProcessRuntime;
  spawn: DesktopSpawn;
}) {
  const { window, runtime, spawn } = options;

  // The renderer's push channel, connected once the window's routes exist.
  // Until then, and once the window or its page is gone, `post` reports that
  // nothing was delivered so a caller falls back to its external viewer
  // instead of reporting a success that reached nobody.
  let renderer: { postToRenderer(message: unknown): void } | undefined;
  const post = (message: unknown): boolean => {
    if (!renderer || window.isDestroyed() || window.webContents.isDestroyed()) {
      return false;
    }
    renderer.postToRenderer(message);
    return true;
  };

  const dialogs = createDesktopDialogs(window, {
    openGuide: (docsCommand) =>
      openExternalInBackground(`https://texra.ai/guide/${docsCommand}`),
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

  const previewOptions = {
    shell,
    runtime,
    // The in-app PDF overlay is preferred when the renderer is available.
    postToRenderer: post,
  };
  const previewHost = createDesktopPreviewHost({
    ...previewOptions,
    showErrorMessage,
  });
  // Session requests present errors at their dispatcher. Menu, navigation,
  // and runtime preview callers retain the reporting host above.
  const requestPreviewHost = createDesktopPreviewHost(previewOptions);
  // Returning `false` when the IPC bridge is not yet wired (startup race) or
  // the BrowserWindow has been destroyed falls a diff back to the
  // external-editor flow, so diffs never silently disappear.
  const diffHost = createDesktopDiffHost({
    runtime,
    openPath: previewHost.openPath,
    postToRenderer: post,
  });
  const requestDiffHost = createDesktopDiffHost({
    runtime,
    openPath: requestPreviewHost.openPath,
    postToRenderer: post,
  });

  /**
   * The shell-facing `openExternal` worded for the ExternalOpener port: the
   * member is already a program, so this only names the failure.
   * `reportFailure: false` leaves the window's own "could not open" dialog
   * out, for a caller that reports the failure itself.
   */
  const openExternalProgram = (
    url: string,
    reportFailure: boolean,
  ): Effect.Effect<void, ExternalOpenFailed> =>
    previewHost.openExternal(url, { reportFailure }).pipe(
      Effect.catchTag('PreviewUnavailable', (cause) =>
        Effect.fail(
          new ExternalOpenFailed({
            kind: 'url',
            target: url,
            message: `The desktop could not open ${url} in the default browser: ${cause.message}`,
            cause,
          }),
        ),
      ),
    );
  /**
   * Open a documentation URL without keeping the caller waiting; the browser
   * never opening is reported, not swallowed. Its own wording, not
   * {@link openExternalProgram}'s: this report names the documentation URL
   * rather than the address the shell refused.
   */
  const openExternalInBackground = (url: string): void => {
    spawn(
      previewHost.openExternal(url).pipe(
        Effect.mapError(
          (cause) =>
            new ExternalOpenFailed({
              kind: 'url',
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
        openExternalInBackground('https://texra.ai/guide/configuration.html');
        return;
      case INSTRUCTION_ACTION.OPEN_MODELS_DOC:
        openExternalInBackground('https://texra.ai/guide/models.html');
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
    /** Connect the renderer's push channel. */
    connectRenderer(next: { postToRenderer(message: unknown): void }) {
      renderer = next;
    },
    dialogs,
    previewHost,
    /** The request-side `openExternal`: its failure is the caller's. */
    openExternalUrl: requestPreviewHost.openExternal,
    reportAsyncError,
    reported,
    reportBackgroundError,
    openExternalProgram,
    openExternalInBackground,
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
    announceRelease: async (release: { version: string }) => {
      const { response } = await dialog.showMessageBox(window, {
        type: 'info',
        message: `TeXRA ${release.version} is available (you have ${app.getVersion()}).`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) await shell.openExternal(DESKTOP_RELEASES_PAGE_URL);
    },
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
    openFileDialog: async (dialogOptions: {
      title: string;
      defaultPath?: string;
      filters: Array<{ name: string; extensions: string[] }>;
      allowMultiple?: boolean;
    }) => {
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
    /**
     * What one project's runs present through: its dialogs name that project,
     * and its diff and build views are addressed by its own storage root,
     * because the window shows several open projects at once. A session's
     * requests present errors at their dispatcher, so the request-side hosts
     * are the ones that do not.
     */
    forProject(project: DesktopProject) {
      const { roots } = project.session;
      const name = project.display.name;
      const diff = diffHost.inProject(roots);
      const requestDiff = requestDiffHost.inProject(roots);
      const dialogsOfProject: Omit<
        DesktopAgentRunHost,
        'openBuildDisplay' | 'openDiff'
      > = {
        openPath: previewHost.openPath,
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
        showErrorDialog: (message, docsCommand) =>
          awaitOrReport(dialogs.showErrorDialog(message, docsCommand, name)),
        showInstructionDialog: (message, actions) =>
          awaitOrReport(dialogs.showInstructionDialog(message, actions, name)),
        pickTranscriptExportFormat: () =>
          dialogs.pickTranscriptExportFormat(name),
      };
      return {
        run: {
          ...dialogsOfProject,
          openDiff: diff.openDiff,
          openBuildDisplay: previewHost.openBuildDisplayIn(roots),
        } satisfies DesktopAgentRunOptions['host'],
        toolEditPreview: {
          openPath: requestPreviewHost.openPath,
          openBuildDisplay: requestPreviewHost.openBuildDisplayIn(roots),
          openDiff: requestDiff.openDiff,
          closeDiff: requestDiff.closeDiff,
        },
        request: {
          ...dialogsOfProject,
          openPath: requestPreviewHost.openPath,
          openBuildDisplay: requestPreviewHost.openBuildDisplayIn(roots),
          openDiff: requestDiff.openDiff,
        },
      };
    },
  };
}
