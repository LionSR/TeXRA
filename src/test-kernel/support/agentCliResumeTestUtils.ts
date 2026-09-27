import { Effect } from 'effect';

// Local imports
import type { ChildRunPort } from '@agent/runtime/childRunLoop';
import type { RunId } from '@shared/schemas';
import { createTestRunTrace } from '@test/support/sessionTestUtils';

export function createFakeAgentCliChildRun(childRunId: RunId): ChildRunPort {
  const logger = createTestRunTrace(childRunId).trace;
  return {
    logger,
    track: () => undefined,
    finalize: () => Effect.void,
  };
}
