import { Effect } from 'effect';

// Local imports
import type { RunId } from '@shared/schemas';
import { StreamLog } from '@shared/session/traceEntries';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import type { ChildRun } from '@tools/delegation/childRun';

export function createFakeAgentCliChildRun(childRunId: RunId): ChildRun {
  const logger = createTestRunTrace(childRunId, new StreamLog()).trace;
  return {
    childRunId,
    logger,
    finalize: () => Effect.void,
  };
}
