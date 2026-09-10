/** Commit the report and result together before acknowledging child delivery. */
import { Cause, Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  type ExecutionId,
  type SessionEventDraft,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import type { ResultMeta } from './resultMeta';

export function persistChildRunDelivery(
  session: SessionHandle,
  executionId: ExecutionId,
  message: string,
  resultMeta: ResultMeta | undefined,
): Effect.Effect<void, Error> {
  const target = aggregateId('run', executionId);
  const events: SessionEventDraft[] = [
    { type: 'execution.report', aggregateId: target, report: message },
  ];
  if (resultMeta !== undefined)
    events.push({
      type: 'execution.result',
      aggregateId: target,
      result: resultMeta,
    });
  return session.commit(events).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
  );
}
