/**
 * Inquiry continuation injector.
 *
 * Host-neutral. When the user submits an answer (or drops an open
 * inquiry), this module synthesizes the `[inquiry] …` continuation
 * text, hands it to `sendFollowUp` for the parent stream, and delegates
 * queued-stream wake/release policy to the follow-up owner so exited
 * cycles (WAITING / children_running) can pick the message up when the
 * parent stream is still resumable.
 *
 * Returns an `InjectionOutcome` so the caller (action handler) can
 * forward it to the UI via the `inquiryThreadUpdated` event.
 */

import { createChannelTrace } from '@agent/trace';
import {
  submitFollowUp,
  type SubmitFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
import {
  getRunContextSession,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type {
  ExternalInquiryThreadId,
  ExternalInquiryThreadSummary,
  InquiryThreadUpdatedEvent,
  InquiryResumeOutcome,
  StreamTabId,
} from '@shared/schemas';
import {
  formatRelativeTime,
  truncateSummary,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';

import {
  getThreadSummary,
  listThreadsByStatus,
  readExternalInquiryThread,
  type ExternalInquiryThreadManifest,
} from './externalInquiryStorage';

const logger = createChannelTrace('inquiryContinuation');

export type InjectionOutcome = 'sent' | 'queued' | 'resumed' | 'archived';

const QUESTION_TRUNCATION = 400;
const ANSWER_TRUNCATION = 2000;

function formatStillOpen(threads: ExternalInquiryThreadSummary[]): string[] {
  if (!threads.length) return [];
  const lines = ['', 'Still open on this stream:'];
  for (const t of threads) {
    const since = formatRelativeTime(Date.parse(t.lastActivityIso));
    lines.push(
      `  - ${t.threadId}  "${truncateWithEllipsis(t.lastQuestionPreview, 60)}"  (dispatched ${since})`,
    );
  }
  return lines;
}

export function buildContinuationText(params: {
  event: 'answered' | 'dropped';
  threadId: ExternalInquiryThreadId;
  question: string;
  answer?: string;
  stillOpen: ExternalInquiryThreadSummary[];
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

async function emitInquiryThreadUpdate(
  threadId: ExternalInquiryThreadId,
  extra: { resumeOutcome: InquiryResumeOutcome },
  session?: SessionHandle,
): Promise<void> {
  const summary = await getThreadSummary(threadId);
  if (!summary) return;
  const payload: InquiryThreadUpdatedEvent = { ...summary, ...extra };
  const owner = session ?? getRunContextSession(tryUseRunContext());
  (owner?.events ? owner : defaultSession()).events.emit({
    scope: 'session',
    event: { type: 'inquiryThreadUpdated', payload },
  });
}

function mapSubmissionToInquiryOutcome(
  result: SubmitFollowUpResult,
): InjectionOutcome {
  if (result.status === 'sent') return 'sent';
  if (result.status === 'dropped' || result.status === 'no_session') {
    return 'archived';
  }
  // Inquiry continuations carry no delivery id, so 'duplicate' is
  // unreachable; it maps to 'queued' (already admitted) by construction.
  if (result.status === 'duplicate') return 'queued';
  return result.continuation === 'resumed' ? 'resumed' : 'queued';
}

async function deliverContinuation(params: {
  parentStreamId: StreamTabId;
  text: string;
  threadId: ExternalInquiryThreadId;
  session?: SessionHandle;
}): Promise<InjectionOutcome> {
  const result = await submitFollowUp(params.parentStreamId, params.text, {
    session: params.session,
  });

  if (result.status === 'no_session') {
    logger.warn(
      `Inquiry continuation for ${params.threadId}: parent stream ${params.parentStreamId} has no session.`,
    );
    await emitInquiryThreadUpdate(
      params.threadId,
      { resumeOutcome: 'parent_finished' },
      params.session,
    );
    return 'archived';
  }

  const outcome = mapSubmissionToInquiryOutcome(result);

  await emitInquiryThreadUpdate(
    params.threadId,
    {
      resumeOutcome: outcome === 'archived' ? 'parent_finished' : outcome,
    },
    params.session,
  );
  return outcome;
}

/**
 * Shared body of the answered / dropped injectors: resolve the manifest,
 * archive when there is nothing to continue (missing thread, an `answered`
 * event whose last turn is no longer answered, or no parent stream), then
 * build and deliver the continuation.
 */
async function injectContinuation(
  event: 'answered' | 'dropped',
  threadId: ExternalInquiryThreadId,
  manifestHint?: ExternalInquiryThreadManifest,
  session?: SessionHandle,
): Promise<InjectionOutcome> {
  const manifest = manifestHint ?? (await readExternalInquiryThread(threadId));
  if (!manifest) return 'archived';

  const lastTurn = manifest.turns.at(-1);
  if (event === 'answered' && lastTurn?.kind !== 'answered') return 'archived';
  if (manifest.parentStreamId == null) {
    await emitInquiryThreadUpdate(
      threadId,
      {
        resumeOutcome: 'parent_finished',
      },
      session,
    );
    return 'archived';
  }

  const stillOpen = await listThreadsByStatus({
    status: 'open',
    scope: 'stream',
    streamId: manifest.parentStreamId,
  });
  const text = buildContinuationText({
    event,
    threadId,
    question: lastTurn?.question ?? '',
    answer:
      event === 'answered' && lastTurn?.kind === 'answered'
        ? lastTurn.answer
        : undefined,
    stillOpen,
  });

  return deliverContinuation({
    parentStreamId: manifest.parentStreamId,
    text,
    threadId,
    session,
  });
}

export function injectContinuationForAnsweredThread(
  threadId: ExternalInquiryThreadId,
  /**
   * Manifest snapshot from the writer (action handler) — pass it to
   * avoid a re-read race: a concurrent follow-up `ask` from another
   * stream could flip `answered → open` between the write and the
   * re-read, which would otherwise drop the continuation as archived.
   */
  manifestHint?: ExternalInquiryThreadManifest,
  session?: SessionHandle,
): Promise<InjectionOutcome> {
  return injectContinuation('answered', threadId, manifestHint, session);
}

export function injectContinuationForDroppedThread(
  threadId: ExternalInquiryThreadId,
  /**
   * Manifest snapshot from `markDropped` — same race-avoidance pattern
   * as the answered path: a concurrent follow-up `ask` on the same
   * thread from another stream could flip status away from `dropped`
   * before a fresh read, which would mislabel the continuation.
   */
  manifestHint?: ExternalInquiryThreadManifest,
  session?: SessionHandle,
): Promise<InjectionOutcome> {
  return injectContinuation('dropped', threadId, manifestHint, session);
}
