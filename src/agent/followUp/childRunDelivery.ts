/** Parent-continuation delivery for child runs. */
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';

import { submitFollowUp, type FollowUpFailureReason } from './ToolUseFollowUp';
import type { FollowUpQueueInput } from './FollowUpQueue';

/** `wake: 'failed'`: the result is in the parent's queue; only its wake failed. */
type ChildRunDeliveryResult =
  | { kind: 'delivered'; wake?: 'failed' }
  | { kind: 'failed'; reason: FollowUpFailureReason };

export async function deliverChildRunFollowUp(params: {
  readonly targetStreamId: StreamTabId;
  readonly followUp: FollowUpQueueInput;
  readonly session: SessionHandle;
  readonly mode?: 'live_notification' | 'child_delivery';
}): Promise<ChildRunDeliveryResult> {
  const result = await submitFollowUp(params.targetStreamId, params.followUp, {
    session: params.session,
    mode: params.mode ?? 'child_delivery',
  });
  if (result.status === 'failed') {
    return { kind: 'failed', reason: result.reason };
  }
  return result.status === 'queued' && result.wake === 'failed'
    ? { kind: 'delivered', wake: 'failed' }
    : { kind: 'delivered' };
}
