import '@test/support/sessionGraphTestSetup';

import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  openTestDefaultSession,
  tryTestDefaultSession,
} from '@test/support/sessionEnd';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

// An ephemeral session's graph builds synchronously, so the default is open
// before the importing suite's first test.
Effect.runSync(
  openTestDefaultSession({
    roots: testWorkspaceRoots(),
    transcriptMode: {
      kind: 'ephemeral',
      reason: 'test process default session',
    },
  }),
);

/**
 * The file's default session this setup opened, or the one a suite reopened
 * through `openTestDefaultSession`. Access with none open is a lifecycle
 * error.
 */
export function testDefaultSession(): SessionHandle {
  const session = tryTestDefaultSession();
  if (!session) {
    throw new Error(
      'The default session is not open. Import @test/support/defaultSessionTestSetup or call openTestDefaultSession() first.',
    );
  }
  return session;
}
