// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import {
  ToolUseResumeQueue,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseResumeQueue';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

describe('ToolUseSessionManager queue handling', () => {
  type ManagerState = {
    pendingSnapshots: Map<StreamTabId, ToolUseSessionSnapshot>;
    resumingSessions: Map<StreamTabId, { queuedFollowUps: string[] }>;
  };

  const managerState = ToolUseResumeQueue as unknown as ManagerState & {
    clearAllPendingSnapshots: () => void;
  };

  const streamId = 'stream-queue' as StreamTabId;

  function createSnapshot(): ToolUseSessionSnapshot {
    return {
      version: 1,
      executionId: 'exec-queue',
      streamId,
      agentName: 'demo-agent',
      model: 'demo-model',
      session: {
        agentType: AgentType.ToolUse,
        agentCategory: AgentCategory.ToolUse,
      },
      messages: [],
      toolState: {
        assembly: {
          lastResponse: '',
          accumulatedOutput: '',
        },
        media: {
          files: [],
        },
        reasoning: {
          thinkingBlocks: [],
          thinkingAdded: false,
        },
        document: {
          texcountStats: null,
        },
      },
      lastUpdated: Date.now(),
    };
  }

  beforeEach(() => {
    managerState.pendingSnapshots.clear();
    managerState.resumingSessions.clear();
  });

  afterEach(() => {
    managerState.pendingSnapshots.clear();
    managerState.resumingSessions.clear();
  });

  it('drains queued follow-ups in FIFO order', () => {
    ToolUseResumeQueue.setResumingSession(streamId);
    ToolUseResumeQueue.enqueueFollowUpWhileResuming(streamId, 'first');
    ToolUseResumeQueue.enqueueFollowUpWhileResuming(streamId, 'second');

    const drained = ToolUseResumeQueue.drainQueuedFollowUps(streamId);

    assert.deepEqual(drained, ['first', 'second']);
    const secondDrain = ToolUseResumeQueue.drainQueuedFollowUps(streamId);
    assert.deepEqual(secondDrain, []);
  });

  it('consumes pending snapshots when resuming', () => {
    const snapshot = createSnapshot();
    ToolUseResumeQueue.registerPendingSnapshots([snapshot]);

    assert.equal(ToolUseResumeQueue.getSnapshotForStream(streamId), snapshot);

    const consumed = ToolUseResumeQueue.consumeSnapshotForStream(streamId);
    assert.equal(consumed, snapshot);
    assert.equal(ToolUseResumeQueue.hasPendingSnapshot(streamId), false);
  });

  it('clears cached snapshots explicitly', () => {
    const snapshot = createSnapshot();
    ToolUseResumeQueue.registerPendingSnapshots([snapshot]);

    ToolUseResumeQueue.clearPendingSnapshot(streamId);
    assert.equal(ToolUseResumeQueue.hasPendingSnapshot(streamId), false);

    ToolUseResumeQueue.registerPendingSnapshots([snapshot]);
    managerState.clearAllPendingSnapshots();
    assert.equal(ToolUseResumeQueue.hasPendingSnapshot(streamId), false);
  });
});
