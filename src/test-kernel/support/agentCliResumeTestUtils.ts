import { Effect } from 'effect';

// Local imports
import type { StreamTabId } from '@shared/schemas';
import { StreamLog } from '@shared/session/traceEntries';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import type { ChildStream } from '@tools/delegation/childStream';

export function createFakeAgentCliChildStream(
  childStreamId: StreamTabId,
): ChildStream {
  const logger = createTestRunTrace(childStreamId, new StreamLog()).trace;
  return {
    childStreamId,
    logger,
    waitForInput: () => {},
    beginTurn: () => {},
    failTurn: () => {},
    finalize: () => Effect.void,
  };
}
