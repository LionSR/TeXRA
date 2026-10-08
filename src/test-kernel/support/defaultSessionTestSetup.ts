import '@test/support/sessionGraphTestSetup';

import { Effect, References } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  openTestDefaultSession,
  tryTestDefaultSession,
} from '@test/support/sessionEnd';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

// An ephemeral session's graph builds synchronously, so the default is open
// before the importing suite's first test. The graph builds on the session
// map's own fiber, which `runSync` does not drive: past the scheduler's
// operation budget that fiber would yield, and the open would turn async.
Effect.runSync(
  openTestDefaultSession({
    roots: testWorkspaceRoots(),
    transcriptMode: {
      kind: 'ephemeral',
      reason: 'test process default session',
    },
  }).pipe(Effect.provideService(References.PreventSchedulerYield, true)),
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
