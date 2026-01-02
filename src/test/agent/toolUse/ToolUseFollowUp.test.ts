// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState, ConversationRoundState } from '@agent/core/AgentState';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
// Type imports
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
// Internal imports
import * as AgentRegistry from '@agent/toolUse/ToolUseAgentRegistry';

describe('ToolUseFollowUp', () => {
  const streamId = 'stream-follow-up' as StreamTabId;

  // Create state snapshots directly (no store wrapper needed)
  const runState = new AgentRunState();
  const workspaceState = AgentWorkspaceState.create();
  const roundState = new ConversationRoundState(0);

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
    // Store snapshot for backwards compatibility with existing persisted data
    store: {
      round: roundState.toSnapshot(),
      run: runState.toSnapshot(),
      workspace: workspaceState.toSnapshot(),
      user: {
        input: {},
        transient: {},
      },
    },
    lastUpdated: Date.now(),
  };

  const originalGetFlowContext = AgentRegistry.getToolUseFlowContext;

  afterEach(() => {
    (AgentRegistry as any).getToolUseFlowContext = originalGetFlowContext;
  });

  it('sends follow-ups to active flow contexts', async () => {
    const calls: string[] = [];
    (AgentRegistry as any).getToolUseFlowContext = () => ({
      session: {
        appendFollowUp: (text: string) => {
          calls.push(text);
        },
      },
    });

    await sendFollowUp(streamId, 'hello');

    assert.deepEqual(calls, ['hello']);
  });

  it('creates valid snapshot structure', () => {
    // Test that snapshot structure is valid (used for resume operations)
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.streamId, streamId);
    assert.equal(snapshot.executionId, 'exec-1');
    assert.ok(snapshot.agentConfig);
    assert.ok(snapshot.store);
  });
});
