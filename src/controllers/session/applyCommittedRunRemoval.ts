import { Effect } from 'effect';

import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import type { RunId } from '@shared/schemas';
import { releaseRunResources } from '@tools/approval';
import { GoalStore } from '@tools/goal';
import { ensureError } from '@utils/errors/errorMessage';

const log = createLog('RunRemoval');

/** Apply a committed deletion to local state and remove its goal record. */
export const applyCommittedRunRemoval = Effect.fn('applyCommittedRunRemoval')(
  function* (session: SessionHandle, stream: RunId) {
    session.runs.detachChildren(stream);
    releaseRunResources(stream, session);
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
  },
);
