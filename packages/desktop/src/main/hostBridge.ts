import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

import { assertKnownOutboundMessage } from '@shared/utils/dispatcher';
import type { DownMessage } from '@shared/session/sessionFrames';

import { DesktopOutboundMessageSchema } from '../shared/desktopOutboundMessages.js';
import {
  ELECTRON_SESSION_MESSAGE_CHANNEL,
  ELECTRON_SESSION_PUSH_CHANNEL,
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '../shared/hostBridgeChannels.js';

interface DesktopHostBridgeOptions {
  /** A `desktop:*` or settings-view command from the renderer. */
  onCommand(message: unknown): void;
  /** An `UpMessage` from the renderer's session transport. */
  onSession(message: unknown): void;
}

export interface DesktopHostBridge {
  /** A `desktop:*` or settings-view command push. */
  postToRenderer(message: unknown): void;
  postSession(message: DownMessage): void;
  dispose(): void;
}

export function installDesktopHostBridge(
  window: BrowserWindow,
  options: DesktopHostBridgeOptions,
): DesktopHostBridge {
  let disposed = false;
  const listen = (channel: string, handle: (message: unknown) => void) => {
    const listener = (event: IpcMainEvent, message: unknown) => {
      if (event.sender === window.webContents) handle(message);
    };
    ipcMain.on(channel, listener);
    return () => ipcMain.off(channel, listener);
  };
  const stops = [
    listen(ELECTRON_WEBVIEW_MESSAGE_CHANNEL, options.onCommand),
    listen(ELECTRON_SESSION_MESSAGE_CHANNEL, options.onSession),
  ];

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const stop of stops) stop();
  };
  window.once('closed', dispose);
  const push = (channel: string, message: unknown) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, message);
  };
  return {
    postToRenderer: (message) => {
      // Dev/test-only shape check (no-op in prod, see
      // `assertKnownOutboundMessage`): the desktop-only `desktop:*` commands
      // (workspace file I/O, terminal, overlays, shell, logs, onboarding,
      // papers); the settings view's pushes pass through unchecked, as
      // before.
      assertKnownOutboundMessage([DesktopOutboundMessageSchema], message);
      push(ELECTRON_WEBVIEW_PUSH_CHANNEL, message);
    },
    // Typed `DownMessage`s the session bridge builds: nothing to check.
    postSession: (message) => push(ELECTRON_SESSION_PUSH_CHANNEL, message),
    dispose,
  };
}
