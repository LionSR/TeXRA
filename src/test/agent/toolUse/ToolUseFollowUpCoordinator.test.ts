// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState } from '@agent/core/AgentState';
import { createSharedStore } from '@agent/core/AgentSharedStore';
import {
  resumeFromSnapshot,
  sendFollowUp,
} from '@agent/toolUse/ToolUseFollowUpCoordinator';
// Type imports
import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSnapshotTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
// Internal imports
import * as AgentRegistry from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseSessionPersistence } from '@agent/toolUse/ToolUseSessionPersistence';

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

  const originalGetAgent = AgentRegistry.getToolUseAgent;
  const originalResume = ToolUseSessionPersistence.resumeFromSnapshot;

  afterEach(() => {
    (AgentRegistry as any).getToolUseAgent = originalGetAgent;
    ToolUseSessionPersistence.resumeFromSnapshot = originalResume;
  });

  it('sends follow-ups to active agents', async () => {
    const calls: string[] = [];
    (AgentRegistry as any).getToolUseAgent = () => ({
      appendFollowUp: (text: string) => {
        calls.push(text);
      },
    });

    await sendFollowUp(streamId, 'hello');

    assert.deepEqual(calls, ['hello']);
  });

  it('resumes from snapshot through the session coordinator', async () => {
    ToolUseSessionPersistence.resumeFromSnapshot = async (snap, followUp) => {
      assert.equal(snap, snapshot);
      assert.equal(followUp, 'next');
      return { success: true };
    };

    const result = await resumeFromSnapshot(snapshot, 'next');

    assert.deepEqual(result, { success: true });
  });
});
