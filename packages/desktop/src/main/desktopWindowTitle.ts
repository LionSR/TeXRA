import { basename } from 'node:path';
import { type BrowserWindow } from 'electron';
import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';
import type { SessionHandle } from '@agent/runtime';
import { effectRuntime } from '@platform/processRuntime';
import {
  formatSessionTitle,
  NATIVE_WINDOW_TITLE,
  type SessionTitleState,
} from '@shared/sessionTitle';
import type { SessionView } from '@shared/session/sessionView';

type DesktopTitleSession = Pick<SessionHandle, 'view'>;

type DesktopTitleWindow = Pick<
  BrowserWindow,
  'getTitle' | 'isDestroyed' | 'setTitle' | 'webContents'
>;

/** The paper-level activity, read from the fold's rollup and nothing else:
 *  a decision waiting on the user outranks a run in progress. */
function sessionActivity(view: SessionView): SessionTitleState {
  if (view.rollup.waiting > 0) return 'approval';
  return view.rollup.running > 0 ? 'running' : 'idle';
}

/** Compute the current title synchronously, including before a window opens. */
export function getDesktopWindowTitle(
  session: DesktopTitleSession,
  workspacePath: string | undefined,
): string {
  const workspaceName = workspacePath ? basename(workspacePath) : undefined;
  return formatSessionTitle(
    workspaceName,
    sessionActivity(SubscriptionRef.getUnsafe(session.view)),
    { style: NATIVE_WINDOW_TITLE },
  );
}

/**
 * Keep one BrowserWindow title synchronized with its session's view.
 * Renderer page titles are presentation content and cannot replace this
 * host-owned projection.
 */
export function installDesktopWindowTitle(
  window: DesktopTitleWindow,
  session: DesktopTitleSession,
  workspacePath: string | undefined,
): () => void {
  let currentTitle = window.getTitle();
  let disposed = false;
  const update = (): void => {
    if (disposed || window.isDestroyed()) return;
    const title = getDesktopWindowTitle(session, workspacePath);
    if (title === currentTitle) return;
    currentTitle = title;
    window.setTitle(title);
  };
  const preventRendererTitle = (event: { preventDefault(): void }): void => {
    event.preventDefault();
  };

  window.webContents.on('page-title-updated', preventRendererTitle);
  const views = effectRuntime().runFork(
    Stream.runForEach(SubscriptionRef.changes(session.view), () =>
      Effect.sync(update),
    ),
  );
  update();

  return () => {
    if (disposed) return;
    disposed = true;
    effectRuntime().runFork(Fiber.interrupt(views));
    // Check the window before touching `.webContents`: the property getter
    // itself throws "Object has been destroyed" once the window is gone, so
    // reaching for `webContents.isDestroyed()` was already too late. This
    // disposer runs from the window's own `closed` handler, which is exactly
    // that case: the listener dies with the web contents anyway.
    if (window.isDestroyed()) return;
    if (!window.webContents.isDestroyed()) {
      window.webContents.removeListener(
        'page-title-updated',
        preventRendererTitle,
      );
    }
  };
}
