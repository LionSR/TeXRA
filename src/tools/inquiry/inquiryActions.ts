import { Effect } from 'effect';
import { runInSession } from '@agent/runtime/RunContext';
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
import { ensureError } from '@utils/errors/errorMessage';

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
type ExternalInquiryAction =
  | Extract<InquiryActionMessage, { readonly action: 'submit' }>
  | InquiryDropAction;

type ExternalInquiryTransition =
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
async function persistExternalInquiryAction(
  payload: ExternalInquiryAction,
): Promise<ExternalInquiryTransition> {
  if (payload.action === 'submit') {
    const manifest = await recordAnswerForOpenTurn({
      threadId: payload.threadId,
      turnIndex: payload.turnIndex,
      answer: payload.answer,
      sessionLinks: payload.sessionLinks ?? undefined,
    });
    if (!manifest) {
      logger.warn(
        `Inquiry submit ignored: thread ${payload.threadId} has no open turn.`,
      );
      return { kind: 'stale', threadId: payload.threadId };
    }
    return {
      kind: 'answered',
      threadId: payload.threadId,
      manifest,
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
  const droppedManifest = await markDropped({
    threadId: payload.threadId,
    turnIndex: payload.turnIndex,
  });
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
const continueExternalInquiryAction = Effect.fn(
  'continueExternalInquiryAction',
)(function* (
  transition: ExternalInquiryTransition,
  options: { session: SessionHandle },
): Effect.fn.Return<void, Error> {
  switch (transition.kind) {
    case 'answered':
      // Use the manifest just written so a concurrent follow-up cannot flip
      // storage back to `open` before this continuation observes the answer.
      yield* injectContinuationForAnsweredThread(
        transition.threadId,
        transition.manifest,
        options.session,
      );
      return;
    case 'dropped':
      yield* injectContinuationForDroppedThread(
        transition.threadId,
        transition.manifest,
        options.session,
      );
      return;
    case 'stale':
      return;
  }
});

/** Persist and continue an inquiry action for hosts without progress UI. */
export const handleExternalInquiryAction = Effect.fn(
  'handleExternalInquiryAction',
)(function* (
  payload: ExternalInquiryAction,
  options: { session: SessionHandle },
): Effect.fn.Return<boolean, Error> {
  const transition = yield* Effect.tryPromise({
    try: async () =>
      runInSession(options.session, () =>
        persistExternalInquiryAction(payload),
      ),
    catch: ensureError,
  });
  yield* continueExternalInquiryAction(transition, options);
  return transition.kind !== 'stale';
});
