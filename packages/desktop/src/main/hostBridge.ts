import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

import {
  CommonViewMessageSchema,
  MainViewMessageSchema,
  ProgressViewOutboundMessageSchema,
} from '@shared/schemas';
import { assertKnownOutboundMessage } from '@shared/utils/dispatcher';

import { DesktopOutboundMessageSchema } from '../shared/desktopOutboundMessages.js';
import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '../shared/hostBridgeChannels.js';

export interface DesktopHostBridgeOptions {
  onRendererMessage?: (message: unknown, window: BrowserWindow) => void;
}

export interface DesktopHostBridge {
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
      // in `assertKnownOutboundMessage`). Desktop multiplexes
      // `MainViewMessage`s, `ProgressViewOutboundMessage`s, common host
      // pushes (theme / debug-mode / state-restore), and desktop-only
      // `desktop:*` commands (workspace file I/O, terminal, overlays,
      // shell, logs, onboarding) onto this one renderer-push channel.
      // `DesktopOutboundMessageSchema` composes the per-surface desktop
      // schemas, so those are shape-checked too; a command no listed
      // schema claims (settings-domain pushes) still passes through
      // unchecked.
      assertKnownOutboundMessage(
        [
          MainViewMessageSchema,
          ProgressViewOutboundMessageSchema,
          CommonViewMessageSchema,
          DesktopOutboundMessageSchema,
        ],
        message,
      );
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(ELECTRON_WEBVIEW_PUSH_CHANNEL, message);
    },
    dispose,
  };
}
