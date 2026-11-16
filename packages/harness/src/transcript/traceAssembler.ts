/**
 * Assemble a static trace: the run aggregate's own display events, in commit
 * order, plus the run's persisted record for the caller's filename.
 *
 * The creation row loses its parent and its follow-up support, because an
 * exported file has no siblings and no writable host (a visible composer
 * would be a dead control against a read-only bridge), and a decided request
 * keeps its action but loses what the user typed or approved (see
 * `decisionAction`).
 */
import { Effect, absurd } from 'effect';
import { getRunRecords } from '@agent/storage/runOwnership';

import {
  isDisplayRow,
  type RequestDecision,
  type RunId,
} from '@shared/schemas';
import { SessionLog } from '@shared/session/runHistory';
import { isRequestDecision } from '@shared/session/runRowReads';

import type { AssembleTraceResult } from './traceDocumentSchema';

/**
 * A decision's action, without what the user typed or approved. The fold reads
 * a `request.decided` row for its id alone — it closes the pending request and
 * renders nothing from the decision — while the payload can hold a whole
 * edited document (`approve.content`), a written answer and its session
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
    // These carry no user text: their fields are the policy's own reason
    // or cause. A new action is redacted here before it can export.
    case 'approve_and_goal':
    case 'deny':
    case 'cancel':
      return decision;
    default:
      return absurd(decision);
  }
};

export const assembleTrace = Effect.fn('assembleTrace')(function* (
  runId: RunId,
): Effect.fn.Return<AssembleTraceResult, Error, SessionLog> {
  const log = yield* SessionLog;
  const [record, events] = yield* Effect.all(
    [getRunRecords(runId).readRunRecord(), log.display(runId)],
    { concurrency: 2 },
  );
  if (!record) return { status: 'no_record' };
  // The display rows are what the document carries, so the emptiness guard
  // belongs after the filter: a deleted aggregate and one holding only
  // run-history-private rows are both "no replayable timeline", and readers may
  // then treat a non-empty document as having a creation row.
  const displayEvents = events.filter(isDisplayRow);
  if (displayEvents.length === 0) return { status: 'no_rows' };
  return {
    status: 'ok',
    record,
    trace: {
      runId,
      events: displayEvents.map((event) => {
        if (event.type === 'run.start')
          return { ...event, parent: null, takesFollowUps: false };
        if (isRequestDecision(event))
          return { ...event, decision: decisionAction(event.decision) };
        return event;
      }),
    },
  };
});
