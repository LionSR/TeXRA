import '@test/support/sessionGraphTestSetup';

import { Effect, References } from 'effect';

import { SessionOwner } from '@agent/runtime/rootLaunch';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import { testSessionOwner } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

// An ephemeral session's graph builds synchronously, so the default is open
// before the importing suite's first test. The graph builds on the session
// map's own fiber, which `runSync` does not drive: past the scheduler's
// operation budget that fiber would yield, and the open would turn async.
Effect.runSync(
  openTestDefaultSession({
    roots: testWorkspaceRoots(),
    transcriptMode: { kind: 'ephemeral' },
  }).pipe(
    Effect.provideServiceEffect(SessionOwner, testSessionOwner),
    Effect.provideService(References.PreventSchedulerYield, true),
  ),
);
