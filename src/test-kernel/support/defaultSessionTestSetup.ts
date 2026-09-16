import '@test/support/sessionGraphTestSetup';

import { Effect } from 'effect';

import {
  initializeDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';

// An ephemeral session's graph builds synchronously, so the process default
// is open before the importing suite's first test.
Effect.runSync(
  initializeDefaultSession({
    transcriptMode: {
      kind: 'ephemeral',
      reason: 'test process default session',
    },
  }),
);

/**
 * The process-default session this setup installed — or the one a suite
 * reinstalled through `initializeDefaultSession` after a teardown, since the
 * read goes through the owner on each call. Replaces the deleted production
 * `defaultSession()` accessor at test call sites; access with no default
 * installed is a lifecycle error, as it was there.
 */
export function testDefaultSession(): SessionHandle {
  const session = tryDefaultSession();
  if (!session) {
    throw new Error(
      'The default session has not been initialized. Import @test/support/defaultSessionTestSetup or call initializeDefaultSession() first.',
    );
  }
  return session;
}
