/**
 * Inquiry continuation injector.
 *
 * Host-neutral. When the user submits an answer (or drops an open
 * inquiry), this module synthesizes the `[inquiry] …` continuation
 * text and hands it to `requestRuntimeFollowUp` for the parent stream. The
 * runtime command owns the WAITING / children-running wake logic so this
 * module only interprets the host-facing result.
 *
 * Returns an `InjectionOutcome` so the caller (action handler) can
 * forward it to the UI via the `inquiryThreadUpdated` event.
 */

import { requestRuntimeFollowUp } from '@agent/runtime/followUpCommands';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { emitRuntimeEvent } from '@agent/runtime/emitRuntimeEvent';
import { createChannelTrace } from '@logger';
import type {
  ExternalInquiryThreadId,
  InquiryResumeOutcome,
  StreamTabId,
} from '@shared/schemas';
import { buildExternalInquiryContinuationText } from '@shared/inquiry/continuationText';

import {
  getThreadSummary,
  listOpenThreadsForStream,
  readExternalInquiryThread,
  type ExternalInquiryThreadManifest,
} from './externalInquiryStorage';

const logger = createChannelTrace('inquiryContinuation');

export type InjectionOutcome = 'sent' | 'queued' | 'resumed' | 'archived';
export { buildExternalInquiryContinuationText as buildContinuationText };

async function emitInquiryThreadUpdate(
  threadId: ExternalInquiryThreadId,
  extra: { resumeOutcome: InquiryResumeOutcome },
  session?: SessionHandle,
): Promise<void> {
  const summary = await getThreadSummary(threadId);
  if (!summary) return;
  emitRuntimeEvent('inquiryThreadUpdated', { ...summary, ...extra }, session);
}

async function deliverContinuation(params: {
  parentStreamId: StreamTabId;
  text: string;
  threadId: ExternalInquiryThreadId;
  session?: SessionHandle;
}): Promise<InjectionOutcome> {
  const result = await requestRuntimeFollowUp({
    streamId: params.parentStreamId,
    text: params.text,
    session: params.session,
    wakeQueuedStream: true,
  });

  switch (result.outcome) {
    case 'sent':
      await emitInquiryThreadUpdate(
        params.threadId,
        { resumeOutcome: 'sent' },
        params.session,
      );
      return 'sent';
    case 'queued': {
      const outcome: InjectionOutcome =
        result.wakeStatus === 'resumed' ? 'resumed' : 'queued';
      await emitInquiryThreadUpdate(
        params.threadId,
        {
          resumeOutcome: outcome,
        },
        params.session,
      );
      return outcome;
    }
    case 'dropped':
    case 'no_session':
      logger.warn(
        result.outcome === 'dropped'
          ? `Inquiry continuation for ${params.threadId}: parent stream ${params.parentStreamId} could not be resumed.`
          : `Inquiry continuation for ${params.threadId}: parent stream ${params.parentStreamId} has no session.`,
      );
      await emitInquiryThreadUpdate(
        params.threadId,
        {
          resumeOutcome: 'parent_finished',
        },
        params.session,
      );
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
  session?: SessionHandle,
): Promise<InjectionOutcome> {
  const manifest = manifestHint ?? (await readExternalInquiryThread(threadId));
  if (!manifest) return 'archived';

  const lastTurn = manifest.turns.at(-1);
  if (!lastTurn || !lastTurn.answer) return 'archived';
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
  const text = buildExternalInquiryContinuationText({
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
  const text = buildExternalInquiryContinuationText({
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
