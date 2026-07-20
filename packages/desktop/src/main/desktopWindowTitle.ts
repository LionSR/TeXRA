import { basename } from 'node:path';

// Local imports
import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { STREAM_PHASE } from '@shared/schemas';

// Third-party type imports
import type { BrowserWindow } from 'electron';

export type DesktopSessionActivity = 'approval' | 'running' | 'idle';

type DesktopTitleSession = Pick<
  SessionHandle,
  'executions' | 'interactions' | 'status'
>;

type DesktopTitleWindow = Pick<
  BrowserWindow,
  'getTitle' | 'setTitle' | 'webContents'
>;

/** Derive aggregate activity from canonical process-session owners. */
export function getDesktopSessionActivity(session: {
  readonly executions: Pick<ExecutionRegistry, 'getAgentHandles'>;
  readonly interactions: Pick<SessionHostInteractions, 'pendingCount'>;
  readonly status: Pick<StreamStatusMachine, 'get'>;
}): DesktopSessionActivity {
  if (session.interactions.pendingCount > 0) return 'approval';
  const hasRunningAgent = session.executions
    .getAgentHandles()
    .some(
      (handle) =>
        session.status.get(handle.childStreamId) === STREAM_PHASE.RUNNING,
    );
  return hasRunningAgent ? 'running' : 'idle';
}

/** Format the exact native title copy for one process session. */
export function formatDesktopWindowTitle(
  activity: DesktopSessionActivity,
  workspaceName?: string,
): string {
  let activitySegment: string | undefined;
  if (activity === 'approval') activitySegment = 'Approval needed';
  if (activity === 'running') activitySegment = 'Running';
  return ['TeXRA', activitySegment, workspaceName || undefined]
    .filter((segment): segment is string => segment !== undefined)
    .join(' — ');
}

/** Compute the current title synchronously, including before a window opens. */
export function getDesktopWindowTitle(
  session: DesktopTitleSession,
  workspacePath: string | undefined,
): string {
  const workspaceName = workspacePath ? basename(workspacePath) : undefined;
  return formatDesktopWindowTitle(
    getDesktopSessionActivity(session),
    workspaceName,
  );
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
    if (disposed) return;
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
  const disposeStatus = session.status.onDidChange(update);
  const disposePending = session.interactions.onPendingCountChange(update);
  update();

  return () => {
    if (disposed) return;
    disposed = true;
    disposePending();
    disposeStatus();
    disposeRegistrations();
    window.webContents.removeListener(
      'page-title-updated',
      preventRendererTitle,
    );
  };
}
