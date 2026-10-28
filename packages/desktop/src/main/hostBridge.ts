import { Effect, type Scope } from 'effect';
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

import type { DownMessage } from '@texra/shared/session/sessionFrames';
import { assertKnownOutboundMessage } from '@texra/shared/utils/dispatcher';

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
}

/** The bridge listens until the caller's scope (the window's) closes. */
export const installDesktopHostBridge = Effect.fnUntraced(function* (
  window: BrowserWindow,
  options: DesktopHostBridgeOptions,
): Effect.fn.Return<DesktopHostBridge, never, Scope.Scope> {
  const listen = (channel: string, handle: (message: unknown) => void) => {
    const listener = (event: IpcMainEvent, message: unknown) => {
      if (event.sender === window.webContents) handle(message);
    };
    return Effect.acquireRelease(
      Effect.sync(() => ipcMain.on(channel, listener)),
      () => Effect.sync(() => ipcMain.off(channel, listener)),
    );
  };
  yield* listen(ELECTRON_WEBVIEW_MESSAGE_CHANNEL, options.onCommand);
  yield* listen(ELECTRON_SESSION_MESSAGE_CHANNEL, options.onSession);
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
  };
});
