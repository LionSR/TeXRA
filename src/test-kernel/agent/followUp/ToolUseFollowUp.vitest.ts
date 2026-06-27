// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'vitest';

// Standard library imports

// Local imports - agent
import { createFakePlatform } from '@test/support/FakePlatform';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import { AgentRunStateSnapshotSchema } from '@agent/core/execution/AgentState';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  AgentExecutionHandle,
  executionRegistry,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import {
  sendFollowUp,
  wakeOrReleaseQueuedStream,
} from '@agent/followUp/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
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
          // Queue items always carry the optional metadata slots explicitly.
          displayText: undefined,
          mediaFiles: undefined,
        },
      ]);
    } finally {
      executionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('serializes concurrent wakes so an in-flight resume keeps the queue', async () => {
    // Regression: hosts report an already-in-flight resume as `false` before
    // RESUMING is set, so a second concurrent wake used to release the queue
    // the first resume was about to drain.
    const parentStreamId = 'parent-stream-wake-race' as StreamTabId;
    const childStreamId = 'child-stream-wake-race' as StreamTabId;
    const executionId = 'exec-wake-race';

    let resumeCalls = 0;
    let resolveResume!: (resumed: boolean) => void;
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {},
        {
          agentResume: {
            tryResumeStream: () => {
              resumeCalls++;
              return new Promise<boolean>((resolve) => {
                resolveResume = resolve;
              });
            },
          },
        },
      ),
    );

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
      const first = await sendFollowUp(parentStreamId, 'result one');
      const second = await sendFollowUp(parentStreamId, 'result two');
      assert.deepEqual(first, { status: 'queued', reason: 'children_running' });
      assert.deepEqual(second, {
        status: 'queued',
        reason: 'children_running',
      });

      const wakes = Promise.all([
        wakeOrReleaseQueuedStream(parentStreamId, first),
        wakeOrReleaseQueuedStream(parentStreamId, second),
      ]);
      resolveResume(true);

      assert.deepEqual(await wakes, [true, true]);
      assert.equal(resumeCalls, 1);
      assert.deepEqual(ToolUseFollowUpQueue.getAll(parentStreamId), [
        'result one',
        'result two',
      ]);
    } finally {
      executionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('releases the reopened queue when the parent cannot be resumed', async () => {
    const parentStreamId = 'parent-stream-wake-dead' as StreamTabId;
    const childStreamId = 'child-stream-wake-dead' as StreamTabId;
    const executionId = 'exec-wake-dead';

    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {},
        { agentResume: { tryResumeStream: async () => false } },
      ),
    );

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
      const result = await sendFollowUp(parentStreamId, 'late result');
      assert.deepEqual(result, {
        status: 'queued',
        reason: 'children_running',
      });

      assert.equal(
        await wakeOrReleaseQueuedStream(parentStreamId, result),
        false,
      );
      assert.deepEqual(ToolUseFollowUpQueue.getAll(parentStreamId), []);
    } finally {
      executionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('keeps the reopened queue while the host has a resume in flight', async () => {
    const parentStreamId = 'parent-stream-wake-in-flight' as StreamTabId;
    const childStreamId = 'child-stream-wake-in-flight' as StreamTabId;
    const executionId = 'exec-wake-in-flight';

    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {},
        {
          agentResume: {
            tryResumeStream: async () => false,
            isResumeInFlight: (stream) => stream === parentStreamId,
          },
        },
      ),
    );

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
      const result = await sendFollowUp(parentStreamId, 'late result');
      assert.deepEqual(result, {
        status: 'queued',
        reason: 'children_running',
      });

      assert.equal(
        await wakeOrReleaseQueuedStream(parentStreamId, result),
        true,
      );
      assert.deepEqual(ToolUseFollowUpQueue.getAll(parentStreamId), [
        'late result',
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
