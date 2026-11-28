// The desktop's half of a project's window (`openGuiWindow`): every
// capability a surface asks its host for, mapped onto the window's dialogs,
// the preview host, the file pickers, its settings view, and the project's
// launch path. It has no editor, no pop-out and no getting-started commands,
// so the shared body refuses those requests and shows no getting-started
// card.

import { Effect } from 'effect';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@texra-ai/worldline/host';
import { Rejected } from '@texra-ai/worldline/schemas';
import type { HostFailed } from '@texra/hosts/uiHosts';

import {
  hostFailure,
  openLink,
} from '@texra/controllers/session/hostCallFailure';
import type { OpenFilesDialog } from '@texra/controllers/session/launcherFilePicker';
import type { GuiWindowHost } from '@texra/controllers/session/openGuiWindow';

import {
  DESKTOP_DOCS_URL,
  postDesktopSettingsView,
} from '../shared/desktopCommandSurface.js';
import type { DesktopPush } from '../shared/desktopOutboundMessages.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';

interface DesktopHostRequestsOptions {
  host: DesktopAgentRunHost;
  runtime: ProcessRuntime;
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
): GuiWindowHost => {
  const { host } = options;
  return {
    notify: host.notify,
    ask: host.ask,
    openPath: (file, line) => host.openPath(file, line),
    openFiles: options.openFiles,
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
                reason: 'Settings are still loading. Try again in a moment.',
              }),
            );
      }),
      // The desktop has no walkthrough of its own: the card's "Open
      // walkthrough" opens the desktop docs, as the other links open.
      openGettingStarted: Effect.suspend(() =>
        openLink(options.openExternalUrl, DESKTOP_DOCS_URL),
      ),
    },
    // A TeX file is built into the PDF tab and any other file goes to the
    // OS. The build takes this window's file services from the runtime's
    // context, which the session that forks it does not carry.
    openFile: (data) =>
      withProcessServices(
        options.runtime,
        host.openBuildDisplay(data.location),
      ),
    window: {},
    runs: {
      // The progress surface is always on screen in the desktop window.
      revealProgress: () => Effect.void,
      showRunView: () => Effect.void,
    },
    openDirectory: (directory: string) => host.openPath(directory),
    export: {
      pickFormat: host.pickTranscriptExportFormat(),
      // The window has already shown the failure (the run host's
      // `openPath` is `presented`); its `HostFailed` carries the wording
      // out unchanged.
      openPath: (filePath: string) => host.openPath(filePath),
    },
  };
};
