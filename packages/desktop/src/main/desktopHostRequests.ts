// The desktop's half of a project's window (`openGuiWindow`): every
// capability a surface asks its host for, mapped onto the window's dialogs,
// the preview host, the file pickers, and the project's launch path, plus
// the requests the desktop answers its own way. Each request is answered
// exactly once with an outcome or a request error; one the desktop does not
// perform is `Rejected` with its reason, never dropped.

import { Effect } from 'effect';
import { Rejected } from '@texra-ai/worldline/schemas';
import type { HostFailed } from '@texra/hosts/uiHosts';

import {
  hostFailed,
  hostFailure,
  openLink,
} from '@texra/controllers/session/hostCallFailure';
import type { OpenFilesDialog } from '@texra/controllers/session/launcherFilePicker';
import type {
  GuiWindowHost,
  OwnHostHandlers,
  SharedHostCommandBindings,
} from '@texra/controllers/session/openGuiWindow';

import {
  DESKTOP_DOCS_URL,
  postDesktopSettingsView,
} from '../shared/desktopCommandSurface.js';
import type { DesktopPush } from '../shared/desktopOutboundMessages.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';

interface DesktopHostRequestsOptions {
  host: DesktopAgentRunHost;
  openFiles: OpenFilesDialog;
  postToRenderer(message: DesktopPush): void;
  /** The window's settings surface, absent while the window switches
   *  projects; the onboarding card's sign-in goes through it. */
  settings(): DesktopSettingsIpc | undefined;
  openExternalUrl(url: string): Effect.Effect<void, HostFailed>;
}

/** The desktop's half of a project's window, for the window's scope. */
export const createDesktopHostRequests = (
  options: DesktopHostRequestsOptions,
) =>
  Effect.sync(() => {
    const { host } = options;
    /** Each notice answers with the program that presents it; the session
     *  forks it and warn-logs its failure. */
    const notices: GuiWindowHost['notices'] = {
      ...host.notices,
      // Desktop has no editor integration to preview through, so the
      // resolved path goes to the preview-with-fallback host directly.
      openFile: (data) => host.openPath(data.location.absolutePath),
    };

    /** This window's half of the shared body's binding table: every verb
     *  mapped onto the window's dialogs, its preview host, its settings
     *  view, and the project's launch path. */
    const bindings: SharedHostCommandBindings = {
      openPath: (file, line) => host.openPath(file, line),
      openFiles: options.openFiles,
      latexdiff: {
        // Each diff opens in the PDF tab through the build display, as a
        // run's outputs do.
        openDiffs: (diffPaths) =>
          Effect.forEach(
            diffPaths,
            (absolutePath) =>
              host.openBuildDisplay({ kind: 'external', absolutePath }),
            { discard: true },
          ).pipe(
            Effect.mapError((cause) =>
              hostFailure('host.openBuildDisplay', cause),
            ),
          ),
        // The window has no progress chrome for a diff run.
        withProgress: (_title, task) => task({ report: () => undefined }),
      },
      openSettings: (target) =>
        Effect.sync(() =>
          postDesktopSettingsView(options.postToRenderer, target),
        ),
      // Only the "ask the user for a key" step is host-specific: on the
      // desktop that means opening the Models tab rather than a modal
      // prompt.
      setApiKey: () =>
        Effect.sync(() =>
          postDesktopSettingsView(options.postToRenderer, 'models/keys'),
        ),
      openExternal: (url) => options.openExternalUrl(url),
      onboarding: {
        signInChatGpt: Effect.suspend(() => {
          const settings = options.settings();
          return settings
            ? settings
                .signInSubscription('chatgpt')
                .pipe(
                  Effect.mapError((cause) =>
                    hostFailure('settings.signInSubscription', cause),
                  ),
                )
            : Effect.fail(
                new Rejected({
                  reason: 'No project shows its settings yet; try again.',
                }),
              );
        }),
        // The desktop has no walkthrough of its own: the card's "Open
        // walkthrough" opens the desktop docs, as the other links open.
        openGettingStarted: Effect.suspend(() =>
          openLink(options.openExternalUrl, DESKTOP_DOCS_URL),
        ),
      },
    };

    /** The requests a host performs its own way: the desktop has none (no
     *  pop-out, no editor current file, no getting-started walkthrough), so
     *  the shared router refuses each. */
    const own: OwnHostHandlers = {};

    return {
      bindings,
      own,
      notices,
      window: {},
      notify: host.notify,
      runs: {
        // Desktop has no editor integration to preview through, so the
        // output goes to the preview-with-fallback host directly.
        openFinalOutput: (absolutePath: string) => host.openPath(absolutePath),
        // The progress surface is always on screen in the desktop window.
        revealProgress: () => Effect.void,
        showRunView: () => Effect.void,
      },
      files: {
        openDiff: (baseFile: string, editedFile: string, title: string) =>
          host
            .openDiff(
              { filePath: baseFile },
              { filePath: editedFile },
              {
                title,
                // Each compared pair is a review of its own.
                displayPath: `${editedFile} <-> ${baseFile}`,
              },
            )
            .pipe(Effect.mapError((cause) => hostFailed('openDiff', cause))),
        confirm: host.confirm,
        openDirectory: (directory: string) => host.openPath(directory),
      },
      export: {
        pickFormat: host.pickTranscriptExportFormat(),
        // The window has already shown the failure (the run host's
        // `openPath` is `presented`); its `HostFailed` carries the wording
        // out unchanged.
        openPath: (filePath: string) => host.openPath(filePath),
      },
    };
  });
