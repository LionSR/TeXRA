import { runWithWorkspaceRoots } from '@platform/workspaceRoots';

import type { SessionHandle } from './SessionHandle';

/**
 * Run host code in the scope of one session, so session-rooted services
 * (`workspaceRoots()`) resolve to that session outside any agent run.
 * A host holding several sessions in one process (the desktop, one per open
 * paper) wraps every touch of a session's storage.
 */
export function runInSession<T>(session: SessionHandle, fn: () => T): T {
  return runWithWorkspaceRoots(session.roots, fn);
}
