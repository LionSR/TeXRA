import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

export interface RuntimeQueuedFollowUpsProjection {
  readonly streamId: StreamTabId;
  readonly messages: string[];
}

function getRuntimeQueuedFollowUpsProjection(
  streamId: StreamTabId,
): RuntimeQueuedFollowUpsProjection {
  return {
    streamId,
    messages: ToolUseFollowUpQueue.getAll(streamId),
  };
}

export function publishRuntimeQueuedFollowUps(
  runtimeHost: AgentRuntimeHost,
  streamId: StreamTabId,
): void {
  runtimeHost.emit(
    'updateQueuedFollowUps',
    getRuntimeQueuedFollowUpsProjection(streamId),
  );
}
