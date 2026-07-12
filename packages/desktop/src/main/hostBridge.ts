import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '../hostBridgeChannels.js';
import { assertDesktopOutboundMessage } from './desktopIpcTypes.js';

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
      assertDesktopOutboundMessage(message);
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(ELECTRON_WEBVIEW_PUSH_CHANNEL, message);
    },
    dispose,
  };
}
