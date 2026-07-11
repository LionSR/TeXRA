// Local imports - transcript
import { createRunTrace, StreamLogStore } from '@transcript';

// Type imports
import type { StreamTabId } from '@shared/schemas';
import type { ChildStream } from '@tools/childStream';

export function createFakeAgentCliChildStream(
  childStreamId: StreamTabId,
): ChildStream {
  const logger = createRunTrace(childStreamId, new StreamLogStore()).trace;
  return {
    childStreamId,
    logger,
    waitForInput: () => {},
    beginTurn: () => {},
    failTurn: () => {},
    finalize: async () => {},
  };
}
