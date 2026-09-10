import { Deferred, Effect } from 'effect';

import { presentFollowUpResult, submitFollowUp } from '@agent/followUp';
import type { SessionHandle } from '@agent/runtime';
import type { FollowUpQueueInput } from '@agent/followUp';
import { createLog } from '@logger/logUtils';
import {
  aggregateId as qualifyAggregateId,
  type RunId,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const logger = createLog('ProgressFollowUpSubmit');

export interface ProgressFollowUpSubmitArgs {
  readonly session: SessionHandle;
  readonly runId: RunId;
  readonly input: FollowUpQueueInput;
  /**
   * Admission ack for the composer that sent this. Fires exactly once, as
   * soon as admission is decided and before any recovery resume runs, so a
   * refused draft is handed back without waiting on a model turn.
   */
  readonly acknowledge: (accepted: boolean) => void;
  readonly showInfo: (message: string) => void | PromiseLike<unknown>;
}

/**
 * One follow-up submission path for the extension and desktop progress views:
 * admission, the composer ack, the queued-follow-ups refresh, and outcome
 * presentation. Hosts supply only their ports. A stream with no live flow in
 * this process refuses the draft with a worded reason.
 *
 * Resolves at admission with whether the draft was accepted. Anything after
 * admission (a recovery resume may run a whole model turn, then present its
 * outcome) runs detached so no IPC request or window close waits on it.
 */
export const submitProgressFollowUp = Effect.fn('submitProgressFollowUp')(
  function* (args: ProgressFollowUpSubmitArgs) {
    const { session, runId, input, showInfo } = args;
    const admission = yield* Deferred.make<boolean>();
    const acknowledge = (accepted: boolean): void => {
      if (Deferred.doneUnsafe(admission, Effect.succeed(accepted))) {
        args.acknowledge(accepted);
      }
    };
    const present = (message: string) =>
      Effect.tryPromise({
        try: async () => {
          await showInfo(message);
        },
        catch: ensureError,
      });
    const deliver = Effect.gen(function* () {
      const result = yield* submitFollowUp(runId, input, {
        session,
        onAdmitted: acknowledge,
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            acknowledge(false);
            const message = toErrorMessage(error);
            logger.warn(
              `Failed to submit follow-up for stream ${runId}: ${message}`,
              {
                data: { runId, error: message },
              },
            );
            yield* present(`Could not send the follow-up: ${message}`);
            return undefined;
          }),
        ),
      );
      if (!result) return;
      acknowledge(result.status !== 'failed');
      session.publish([
        {
          type: 'updateQueuedFollowUps',
          aggregateId: qualifyAggregateId('run', runId),
          messages: session.followUps.getAll(runId),
        },
      ]);
      const presentation = presentFollowUpResult(result);
      if (presentation.severity !== 'none')
        yield* present(presentation.message);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          acknowledge(false);
          logger.warn(
            `Follow-up presentation failed for stream ${runId}: ${String(cause)}`,
          );
        }),
      ),
    );
    yield* Effect.forkDetach(deliver);
    return yield* Deferred.await(admission);
  },
);
