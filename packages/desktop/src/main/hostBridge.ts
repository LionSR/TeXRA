import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

import { MainViewMessageSchema } from '@shared/schemas/mainView';
import { ProgressViewOutboundMessageSchema } from '@shared/schemas/progressView';
import { assertKnownOutboundMessage } from '@shared/utils/dispatcher';

import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '../hostBridgeChannels.js';

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
      // `MainViewMessage`s, `ProgressViewOutboundMessage`s, and
      // desktop-only overlay/settings commands (`desktop:showPdf`,
      // git-author settings, history, ...) onto this one renderer-push
      // channel; only the first two domains have an outbound Zod schema
      // today — a command belonging to neither passes through unchecked.
      assertKnownOutboundMessage(
        [MainViewMessageSchema, ProgressViewOutboundMessageSchema],
        message,
      );
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(ELECTRON_WEBVIEW_PUSH_CHANNEL, message);
    },
    dispose,
  };
}
