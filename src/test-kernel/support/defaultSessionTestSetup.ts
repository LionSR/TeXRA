import '@test/support/sessionGraphTestSetup';

import { initializeDefaultSession } from '@agent/runtime/SessionHandle';

initializeDefaultSession({
  transcriptMode: { kind: 'ephemeral', reason: 'test process default session' },
});
