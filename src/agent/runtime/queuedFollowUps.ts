import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';

import type { AgentRuntimeHost } from './AgentRuntimeHost';

export interface QueuedFollowUpsProjection {
  readonly streamId: StreamTabId;
  readonly messages: string[];
}

export function getQueuedFollowUpsProjection(
  streamId: StreamTabId,
): QueuedFollowUpsProjection {
  return {
    streamId,
    messages: ToolUseFollowUpQueue.getAll(streamId),
  };
}

export function emitQueuedFollowUps(
  runtimeHost: AgentRuntimeHost,
  streamId: StreamTabId,
): void {
  runtimeHost.emit(
    'updateQueuedFollowUps',
    getQueuedFollowUpsProjection(streamId),
  );
}
