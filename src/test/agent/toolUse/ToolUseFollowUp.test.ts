// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import { AgentRunStateSnapshotSchema } from '@agent/core/execution/AgentState';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  AgentExecutionHandle,
  executionRegistry,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { FollowUpQueueInput } from '@agent/toolUse/FollowUpQueue';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
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
    run: AgentRunStateSnapshotSchema.parse({}),
    workspace: workspaceState.toSnapshot(),
    user: {
      input: {},
      transient: {},
    },
    lastUpdated: Date.now(),
  };

  afterEach(() => {
    for (const executionId of executionRegistry.getActiveIds()) {
      executionRegistry.untrack(executionId);
    }
    ToolUseFollowUpQueue.release(streamId);
  });

  function trackToolUseFlow(
    stream: StreamTabId,
    appendFollowUp: LiveToolUseFlowContext['session']['appendFollowUp'],
    executionId = `exec-${stream}`,
  ): string {
    const handle = new AgentExecutionHandle(
      executionId,
      stream,
      stream,
      'demo-agent',
      'toolUse',
      noopAgentRuntimeHost,
    );
    handle.attachToolUseFlow({
      session: { appendFollowUp },
      modelHandler: { supportsManualCompaction: true },
      runtimeHost: noopAgentRuntimeHost,
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => undefined,
      switchModel: async () => {},
    });
    executionRegistry.track(handle);
    return executionId;
  }

  it('sends follow-ups to active flow contexts', async () => {
    const calls: string[] = [];
    trackToolUseFlow(streamId, (followUp) => {
      calls.push(followUp.text);
    });

    const result = await sendFollowUp(streamId, 'hello');

    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'hello');
    assert.deepEqual(result, { status: 'sent' });
  });

  it('preserves explicit follow-up item origin for active flow contexts', async () => {
    const calls: FollowUpQueueInput[] = [];
    trackToolUseFlow(streamId, (followUp) => {
      calls.push(followUp);
    });

    const result = await sendFollowUp(streamId, {
      text: 'subagent result',
      origin: 'subagent_result',
    });

    assert.deepEqual(result, { status: 'sent' });
    assert.deepEqual(calls, [
      { text: 'subagent result', origin: 'subagent_result' },
    ]);
  });

  it('queues follow-ups when children are still running', async () => {
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
    executionRegistry.track(handle);

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
      executionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('survives prior queue release when children are running', async () => {
    // Regression: without force:true, enqueue() silently drops messages
    // on streams previously released by sessionLifecycle.dispose().
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
    executionRegistry.track(handle);
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
      executionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('queues subagent result follow-ups through the released parent queue', async () => {
    const parentStreamId = 'parent-stream-subagent-result' as StreamTabId;
    const childStreamId = 'child-stream-subagent-result' as StreamTabId;
    const executionId = 'exec-subagent-result';

    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'test-subagent',
      'toolUse',
      noopAgentRuntimeHost,
    );
    executionRegistry.track(handle);
    ToolUseFollowUpQueue.release(parentStreamId);

    try {
      const result = await sendFollowUp(parentStreamId, {
        text: 'child done',
        origin: 'subagent_result',
      });

      assert.deepEqual(result, {
        status: 'queued',
        reason: 'children_running',
      });
      assert.deepEqual(ToolUseFollowUpQueue.drainItems(parentStreamId), [
        {
          text: 'child done',
          origin: 'subagent_result',
        },
      ]);
    } finally {
      executionRegistry.untrack(executionId);
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
