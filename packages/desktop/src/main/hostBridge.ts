import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

import { MainViewMessageSchema } from '@shared/schemas/mainView';
import { ProgressViewOutboundMessageSchema } from '@shared/schemas/progressView';
import { assertKnownOutboundMessage } from '@shared/utils/dispatcher';

import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
  ELECTRON_WEBVIEW_STATE_GET_CHANNEL,
  ELECTRON_WEBVIEW_STATE_SET_CHANNEL,
} from '../shared/hostBridgeChannels.js';

interface DesktopWebviewStateStore {
  getState(): Record<string, unknown> | undefined;
  setState(state: unknown): void;
}

export interface DesktopHostBridgeOptions {
  onRendererMessage?: (message: unknown, window: BrowserWindow) => void;
  webviewState?: DesktopWebviewStateStore;
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
  const getState = (event: IpcMainEvent) => {
    if (event.sender !== window.webContents) return;
    event.returnValue = { ok: true, state: options.webviewState?.getState() };
  };
  const setState = (event: IpcMainEvent, state: unknown) => {
    if (event.sender !== window.webContents) return;
    if (!options.webviewState) {
      event.returnValue = { ok: false };
      return;
    }
    try {
      options.webviewState.setState(state);
      event.returnValue = { ok: true };
    } catch {
      event.returnValue = { ok: false };
    }
  };
  ipcMain.on(ELECTRON_WEBVIEW_MESSAGE_CHANNEL, listener);
  ipcMain.on(ELECTRON_WEBVIEW_STATE_GET_CHANNEL, getState);
  ipcMain.on(ELECTRON_WEBVIEW_STATE_SET_CHANNEL, setState);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.off(ELECTRON_WEBVIEW_MESSAGE_CHANNEL, listener);
    ipcMain.off(ELECTRON_WEBVIEW_STATE_GET_CHANNEL, getState);
    ipcMain.off(ELECTRON_WEBVIEW_STATE_SET_CHANNEL, setState);
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
      // today. A command belonging to neither passes through unchecked.
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
