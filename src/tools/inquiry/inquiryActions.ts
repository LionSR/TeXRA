import { Effect } from 'effect';
/**
 * The inquiry's side of a `request.decided` (one run model, 3.7): an inquiry
 * is a request whose thread names its predecessor, so it rides the one
 * request protocol; what stays here is what is specific to the kind. The
 * answer is recorded on the thread's cross-project record (the record stays,
 * cross-project scope is a real difference) and, because an inquiry never
 * parks its run, delivered to that run as a `[inquiry]` follow-up: "a
 * `request.decided` for a request its run is not parked on is delivered as
 * a follow-up".
 */

// Local imports - agent
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';

// Local imports - shared
import {
  aggregateId as qualifyAggregateId,
  type ExternalInquiryPermission,
  type InquiryResumeOutcome,
  type InquiryThreadId,
  type InquiryThreadRecord,
  type InquiryThreadSummary,
  type InquiryThreadUpdatedEvent,
  type RequestDecision,
  type RunId,
} from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import {
  formatRelativeTime,
  previewLabel,
  truncateSummary,
} from '@utils/text/stringUtils';

const logger = createLog('InquiryTool');

const QUESTION_TRUNCATION = 400;
const ANSWER_TRUNCATION = 2000;

function formatStillOpen(threads: InquiryThreadSummary[]): string[] {
  if (!threads.length) return [];
  const lines = ['', 'Still open on this run:'];
  for (const t of threads) {
    const since = formatRelativeTime(Date.parse(t.lastActivityIso));
    lines.push(
      `  - ${t.threadId}  "${previewLabel(t.lastQuestionPreview)}"  (dispatched ${since})`,
    );
  }
  return lines;
}

/** The `[inquiry]` follow-up the agent reads: the answer, or the drop. */
function buildContinuationText(params: {
  event: 'answered' | 'dropped';
  threadId: InquiryThreadId;
  question: string;
  answer?: string;
  stillOpen: InquiryThreadSummary[];
}): string {
  const { event, threadId, question, answer, stillOpen } = params;
  const lines: string[] = [];

  if (event === 'answered') {
    lines.push(`[inquiry] ${threadId} answered.`);
    lines.push(`Q: ${truncateSummary(question, QUESTION_TRUNCATION)}`);
    if (answer !== undefined) {
      lines.push(
        `A: ${truncateSummary(answer, ANSWER_TRUNCATION)}` +
          (answer.length > ANSWER_TRUNCATION
            ? ` (full text available in thread ${threadId})`
            : ''),
      );
    }
    lines.push(`Full thread: ${threadId}`);
    lines.push(...formatStillOpen(stillOpen));
    if (stillOpen.length === 0) {
      lines.push('', 'No other open inquiries on this run.');
    }
    lines.push(
      '',
      stillOpen.length
        ? 'Proceed using the new answer. Do not re-dispatch any open thread_id.'
        : 'Proceed using the new answer.',
    );
    return lines.join('\n');
  }

  lines.push(`[inquiry] ${threadId} dropped by user.`);
  lines.push(`Q: ${truncateSummary(question, QUESTION_TRUNCATION)}`);
  lines.push(`Full thread: ${threadId}`);
  lines.push(...formatStillOpen(stillOpen));
  lines.push(
    '',
    'Proceed without this answer: either re-formulate (new thread) or take an ' +
      `alternate approach. Do not re-dispatch ${threadId}.`,
  );
  return lines.join('\n');
}

/** The Background Tasks panel's row for the thread, with how the run took it. */
const publishThreadUpdate = Effect.fn('publishInquiryThreadUpdate')(function* (
  threadId: InquiryThreadId,
  resumeOutcome: InquiryResumeOutcome,
  session: SessionHandle,
): Effect.fn.Return<void, Error, InquiryRecords> {
  const records = yield* InquiryRecords;
  const summary = yield* records.getThreadSummary(threadId);
  if (!summary) return;
  const payload: InquiryThreadUpdatedEvent = { ...summary, resumeOutcome };
  session.publish([
    {
      type: 'inquiryThreadUpdated',
      aggregateId: qualifyAggregateId('inquiry', payload.threadId),
      ...payload,
    },
  ]);
});

/**
 * The record of a turn an earlier attempt at this same decision already
 * closed, or null when the turn was closed by something else (a follow-up
 * reopened the thread and closed a later turn, a decision for a turn already
 * superseded). Read only when the write found no open turn; the answer the
 * continuation carries is on the closed turn itself, so nothing else has to
 * be kept to re-deliver it.
 */
const closedByEarlierAttempt = Effect.fn('inquiryClosedByEarlierAttempt')(
  function* (
    threadId: InquiryThreadId,
    turnIndex: number,
  ): Effect.fn.Return<InquiryThreadRecord | null, Error, InquiryRecords> {
    const records = yield* InquiryRecords;
    const manifest = yield* records.readExternalInquiryThread(threadId);
    if (!manifest || manifest.status === 'open') return null;
    return manifest.turns.at(-1)?.turnIndex === turnIndex ? manifest : null;
  },
);

/**
 * Record one inquiry decision on its thread and deliver the continuation to
 * the run that asked. The run either drains it at its next turn boundary or
 * resumes from the fold (`submitFollowUp` owns that choice); a run that
 * refuses it has nothing left to continue and the thread is archived as
 * such. A decision for a turn no longer open (a duplicate, a decision after a
 * follow-up reopened the thread) records nothing and delivers nothing.
 *
 * The one exception is the turn this decision itself closed on an earlier
 * attempt that then failed before its continuation reached the run: the
 * thread carries the answer and the request is still pending (the caller
 * decides only pending requests), so the continuation is delivered from the
 * record rather than reported as already done. Delivery is keyed on the turn,
 * so an attempt that failed after the queue admitted it re-delivers nothing.
 */
export const recordInquiryDecision = Effect.fn('recordInquiryDecision')(
  function* (
    permission: ExternalInquiryPermission,
    decision: RequestDecision,
    session: SessionHandle,
  ): Effect.fn.Return<void, Error, InquiryRecords> {
    const records = yield* InquiryRecords;
    const { threadId } = permission;
    const turnIndex = permission.transcript?.at(-1)?.turnIndex ?? 1;
    let manifest: InquiryThreadRecord | null;
    let event: 'answered' | 'dropped';
    if (decision.action === 'answer') {
      manifest = yield* records.recordAnswerForOpenTurn({
        threadId,
        turnIndex,
        answer: decision.answer,
        sessionLinks: decision.sessionLinks ?? undefined,
      });
      event = 'answered';
    } else {
      logger.info(`Inquiry ${threadId} dropped (${decision.action})`);
      manifest = yield* records.markDropped({ threadId, turnIndex });
      event = 'dropped';
    }
    if (!manifest) {
      const closed = yield* closedByEarlierAttempt(threadId, turnIndex);
      if (!closed) {
        logger.warn(
          `Inquiry ${event === 'answered' ? 'answer' : 'drop'} ignored: thread ${threadId} has no open turn ${turnIndex}.`,
        );
        return;
      }
      // What the thread says is what the run is told: the earlier attempt's
      // record is the decision that stands, whatever this attempt asked for.
      manifest = closed;
      event = closed.status === 'answered' ? 'answered' : 'dropped';
      logger.info(
        `Inquiry ${threadId}: re-delivering the ${event} continuation for turn ${turnIndex}, recorded by an attempt that never delivered it.`,
      );
    }
    const lastTurn = manifest.turns.at(-1);
    const parentRunId: RunId | null | undefined = manifest.parentRunId;
    if (!lastTurn || parentRunId == null) {
      yield* publishThreadUpdate(threadId, 'parent_finished', session);
      return;
    }
    const stillOpen = yield* records.listThreadsByStatus({
      status: 'open',
      scope: 'run',
      runId: parentRunId,
    });
    const text = buildContinuationText({
      event,
      threadId,
      question: lastTurn.question,
      answer:
        event === 'answered' && lastTurn.kind === 'answered'
          ? lastTurn.answer
          : undefined,
      stillOpen,
    });
    // Keyed on the turn: the queue admits one continuation per inquiry turn,
    // so re-delivering after a failure the queue never saw reaches the run
    // and re-delivering after one it did is a no-op.
    const result = yield* submitFollowUp(
      parentRunId,
      { text, deliveryId: `inquiry:${threadId}:${lastTurn.turnIndex}` },
      { session },
    );
    if (result.status === 'failed') {
      logger.warn(
        `Inquiry continuation for ${threadId}: run ${parentRunId} refused it (${result.reason}).`,
      );
      yield* publishThreadUpdate(threadId, 'parent_finished', session);
      return;
    }
    yield* publishThreadUpdate(threadId, result.status, session);
  },
);
