// Main-process IPC for the workspace shell surfaces: terminal pty sessions
// and embedded browser tabs. Both are renderer-driven, and the sandboxed
// renderer has no node integration, so every request lands here, validated
// against its schema at the boundary. The editor pane's file I/O is the app's
// `workspaceFile` request (`workspaceFileRequest.ts`), answered by the
// window's shared request body; this file only tells the renderer when a
// write lands in its tree.

import { Effect } from 'effect';

import type { HostFailed } from '@texra/hosts/uiHosts';

import {
  DESKTOP_WORKSPACE_COMMANDS,
  type DesktopBrowserBounds,
  type DesktopWorkspaceInboundMessage,
  type DesktopWorkspaceReply,
} from '../shared/desktopWorkspaceMessages.js';
import type { ProcessServices } from '@texra-ai/harness/host';
import type { DesktopPtyHost } from './desktopPtyHost.js';
import type { DesktopBrowserViews } from './desktopBrowserViews.js';

interface DesktopWorkspaceIpcOptions {
  ptyHost: DesktopPtyHost;
  browserViews: DesktopBrowserViews;
  /**
   * Translates renderer-reported CSS pixel bounds into window coordinates.
   * A WebContentsView is positioned in device-independent window space, which
   * differs from the renderer's own coordinates under display zoom.
   */
  toWindowBounds(bounds: DesktopBrowserBounds): DesktopBrowserBounds;
}

interface DesktopWorkspaceIpc {
  /** The program one parsed renderer request runs. */
  handle(
    message: DesktopWorkspaceInboundMessage,
  ): Effect.Effect<void, Error, ProcessServices>;

  /**
   * Releases resources owned by the current renderer document.
   *
   * Renderer reload creates a new terminal-id namespace and a new browser-tab
   * layout, so neither resource may survive across that boundary.
   */
  disposeRendererResources(): void;

  /**
   * Tells the renderer to re-list its file tree. The project's binding runs
   * it on each write TeXRA makes inside the project (the host snapshot's
   * `filesWritten`): accepted outputs and diffs write straight to disk, past
   * the editor's own write path, and the tree caches its listing with no
   * watcher behind it.
   */
  readonly filesChanged: Effect.Effect<void>;
}

export function createDesktopWorkspaceIpc(
  post: (message: DesktopWorkspaceReply) => void,
  options: DesktopWorkspaceIpcOptions,
): DesktopWorkspaceIpc {
  const filesChanged = Effect.sync(() =>
    post({ command: DESKTOP_WORKSPACE_COMMANDS.FILES_CHANGED }),
  );

  function startTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    initialCommand?: string,
  ) {
    return Effect.gen(function* () {
      const session = yield* options.ptyHost.create({
        id: sessionId,
        cols,
        rows,
      });
      if (!session) return;
      if (initialCommand) {
        session.write(`${initialCommand}\r`);
      }
    }).pipe(
      // The handler's parameter is the whole error type this expression can
      // carry, so a second failure added here fails to compile rather than
      // being reported as a terminal that would not start.
      // Surface in the terminal itself: a silent no-op looks like a shell
      // that never printed a prompt. The failure goes on with its cause, so
      // the window's router reports it and the request never ends in silence.
      Effect.tapError((error: HostFailed) =>
        Effect.sync(() =>
          post({
            command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_ERROR,
            sessionId,
            // The pty host's `HostFailed` is already its cause in its own
            // words.
            message: `Could not start a terminal: ${error.message}`,
          }),
        ),
      ),
    );
  }

  return {
    disposeRendererResources() {
      options.ptyHost.disposeAll();
      options.browserViews.disposeAll();
    },

    filesChanged,

    handle(data) {
      switch (data.command) {
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START:
          return startTerminal(
            data.sessionId,
            data.cols,
            data.rows,
            data.initialCommand,
          );
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT:
          return Effect.sync(() => {
            options.ptyHost.get(data.sessionId)?.write(data.data);
          });
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE:
          return Effect.sync(() => {
            options.ptyHost.get(data.sessionId)?.resize(data.cols, data.rows);
          });
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE:
          return Effect.sync(() => {
            options.ptyHost.get(data.sessionId)?.dispose();
          });

        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_OPEN:
          return Effect.sync(() => {
            options.browserViews.open(data.tabId, data.url);
          });
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS:
          return Effect.sync(() => {
            options.browserViews.show(
              data.tabId,
              options.toWindowBounds(data.bounds),
            );
          });
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE:
          return Effect.sync(() => {
            options.browserViews.hideAll();
          });
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE:
          return Effect.sync(() => {
            options.browserViews.close(data.tabId);
          });
      }
    },
  };
}
