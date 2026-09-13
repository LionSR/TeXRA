import '@test/support/sessionGraphTestSetup';

import { Effect } from 'effect';

import { initializeDefaultSession } from '@agent/runtime/SessionHandle';

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
