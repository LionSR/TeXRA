import { Effect } from 'effect';

// Local imports
import type { RunId } from '@shared/schemas';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import type { ChildRun } from '@tools/delegation/childRun';

export function createFakeAgentCliChildRun(childRunId: RunId): ChildRun {
  const logger = createTestRunTrace(childRunId).trace;
  return {
    childRunId,
    logger,
    track: () => undefined,
    finalize: () => Effect.void,
  };
}
