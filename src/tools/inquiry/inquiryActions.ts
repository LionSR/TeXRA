/**
 * External-inquiry action persistence and continuation dispatch.
 *
 * Host/controller layers (progress-view command handlers, CLI approval
 * adapters) reach these to persist a terminal inquiry action (submit/drop)
 * and deliver the resulting `[inquiry]` continuation — orchestration that has
 * no tool concern. Kept out of `ExternalInquiryTool.ts` so the tool file owns
 * tool execution and output formatting only.
 */

// Local imports - agent
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';

// Local imports - shared
import type { InquiryActionMessage } from '@shared/schemas';

// Local imports - inquiry
import {
  markDropped,
  recordAnswerForOpenTurn,
  type ExternalInquiryThreadManifest,
} from './externalInquiryStorage';
import {
  injectContinuationForAnsweredThread,
  injectContinuationForDroppedThread,
} from './inquiryContinuation';

const logger = createLog('InquiryTool');

type InquirySubmitAction = Extract<
  InquiryActionMessage,
  { readonly action: 'submit' }
>;
type InquiryDropBase = Omit<
  Extract<InquiryActionMessage, { readonly action: 'drop' }>,
  'feedback'
>;
type InquiryDropAction = InquiryDropBase &
  (
    | {
        readonly feedback?: string;
        readonly reason?: never;
        readonly cause?: never;
      }
    | {
        readonly feedback?: never;
        readonly reason: string;
        readonly cause?: never;
      }
    | {
        readonly feedback?: never;
        readonly reason?: never;
        readonly cause: string;
      }
  );
type ExternalInquiryAction = InquirySubmitAction | InquiryDropAction;

export type ExternalInquiryTransition =
  | {
      readonly kind: 'answered';
      readonly threadId: InquiryActionMessage['threadId'];
      readonly manifest: ExternalInquiryThreadManifest;
    }
  | {
      readonly kind: 'dropped';
      readonly threadId: InquiryActionMessage['threadId'];
      readonly manifest: ExternalInquiryThreadManifest;
    }
  | {
      readonly kind: 'stale';
      readonly threadId: InquiryActionMessage['threadId'];
    };

/** Persist one terminal inquiry action without reaching into host presentation. */
export async function persistExternalInquiryAction(
  payload: ExternalInquiryAction,
): Promise<ExternalInquiryTransition> {
  if (payload.action === 'submit') {
    const persisted = await recordAnswerForOpenTurn({
      threadId: payload.threadId,
      answer: payload.answer,
      sessionLinks: payload.sessionLinks ?? undefined,
    });
    if (!persisted) {
      logger.warn(
        `Inquiry submit ignored: thread ${payload.threadId} has no open turn.`,
      );
      return { kind: 'stale', threadId: payload.threadId };
    }
    return {
      kind: 'answered',
      threadId: payload.threadId,
      manifest: persisted.manifest,
    };
  }

  // drop — only flips status if the thread is still open; see markDropped.
  if (payload.feedback) {
    logger.info(`Inquiry ${payload.threadId} dropped with feedback`, {
      data: payload.feedback,
    });
  } else if (payload.reason) {
    logger.info(`Inquiry ${payload.threadId} denied`, {
      data: payload.reason,
    });
  } else if (payload.cause) {
    logger.info(`Inquiry ${payload.threadId} dropped with cause`, {
      data: payload.cause,
    });
  }
  const droppedManifest = await markDropped({ threadId: payload.threadId });
  if (droppedManifest) {
    return {
      kind: 'dropped',
      threadId: payload.threadId,
      manifest: droppedManifest,
    };
  }
  logger.warn(
    `Inquiry drop ignored: thread ${payload.threadId} is no longer open ` +
      `(stale/duplicate drop after submit?). Skipping continuation.`,
  );
  return { kind: 'stale', threadId: payload.threadId };
}

/** Deliver the continuation represented by a completed durable transition. */
export async function continueExternalInquiryAction(
  transition: ExternalInquiryTransition,
  options: { session?: SessionHandle } = {},
): Promise<void> {
  switch (transition.kind) {
    case 'answered':
      // Use the manifest just written so a concurrent follow-up cannot flip
      // storage back to `open` before this continuation observes the answer.
      await injectContinuationForAnsweredThread(
        transition.threadId,
        transition.manifest,
        options.session,
      );
      return;
    case 'dropped':
      await injectContinuationForDroppedThread(
        transition.threadId,
        transition.manifest,
        options.session,
      );
      return;
    case 'stale':
      return;
  }
}

/** Persist and continue an inquiry action for hosts without progress UI. */
export async function handleExternalInquiryAction(
  payload: ExternalInquiryAction,
  options: { session?: SessionHandle } = {},
): Promise<void> {
  const transition = await persistExternalInquiryAction(payload);
  await continueExternalInquiryAction(transition, options);
}
