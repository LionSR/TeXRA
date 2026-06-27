import { describe, expect, it } from 'vitest';

import { releaseRuntimeStreamResources } from '@agent/runtime/streamResourceLifecycle';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';

describe('runtime stream resource lifecycle', () => {
  it('releases queued follow-ups for a deleted stream', () => {
    const streamId = 'stream-resource-lifecycle' as StreamTabId;
    ToolUseFollowUpQueue.acquire(streamId).enqueue({
      text: 'queued follow-up',
    });

    try {
      releaseRuntimeStreamResources(streamId);

      expect(ToolUseFollowUpQueue.getAll(streamId)).toEqual([]);
    } finally {
      ToolUseFollowUpQueue.release(streamId);
    }
  });
});
