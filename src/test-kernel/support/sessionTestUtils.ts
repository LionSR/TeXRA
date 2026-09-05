import '@test/support/sessionGraphTestSetup';

import { openSession } from '@agent/runtime/sessionGraph';
import {
  forEachLiveSession,
  type SessionHandle,
  type SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import { processWorkspaceRoots } from '@platform/workspaceRoots';
import { StreamLogStore } from '@transcript';

type TestSessionInit = Omit<SessionHandleInit, 'transcripts'> & {
  readonly transcripts?: StreamLogStore;
};

let opened = 0;

/**
 * Open an isolated session with an explicitly ephemeral transcript. A
 * session is one per workspace storage root (the `Sessions` owner returns
 * the session already open on a root), so each call names its own storage
 * root under the process roots, as a desktop paper would: two test sessions
 * never share a graph, and neither shares the process default session's.
 */
export function createTestSession(init: TestSessionInit = {}): SessionHandle {
  const process = processWorkspaceRoots();
  opened += 1;
  return openSession({
    ...init,
    roots: init.roots ?? {
      workspace: process.workspace,
      storage: `${process.storage}/test-sessions/${opened}`,
      config: process.config,
      workspaceState: process.workspaceState,
    },
    transcripts:
      init.transcripts ?? StreamLogStore.ephemeral('isolated test session'),
  });
}

/**
 * Open a fresh session over the process roots, for a file that installs no
 * default session and seeds or reads the process storage outside the
 * session's scope. One root holds one session, so a session still open
 * there (a previous test's, left undisposed) is released first: the caller
 * gets a session of its own, over the store it supplies.
 */
export function createProcessSession(
  init: TestSessionInit = {},
): SessionHandle {
  const roots = processWorkspaceRoots();
  forEachLiveSession((live) => {
    if (live.roots.storage === roots.storage) live.dispose();
  });
  return openSession({
    ...init,
    roots,
    transcripts:
      init.transcripts ?? StreamLogStore.ephemeral('process test session'),
  });
}
