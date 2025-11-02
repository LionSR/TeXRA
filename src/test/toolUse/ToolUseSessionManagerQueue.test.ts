// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionManager';
import { ToolUseSessionManager } from '@agent/toolUse/ToolUseSessionManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { ToolUseSnapshotStore } from '@agent/toolUse/ToolUseSnapshotStore';

describe('ToolUseSessionManager queue handling', () => {
  type ManagerState = {
    pendingSnapshots: Map<StreamTabId, ToolUseSessionSnapshot>;
    resumingSessions: Map<StreamTabId, { queuedFollowUps: string[] }>;
  };

  type StoreMutable = {
    delete: typeof ToolUseSnapshotStore.delete;
  };

  const managerState = ToolUseSessionManager as unknown as ManagerState;
  const storeMutable = ToolUseSnapshotStore as unknown as StoreMutable;
  const originalDelete = storeMutable.delete;

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
        document: { texcountStats: null, mediaFiles: [] },
        draft: { lastResponse: '', accumulatedOutput: '' },
        reasoning: { thinkingBlocks: [], thinkingAdded: false },
      },
      lastUpdated: Date.now(),
    };
  }

  beforeEach(() => {
    managerState.pendingSnapshots.clear();
    managerState.resumingSessions.clear();
    storeMutable.delete = async () => {
      /* noop */
    };
  });

  afterEach(() => {
    storeMutable.delete = originalDelete;
    managerState.pendingSnapshots.clear();
    managerState.resumingSessions.clear();
  });

  it('drains queued follow-ups in FIFO order', () => {
    ToolUseSessionManager.setResumingSession(streamId);
    ToolUseSessionManager.enqueueFollowUpWhileResuming(streamId, 'first');
    ToolUseSessionManager.enqueueFollowUpWhileResuming(streamId, 'second');

    const drained = ToolUseSessionManager.drainQueuedFollowUps(streamId);

    assert.deepEqual(drained, ['first', 'second']);
    const secondDrain = ToolUseSessionManager.drainQueuedFollowUps(streamId);
    assert.deepEqual(secondDrain, []);
  });

  it('consumes pending snapshots when resuming', () => {
    const snapshot = createSnapshot();
    ToolUseSessionManager.registerPendingSnapshots([snapshot]);

    assert.equal(
      ToolUseSessionManager.getSnapshotForStream(streamId),
      snapshot,
    );

    const consumed = ToolUseSessionManager.consumeSnapshotForStream(streamId);
    assert.equal(consumed, snapshot);
    assert.equal(ToolUseSessionManager.hasPendingSnapshot(streamId), false);
  });

  it('removes cached snapshot before delegating to the store on delete', async () => {
    const snapshot = createSnapshot();
    ToolUseSessionManager.registerPendingSnapshots([snapshot]);

    const deleteCalls: (string | undefined)[] = [];
    storeMutable.delete = async (executionId) => {
      deleteCalls.push(executionId);
    };

    await ToolUseSessionManager.deleteSnapshot(snapshot.executionId);

    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0], snapshot.executionId);
    assert.equal(ToolUseSessionManager.hasPendingSnapshot(streamId), false);
  });
});
