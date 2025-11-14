// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState } from '@agent/core/AgentState';
import { createSharedStore } from '@agent/core/AgentSharedStore';
// Type imports
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
// Internal imports
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueue';
import { ToolUseSnapshotCache } from '@agent/toolUse/ToolUseSnapshotCache';
// Type imports
import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSnapshotTypes';

describe('ToolUse session queue helpers', () => {
  const streamId = 'stream-queue' as StreamTabId;
  const executionId = 'exec-queue' as ExecutionId;

  function buildSnapshot(): ToolUseSessionSnapshot {
    const workspace = new AgentWorkspaceState();
    workspace.assembly.updateLastResponse('queued');
    const store = createSharedStore({
      roundIndex: 0,
      runState: new AgentRunState(),
      workspaceState: workspace,
      userChannels: {
        input: Object.freeze({}) as Readonly<Record<string, unknown>>,
        transient: {},
        output: {},
      },
    });

    return {
      version: 1,
      executionId,
      streamId,
      agentConfig: parseAgentConfig({
        model: 'demo-model',
        agent: 'demo-agent',
        session: {
          agentType: 'toolUse',
          agentCategory: 'toolUse',
        },
      }),
      messages: [],
      store: store.toJSON(),
      lastUpdated: Date.now(),
    };
  }

  beforeEach(() => {
    ToolUseFollowUpQueue.clearResuming(streamId);
    ToolUseSnapshotCache.clearAll();
  });

  afterEach(() => {
    ToolUseFollowUpQueue.clearResuming(streamId);
    ToolUseSnapshotCache.clearAll();
  });

  it('drains queued follow-ups in FIFO order', () => {
    ToolUseFollowUpQueue.markResuming(streamId);
    assert.equal(ToolUseFollowUpQueue.enqueue(streamId, 'first'), true);
    assert.equal(ToolUseFollowUpQueue.enqueue(streamId, 'second'), true);

    const drained = ToolUseFollowUpQueue.drain(streamId);

    assert.deepEqual(drained, ['first', 'second']);
    const secondDrain = ToolUseFollowUpQueue.drain(streamId);
    assert.deepEqual(secondDrain, []);
  });

  it('consumes pending snapshots when resuming', () => {
    const snapshot = buildSnapshot();
    ToolUseSnapshotCache.registerSnapshots([snapshot]);

    assert.equal(ToolUseSnapshotCache.getByStream(streamId), snapshot);

    const consumed = ToolUseSnapshotCache.consumeByStream(streamId);
    assert.equal(consumed, snapshot);
    assert.equal(ToolUseSnapshotCache.getByStream(streamId), undefined);
  });

  it('clears cached snapshots explicitly', () => {
    const snapshot = buildSnapshot();
    ToolUseSnapshotCache.cacheSnapshot(snapshot);

    ToolUseSnapshotCache.clearByStream(streamId);
    assert.equal(ToolUseSnapshotCache.getByStream(streamId), undefined);

    ToolUseSnapshotCache.cacheSnapshot(snapshot);
    ToolUseSnapshotCache.clearAll();
    assert.equal(ToolUseSnapshotCache.getByStream(streamId), undefined);
    assert.equal(ToolUseSnapshotCache.clearByExecution(executionId), undefined);
  });
});
