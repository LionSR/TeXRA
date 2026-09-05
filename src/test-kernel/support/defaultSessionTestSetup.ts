import '@test/support/sessionGraphTestSetup';

import { initializeDefaultSession } from '@agent/runtime/SessionHandle';
import { StreamLogStore } from '@transcript/StreamLogStore';

initializeDefaultSession({
  transcripts: StreamLogStore.ephemeral('test process default session'),
});
