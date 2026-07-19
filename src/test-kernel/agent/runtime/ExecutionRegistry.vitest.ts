// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { getExecutionStore } from '@agent/storage';
import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  AgentExecutionHandle,
  ProcessExecutionHandle,
  type LiveToolUseFlowContext,
} from '@agent/runtime/ExecutionHandle';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { ProcessOutputPoller } from '@agent/runtime/ProcessOutputPoller';
import {
  SessionEventHub,
  type SessionEvent,
} from '@agent/runtime/SessionEventHub';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { createSessionApprovals } from '@agent/runtime/streamApprovalQueue';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { seedStreamStatusForTest } from '@test/helpers/streamStatusTestUtils';

import {
  createRecordingHost,
  recordSessionEvents,
  runEventsOfType,
  sessionFactPayloads,
} from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn(),
  synchronizeAgentResultOutcome: vi.fn(),
}));

const channelTraceMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@agent/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/storage')>();
  storageMocks.finalizeExecution.mockImplementation(actual.finalizeExecution);
  storageMocks.synchronizeAgentResultOutcome.mockImplementation(
    actual.synchronizeAgentResultOutcome,
  );
  return {
    ...actual,
    finalizeExecution: storageMocks.finalizeExecution,
    synchronizeAgentResultOutcome: storageMocks.synchronizeAgentResultOutcome,
  };
});

vi.mock('@agent/trace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/trace')>();
  return {
    ...actual,
    createChannelTrace: vi.fn(() => ({
      ...actual.noopTrace,
      warn: channelTraceMocks.warn,
    })),
  };
});

setupPlatform({ workspacePath: '/workspace' });

/** Builds an `AgentExecutionHandle` for a toolUse test-subagent, the shape most tests need. */
function createHandle(
  executionId: string,
  parentStreamId: StreamTabId,
  childStreamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
  overrides: {
    agentName?: string;
    category?: AgentCategory;
    trace?: AgentTrace;
  } = {},
): AgentExecutionHandle {
  return new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    overrides.agentName ?? 'test-subagent',
    overrides.category ?? AgentCategory.ToolUse,
    runtimeHost,
    overrides.trace,
  );
}

describe('executionRegistry', () => {
  it('settles without persisting a stopped waiting handle after lease loss', async () => {
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-waiting-lease-lost' as ExecutionId;
    const streamId = 'stream-waiting-lease-lost' as StreamTabId;
    const handle = createHandle(
      executionId,
      streamId,
      streamId,
      createRecordingHost().host,
    );
    storageMocks.finalizeExecution.mockClear();

    try {
      registry.track(handle);
      handle.registerWaitingCleanup(() => {});
      handle.markExecutionLeaseLost();
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.WAITING);

      expect(registry.kill(executionId)).toBe(true);
      await expect(handle.result).resolves.toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.CANCELLED,
        executionId,
      });
      expect(storageMocks.finalizeExecution).not.toHaveBeenCalled();
      expect(registry.getHandle(executionId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('observes the current handle, replacements, and removal in order', () => {
    const registry = new ExecutionRegistry();
    const executionId = 'exec-observe-handle';
    const streamId = 'stream-observe-handle' as StreamTabId;
    const first = createHandle(
      executionId,
      streamId,
      streamId,
      createRecordingHost().host,
      { agentName: 'first', category: AgentCategory.Workflow },
    );
    const second = createHandle(
      executionId,
      streamId,
      streamId,
      createRecordingHost().host,
      { agentName: 'second', category: AgentCategory.Workflow },
    );
    const registrations: unknown[] = [];
    const detachRegistrations = registry.addRegistrationListener(
      (changedId, handle) => {
        if (changedId === executionId) registrations.push(handle);
      },
    );
    registry.track(first);
    const seen: unknown[] = [];
    const detach = registry.observeHandle(executionId, (handle) => {
      seen.push(handle);
    });

    registry.track(second);
    registry.untrack(executionId);

    expect(seen).toEqual([first, second, undefined]);
    expect(registrations).toEqual([first, second, undefined]);
    detach();
    detachRegistrations();
    registry.dispose();
  });

  it('owns process-output poller teardown', () => {
    const explicit = createRecordingHost();
    const processOutput = new ProcessOutputPoller();
    const dispose = vi.spyOn(processOutput, 'dispose');
    const flush = vi.spyOn(processOutput, 'flush');
    const registry = new ExecutionRegistry({ processOutput });
    const handle = new ProcessExecutionHandle(
      'exec-process-output-dispose-test',
      'stream-process-output-dispose-test' as StreamTabId,
      'bash',
      () => true,
      explicit.host,
    );

    registry.track(handle);
    registry.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(flush).not.toHaveBeenCalled();
  });

  it('drains a background-bash AgentExecutionHandle on shutdown without disturbing a resumable agent execution (issue #8155)', () => {
    // Regression for #8155: killBackgroundProcesses() previously only walked
    // ProcessExecutionHandles, missing a background `bash` run — which is
    // registered as an AgentExecutionHandle (see createChildStream in
    // tools/bash.ts) with its OS-process kill reachable only via the
    // interrupt handler BashBackgroundSession attaches. The two AgentExecutionHandles
    // below are tracked concurrently, mirroring the real interleaving at
    // shutdown: a background bash child stream alongside an ordinary
    // resumable agent execution (e.g. a native subagent loop, whose own
    // loop-level interrupt handler must stay untouched so restart recovery
    // can resume it). Drain must reach only the former.
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const bashExecutionId = 'exec-background-bash-drain-test';
    const bashParentStreamId =
      'parent-background-bash-drain-test' as StreamTabId;
    const bashChildStreamId = 'child-background-bash-drain-test' as StreamTabId;
    const agentExecutionId = 'exec-resumable-agent-drain-test';
    const agentParentStreamId =
      'parent-resumable-agent-drain-test' as StreamTabId;
    const agentChildStreamId =
      'child-resumable-agent-drain-test' as StreamTabId;
    const bashInterrupt = vi.fn();
    const agentInterrupt = vi.fn();
    const processKillFn = vi.fn(() => true);

    try {
      // Background bash: an AgentExecutionHandle whose attached interrupt
      // handler owns a live OS process (mirrors BashBackgroundSession).
      const bashHandle = createHandle(
        bashExecutionId,
        bashParentStreamId,
        bashChildStreamId,
        explicit.host,
        { agentName: 'bash' },
      );
      bashHandle.attachInterruptHandler({
        interrupt: bashInterrupt,
        ownsBackgroundProcess: true,
      });
      registry.trackAgentExecution(bashHandle, {
        status: STREAM_PHASE.RUNNING,
      });

      // Ordinary agent execution (e.g. a native-subagent loop's own
      // loop-level interrupt handler): no ownsBackgroundProcess flag, so
      // shutdown drain must leave it alone for restart recovery.
      const agentHandle = createHandle(
        agentExecutionId,
        agentParentStreamId,
        agentChildStreamId,
        explicit.host,
      );
      agentHandle.attachInterruptHandler({ interrupt: agentInterrupt });
      registry.trackAgentExecution(agentHandle, {
        status: STREAM_PHASE.RUNNING,
      });

      // A genuine background process handle keeps working exactly as before.
      const processHandle = new ProcessExecutionHandle(
        'exec-process-drain-test',
        bashParentStreamId,
        'bash',
        processKillFn,
        explicit.host,
      );
      registry.track(processHandle);

      registry.killBackgroundProcesses();

      expect(bashInterrupt).toHaveBeenCalledOnce();
      expect(processKillFn).toHaveBeenCalledOnce();
      expect(agentInterrupt).not.toHaveBeenCalled();
      // Neither AgentExecutionHandle's tracked status changes: killing a
      // background OS process bypasses the generic terminate()/kill() path
      // (and its cancelStreamStatus side effect) so restart recovery still
      // finds both handles exactly as it would have before shutdown.
      expect(streamStatus.get(bashChildStreamId)).toBe(STREAM_PHASE.RUNNING);
      expect(streamStatus.get(agentChildStreamId)).toBe(STREAM_PHASE.RUNNING);
      expect(registry.getHandle(bashExecutionId)).toBe(bashHandle);
      expect(registry.getHandle(agentExecutionId)).toBe(agentHandle);
    } finally {
      registry.dispose();
    }
  });

  it('uses the handle interrupt target when terminating agent handles', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-injected-interrupt-test';
    const parentStreamId = 'parent-injected-interrupt-test' as StreamTabId;
    const childStreamId = 'child-injected-interrupt-test' as StreamTabId;
    const interrupt = vi.fn();

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        explicit.host,
      );
      handle.attachInterruptHandler({ interrupt });
      registry.track(handle);

      expect(registry.kill(executionId)).toBe(true);

      expect(interrupt).toHaveBeenCalledOnce();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
    } finally {
      registry.dispose();
    }
  });

  it('falls back to a registered waiting-cleanup when a suspended handle has no live interrupt (issue #7287)', () => {
    // Regression: a native subagent suspended at WAITING has already had its
    // live interrupt context detached (runToolUseFlow's finally), while the
    // handle stays tracked for resume. Before the fix, terminate() found no
    // interrupt target and silently no-opped, leaving the handle stuck
    // registered forever with no way to tear it down from a stop/kill.
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-waiting-cleanup-kill-test';
    const parentStreamId = 'parent-waiting-cleanup-kill-test' as StreamTabId;
    const childStreamId = 'child-waiting-cleanup-kill-test' as StreamTabId;
    const cleanup = vi.fn();

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        explicit.host,
      );
      registry.track(handle);
      handle.registerWaitingCleanup(cleanup);
      // No handle interrupt target: mirrors a suspended subagent whose live
      // tool-use session has already been disposed.
      // Genuinely suspended: only `transitionToWaiting` reaches this status.
      seedStreamStatusForTest(
        streamStatus,
        childStreamId,
        STREAM_STATUS.WAITING,
      );

      expect(registry.kill(executionId)).toBe(true);

      expect(cleanup).toHaveBeenCalledOnce();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(registry.getHandle(executionId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('publishes the cancelled terminal result when killing a suspended WAITING handle (Bugbot: waiting kill omits trace result)', async () => {
    // Regression: terminateWaitingHandle settles handle.result and the run's
    // own (already-disposed, per runFlowWithLifecycle's finally) trace, but
    // previously never told the owning session about the terminal event —
    // trace/session-result-stream subscribers (session.onResult et al.) would
    // silently miss a user-initiated stop of a suspended native subagent even
    // though handle.result itself resolved correctly. `publishResult` is the
    // callback SessionHandle injects (see SessionHandle.publishRunEvent) so
    // this path can reach those subscribers directly, since the turn's own
    // trace subscriptions are already torn down by the time a kill runs.
    const streamStatus = new StreamStatusMachine();
    const publishResult = vi.fn();
    const registry = new ExecutionRegistry({
      streamStatus,
      events: new SessionEventHub(),
      publishResult,
    });
    const executionId = 'exec-waiting-kill-publish-result-test';
    const parentStreamId =
      'parent-waiting-kill-publish-result-test' as StreamTabId;
    const childStreamId =
      'child-waiting-kill-publish-result-test' as StreamTabId;
    const trace: AgentTrace = { emit: vi.fn() } as unknown as AgentTrace;

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        createRecordingHost().host,
        { trace },
      );
      registry.track(handle);
      handle.registerWaitingCleanup(() => {});
      // Genuinely suspended: only `transitionToWaiting` reaches this status.
      seedStreamStatusForTest(
        streamStatus,
        childStreamId,
        STREAM_STATUS.WAITING,
      );

      expect(registry.kill(executionId)).toBe(true);

      expect(publishResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: 'result',
          outcome: RUN_OUTCOME.CANCELLED,
          executionId,
          streamId: childStreamId,
        }),
        childStreamId,
      );
      // The (already-disposed-in-production) trace still gets a best-effort
      // emit — harmless when there are no subscribers left, but exercised
      // here to confirm the call site didn't drop it. (A second, unrelated
      // `trace.emit` call comes from the streamStatus transition below.)
      expect(trace.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          outcome: RUN_OUTCOME.CANCELLED,
        }),
      );
      await expect(handle.result).resolves.toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.CANCELLED,
        executionId,
      });
    } finally {
      registry.dispose();
    }
  });

  it('settles and untracks a waiting handle when terminal metadata persistence fails', async () => {
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-waiting-kill-metadata-failure' as ExecutionId;
    const parentStreamId =
      'parent-waiting-kill-metadata-failure' as StreamTabId;
    const childStreamId = 'child-waiting-kill-metadata-failure' as StreamTabId;
    const durabilityError = new Error('metadata disk write failed');
    storageMocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      stage: 'terminal-status',
      terminalStatusPersisted: false,
      error: durabilityError,
    });
    storageMocks.synchronizeAgentResultOutcome.mockClear();
    channelTraceMocks.warn.mockClear();

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        createRecordingHost().host,
      );
      registry.track(handle);
      handle.registerWaitingCleanup(() => {});
      seedStreamStatusForTest(
        streamStatus,
        childStreamId,
        STREAM_STATUS.WAITING,
      );

      expect(registry.kill(executionId)).toBe(true);

      await expect(handle.result).resolves.toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.CANCELLED,
        executionId,
      });
      expect(registry.getHandle(executionId)).toBeUndefined();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
      await vi.waitFor(() => {
        expect(channelTraceMocks.warn).toHaveBeenCalledExactlyOnceWith(
          'Failed to finalize stopped waiting execution',
          {
            data: {
              executionId,
              stage: 'terminal-status',
              terminalStatusPersisted: false,
              error: durabilityError,
            },
          },
        );
      });
      expect(storageMocks.synchronizeAgentResultOutcome).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
    }
  });

  it('synchronizes a waiting stop when only flow-record deletion fails', async () => {
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-waiting-kill-flow-delete-failure' as ExecutionId;
    const parentStreamId =
      'parent-waiting-kill-flow-delete-failure' as StreamTabId;
    const childStreamId =
      'child-waiting-kill-flow-delete-failure' as StreamTabId;
    const cleanupError = new Error('flow delete failed');
    storageMocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      stage: 'flow-record-delete',
      terminalStatusPersisted: true,
      error: cleanupError,
    });
    storageMocks.synchronizeAgentResultOutcome.mockResolvedValueOnce(undefined);
    storageMocks.synchronizeAgentResultOutcome.mockClear();
    channelTraceMocks.warn.mockClear();

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        createRecordingHost().host,
      );
      registry.track(handle);
      handle.registerWaitingCleanup(() => {});
      seedStreamStatusForTest(
        streamStatus,
        childStreamId,
        STREAM_STATUS.WAITING,
      );

      expect(registry.kill(executionId)).toBe(true);

      await vi.waitFor(() => {
        expect(
          storageMocks.synchronizeAgentResultOutcome,
        ).toHaveBeenCalledExactlyOnceWith(executionId, RUN_OUTCOME.CANCELLED);
      });
      expect(channelTraceMocks.warn).toHaveBeenCalledExactlyOnceWith(
        'Failed to finalize stopped waiting execution',
        {
          data: {
            executionId,
            stage: 'flow-record-delete',
            terminalStatusPersisted: true,
            error: cleanupError,
          },
        },
      );
    } finally {
      registry.dispose();
    }
  });

  it('reports a failed kill for a tracked handle with neither an interrupt nor a waiting-cleanup', () => {
    // Guards the fallback above: a handle that never registered a
    // waiting-cleanup (i.e. was never confirmed suspended at WAITING) must
    // still no-op exactly like before the fix — otherwise the fallback could
    // spuriously tear down a handle mid-completion, in the narrow window
    // between its own interrupt unregister and its own untrack.
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-no-cleanup-kill-test';
    const parentStreamId = 'parent-no-cleanup-kill-test' as StreamTabId;
    const childStreamId = 'child-no-cleanup-kill-test' as StreamTabId;

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        createRecordingHost().host,
      );
      registry.track(handle);

      expect(registry.kill(executionId)).toBe(false);

      expect(streamStatus.get(childStreamId)).toBeUndefined();
      expect(registry.getHandle(executionId)).toBe(handle);
    } finally {
      registry.dispose();
    }
  });

  it('does not abandon a handle with a stale waiting-cleanup when the stream never actually reached WAITING (review: waiting cleanup on non-suspend paths)', () => {
    // A registered waiting-cleanup alone does not prove genuine suspension —
    // if a registrant ever registers one without the flow actually
    // transitioning to WAITING (streamStatus stays whatever it was), and a
    // kill lands in the narrow window between that turn's interrupt-
    // unregister and its handle's normal untrack, terminate() must not
    // mistake the stale registered cleanup for a genuine suspension and
    // incorrectly abandon/cancel a run that is still executing or has
    // already completed. `runFlowWithLifecycle` is the only registrant today
    // (see AgentRunLifecycle.ts) and only registers after `streamStatus` has
    // already reached WAITING, so this guard is defensive against any future
    // registrant that doesn't hold that invariant.
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-non-suspend-stale-cleanup-test';
    const parentStreamId =
      'parent-non-suspend-stale-cleanup-test' as StreamTabId;
    const childStreamId = 'child-non-suspend-stale-cleanup-test' as StreamTabId;
    const cleanup = vi.fn();

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        createRecordingHost().host,
      );
      registry.track(handle);
      // A cleanup gets registered directly here, simulating any registrant
      // that registers one without the flow actually suspending — streamStatus
      // was never transitioned to WAITING (no `transitionToWaiting` call).
      handle.registerWaitingCleanup(cleanup);

      expect(registry.kill(executionId)).toBe(false);

      expect(cleanup).not.toHaveBeenCalled();
      expect(registry.getHandle(executionId)).toBe(handle);
    } finally {
      registry.dispose();
    }
  });

  it('tears down and aligns a suspended handle killed during RESUMING', async () => {
    // Regression: `resumeQueuedToolUseFromResumeData` flips `streamStatus` to
    // RUNNING with a RESUMING substate *before* the resumed run installs its
    // own interrupt context. A kill landing in that window would otherwise
    // find this same still-suspended handle (its waiting-cleanup from the
    // earlier genuine WAITING suspension is still registered) but a
    // non-WAITING phase, and get wrongly no-opped by the WAITING-only guard
    // above — silently ignoring a stop the user actually issued.
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-resuming-window-kill-test' as ExecutionId;
    const parentStreamId = 'parent-resuming-window-kill-test' as StreamTabId;
    const childStreamId = 'child-resuming-window-kill-test' as StreamTabId;
    const cleanup = vi.fn();
    const store = getExecutionStore(executionId);

    try {
      await store.writeMeta({
        timestamp: '2026-07-10T00:00:00.000Z',
        outcome: RUN_OUTCOME.COMPLETED,
      });
      await store.writeResultMeta({
        producer: 'subagent',
        agentName: 'test-subagent',
        wallTimeMs: 1,
        result: {
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          response: 'interim response',
          files: [],
          cost: 0,
        },
      });
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        createRecordingHost().host,
      );
      registry.track(handle);
      handle.registerWaitingCleanup(cleanup);
      // Mirrors resumeQueuedToolUseFromResumeData's status flip that runs ahead of
      // the resumed run's own context — RUNNING phase, RESUMING substate.
      seedStreamStatusForTest(
        streamStatus,
        childStreamId,
        STREAM_STATUS.RESUMING,
      );

      expect(registry.kill(executionId)).toBe(true);

      expect(cleanup).toHaveBeenCalledOnce();
      expect(registry.getHandle(executionId)).toBeUndefined();
      await vi.waitFor(async () => {
        await expect(store.readMeta()).resolves.toMatchObject({
          outcome: RUN_OUTCOME.CANCELLED,
        });
        await expect(store.readResultMeta()).resolves.toMatchObject({
          result: {
            outcome: RUN_OUTCOME.CANCELLED,
            response: 'interim response',
          },
        });
      });
    } finally {
      registry.dispose();
    }
  });

  it('owns visible stream stop policy for root and children', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const events = new SessionEventHub();
    const recorded = recordSessionEvents(events, { scope: 'session' });
    const registry = new ExecutionRegistry({
      streamStatus,
      events,
    });
    const rootStreamId = 'root-stop-policy-test' as StreamTabId;
    const childStreamId = 'child-stop-policy-test' as StreamTabId;
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();

    try {
      const rootHandle = createHandle(
        'exec-root-stop-policy-test',
        rootStreamId,
        rootStreamId,
        explicit.host,
        { agentName: 'test-root' },
      );
      rootHandle.attachInterruptHandler({ interrupt: rootInterrupt });
      registry.track(rootHandle);
      const childHandle = createHandle(
        'exec-child-stop-policy-test',
        rootStreamId,
        childStreamId,
        explicit.host,
      );
      childHandle.attachInterruptHandler({ interrupt: childInterrupt });
      registry.track(childHandle);

      expect(
        registry.stopAgentStream(rootStreamId, {
          runtimeHost: explicit.host,
        }),
      ).toEqual({
        kind: 'interrupted',
        streamId: rootStreamId,
        childPolicy: 'cascade',
      });

      expect(rootInterrupt).toHaveBeenCalledOnce();
      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(streamStatus.get(rootStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(
        sessionFactPayloads(recorded.events, 'updateStreamStatus'),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: STREAM_PHASE.CANCELLED,
          }),
        ]),
      );
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('interrupts grandchildren when killing a subagent chain', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const rootStreamId = 'root-cascade-test' as StreamTabId;
    const childStreamId = 'child-cascade-test' as StreamTabId;
    const grandchildStreamId = 'grandchild-cascade-test' as StreamTabId;
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      const childHandle = createHandle(
        'exec-child-cascade-test',
        rootStreamId,
        childStreamId,
        explicit.host,
      );
      childHandle.attachInterruptHandler({ interrupt: childInterrupt });
      registry.track(childHandle);
      const grandchildHandle = createHandle(
        'exec-grandchild-cascade-test',
        childStreamId,
        grandchildStreamId,
        explicit.host,
        { agentName: 'test-grandchild' },
      );
      grandchildHandle.attachInterruptHandler({
        interrupt: grandchildInterrupt,
      });
      registry.track(grandchildHandle);

      expect(registry.kill('exec-child-cascade-test')).toBe(true);

      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(grandchildInterrupt).toHaveBeenCalledOnce();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(streamStatus.get(grandchildStreamId)).toBe(STREAM_PHASE.CANCELLED);
    } finally {
      registry.dispose();
    }
  });

  it('detaches descendants when killing with detached subagents', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const events = new SessionEventHub();
    const recorded = recordSessionEvents(events, { scope: 'session' });
    const registry = new ExecutionRegistry({
      streamStatus,
      events,
    });
    const rootStreamId = 'root-detach-kill-test' as StreamTabId;
    const childStreamId = 'child-detach-kill-test' as StreamTabId;
    const grandchildStreamId = 'grandchild-detach-kill-test' as StreamTabId;
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      const childHandle = createHandle(
        'exec-child-detach-kill-test',
        rootStreamId,
        childStreamId,
        explicit.host,
      );
      childHandle.attachInterruptHandler({ interrupt: childInterrupt });
      registry.track(childHandle);
      const grandchildHandle = createHandle(
        'exec-grandchild-detach-kill-test',
        childStreamId,
        grandchildStreamId,
        explicit.host,
        { agentName: 'test-grandchild' },
      );
      grandchildHandle.attachInterruptHandler({
        interrupt: grandchildInterrupt,
      });
      registry.track(grandchildHandle);

      expect(
        registry.kill('exec-child-detach-kill-test', {
          detachActiveChildren: true,
        }),
      ).toBe(true);

      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(grandchildInterrupt).not.toHaveBeenCalled();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(streamStatus.get(grandchildStreamId)).toBeUndefined();
      expect(
        registry.getAgentHandleByStream(grandchildStreamId)?.parentStreamId,
      ).toBe(grandchildStreamId);
      expect(
        sessionFactPayloads(recorded.events, 'setParentStream'),
      ).toContainEqual({
        childStreamId: grandchildStreamId,
        parentStreamId: null,
      });
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('detaches children when stopping a stream with detached subagents', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const events = new SessionEventHub();
    const recorded = recordSessionEvents(events, { scope: 'session' });
    const registry = new ExecutionRegistry({
      streamStatus,
      events,
    });
    const rootStreamId = 'root-detach-stop-policy-test' as StreamTabId;
    const childStreamId = 'child-detach-stop-policy-test' as StreamTabId;
    const grandchildStreamId =
      'grandchild-detach-stop-policy-test' as StreamTabId;
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      const rootHandle = createHandle(
        'exec-root-detach-stop-policy-test',
        rootStreamId,
        rootStreamId,
        explicit.host,
        { agentName: 'test-root' },
      );
      rootHandle.attachInterruptHandler({ interrupt: rootInterrupt });
      registry.track(rootHandle);
      const childHandle = createHandle(
        'exec-child-detach-stop-policy-test',
        rootStreamId,
        childStreamId,
        explicit.host,
      );
      childHandle.attachInterruptHandler({ interrupt: childInterrupt });
      registry.track(childHandle);
      const grandchildHandle = createHandle(
        'exec-grandchild-detach-stop-policy-test',
        childStreamId,
        grandchildStreamId,
        explicit.host,
        { agentName: 'test-grandchild' },
      );
      grandchildHandle.attachInterruptHandler({
        interrupt: grandchildInterrupt,
      });
      registry.track(grandchildHandle);

      expect(
        registry.stopAgentStream(rootStreamId, {
          detachActiveChildren: true,
          runtimeHost: explicit.host,
        }),
      ).toEqual({
        kind: 'interrupted',
        streamId: rootStreamId,
        childPolicy: 'detach',
      });

      expect(rootInterrupt).toHaveBeenCalledOnce();
      expect(childInterrupt).not.toHaveBeenCalled();
      expect(grandchildInterrupt).not.toHaveBeenCalled();
      expect(registry.getActiveChildren(rootStreamId).subagents).toHaveLength(
        0,
      );
      expect(
        registry.getAgentHandleByStream(childStreamId)?.parentStreamId,
      ).toBe(childStreamId);
      expect(
        registry.getAgentHandleByStream(grandchildStreamId)?.parentStreamId,
      ).toBe(childStreamId);
      expect(registry.getActiveChildren(childStreamId).subagents).toEqual([
        expect.objectContaining({ childStreamId: grandchildStreamId }),
      ]);
      expect(streamStatus.get(rootStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(streamStatus.get(childStreamId)).toBeUndefined();
      expect(streamStatus.get(grandchildStreamId)).toBeUndefined();
      expect(
        sessionFactPayloads(recorded.events, 'setParentStream'),
      ).toContainEqual({
        childStreamId,
        parentStreamId: null,
      });
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('marks an ownerless stream stopped when a host can publish status', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const events = new SessionEventHub();
    const recorded = recordSessionEvents(events, { scope: 'session' });
    const registry = new ExecutionRegistry({ streamStatus, events });
    const streamId = 'ownerless-stop-policy-test' as StreamTabId;

    try {
      expect(
        registry.stopAgentStream(streamId, {
          runtimeHost: explicit.host,
        }),
      ).toEqual({
        kind: 'marked_stopped',
        streamId,
        childPolicy: 'cascade',
      });
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(
        sessionFactPayloads(recorded.events, 'updateStreamStatus').at(-1),
      ).toMatchObject({
        status: STREAM_PHASE.CANCELLED,
      });
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('reports no target when no execution or host owns the stream', () => {
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const streamId = 'missing-stop-target-test' as StreamTabId;

    try {
      expect(registry.stopAgentStream(streamId)).toEqual({
        kind: 'no_target',
        streamId,
        childPolicy: 'cascade',
      });
      expect(streamStatus.get(streamId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('reports agent status from its stream-status owner', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const parentStreamId = 'parent-owned-status-test' as StreamTabId;
    const childStreamId = 'child-owned-status-test' as StreamTabId;
    const executionId = 'exec-owned-status-test';

    try {
      seedStreamStatusForTest(
        streamStatus,
        childStreamId,
        STREAM_STATUS.WAITING,
      );
      registry.track(
        createHandle(executionId, parentStreamId, childStreamId, explicit.host),
      );

      expect(registry.getActiveChildren(parentStreamId).subagents).toEqual([
        expect.objectContaining({
          executionId,
          status: STREAM_STATUS.WAITING,
        }),
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('publishes initial status when tracking an agent execution', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const parentStreamId = 'parent-track-agent-status-test' as StreamTabId;
    const childStreamId = 'child-track-agent-status-test' as StreamTabId;
    const executionId = 'exec-track-agent-status-test';

    try {
      registry.trackAgentExecution(
        createHandle(executionId, parentStreamId, childStreamId, explicit.host),
        { status: STREAM_STATUS.RUNNING },
      );

      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.RUNNING);
      expect(registry.getActiveChildren(parentStreamId).subagents).toEqual([
        expect.objectContaining({
          executionId,
          status: STREAM_STATUS.RUNNING,
        }),
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('updates live agent status without reviving stopped or stale handles', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const parentStreamId = 'parent-update-agent-status-test' as StreamTabId;
    const childStreamId = 'child-update-agent-status-test' as StreamTabId;
    const executionId = 'exec-update-agent-status-test';
    const handle = createHandle(
      executionId,
      parentStreamId,
      childStreamId,
      explicit.host,
    );

    try {
      registry.trackAgentExecution(handle, { status: STREAM_STATUS.RUNNING });

      expect(
        registry.updateAgentExecutionStatus(handle, STREAM_STATUS.WAITING),
      ).toBe(true);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.WAITING);

      seedStreamStatusForTest(
        streamStatus,
        childStreamId,
        STREAM_PHASE.CANCELLED,
      );
      expect(registry.getActiveChildren(parentStreamId).subagents).toEqual([
        expect.objectContaining({
          executionId,
          status: STREAM_PHASE.CANCELLED,
        }),
      ]);
      expect(
        registry.updateAgentExecutionStatus(handle, STREAM_STATUS.RUNNING),
      ).toBe(false);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);

      registry.untrack(executionId);
      seedStreamStatusForTest(
        streamStatus,
        childStreamId,
        STREAM_STATUS.WAITING,
      );
      expect(
        registry.updateAgentExecutionStatus(handle, STREAM_STATUS.RUNNING),
      ).toBe(false);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.WAITING);
    } finally {
      registry.dispose();
    }
  });

  it('reports a missing runtime host when detach cannot be applied', () => {
    const registry = new ExecutionRegistry();
    const streamId = 'missing-host-detach-stop-policy-test' as StreamTabId;

    try {
      expect(
        registry.stopAgentStream(streamId, {
          detachActiveChildren: true,
        }),
      ).toEqual({
        kind: 'missing_runtime_host',
        streamId,
        childPolicy: 'detach',
      });
    } finally {
      registry.dispose();
    }
  });

  it('projects handle updates from session events', () => {
    const explicit = createRecordingHost();
    const events = new SessionEventHub();
    const recorded = recordSessionEvents(events);
    const registry = new ExecutionRegistry({ events });
    const executionId = 'exec-handle-runtime-host-test';
    const parentStreamId = 'parent-handle-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-handle-runtime-host-test' as StreamTabId;

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        explicit.host,
      );

      registry.track(handle);
      registry.untrack(executionId);

      const childActivity = runEventsOfType(recorded.events, 'child.activity');
      expect(childActivity[0]).toMatchObject({
        kind: 'subagents',
        parentStreamId,
        items: [
          {
            executionId,
            agentName: 'test-subagent',
            childStreamId,
          },
        ],
      });
      expect(
        sessionFactPayloads(recorded.events, 'setParentStream'),
      ).toContainEqual({
        childStreamId,
        parentStreamId,
      });
      expect(childActivity.at(-1)).toMatchObject({
        kind: 'subagents',
        parentStreamId,
        items: [],
      });
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('publishes parent links through the attached session event hub', () => {
    const explicit = createRecordingHost();
    const events = new SessionEventHub();
    const seen: SessionEvent[] = [];
    const detach = events.subscribe((event) => seen.push(event));
    const registry = new ExecutionRegistry({ events });
    const executionId = 'exec-session-parent-link-test';
    const parentStreamId = 'parent-session-parent-link-test' as StreamTabId;
    const childStreamId = 'child-session-parent-link-test' as StreamTabId;

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        explicit.host,
      );

      registry.track(handle);

      expect(explicit.events).toEqual([]);
      expect(seen).toContainEqual({
        scope: 'session',
        event: {
          type: 'setParentStream',
          payload: {
            childStreamId,
            parentStreamId,
          },
        },
      });
    } finally {
      detach();
      registry.dispose();
    }
  });

  it('clears live tool-use context while the handle remains tracked', () => {
    const explicit = createRecordingHost();
    const registry = new ExecutionRegistry();
    const executionId = 'exec-live-flow-context-test';
    const streamId = 'stream-live-flow-context-test' as StreamTabId;
    const context: LiveToolUseFlowContext = {
      session: {
        appendFollowUp: vi.fn(),
      },
      modelHandler: {
        supportsManualCompaction: true,
      },
      runtimeHost: explicit.host,
      requestImmediateCompaction: vi.fn(),
      modelSwitchDisabledReason: vi.fn(),
      switchModel: vi.fn(),
      interrupt: vi.fn(),
    };

    try {
      const handle = createHandle(
        executionId,
        streamId,
        streamId,
        explicit.host,
        { agentName: 'test-tool-use' },
      );

      handle.attachToolUseFlow(context);
      registry.track(handle);

      expect(registry.getToolUseFlowContext(streamId)).toBe(context);

      handle.detachToolUseFlow(context);

      expect(registry.getToolUseFlowContext(streamId)).toBeUndefined();
      expect(registry.getAgentHandleByStream(streamId)).toBe(handle);
    } finally {
      registry.dispose();
    }
  });

  it('owns manual compaction admission for active tool-use flows', () => {
    const explicit = createRecordingHost();
    const registry = new ExecutionRegistry();
    const streamId = 'stream-manual-compaction-test' as StreamTabId;
    const unsupportedStreamId =
      'stream-manual-compaction-unsupported-test' as StreamTabId;
    const requestImmediateCompaction = vi.fn();
    const ownerSession = {} as SessionHandle;
    const context: LiveToolUseFlowContext = {
      ownerSession,
      session: {
        appendFollowUp: vi.fn(),
      },
      modelHandler: {
        supportsManualCompaction: true,
      },
      runtimeHost: explicit.host,
      requestImmediateCompaction,
      modelSwitchDisabledReason: vi.fn(),
      switchModel: vi.fn(),
      interrupt: vi.fn(),
    };
    const unsupportedContext: LiveToolUseFlowContext = {
      ...context,
      modelHandler: {
        supportsManualCompaction: false,
      },
      requestImmediateCompaction: vi.fn(),
    };

    try {
      expect(registry.requestManualCompaction(undefined)).toEqual({
        kind: 'no_active_tool_use',
      });
      expect(registry.requestManualCompaction(streamId)).toEqual({
        kind: 'no_active_tool_use',
        streamId,
      });

      const handle = createHandle(
        'exec-manual-compaction-test',
        streamId,
        streamId,
        explicit.host,
        { agentName: 'test-tool-use' },
      );
      handle.attachToolUseFlow(context);
      registry.track(handle);

      const unsupportedHandle = createHandle(
        'exec-manual-compaction-unsupported-test',
        unsupportedStreamId,
        unsupportedStreamId,
        explicit.host,
        { agentName: 'test-tool-use' },
      );
      unsupportedHandle.attachToolUseFlow(unsupportedContext);
      registry.track(unsupportedHandle);

      expect(registry.requestManualCompaction(unsupportedStreamId)).toEqual({
        kind: 'unsupported',
        streamId: unsupportedStreamId,
      });
      expect(
        unsupportedContext.requestImmediateCompaction,
      ).not.toHaveBeenCalled();

      expect(registry.requestManualCompaction(streamId)).toEqual({
        kind: 'requested',
        streamId,
        session: ownerSession,
      });
      expect(requestImmediateCompaction).toHaveBeenCalledOnce();
    } finally {
      registry.dispose();
    }
  });

  it('owns tool-use follow-up admission from status, context, and children', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const activeStreamId = 'stream-follow-up-active-test' as StreamTabId;
    const resumingStreamId = 'stream-follow-up-resuming-test' as StreamTabId;
    const waitingStreamId = 'stream-follow-up-waiting-test' as StreamTabId;
    const stoppedStreamId = 'stream-follow-up-stopped-test' as StreamTabId;
    const parentStreamId = 'stream-follow-up-parent-test' as StreamTabId;
    const childStreamId = 'stream-follow-up-child-test' as StreamTabId;
    const context: LiveToolUseFlowContext = {
      session: {
        appendFollowUp: vi.fn(),
      },
      modelHandler: {
        supportsManualCompaction: true,
      },
      runtimeHost: explicit.host,
      requestImmediateCompaction: vi.fn(),
      modelSwitchDisabledReason: vi.fn(),
      switchModel: vi.fn(),
      interrupt: vi.fn(),
    };

    try {
      const activeHandle = createHandle(
        'exec-follow-up-active-test',
        activeStreamId,
        activeStreamId,
        explicit.host,
        { agentName: 'test-tool-use' },
      );
      activeHandle.attachToolUseFlow(context);
      registry.track(activeHandle);
      seedStreamStatusForTest(
        streamStatus,
        activeStreamId,
        STREAM_STATUS.RUNNING,
      );

      expect(registry.getToolUseFollowUpTarget(activeStreamId)).toEqual({
        kind: 'active',
        context,
      });

      seedStreamStatusForTest(
        streamStatus,
        resumingStreamId,
        STREAM_STATUS.RESUMING,
      );
      expect(registry.getToolUseFollowUpTarget(resumingStreamId)).toEqual({
        kind: 'queue',
        reason: 'resuming',
      });

      seedStreamStatusForTest(
        streamStatus,
        waitingStreamId,
        STREAM_STATUS.WAITING,
      );
      expect(registry.getToolUseFollowUpTarget(waitingStreamId)).toEqual({
        kind: 'queue',
        reason: 'waiting',
      });

      seedStreamStatusForTest(
        streamStatus,
        stoppedStreamId,
        STREAM_PHASE.CANCELLED,
      );
      expect(registry.getToolUseFollowUpTarget(stoppedStreamId)).toEqual({
        kind: 'no_session',
        streamStatus: STREAM_PHASE.CANCELLED,
      });

      seedStreamStatusForTest(
        streamStatus,
        parentStreamId,
        STREAM_PHASE.CANCELLED,
      );
      registry.track(
        createHandle(
          'exec-follow-up-child-test',
          parentStreamId,
          childStreamId,
          explicit.host,
        ),
      );
      expect(registry.getToolUseFollowUpTarget(parentStreamId)).toEqual({
        kind: 'queue',
        reason: 'children_running',
      });
    } finally {
      registry.dispose();
    }
  });

  it('projects detach updates from session events', () => {
    const explicit = createRecordingHost();
    const events = new SessionEventHub();
    const recorded = recordSessionEvents(events);
    const registry = new ExecutionRegistry({ events });
    const executionId = 'exec-detach-runtime-host-test';
    const parentStreamId = 'parent-detach-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-detach-runtime-host-test' as StreamTabId;

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        explicit.host,
      );

      registry.track(handle);
      expect(handle.deliveryTargetStreamId).toBe(parentStreamId);
      registry.detachActiveChildren(parentStreamId, explicit.host);
      expect(handle.deliveryTargetStreamId).toBeUndefined();

      expect(
        sessionFactPayloads(recorded.events, 'setParentStream'),
      ).toContainEqual({
        childStreamId,
        parentStreamId: null,
      });
      expect(
        runEventsOfType(recorded.events, 'child.activity').at(-1),
      ).toMatchObject({
        kind: 'subagents',
        parentStreamId,
        items: [],
      });
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('preserves child approvals when detaching it from its parent', () => {
    const explicit = createRecordingHost();
    const registry = new ExecutionRegistry();
    const approvals = createSessionApprovals();
    const parentStreamId = 'parent-detach-approvals' as StreamTabId;
    const childStreamId = 'child-detach-approvals' as StreamTabId;
    const handle = createHandle(
      'exec-detach-approvals',
      parentStreamId,
      childStreamId,
      explicit.host,
    );

    try {
      registry.attachSessionApprovals(approvals);
      approvals.toolEdit.bypass.setBypass(parentStreamId, true);
      approvals.registerStreamParent(childStreamId, parentStreamId, [
        'toolEdit',
      ]);
      registry.track(handle);

      registry.detachActiveChildren(parentStreamId, explicit.host);
      approvals.toolEdit.bypass.setBypass(parentStreamId, false);

      expect(approvals.toolEdit.bypass.isBypassed(childStreamId)).toBe(true);
      expect(handle.deliveryTargetStreamId).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('publishes detach parent links through the attached session event hub', () => {
    const explicit = createRecordingHost();
    const events = new SessionEventHub();
    const seen: SessionEvent[] = [];
    const detach = events.subscribe((event) => seen.push(event));
    const registry = new ExecutionRegistry({ events });
    const executionId = 'exec-detach-session-parent-link-test';
    const parentStreamId =
      'parent-detach-session-parent-link-test' as StreamTabId;
    const childStreamId =
      'child-detach-session-parent-link-test' as StreamTabId;

    try {
      const handle = createHandle(
        executionId,
        parentStreamId,
        childStreamId,
        explicit.host,
      );

      registry.track(handle);
      registry.detachActiveChildren(parentStreamId, explicit.host);

      expect(explicit.events).toEqual([]);
      expect(seen).toContainEqual({
        scope: 'session',
        event: {
          type: 'setParentStream',
          payload: {
            childStreamId,
            parentStreamId: null,
          },
        },
      });
    } finally {
      detach();
      registry.dispose();
    }
  });

  it('detaches its stream-status listener when disposed', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusMachine();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-dispose-runtime-host-test';
    const parentStreamId = 'parent-dispose-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-dispose-runtime-host-test' as StreamTabId;

    const handle = createHandle(
      executionId,
      parentStreamId,
      childStreamId,
      explicit.host,
    );

    registry.track(handle);
    registry.dispose();
    explicit.events.length = 0;

    streamStatus.transition(
      childStreamId,
      STREAM_PHASE.WAITING,
      'restart-repair',
    );

    expect(
      explicit.events.some((entry) => entry.event === 'updateActiveSubagents'),
    ).toBe(false);
  });
});
