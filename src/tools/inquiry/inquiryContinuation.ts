/**
 * Inquiry continuation injector.
 *
 * Host-neutral. When the user submits an answer (or drops an open
 * inquiry), this module synthesizes the `[inquiry] …` continuation
 * text, hands it to `sendFollowUp` for the parent stream, and — for
 * the cases where the cycle has exited (WAITING / children_running) —
 * triggers `AgentResumePort.tryResumeStream` so the parent stream
 * picks the message up.
 *
 * Returns an `InjectionOutcome` so the caller (action handler) can
 * forward it to the UI via the `inquiryThreadUpdated` event.
 */
import { platform } from '@platform/platform';

import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import type {
  ExternalInquiryThreadId,
  ExternalInquiryThreadSummary,
  InquiryResumeOutcome,
  StreamTabId,
} from '@shared/schemas';

import {
  getThreadSummary,
  listOpenThreadsForStream,
  readExternalInquiryThread,
  type ExternalInquiryThreadManifest,
} from './externalInquiryStorage';

const logger = new AgentLogger('inquiryContinuation');

export type InjectionOutcome = 'sent' | 'queued' | 'resumed' | 'archived';

const QUESTION_TRUNCATION = 400;
const ANSWER_TRUNCATION = 2000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit).trimEnd() + ' …';
}

function formatStillOpen(threads: ExternalInquiryThreadSummary[]): string[] {
  if (!threads.length) return [];
  const lines = ['', 'Still open on this stream:'];
  for (const t of threads) {
    const since = formatRelativeTime(t.lastActivityIso);
    lines.push(
      `  - ${t.threadId}  "${truncate(t.lastQuestionPreview, 60)}"  (dispatched ${since})`,
    );
  }
  return lines;
}

function formatRelativeTime(iso: string): string {
  const elapsedMs = Math.max(0, Date.now() - Date.parse(iso));
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
    lines.push(`Q: ${truncate(question, QUESTION_TRUNCATION)}`);
    if (answer !== undefined) {
      lines.push(
        `A: ${truncate(answer, ANSWER_TRUNCATION)}` +
          (answer.length > ANSWER_TRUNCATION
            ? ` (full text via inquiry { command: 'read', thread_id: '${threadId}' })`
            : ''),
      );
    }
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
  lines.push(`Q: ${truncate(question, QUESTION_TRUNCATION)}`);
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
): Promise<void> {
  const summary = await getThreadSummary(threadId);
  if (!summary) return;
  bus.emit('inquiryThreadUpdated', { ...summary, ...extra });
}

async function deliverContinuation(params: {
  parentStreamId: StreamTabId;
  text: string;
  threadId: ExternalInquiryThreadId;
}): Promise<InjectionOutcome> {
  const result = await sendFollowUp(params.parentStreamId, params.text);

  switch (result.status) {
    case 'sent':
      await emitInquiryThreadUpdate(params.threadId, { resumeOutcome: 'sent' });
      return 'sent';
    case 'queued': {
      if (result.reason === 'waiting' || result.reason === 'children_running') {
        const resumed = await platform().agentResume.tryResumeStream(
          params.parentStreamId,
        );
        const outcome: InjectionOutcome = resumed ? 'resumed' : 'queued';
        await emitInquiryThreadUpdate(params.threadId, {
          resumeOutcome: outcome,
        });
        return outcome;
      }
      await emitInquiryThreadUpdate(params.threadId, {
        resumeOutcome: 'queued',
      });
      return 'queued';
    }
    case 'no_session':
      logger.warn(
        `Inquiry continuation for ${params.threadId}: parent stream ${params.parentStreamId} has no session.`,
      );
      await emitInquiryThreadUpdate(params.threadId, {
        resumeOutcome: 'parent_finished',
      });
      return 'archived';
  }
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
): Promise<InjectionOutcome> {
  const manifest = manifestHint ?? (await readExternalInquiryThread(threadId));
  if (!manifest) return 'archived';

  const lastTurn = manifest.turns.at(-1);
  if (!lastTurn || !lastTurn.answer) return 'archived';
  if (manifest.parentStreamId == null) {
    await emitInquiryThreadUpdate(threadId, {
      resumeOutcome: 'parent_finished',
    });
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
  });
}

export async function injectContinuationForDroppedThread(
  threadId: ExternalInquiryThreadId,
): Promise<InjectionOutcome> {
  const manifest = await readExternalInquiryThread(threadId);
  if (!manifest) return 'archived';
  if (manifest.parentStreamId == null) {
    await emitInquiryThreadUpdate(threadId, {
      resumeOutcome: 'parent_finished',
    });
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
  });
}
