/** Commit the report and result together before acknowledging child delivery. */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type {
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
import {
  aggregateId,
  type ResultMeta,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
export function persistChildRunDelivery(
  session: SessionHandle,
  runId: RunId,
  message: string,
  resultMeta: ResultMeta | undefined,
): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> {
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
  return session.commit(events).pipe(Effect.asVoid);
}
