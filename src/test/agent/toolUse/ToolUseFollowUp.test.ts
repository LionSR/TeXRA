// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { createRunState } from '@agent/core/AgentState';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  AgentExecutionHandle,
  trackExecution,
  untrackExecution,
} from '@agent/runtime/executionRegistry';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
// Type imports
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import * as AgentRegistry from '@agent/toolUse/ToolUseAgentRegistry';
import type { StreamTabId } from '@shared/schemas';

describe('ToolUseFollowUp', () => {
  const streamId = 'stream-follow-up' as StreamTabId;

  // Create state snapshots directly (no store wrapper needed)
  const workspaceState = AgentWorkspaceState.create();

  const snapshot: ToolUseSessionSnapshot = {
    version: 2,
    executionId: 'exec-1',
    streamId,
    agentConfig: AgentConfigSchema.parse({
      model: 'demo-model',
      agent: 'demo-agent',
      agentCategory: 'toolUse',
    }),
    messages: [],
    // State slices stored directly (v2 schema)
    run: createRunState(),
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

    const result = await sendFollowUp(streamId, 'hello');

    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'hello');
    assert.deepEqual(result, { status: 'sent' });
  });

  it('queues follow-ups when children are still running', async () => {
    (AgentRegistry as any).getToolUseFlowContext = () => undefined;

    const parentStreamId = 'parent-stream-children' as StreamTabId;
    const childStreamId = 'child-stream-children' as StreamTabId;
    const executionId = 'exec-children-running';

    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'test-subagent',
      'toolUse',
      noopAgentRuntimeHost,
    );
    trackExecution(handle);

    try {
      const result = await sendFollowUp(parentStreamId, 'hello while running');

      assert.deepEqual(result, {
        status: 'queued',
        reason: 'children_running',
      });
      assert.deepEqual(ToolUseFollowUpQueue.getAll(parentStreamId), [
        'hello while running',
      ]);
    } finally {
      untrackExecution(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('survives prior queue release when children are running', async () => {
    // Regression: without force:true, enqueue() silently drops messages
    // on streams previously released by sessionLifecycle.dispose().
    (AgentRegistry as any).getToolUseFlowContext = () => undefined;

    const parentStreamId = 'parent-stream-released' as StreamTabId;
    const childStreamId = 'child-stream-released' as StreamTabId;
    const executionId = 'exec-released';

    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'test-subagent',
      'toolUse',
      noopAgentRuntimeHost,
    );
    trackExecution(handle);
    ToolUseFollowUpQueue.release(parentStreamId);

    try {
      const result = await sendFollowUp(parentStreamId, 'after release');

      assert.deepEqual(result, {
        status: 'queued',
        reason: 'children_running',
      });
      assert.deepEqual(ToolUseFollowUpQueue.getAll(parentStreamId), [
        'after release',
      ]);
    } finally {
      untrackExecution(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
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
