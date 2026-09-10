import { Effect } from 'effect';

// Local imports
import type { StreamTabId } from '@shared/schemas';
import { RunLog } from '@shared/session/traceEntries';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import type { ChildRun } from '@tools/delegation/childStream';

export function createFakeAgentCliChildStream(
  childStreamId: StreamTabId,
): ChildRun {
  const logger = createTestRunTrace(childStreamId, new RunLog()).trace;
  return {
    childStreamId,
    logger,
    waitForInput: () => {},
    beginTurn: () => {},
    failTurn: () => {},
    finalize: () => Effect.void,
  };
}
