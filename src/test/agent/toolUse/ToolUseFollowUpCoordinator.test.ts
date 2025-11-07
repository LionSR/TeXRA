// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState } from '@agent/core/AgentState';
import { createSharedStore } from '@agent/core/AgentSharedStore';
import { ToolUseSessionCoordinator } from '@agent/toolUse/ToolUseSessionCoordinator';
import {
  resumeFromSnapshot,
  sendFollowUp,
} from '@agent/toolUse/ToolUseFollowUpCoordinator';
import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSnapshotTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

describe('ToolUseFollowUpCoordinator', () => {
  const streamId = 'stream-follow-up' as StreamTabId;
  const workspace = new AgentWorkspaceState();
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

  const snapshot: ToolUseSessionSnapshot = {
    version: 1,
    executionId: 'exec-1',
    streamId,
    agentConfig: parseAgentConfig({
      model: 'demo-model',
      agent: 'demo-agent',
      session: { agentType: 'toolUse', agentCategory: 'toolUse' },
    }),
    messages: [],
    store: store.toJSON(),
    lastUpdated: Date.now(),
  };

  const originalHandleFollowUp = ToolUseSessionCoordinator.handleFollowUp;
  const originalResume = ToolUseSessionCoordinator.resumeFromSnapshot;

  afterEach(() => {
    ToolUseSessionCoordinator.handleFollowUp = originalHandleFollowUp;
    ToolUseSessionCoordinator.resumeFromSnapshot = originalResume;
  });

  it('delegates follow-up handling to the session coordinator', async () => {
    const calls: { streamId: StreamTabId; text: string }[] = [];
    ToolUseSessionCoordinator.handleFollowUp = async (
      sid,
      text,
    ): Promise<void> => {
      calls.push({ streamId: sid, text });
    };

    await sendFollowUp(streamId, 'hello');

    assert.deepEqual(calls, [{ streamId, text: 'hello' }]);
  });

  it('resumes from snapshot through the session coordinator', async () => {
    ToolUseSessionCoordinator.resumeFromSnapshot = async (snap, followUp) => {
      assert.equal(snap, snapshot);
      assert.equal(followUp, 'next');
      return { success: true };
    };

    const result = await resumeFromSnapshot(snapshot, 'next');

    assert.deepEqual(result, { success: true });
  });
});
