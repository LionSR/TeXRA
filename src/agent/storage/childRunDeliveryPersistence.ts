/** Commit the report and result together before acknowledging child delivery. */
import { Cause, Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  type ResultMeta,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

export function persistChildRunDelivery(
  session: SessionHandle,
  runId: RunId,
  message: string,
  resultMeta: ResultMeta | undefined,
): Effect.Effect<void, Error> {
  const target = aggregateId('run', runId);
  const events: SessionEventDraft[] = [
    { type: 'run.report', aggregateId: target, report: message },
  ];
  if (resultMeta !== undefined)
    events.push({
      type: 'run.result',
      aggregateId: target,
      result: resultMeta,
    });
  return session.commit(events).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
  );
}
