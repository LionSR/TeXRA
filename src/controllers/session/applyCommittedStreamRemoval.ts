import { Effect } from 'effect';

import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import type { StreamTabId } from '@shared/schemas';
import { releaseStreamResources } from '@tools/approval';
import { GoalStore } from '@tools/goal';
import { ensureError } from '@utils/errors/errorMessage';

const log = createLog('StreamRemoval');

/** Apply a committed deletion to local state and remove its goal record. */
export const applyCommittedStreamRemoval = Effect.fn(
  'applyCommittedStreamRemoval',
)(function* (session: SessionHandle, stream: StreamTabId) {
  session.executions.detachChildren(stream);
  session.status.clearStream(stream);
  session.interactions.discardStream(stream);
  releaseStreamResources(stream, session);
  yield* Effect.tryPromise({
    try: async () =>
      runInSession(session, () => GoalStore.removeRecords([stream])),
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        log.warn(
          'The stream was removed, but its goal record could not be cleared.',
          { data: error },
        );
      }),
    ),
  );
});
