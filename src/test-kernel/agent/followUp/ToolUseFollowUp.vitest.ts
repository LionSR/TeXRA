// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'vitest';

// Standard library imports

// Local imports - agent
import { createFakePlatform } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  StreamStatusMachine,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentExecutionHandle,
  SharedExecutionRegistry,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import {
  sendFollowUp,
  wakeQueuedFollowUpStream,
  wakeOrReleaseQueuedStream,
} from '@agent/followUp/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

type ResumeHost = NonNullable<
  NonNullable<Parameters<typeof createFakePlatform>[1]>['agentResume']
>;

function initResumePlatform(agentResume: ResumeHost): Promise<void> {
  return installPlatform({}, { agentResume });
}

function trackChildHandle(
  executionId: string,
  parentStreamId: StreamTabId,
  childStreamId: StreamTabId,
): void {
  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    'test-subagent',
    'toolUse',
    noopAgentRuntimeHost,
  );
  SharedExecutionRegistry.track(handle);
}

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
    for (const executionId of SharedExecutionRegistry.getActiveIds()) {
      SharedExecutionRegistry.untrack(executionId);
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
    SharedExecutionRegistry.track(handle);
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

  it('reports unknown streams as no session', async () => {
    const missingStreamId = 'missing-follow-up-session' as StreamTabId;

    const result = await sendFollowUp(missingStreamId, 'hello');

    assert.deepEqual(result, {
      status: 'no_session',
      streamStatus: undefined,
    });
    assert.deepEqual(await wakeQueuedFollowUpStream(missingStreamId, result), {
      kind: 'not_required',
    });
  });

  it('queues follow-ups when children are still running', async () => {
    const parentStreamId = 'parent-stream-children' as StreamTabId;
    const childStreamId = 'child-stream-children' as StreamTabId;
    const executionId = 'exec-children-running';

    trackChildHandle(executionId, parentStreamId, childStreamId);

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
      SharedExecutionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('survives prior queue release when children are running', async () => {
    // Regression: without force:true, enqueue() silently drops messages
    // on streams previously released by sessionLifecycle.dispose().
    const parentStreamId = 'parent-stream-released' as StreamTabId;
    const childStreamId = 'child-stream-released' as StreamTabId;
    const executionId = 'exec-released';

    trackChildHandle(executionId, parentStreamId, childStreamId);
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
      SharedExecutionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('queues subagent result follow-ups through the released parent queue', async () => {
    const parentStreamId = 'parent-stream-subagent-result' as StreamTabId;
    const childStreamId = 'child-stream-subagent-result' as StreamTabId;
    const executionId = 'exec-subagent-result';

    trackChildHandle(executionId, parentStreamId, childStreamId);
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
      SharedExecutionRegistry.untrack(executionId);
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
    await initResumePlatform({
      tryResumeStream: () => {
        resumeCalls++;
        return new Promise<boolean>((resolve) => {
          resolveResume = resolve;
        });
      },
    });

    trackChildHandle(executionId, parentStreamId, childStreamId);

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
      SharedExecutionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('releases the reopened queue when the parent cannot be resumed', async () => {
    const parentStreamId = 'parent-stream-wake-dead' as StreamTabId;
    const childStreamId = 'child-stream-wake-dead' as StreamTabId;
    const executionId = 'exec-wake-dead';

    await initResumePlatform({ tryResumeStream: async () => false });

    trackChildHandle(executionId, parentStreamId, childStreamId);

    try {
      const result = await sendFollowUp(parentStreamId, 'late result');
      assert.deepEqual(result, {
        status: 'queued',
        reason: 'children_running',
      });

      assert.deepEqual(await wakeQueuedFollowUpStream(parentStreamId, result), {
        kind: 'dropped',
      });
      assert.deepEqual(ToolUseFollowUpQueue.getAll(parentStreamId), []);
    } finally {
      SharedExecutionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('reports failed waiting-stream wakes without dropping the queue', async () => {
    const waitingStreamId = 'parent-stream-wake-waiting' as StreamTabId;

    await initResumePlatform({ tryResumeStream: async () => false });
    seedStreamStatusForTest(
      StreamStatusService,
      waitingStreamId,
      STREAM_STATUS.WAITING,
    );

    try {
      const result = await sendFollowUp(
        waitingStreamId,
        'queued while waiting',
      );
      assert.deepEqual(result, {
        status: 'queued',
        reason: 'waiting',
      });

      assert.deepEqual(
        await wakeQueuedFollowUpStream(waitingStreamId, result),
        { kind: 'queued_resume_failed' },
      );
      assert.deepEqual(ToolUseFollowUpQueue.getAll(waitingStreamId), [
        'queued while waiting',
      ]);
    } finally {
      clearStreamStatusForTest(StreamStatusService, waitingStreamId);
      ToolUseFollowUpQueue.release(waitingStreamId);
    }
  });

  it('keeps the reopened queue while the host has a resume in flight', async () => {
    const parentStreamId = 'parent-stream-wake-in-flight' as StreamTabId;
    const childStreamId = 'child-stream-wake-in-flight' as StreamTabId;
    const executionId = 'exec-wake-in-flight';

    await initResumePlatform({
      tryResumeStream: async () => false,
      isResumeInFlight: (stream) => stream === parentStreamId,
    });

    trackChildHandle(executionId, parentStreamId, childStreamId);

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
      SharedExecutionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });

  it('routes the wake decision to an explicitly passed session instead of currentSession()', async () => {
    // Regression for #7161: an explicit session param must decide
    // active/resuming (and therefore wake/release) on its own state, not
    // silently fall back to the process default session.
    const parentStreamId = 'parent-stream-session-routing' as StreamTabId;

    await initResumePlatform({ tryResumeStream: async () => false });

    const result = { status: 'queued' as const, reason: 'waiting' as const };

    const routedSession = new SessionHandle({
      status: new StreamStatusMachine(),
    });
    seedStreamStatusForTest(
      routedSession.status,
      parentStreamId,
      STREAM_STATUS.RUNNING,
    );

    try {
      // The explicit session marks this stream RUNNING (active), so passing
      // it must make the wake decision defer to it.
      assert.deepEqual(
        await wakeQueuedFollowUpStream(
          parentStreamId,
          result,
          undefined,
          routedSession,
        ),
        { kind: 'active_or_resuming' },
      );

      // Without an explicit session, the decision falls back to
      // currentSession() (the process default), whose StreamStatusService
      // has no state for this stream — proving the two sessions are not
      // conflated and the routed session's state actually drove the result
      // above.
      assert.deepEqual(await wakeQueuedFollowUpStream(parentStreamId, result), {
        kind: 'queued_resume_failed',
      });
    } finally {
      clearStreamStatusForTest(routedSession.status, parentStreamId);
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
