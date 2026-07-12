import { StreamLogStore } from '@transcript/StreamLogStore';
import { initializeDefaultSession } from '@agent/runtime/SessionHandle';

initializeDefaultSession({
  transcripts: StreamLogStore.ephemeral('test process default session'),
});
