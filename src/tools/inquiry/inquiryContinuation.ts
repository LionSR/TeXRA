import { Effect } from 'effect';
/**
 * Inquiry continuation injector.
 *
 * Host-neutral. When the user submits an answer (or drops an open
 * inquiry), this module synthesizes the `[inquiry] …` continuation
 * text, hands it to `submitFollowUp` for the parent stream, and delegates
 * queued-stream wake/release policy to the follow-up owner so exited
 * cycles (WAITING / children_running) can pick the message up when the
 * parent stream is still resumable.
 *
 * Returns an `InjectionOutcome` so the caller (action handler) can
 * forward it to the UI via the `inquiryThreadUpdated` event.
 */

import {
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import {
  type InquiryThreadRecord,
  aggregateId as qualifyAggregateId,
  type InquiryThreadId,
  type InquiryThreadSummary,
  type InquiryThreadUpdatedEvent,
  type InquiryResumeOutcome,
  type RunId,
} from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import {
  formatRelativeTime,
  previewLabel,
  truncateSummary,
} from '@utils/text/stringUtils';

const logger = createLog('inquiryContinuation');

export type InjectionOutcome = 'sent' | 'queued' | 'archived';

const QUESTION_TRUNCATION = 400;
const ANSWER_TRUNCATION = 2000;

function formatStillOpen(threads: InquiryThreadSummary[]): string[] {
  if (!threads.length) return [];
  const lines = ['', 'Still open on this stream:'];
  for (const t of threads) {
    const since = formatRelativeTime(Date.parse(t.lastActivityIso));
    lines.push(
      `  - ${t.threadId}  "${previewLabel(t.lastQuestionPreview)}"  (dispatched ${since})`,
    );
  }
  return lines;
}

export function buildContinuationText(params: {
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
      lines.push('', 'No other open inquiries on this stream.');
    }
    lines.push(
      '',
      stillOpen.length
        ? 'Proceed using the new answer. Do not re-dispatch any open thread_id.'
        : 'Proceed using the new answer.',
    );
    return lines.join('\n');
  }

  // dropped
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

const emitInquiryThreadUpdate = Effect.fn('emitInquiryThreadUpdate')(function* (
  threadId: InquiryThreadId,
  extra: { resumeOutcome: InquiryResumeOutcome },
  session: SessionHandle,
): Effect.fn.Return<void, Error, InquiryRecords> {
  const records = yield* InquiryRecords;
  const summary = yield* records.getThreadSummary(threadId);
  if (!summary) return;
  const payload: InquiryThreadUpdatedEvent = { ...summary, ...extra };
  session.publish([
    {
      type: 'inquiryThreadUpdated',
      aggregateId: qualifyAggregateId('inquiry', payload.threadId),
      ...payload,
    },
  ]);
});

/** Archive a thread that has nothing to continue: emit the summary update. */
const archiveAsParentFinished = Effect.fn('archiveAsParentFinished')(function* (
  threadId: InquiryThreadId,
  session: SessionHandle,
): Effect.fn.Return<InjectionOutcome, Error, InquiryRecords> {
  yield* emitInquiryThreadUpdate(
    threadId,
    { resumeOutcome: 'parent_finished' },
    session,
  );
  return 'archived';
});

const deliverContinuation = Effect.fn('deliverContinuation')(
  function* (params: {
    parentRunId: RunId;
    text: string;
    threadId: InquiryThreadId;
    session: SessionHandle;
  }): Effect.fn.Return<InjectionOutcome, Error, InquiryRecords> {
    const result = yield* submitFollowUp(params.parentRunId, params.text, {
      session: params.session,
    });

    // A queued continuation whose wake failed is still queued; an explicit
    // Resume delivers it. A refusal has nothing left to continue.
    if (result.status === 'failed') {
      logger.warn(
        `Inquiry continuation for ${params.threadId}: parent stream ${params.parentRunId} refused it (${result.reason}).`,
      );
      return yield* archiveAsParentFinished(params.threadId, params.session);
    }

    yield* emitInquiryThreadUpdate(
      params.threadId,
      { resumeOutcome: result.status },
      params.session,
    );
    return result.status;
  },
);

/**
 * Shared body of the answered / dropped injectors: resolve the manifest,
 * archive when there is nothing to continue (missing thread, a turn-less
 * manifest, an `answered` event whose last turn is no longer answered, no
 * parent run), then build and deliver the continuation.
 */
const injectContinuation = Effect.fn('injectContinuation')(function* (
  event: 'answered' | 'dropped',
  threadId: InquiryThreadId,
  manifestHint: InquiryThreadRecord | undefined,
  session: SessionHandle,
): Effect.fn.Return<InjectionOutcome, Error, InquiryRecords> {
  const records = yield* InquiryRecords;
  const manifest =
    manifestHint ?? (yield* records.readExternalInquiryThread(threadId));
  if (!manifest) return 'archived';

  const lastTurn = manifest.turns.at(-1);
  if (!lastTurn) {
    // Structural guard: the manifest schema does not require turns, so a
    // turn-less thread is representable, and there is nothing to continue.
    logger.warn(
      `Inquiry continuation for ${threadId}: manifest has no turns; archiving.`,
    );
    return yield* archiveAsParentFinished(threadId, session);
  }
  if (event === 'answered' && lastTurn.kind !== 'answered') return 'archived';
  if (manifest.parentRunId == null) {
    return yield* archiveAsParentFinished(threadId, session);
  }

  const parentRunId = manifest.parentRunId;
  const stillOpen = yield* records.listThreadsByStatus({
    status: 'open',
    scope: 'stream',
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

  return yield* deliverContinuation({
    parentRunId: manifest.parentRunId,
    text,
    threadId,
    session,
  });
});

export function injectContinuationForAnsweredThread(
  threadId: InquiryThreadId,
  /**
   * Manifest snapshot from the writer (action handler) — pass it to
   * avoid a re-read race: a concurrent follow-up `ask` from another
   * stream could flip `answered → open` between the write and the
   * re-read, which would otherwise drop the continuation as archived.
   */
  manifestHint: InquiryThreadRecord | undefined,
  session: SessionHandle,
): Effect.Effect<InjectionOutcome, Error, InquiryRecords> {
  return injectContinuation('answered', threadId, manifestHint, session);
}

export function injectContinuationForDroppedThread(
  threadId: InquiryThreadId,
  /**
   * Manifest snapshot from `markDropped` — same race-avoidance pattern
   * as the answered path: a concurrent follow-up `ask` on the same
   * thread from another stream could flip status away from `dropped`
   * before a fresh read, which would mislabel the continuation.
   */
  manifestHint: InquiryThreadRecord | undefined,
  session: SessionHandle,
): Effect.Effect<InjectionOutcome, Error, InquiryRecords> {
  return injectContinuation('dropped', threadId, manifestHint, session);
}
