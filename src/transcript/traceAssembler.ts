/**
 * Assemble a static trace: the run aggregate's own display events, in commit
 * order, plus the run's persisted record for the caller's filename.
 *
 * Four facts are authored rather than copied, because an exported file has no
 * producer, no siblings and no writable host: `ownerId` is null on every row
 * (which is also PII removal — the owner id names the writing process), and
 * the creation row carries no parent, no checkpoint and no follow-up support
 * (a visible composer would be a dead control against a read-only bridge).
 *
 * A fifth is redacted: a decided request keeps its action and loses what the
 * user typed or approved (see `decisionAction`).
 */
import { Effect } from 'effect';
import type { RunRecord } from '@agent/core/definition/RunRecord';
import { readPersistedRunRecord } from '@agent/storage/runLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { redactDisplayValue } from '@logger/redaction';

import {
  isDisplaySessionEvent,
  USER_FOLLOW_UP_SUPPORT,
  type RequestDecision,
  type RunId,
} from '@shared/schemas';

import type { TraceDocument } from './traceDocumentSchema';

/**
 * A decision's action, without what the user typed or approved. The fold reads
 * a `request.decided` row for its id alone — it closes the pending request and
 * renders nothing from the decision — while the payload can hold a whole
 * edited document (`approve.content`), an inquiry answer and its session
 * links, question answers, or free-text feedback. An exported trace is a file
 * people share, so it carries the action and drops the content.
 */
const decisionAction = (decision: RequestDecision): RequestDecision => {
  switch (decision.action) {
    case 'approve':
      return {
        action: 'approve',
        model: decision.model,
        agent: decision.agent,
      };
    case 'submit':
      return { action: 'submit', answers: {} };
    case 'answer':
      return { action: 'answer', answer: '' };
    case 'skip':
      return { action: 'skip' };
    case 'retry':
      return { action: 'retry', credentials: decision.credentials };
    case 'reject':
      return { action: 'reject' };
    default:
      // `approve_and_goal`, `setup`, `deny` and `cancel` carry no user text:
      // their fields are the policy's own reason or cause.
      return decision;
  }
};

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
  // The display rows are what the document carries, so the emptiness guard
  // belongs after the filter: a tombstoned aggregate and one holding only
  // ledger-private rows are both "no replayable timeline", and readers may
  // then treat a non-empty document as having a creation row.
  const displayEvents = events.filter(isDisplaySessionEvent);
  if (displayEvents.length === 0) return { status: 'streamLogs_missing' };
  return {
    status: 'ok',
    record,
    trace: redactDisplayValue<TraceDocument>({
      runId,
      events: displayEvents.map((event) => {
        if (event.type === 'run.start')
          return {
            ...event,
            ownerId: null,
            parent: null,
            checkpointId: null,
            userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
          };
        if (event.type === 'request.decided')
          return {
            ...event,
            ownerId: null,
            decision: decisionAction(event.decision),
          };
        return { ...event, ownerId: null };
      }),
    }),
  };
});
