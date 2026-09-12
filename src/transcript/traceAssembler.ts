/**
 * Assemble a static trace: the run aggregate's own display events, in commit
 * order, plus the run's persisted record for the caller's filename.
 *
 * Four facts are authored rather than copied, because an exported file has no
 * producer, no siblings and no writable host: `ownerId` is null on every row
 * (which is also PII removal — the owner id names the writing process), and
 * the creation row carries no parent, no checkpoint and no follow-up support
 * (a visible composer would be a dead control against a read-only bridge).
 */
import { Effect } from 'effect';
import type { RunRecord } from '@agent/core/definition/RunRecord';
import { readPersistedRunRecord } from '@agent/storage/runLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { redactDisplayValue } from '@logger/redaction';

import {
  isDisplaySessionEvent,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
} from '@shared/schemas';

import type { TraceDocument } from './traceDocumentSchema';

export type AssembleTraceResult =
  | {
      readonly status: 'ok';
      readonly trace: TraceDocument;
      readonly record: RunRecord;
    }
  | { readonly status: 'config_missing' | 'streamLogs_missing' };

/**
 * `streamLogs_missing` means no replayable run timeline is available: the
 * run's aggregate is empty or tombstoned.
 */
export const assembleTrace = Effect.fn('assembleTrace')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<AssembleTraceResult, Error> {
  const [record, events] = yield* Effect.all(
    [
      readPersistedRunRecord(runId, session),
      session.transcripts.readEvents(runId),
    ],
    { concurrency: 2 },
  );
  if (!record) return { status: 'config_missing' };
  if (events.length === 0) return { status: 'streamLogs_missing' };
  return {
    status: 'ok',
    record,
    trace: redactDisplayValue<TraceDocument>({
      runId,
      events: events.filter(isDisplaySessionEvent).map((event) =>
        event.type === 'run.start'
          ? {
              ...event,
              ownerId: null,
              parent: null,
              checkpointId: null,
              userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
            }
          : { ...event, ownerId: null },
      ),
    }),
  };
});
