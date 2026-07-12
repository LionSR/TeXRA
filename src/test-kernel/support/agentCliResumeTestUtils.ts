// Local imports - transcript
import { createRunTrace, StreamLogStore } from '@transcript';

// Type imports
import type { StreamTabId } from '@shared/schemas';
import type { ChildStream } from '@tools/childStream';

export function createFakeAgentCliChildStream(
  childStreamId: StreamTabId,
): ChildStream {
  const logger = createRunTrace(
    childStreamId,
    StreamLogStore.ephemeral('test'),
  ).trace;
  return {
    childStreamId,
    logger,
    waitForInput: () => {},
    beginTurn: () => {},
    failTurn: () => {},
    finalize: async () => {},
  };
}
