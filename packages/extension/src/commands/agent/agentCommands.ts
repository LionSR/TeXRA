// Local imports - agent
import { defaultSession, detachSubagentsOnStop } from '@agent/runtime';
import type { StreamTabId } from '@shared/schemas';

export function stopAgent(streamId: StreamTabId): void {
  defaultSession().executions.stopAgentStream(streamId, {
    detachActiveChildren: detachSubagentsOnStop(),
  });
}
