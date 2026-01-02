// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentRunState } from '@agent/core/AgentState';
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

  const snapshot: ToolUseSessionSnapshot = {
    version: 2,
    executionId: 'exec-1',
    streamId,
    agentConfig: parseAgentConfig({
      model: 'demo-model',
      agent: 'demo-agent',
      session: { agentType: 'toolUse', agentCategory: 'toolUse' },
    }),
    messages: [],
    // State slices stored directly (v2 schema)
    run: runState.toSnapshot(),
    workspace: workspaceState.toSnapshot(),
    user: {
      input: {},
      transient: {},
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
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.streamId, streamId);
    assert.equal(snapshot.executionId, 'exec-1');
    assert.ok(snapshot.agentConfig);
    // State slices stored directly (v2 schema)
    assert.ok(snapshot.run);
    assert.ok(snapshot.workspace);
    assert.ok(snapshot.user);
  });
});
