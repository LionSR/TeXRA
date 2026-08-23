/** Parent-continuation delivery for child runs. */
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';

import { submitFollowUp, type FollowUpFailureReason } from './ToolUseFollowUp';
import type { FollowUpQueueInput } from './FollowUpQueue';

export type ChildRunDeliveryResult =
  { kind: 'delivered' } | { kind: 'failed'; reason: FollowUpFailureReason };

export async function deliverChildRunFollowUp(params: {
  readonly targetStreamId: StreamTabId;
  readonly followUp: FollowUpQueueInput;
  readonly session: SessionHandle;
  readonly mode?: 'continuation' | 'live_notification' | 'child_delivery';
  /** Parent continuation generation captured when this producer began. */
  readonly expectedGenerationId?: string;
}): Promise<ChildRunDeliveryResult> {
  const result = await submitFollowUp(params.targetStreamId, params.followUp, {
    session: params.session,
    mode: params.mode ?? 'child_delivery',
    expectedGenerationId: params.expectedGenerationId,
  });
  return result.status === 'failed'
    ? { kind: 'failed', reason: result.reason }
    : { kind: 'delivered' };
}
