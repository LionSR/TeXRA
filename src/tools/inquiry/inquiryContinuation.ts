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
  sendFollowUp,
  wakeQueuedFollowUpStream,
  type FollowUpWakeResult,
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
import { formatRelativeTime } from '@shared/utils/string';
import { truncateSummary, truncateWithEllipsis } from '@utils/text/stringUtils';

import {
  getThreadSummary,
  listOpenThreadsForStream,
  readExternalInquiryThread,
  type ExternalInquiryThreadManifest,
} from './externalInquiryStorage';

const logger = createChannelTrace('inquiryContinuation');

export type InjectionOutcome = 'sent' | 'queued' | 'resumed' | 'archived';

const QUESTION_TRUNCATION = 400;
const ANSWER_TRUNCATION = 2000;

function inquiryThreadUpdateSession(session?: SessionHandle): SessionHandle {
  const owner = session ?? getRunContextSession(tryUseRunContext());
  return owner?.events ? owner : defaultSession();
}

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
    'Proceed without this answer — either re-formulate (new thread) or take an ' +
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
  inquiryThreadUpdateSession(session).events.emit({
    scope: 'session',
    event: { type: 'inquiryThreadUpdated', payload },
  });
}

function mapWakeResultToInquiryOutcome(
  result: FollowUpWakeResult,
): InjectionOutcome {
  switch (result.kind) {
    case 'not_required':
      return 'sent';
    case 'resumed':
      return 'resumed';
    case 'dropped':
      return 'archived';
    case 'queued_without_wake':
    case 'resume_in_flight':
    case 'active_or_resuming':
    case 'queued_resume_failed':
      return 'queued';
  }
}

function mapInjectionOutcomeToResumeOutcome(
  outcome: InjectionOutcome,
): InquiryResumeOutcome {
  return outcome === 'archived' ? 'parent_finished' : outcome;
}

async function deliverContinuation(params: {
  parentStreamId: StreamTabId;
  text: string;
  threadId: ExternalInquiryThreadId;
  session?: SessionHandle;
}): Promise<InjectionOutcome> {
  const result = await sendFollowUp(
    params.parentStreamId,
    params.text,
    undefined,
    undefined,
    params.session,
  );

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

  const outcome = mapWakeResultToInquiryOutcome(
    await wakeQueuedFollowUpStream(
      params.parentStreamId,
      result,
      undefined,
      params.session,
    ),
  );

  await emitInquiryThreadUpdate(
    params.threadId,
    { resumeOutcome: mapInjectionOutcomeToResumeOutcome(outcome) },
    params.session,
  );
  return outcome;
}

export async function injectContinuationForAnsweredThread(
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
  const manifest = manifestHint ?? (await readExternalInquiryThread(threadId));
  if (!manifest) return 'archived';

  const lastTurn = manifest.turns.at(-1);
  if (!lastTurn || lastTurn.kind !== 'answered') return 'archived';
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

  const stillOpen = await listOpenThreadsForStream(manifest.parentStreamId);
  const text = buildContinuationText({
    event: 'answered',
    threadId,
    question: lastTurn.question,
    answer: lastTurn.answer,
    stillOpen,
  });

  return deliverContinuation({
    parentStreamId: manifest.parentStreamId,
    text,
    threadId,
    session,
  });
}

export async function injectContinuationForDroppedThread(
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
  const manifest = manifestHint ?? (await readExternalInquiryThread(threadId));
  if (!manifest) return 'archived';
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

  const lastTurn = manifest.turns.at(-1);
  const question = lastTurn?.question ?? '';
  const stillOpen = await listOpenThreadsForStream(manifest.parentStreamId);
  const text = buildContinuationText({
    event: 'dropped',
    threadId,
    question,
    stillOpen,
  });

  return deliverContinuation({
    parentStreamId: manifest.parentStreamId,
    text,
    threadId,
    session,
  });
}
