import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

import { assertKnownOutboundMessage } from '@shared/utils/dispatcher';

import { DesktopOutboundMessageSchema } from '../shared/desktopOutboundMessages.js';
import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '../shared/hostBridgeChannels.js';

/** The session protocol's messages are keyed by `kind`; every other push
 *  on the channel by `command`. */
function isSessionMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'kind' in message &&
    !('command' in message)
  );
}

interface DesktopHostBridgeOptions {
  onRendererMessage?: (message: unknown, window: BrowserWindow) => void;
}

interface DesktopHostBridge {
  postToRenderer(message: unknown): void;
  dispose(): void;
}

export function installDesktopHostBridge(
  window: BrowserWindow,
  options: DesktopHostBridgeOptions = {},
): DesktopHostBridge {
  let disposed = false;
  const listener = (event: IpcMainEvent, message: unknown) => {
    if (event.sender !== window.webContents) return;
    options.onRendererMessage?.(message, window);
  };
  ipcMain.on(ELECTRON_WEBVIEW_MESSAGE_CHANNEL, listener);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.off(ELECTRON_WEBVIEW_MESSAGE_CHANNEL, listener);
  };
  window.once('closed', dispose);
  return {
    postToRenderer: (message) => {
      // Dev/test-only shape check (no-op in prod, see `isDevAssertionMode`
      // in `assertKnownOutboundMessage`). Desktop multiplexes the session
      // protocol's three down messages (frames, responses, surface
      // actions; PRD 8), which the session bridge builds as typed
      // `DownMessage`s, and the desktop-only `desktop:*` commands
      // (workspace file I/O, terminal, overlays, shell, logs, onboarding,
      // papers) onto this one renderer-push channel; the settings view's
      // pushes pass through unchecked, as before.
      if (!isSessionMessage(message)) {
        assertKnownOutboundMessage([DesktopOutboundMessageSchema], message);
      }
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(ELECTRON_WEBVIEW_PUSH_CHANNEL, message);
    },
    dispose,
  };
}
