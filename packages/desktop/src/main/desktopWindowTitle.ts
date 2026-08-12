import { basename } from 'node:path';
import { type BrowserWindow } from 'electron';
import type { SessionHandle } from '@agent/runtime';
import { STREAM_PHASE } from '@shared/schemas';
import {
  formatSessionTitle,
  type SessionTitleState,
} from '@shared/sessionTitle';

type DesktopTitleSession = Pick<
  SessionHandle,
  'events' | 'executions' | 'interactions' | 'status'
>;

type DesktopTitleWindow = Pick<
  BrowserWindow,
  'getTitle' | 'isDestroyed' | 'setTitle' | 'webContents'
>;

/** Derive aggregate activity from canonical process-session owners. */
export function getDesktopSessionActivity(
  session: DesktopTitleSession,
): SessionTitleState {
  if (session.interactions.pendingCount > 0) return 'approval';
  const hasRunningAgent = session.executions.getAgentHandles().some(
    (handle) =>
      // Deliberately exact: provisional/restored and WAITING-like phases
      // must not project a running native title.
      session.status.get(handle.childStreamId) === STREAM_PHASE.RUNNING,
  );
  return hasRunningAgent ? 'running' : 'idle';
}

/** Compute the current title synchronously, including before a window opens. */
export function getDesktopWindowTitle(
  session: DesktopTitleSession,
  workspacePath: string | undefined,
): string {
  const workspaceName = workspacePath ? basename(workspacePath) : undefined;
  return formatSessionTitle(workspaceName, getDesktopSessionActivity(session));
}

/**
 * Keep one BrowserWindow title synchronized with its process session.
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
  const disposeRegistrations =
    session.executions.addRegistrationListener(update);
  const disposeStatus = session.events.subscribeStatus(update);
  const disposePending = session.interactions.onPendingCountChange(update);
  update();

  return () => {
    if (disposed) return;
    disposed = true;
    disposePending();
    disposeStatus();
    disposeRegistrations();
    // Check the window before touching `.webContents`: the property getter
    // itself throws "Object has been destroyed" once the window is gone, so
    // reaching for `webContents.isDestroyed()` was already too late. This
    // disposer runs from the window's own `closed` handler, which is exactly
    // that case — the listener dies with the web contents anyway.
    if (window.isDestroyed()) return;
    if (!window.webContents.isDestroyed()) {
      window.webContents.removeListener(
        'page-title-updated',
        preventRendererTitle,
      );
    }
  };
}
