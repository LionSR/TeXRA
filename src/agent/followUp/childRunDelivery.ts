/** Parent-continuation delivery for child runs. */
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';

import { submitFollowUp } from './ToolUseFollowUp';
import type { FollowUpQueueInput } from './FollowUpQueue';

export type ChildRunDeliveryResult =
  | { kind: 'delivered' }
  | { kind: 'no_session'; streamStatus: string | undefined }
  | { kind: 'dropped' };

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
  if (result.status === 'no_session') {
    return { kind: 'no_session', streamStatus: result.streamStatus };
  }
  return result.status === 'dropped'
    ? { kind: 'dropped' }
    : { kind: 'delivered' };
}
