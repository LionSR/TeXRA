import { Effect } from 'effect';

// Local imports
import type { StreamTabId } from '@shared/schemas';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import type { ChildStream } from '@tools/delegation/childStream';
import { StreamLogStore } from '@transcript';

export function createFakeAgentCliChildStream(
  childStreamId: StreamTabId,
): ChildStream {
  const logger = createTestRunTrace(
    childStreamId,
    StreamLogStore.ephemeral('test'),
  ).trace;
  return {
    childStreamId,
    logger,
    waitForInput: () => {},
    beginTurn: () => {},
    failTurn: () => {},
    finalize: () => Effect.void,
  };
}
