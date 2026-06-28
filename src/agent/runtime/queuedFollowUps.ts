import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

export interface RuntimeQueuedFollowUpsProjection {
  readonly streamId: StreamTabId;
  readonly messages: string[];
}

export function publishRuntimeQueuedFollowUps(
  runtimeHost: AgentRuntimeHost,
  streamId: StreamTabId,
): void {
  const projection: RuntimeQueuedFollowUpsProjection = {
    streamId,
    messages: ToolUseFollowUpQueue.getAll(streamId),
  };
  runtimeHost.emit('updateQueuedFollowUps', projection);
}
