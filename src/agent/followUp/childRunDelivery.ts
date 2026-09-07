/** Parent-continuation delivery for child runs. */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';

import { submitFollowUp, type FollowUpFailureReason } from './ToolUseFollowUp';
import type { FollowUpQueueInput } from './FollowUpQueue';

/** `wake: 'failed'`: the result is in the parent's queue; only its wake failed. */
type ChildRunDeliveryResult =
  | { kind: 'delivered'; wake?: 'failed' }
  | { kind: 'failed'; reason: FollowUpFailureReason };

export const deliverChildRunFollowUp = Effect.fn('deliverChildRunFollowUp')(
  function* (params: {
    readonly targetStreamId: StreamTabId;
    readonly followUp: FollowUpQueueInput;
    readonly session: SessionHandle;
  }): Effect.fn.Return<ChildRunDeliveryResult, Error> {
    const result = yield* submitFollowUp(
      params.targetStreamId,
      params.followUp,
      {
        session: params.session,
        mode: 'child_delivery',
      },
    );
    if (result.status === 'failed') {
      return { kind: 'failed', reason: result.reason };
    }
    return result.status === 'queued' && result.wake === 'failed'
      ? { kind: 'delivered', wake: 'failed' }
      : { kind: 'delivered' };
  },
);
