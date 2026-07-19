// Local imports - transcript
import type { StreamTabId } from '@shared/schemas';
import type { ChildStream } from '@tools/childStream';
import { createRunTrace, StreamLogStore } from '@transcript';

// Type imports

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
