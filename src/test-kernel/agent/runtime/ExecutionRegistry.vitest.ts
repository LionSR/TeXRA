// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { getExecutionStore } from '@agent/storage';
import type { AgentTrace, ResultEvent } from '@agent/trace';
import {
  ExecutionLeaseLostError,
  type OwnedExecutionLeaseScope,
} from '@agent/storage/executionLease';
import type {
  AgentExecutionHandle,
  LiveToolUseFlowContext,
} from '@agent/runtime/ExecutionHandle';
import { finalizeRunTerminal } from '@agent/runtime/AgentRunLifecycle';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
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
  STREAM_SUBSTATE,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { setupPlatform } from '@test/support/setupPlatform';
import { spiedTrace } from '@test/support/spiedTrace';
import { seedStreamStatusForTest } from '@test/support/streamStatusTestUtils';

// Local file imports
import {
  recordSessionEvents,
  runEventsOfType,
  sessionFactPayloads,
  sessionFactsOfType,
} from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn(),
}));

const channelTraceMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

// terminalPersistence deep-imports finalizeExecution from executionLifecycle
// (not the `@agent/storage` barrel), so the spy lives on that leaf module.
// Mocking both the barrel and the leaf with the same `vi.fn` whose
// implementation points at `importOriginal`'s barrel export recurses through
// the re-export and blows the stack.
vi.mock('@agent/storage/executionLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/storage/executionLifecycle')>();
  storageMocks.finalizeExecution.mockImplementation(actual.finalizeExecution);
  return {
    ...actual,
    finalizeExecution: storageMocks.finalizeExecution,
  };
});
vi.mock('@agent/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/storage')>();
  return {
    ...actual,
    finalizeExecution: storageMocks.finalizeExecution,
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

type HandleOverrides = {
  agentName?: string;
  category?: AgentCategory;
  trace?: AgentTrace;
  leaseScope?: OwnedExecutionLeaseScope;
};

/** Builds an `AgentExecutionHandle` for a toolUse test-subagent, the shape most tests need. */
function createHandle(
  executionId: string,
  parentStreamId: StreamTabId,
  childStreamId: StreamTabId,
  overrides: HandleOverrides = {},
): AgentExecutionHandle {
  const handle = testExecutionHandle({
    executionId,
    parentStreamId,
    childStreamId,
    agent: overrides.agentName ?? 'test-subagent',
    category: overrides.category,
    trace: overrides.trace,
  });
  handle.attachExecutionLeaseScope(
    overrides.leaseScope ?? ((operation) => operation()),
  );
  return handle;
}

/** Wires the events/streamStatus/registry trio most tests drive kills through. */
function createRegistry(
  options: {
    approvals?: ReturnType<typeof createSessionApprovals>;
    publishResult?: (event: ResultEvent, streamId: StreamTabId) => void;
    releaseRootExecutionLease?: (executionId: ExecutionId) => Promise<void>;
  } = {},
): {
  events: SessionEventHub;
  streamStatus: StreamStatusMachine;
  registry: ExecutionRegistry;
} {
  const events = new SessionEventHub();
  const streamStatus = new StreamStatusMachine(events);
  const registry = new ExecutionRegistry({
    streamStatus,
    events,
    releaseRootExecutionLease: async () => {},
    ...options,
  });
  return { events, streamStatus, registry };
}

/** Tracks a handle with a live interrupt handler attached. */
function trackInterruptibleHandle(
  registry: ExecutionRegistry,
  ids: {
    executionId: string;
    parentStreamId: StreamTabId;
    childStreamId: StreamTabId;
  },
  interrupt: () => void,
  overrides?: HandleOverrides,
): AgentExecutionHandle {
  const handle = createHandle(
    ids.executionId,
    ids.parentStreamId,
    ids.childStreamId,
    overrides,
  );
  handle.attachInterruptHandler({ interrupt });
  registry.track(handle);
  return handle;
}

/** Tracks a handle genuinely suspended at WAITING, the state every waiting-kill test starts from. */
function trackSuspendedWaitingHandle(
  registry: ExecutionRegistry,
  streamStatus: StreamStatusMachine,
  options: {
    executionId: string;
    childStreamId: StreamTabId;
    parentStreamId?: StreamTabId;
    cleanup?: () => void | Promise<void>;
    overrides?: HandleOverrides;
  },
): AgentExecutionHandle {
  const handle = createHandle(
    options.executionId,
    options.parentStreamId ?? options.childStreamId,
    options.childStreamId,
    options.overrides,
  );
  registry.track(handle);
  handle.suspend(options.cleanup ?? (() => {}));
  seedStreamStatusForTest(streamStatus, options.childStreamId, {
    phase: STREAM_PHASE.WAITING,
  });
  return handle;
}

describe('executionRegistry', () => {
  it('promotes a pending child activation without an ownership gap', () => {
    const { registry } = createRegistry();
    const activationEvents: boolean[] = [];
    const executionId = 'pending-child-exec' as ExecutionId;
    const parentStreamId = 'pending-parent' as StreamTabId;
    const childStreamId = 'pending-child' as StreamTabId;
    const detach = registry.addChildActivationListener((_activation, active) =>
      activationEvents.push(active),
    );

    try {
      const release = registry.reserveChildActivation({
        executionId,
        parentStreamId,
        childStreamId,
        interrupt: vi.fn(),
        detach: vi.fn(),
        isDetached: () => false,
      });
      expect(activationEvents).toEqual([true]);

      registry.track(createHandle(executionId, parentStreamId, childStreamId));
      expect(activationEvents).toEqual([true, false]);

      release();
      expect(activationEvents).toEqual([true, false]);
    } finally {
      detach();
      registry.dispose();
    }
  });

  it('retains and detaches a parent whose child is still activating', () => {
    const { registry } = createRegistry();
    const executionId = 'queued-child-exec' as ExecutionId;
    const parentStreamId = 'queued-parent' as StreamTabId;
    const childStreamId = 'queued-child' as StreamTabId;
    let detached = false;

    try {
      registry.reserveChildActivation({
        executionId,
        parentStreamId,
        childStreamId,
        interrupt: vi.fn(),
        detach: () => {
          detached = true;
        },
        isDetached: () => detached,
      });

      expect(registry.hasActiveChildren(parentStreamId)).toBe(true);
      registry.detachActiveChildren(parentStreamId);
      expect(registry.hasActiveChildren(parentStreamId)).toBe(false);

      const handle = createHandle(executionId, parentStreamId, childStreamId);
      registry.track(handle);
      expect(handle.parentStreamId).toBe(childStreamId);
      expect(handle.deliveryTargetStreamId).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('lets exactly one stop claim a suspended run and reports its teardown', async () => {
    const handle = createHandle(
      'exec-waiting-cleanup-completion',
      'stream-waiting-cleanup-completion' as StreamTabId,
      'stream-waiting-cleanup-completion' as StreamTabId,
    );
    const cleanupFinished = createDeferred();
    handle.suspend(() => cleanupFinished.promise);

    const teardown = handle.beginSuspendedTermination();
    expect(teardown).toBeDefined();
    expect(handle.suspendedTerminationStarted).toBe(true);
    // A second stop of the same suspended run finds the claim taken, so it
    // cannot start a second teardown or publish a second terminal outcome.
    expect(handle.beginSuspendedTermination()).toBeUndefined();
    let observedCompletion = false;
    const observation = teardown?.then(() => {
      observedCompletion = true;
    });
    await Promise.resolve();
    expect(observedCompletion).toBe(false);

    cleanupFinished.resolve();
    await observation;
    expect(observedCompletion).toBe(true);
  });

  it('settles without persisting a stopped waiting handle after lease loss', async () => {
    const { streamStatus, registry } = createRegistry();
    const executionId = 'exec-waiting-lease-lost' as ExecutionId;
    const streamId = 'stream-waiting-lease-lost' as StreamTabId;
    storageMocks.finalizeExecution.mockClear();

    try {
      const handle = trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        childStreamId: streamId,
      });
      handle.markExecutionLeaseLost();

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

  it('observes handle replacements and removal in order', () => {
    const { registry } = createRegistry();
    const executionId = 'exec-observe-handle';
    const streamId = 'stream-observe-handle' as StreamTabId;
    const first = createHandle(executionId, streamId, streamId, {
      agentName: 'first',
      category: AgentCategory.Workflow,
    });
    const second = createHandle(executionId, streamId, streamId, {
      agentName: 'second',
      category: AgentCategory.Workflow,
    });
    const registrations: unknown[] = [];
    const detachRegistrations = registry.addRegistrationListener(
      (changedId, handle) => {
        if (changedId === executionId) registrations.push(handle);
      },
    );
    registry.track(first);
    const seen: unknown[] = [];
    const detach = registry.addListener(executionId, (handle) => {
      seen.push(handle);
    });

    registry.track(second);
    registry.untrack(executionId);

    expect(seen).toEqual([second, undefined]);
    expect(registrations).toEqual([first, second, undefined]);
    detach();
    detachRegistrations();
    registry.dispose();
  });

  it('drains a background-bash AgentExecutionHandle on shutdown without disturbing a resumable agent execution (issue #8155)', () => {
    // A background `bash` run is registered as an AgentExecutionHandle (see
    // createChildStream in tools/bash.ts) with its OS-process kill reachable
    // only via the interrupt handler BashBackgroundSession attaches. The two
    // AgentExecutionHandles below are tracked concurrently, mirroring the real
    // interleaving at shutdown: a background bash child stream alongside an
    // ordinary resumable agent execution (e.g. a native subagent loop, whose
    // own loop-level interrupt handler must stay untouched so restart recovery
    // can resume it). Drain must reach only the former.
    const { streamStatus, registry } = createRegistry();
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

    try {
      // Background bash: an AgentExecutionHandle whose attached interrupt
      // handler owns a live OS process (mirrors BashBackgroundSession).
      const bashHandle = createHandle(
        bashExecutionId,
        bashParentStreamId,
        bashChildStreamId,
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
      );
      agentHandle.attachInterruptHandler({ interrupt: agentInterrupt });
      registry.trackAgentExecution(agentHandle, {
        status: STREAM_PHASE.RUNNING,
      });

      registry.killBackgroundProcesses();

      expect(bashInterrupt).toHaveBeenCalledOnce();
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
    const { streamStatus, registry } = createRegistry();
    const executionId = 'exec-injected-interrupt-test';
    const parentStreamId = 'parent-injected-interrupt-test' as StreamTabId;
    const childStreamId = 'child-injected-interrupt-test' as StreamTabId;
    const interrupt = vi.fn();

    try {
      trackInterruptibleHandle(
        registry,
        { executionId, parentStreamId, childStreamId },
        interrupt,
      );

      expect(registry.kill(executionId)).toBe(true);

      expect(interrupt).toHaveBeenCalledOnce();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
    } finally {
      registry.dispose();
    }
  });

  it('falls back to the parked teardown when a suspended handle has no live interrupt (issue #7287)', async () => {
    // A native subagent suspended at WAITING has already had its live
    // interrupt context detached (runToolUseFlow's finally), while the handle
    // stays tracked for resume. With no interrupt target left, terminate()
    // must fall back to the parked teardown rather than no-op and strand the
    // handle registered forever.
    const { streamStatus, registry } = createRegistry();
    const executionId = 'exec-waiting-cleanup-kill-test';
    const parentStreamId = 'parent-waiting-cleanup-kill-test' as StreamTabId;
    const childStreamId = 'child-waiting-cleanup-kill-test' as StreamTabId;
    const cleanup = vi.fn();

    try {
      // No handle interrupt target: mirrors a suspended subagent whose live
      // tool-use session has already been disposed. The stream phase follows
      // the same suspension, as it does in production.
      const handle = trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        parentStreamId,
        childStreamId,
        cleanup,
      });

      expect(registry.kill(executionId)).toBe(true);
      await handle.result;

      expect(cleanup).toHaveBeenCalledOnce();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(registry.getHandle(executionId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('publishes the cancelled terminal result when killing a suspended WAITING handle', async () => {
    // terminateWaitingHandle settles handle.result and the run's own
    // (already-disposed, per runFlowWithLifecycle's finally) trace, and must
    // also tell the owning session about the terminal event — otherwise
    // session-result subscribers (session.onResult et al.) silently miss a
    // user-initiated stop of a suspended native subagent even though
    // handle.result itself resolved. `publishResult` is the callback
    // SessionHandle injects (see SessionHandle.publishRunEvent) so this path
    // reaches those subscribers directly, since the turn's own trace
    // subscriptions are already torn down by the time a kill runs.
    const publishResult = vi.fn();
    const { streamStatus, registry } = createRegistry({ publishResult });
    const executionId = 'exec-waiting-kill-publish-result-test';
    const parentStreamId =
      'parent-waiting-kill-publish-result-test' as StreamTabId;
    const childStreamId =
      'child-waiting-kill-publish-result-test' as StreamTabId;
    const trace = spiedTrace({ emit: vi.fn() }, { strict: true });
    const leaseScopeInvoked = vi.fn();
    const leaseScope: OwnedExecutionLeaseScope = (operation) => {
      leaseScopeInvoked();
      return operation();
    };

    try {
      const handle = trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        parentStreamId,
        childStreamId,
        overrides: { trace, leaseScope },
      });

      expect(registry.kill(executionId)).toBe(true);
      await handle.result;
      expect(leaseScopeInvoked).toHaveBeenCalledOnce();

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

  it('publishes a waiting cancellation after its transcript cleanup settles', async () => {
    const order: string[] = [];
    const publishResult = vi.fn(() => order.push('publish'));
    const { streamStatus, registry } = createRegistry({ publishResult });
    const executionId = 'exec-waiting-cleanup-order' as ExecutionId;
    const childStreamId = 'child-waiting-cleanup-order' as StreamTabId;
    let finishCleanup = (): void => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    try {
      const handle = trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        parentStreamId: 'parent-waiting-cleanup-order' as StreamTabId,
        childStreamId,
        cleanup: async () => {
          await cleanupGate;
          order.push('cleanup');
        },
      });

      expect(registry.kill(executionId)).toBe(true);
      await Promise.resolve();
      expect(publishResult).not.toHaveBeenCalled();
      expect(registry.getHandle(executionId)).toBe(handle);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.WAITING);

      finishCleanup();
      await expect(handle.result).resolves.toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.CANCELLED,
      });
      expect(order).toEqual(['cleanup', 'publish']);
      expect(registry.getHandle(executionId)).toBeUndefined();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
    } finally {
      registry.dispose();
    }
  });

  it('hands a waiting stop to a successor tracked during cleanup', async () => {
    storageMocks.finalizeExecution.mockClear();
    const publishResult = vi.fn();
    const { streamStatus, registry } = createRegistry({ publishResult });
    const executionId = 'exec-waiting-stop-handoff' as ExecutionId;
    const parentStreamId = 'parent-waiting-stop-handoff' as StreamTabId;
    const childStreamId = 'child-waiting-stop-handoff' as StreamTabId;
    let finishCleanup = (): void => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    try {
      const previous = trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        parentStreamId,
        childStreamId,
        cleanup: () => cleanupGate,
      });

      expect(registry.kill(executionId)).toBe(true);

      const successorInterrupt = vi.fn();
      const successor = trackInterruptibleHandle(
        registry,
        { executionId, parentStreamId, childStreamId },
        successorInterrupt,
      );

      expect(successorInterrupt).toHaveBeenCalledOnce();
      finishCleanup();
      await expect(previous.result).resolves.toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.CANCELLED,
      });

      expect(registry.getHandle(executionId)).toBe(successor);
      expect(publishResult).not.toHaveBeenCalled();
      expect(storageMocks.finalizeExecution).not.toHaveBeenCalled();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.WAITING);
    } finally {
      registry.dispose();
    }
  });

  it('does not let lost-generation recovery mutate a successor handle or lease', async () => {
    const releaseLease = vi.fn(async () => undefined);
    const { streamStatus, registry } = createRegistry({
      releaseRootExecutionLease: releaseLease,
    });
    const executionId = 'exec-waiting-lost-generation' as ExecutionId;
    const streamId = 'stream-waiting-lost-generation' as StreamTabId;
    const lostScope: OwnedExecutionLeaseScope = () => {
      throw new ExecutionLeaseLostError(executionId);
    };

    try {
      const previous = trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        childStreamId: streamId,
        overrides: { leaseScope: lostScope },
      });

      expect(registry.kill(executionId)).toBe(true);
      const successor = createHandle(executionId, streamId, streamId);
      registry.track(successor);

      await previous.result;
      expect(registry.getHandle(executionId)).toBe(successor);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
      expect(releaseLease).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
    }
  });

  it('settles waiting termination when detached publication throws', async () => {
    const publishFailure = new Error('terminal subscriber failed');
    const { streamStatus, registry } = createRegistry({
      publishResult: () => {
        throw publishFailure;
      },
    });
    const executionId = 'exec-waiting-publication-failure' as ExecutionId;
    const childStreamId = 'child-waiting-publication-failure' as StreamTabId;

    try {
      const handle = trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        parentStreamId: 'parent-waiting-publication-failure' as StreamTabId,
        childStreamId,
      });

      expect(registry.kill(executionId)).toBe(true);
      await expect(handle.result).resolves.toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.CANCELLED,
      });
      expect(registry.getHandle(executionId)).toBeUndefined();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
    } finally {
      registry.dispose();
    }
  });

  it('settles and untracks a waiting handle when terminal metadata persistence fails', async () => {
    const { streamStatus, registry } = createRegistry();
    const executionId = 'exec-waiting-kill-metadata-failure' as ExecutionId;
    const parentStreamId =
      'parent-waiting-kill-metadata-failure' as StreamTabId;
    const childStreamId = 'child-waiting-kill-metadata-failure' as StreamTabId;
    const durabilityError = new Error('metadata disk write failed');
    storageMocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      stage: 'terminal-status',
      outcomePersisted: false,
      error: durabilityError,
    });
    channelTraceMocks.warn.mockClear();

    try {
      const handle = trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        parentStreamId,
        childStreamId,
      });

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
              outcomePersisted: false,
              error: durabilityError,
            },
          },
        );
      });
    } finally {
      registry.dispose();
    }
  });

  it('persists a waiting stop after transcript cleanup fails', async () => {
    const { streamStatus, registry } = createRegistry();
    const executionId = 'exec-waiting-cleanup-failure' as ExecutionId;
    const childStreamId = 'child-waiting-cleanup-failure' as StreamTabId;
    const cleanupError = new Error('transcript reload failed');
    storageMocks.finalizeExecution.mockResolvedValueOnce({
      status: 'durable',
      outcomePersisted: true,
      flowRecord: 'deleted',
    });
    channelTraceMocks.warn.mockClear();

    try {
      trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        parentStreamId: 'parent-waiting-cleanup-failure' as StreamTabId,
        childStreamId,
        cleanup: () => Promise.reject(cleanupError),
      });

      expect(registry.kill(executionId)).toBe(true);

      await vi.waitFor(() => {
        expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
          executionId,
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'delete',
        });
      });
      expect(channelTraceMocks.warn).toHaveBeenCalledWith(
        'Waiting-execution cleanup failed; continuing terminal persistence',
        { data: { executionId, error: cleanupError } },
      );
    } finally {
      registry.dispose();
    }
  });

  it('persists a waiting stop when only flow-record deletion fails', async () => {
    const { streamStatus, registry } = createRegistry();
    const executionId = 'exec-waiting-kill-flow-delete-failure' as ExecutionId;
    const childStreamId =
      'child-waiting-kill-flow-delete-failure' as StreamTabId;
    const cleanupError = new Error('flow delete failed');
    storageMocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      stage: 'flow-record-delete',
      outcomePersisted: true,
      error: cleanupError,
    });
    channelTraceMocks.warn.mockClear();

    try {
      trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        parentStreamId:
          'parent-waiting-kill-flow-delete-failure' as StreamTabId,
        childStreamId,
      });

      expect(registry.kill(executionId)).toBe(true);

      await vi.waitFor(() => {
        expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
          executionId,
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'delete',
        });
      });
      expect(channelTraceMocks.warn).toHaveBeenCalledExactlyOnceWith(
        'Failed to finalize stopped waiting execution',
        {
          data: {
            executionId,
            stage: 'flow-record-delete',
            outcomePersisted: true,
            error: cleanupError,
          },
        },
      );
    } finally {
      registry.dispose();
    }
  });

  it('reports a failed kill for a tracked handle with neither an interrupt nor a suspension', () => {
    // Guards the fallback above: a handle that never parked must still no-op,
    // or the fallback could spuriously tear down a handle mid-completion, in
    // the narrow window between its own interrupt unregister and its own
    // untrack.
    const { streamStatus, registry } = createRegistry();
    const executionId = 'exec-no-cleanup-kill-test';
    const parentStreamId = 'parent-no-cleanup-kill-test' as StreamTabId;
    const childStreamId = 'child-no-cleanup-kill-test' as StreamTabId;

    try {
      const handle = createHandle(executionId, parentStreamId, childStreamId);
      registry.track(handle);

      expect(registry.kill(executionId)).toBe(false);

      expect(streamStatus.get(childStreamId)).toBeUndefined();
      expect(registry.getHandle(executionId)).toBe(handle);
    } finally {
      registry.dispose();
    }
  });

  it('leaves a never-suspended handle alone even while its stream reads WAITING', () => {
    // The handle owns the suspension fact; the stream phase is only a
    // projection of it. A stop landing in the narrow window between a live
    // turn's interrupt-handler detach and its own untrack must not abandon a
    // run that never parked, no matter what phase the stream currently shows.
    const { streamStatus, registry } = createRegistry();
    const executionId = 'exec-never-suspended-phase-only-test';
    const parentStreamId =
      'parent-never-suspended-phase-only-test' as StreamTabId;
    const childStreamId =
      'child-never-suspended-phase-only-test' as StreamTabId;

    try {
      const handle = createHandle(executionId, parentStreamId, childStreamId);
      registry.track(handle);
      seedStreamStatusForTest(streamStatus, childStreamId, {
        phase: STREAM_PHASE.WAITING,
      });

      expect(registry.kill(executionId)).toBe(false);

      expect(registry.getHandle(executionId)).toBe(handle);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.WAITING);
    } finally {
      registry.dispose();
    }
  });

  it('refuses a waiting stop once a terminal finalize has claimed the run', async () => {
    // Both terminal writers claim the same gate, so a kill landing while
    // `finalizeRunTerminal` is parked at its persist await cannot run the
    // suspended teardown, publish a second `result`, or persist a second
    // terminal status over the finalizer's outcome.
    const { streamStatus, registry } = createRegistry();
    const executionId = 'exec-waiting-stop-after-claim' as ExecutionId;
    const childStreamId = 'child-waiting-stop-after-claim' as StreamTabId;
    const teardown = vi.fn();
    storageMocks.finalizeExecution.mockClear();
    let releasePersist: (() => void) | undefined;
    storageMocks.finalizeExecution.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          releasePersist = () =>
            resolve({
              status: 'durable',
              outcomePersisted: true,
              flowRecord: 'deleted',
            });
        }),
    );

    try {
      const handle = trackSuspendedWaitingHandle(registry, streamStatus, {
        executionId,
        parentStreamId: 'parent-waiting-stop-after-claim' as StreamTabId,
        childStreamId,
        cleanup: teardown,
      });

      const finalized = finalizeRunTerminal({
        handle,
        executions: registry,
        streamStatus,
        outcome: RUN_OUTCOME.COMPLETED,
        isSubagent: true,
        persistence: { kind: 'finalize', flowRecord: 'delete' },
      });
      await vi.waitFor(() => expect(releasePersist).toBeDefined());

      expect(registry.kill(executionId)).toBe(false);

      releasePersist?.();
      await finalized;
      expect(teardown).not.toHaveBeenCalled();
      await expect(handle.result).resolves.toMatchObject({
        outcome: RUN_OUTCOME.COMPLETED,
      });
      expect(storageMocks.finalizeExecution).toHaveBeenCalledExactlyOnceWith({
        executionId,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'delete',
      });
      expect(registry.getHandle(executionId)).toBeUndefined();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      registry.dispose();
    }
  });

  it('tears down and aligns a suspended handle killed during RESUMING', async () => {
    // Regression: `resumeQueuedToolUseFromResumeData` flips `streamStatus` to
    // RUNNING with a RESUMING substate *before* the resumed run installs its
    // own interrupt context. The handle it is resuming is still parked from
    // the earlier genuine WAITING suspension, so a kill landing in that window
    // tears it down off that fact alone — no phase or substate is consulted.
    const { streamStatus, registry } = createRegistry();
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
      const handle = createHandle(executionId, parentStreamId, childStreamId);
      registry.track(handle);
      handle.suspend(cleanup);
      // Mirrors resumeQueuedToolUseFromResumeData's status flip that runs ahead of
      // the resumed run's own context — RUNNING phase, RESUMING substate.
      seedStreamStatusForTest(streamStatus, childStreamId, {
        phase: STREAM_PHASE.RUNNING,
        substate: STREAM_SUBSTATE.RESUMING,
      });

      expect(registry.kill(executionId)).toBe(true);
      await handle.result;

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
    const { events, streamStatus, registry } = createRegistry();
    const recorded = recordSessionEvents(events, { scope: 'session' });
    const rootStreamId = 'root-stop-policy-test' as StreamTabId;
    const childStreamId = 'child-stop-policy-test' as StreamTabId;
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();
    const queuedChildInterrupt = vi.fn();

    try {
      registry.reserveChildActivation({
        executionId: 'exec-queued-child-stop-policy-test' as ExecutionId,
        parentStreamId: rootStreamId,
        childStreamId: 'queued-child-stop-policy-test' as StreamTabId,
        interrupt: queuedChildInterrupt,
        detach: vi.fn(),
        isDetached: () => false,
      });
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-root-stop-policy-test',
          parentStreamId: rootStreamId,
          childStreamId: rootStreamId,
        },
        rootInterrupt,
        { agentName: 'test-root' },
      );
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-child-stop-policy-test',
          parentStreamId: rootStreamId,
          childStreamId,
        },
        childInterrupt,
      );

      registry.stopAgentStream(rootStreamId);

      expect(rootInterrupt).toHaveBeenCalledOnce();
      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(queuedChildInterrupt).toHaveBeenCalledOnce();
      expect(streamStatus.get(rootStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(sessionFactsOfType(recorded.events, 'status')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: STREAM_PHASE.CANCELLED,
          }),
        ]),
      );
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('interrupts grandchildren when killing a subagent chain', () => {
    const { streamStatus, registry } = createRegistry();
    const rootStreamId = 'root-cascade-test' as StreamTabId;
    const childStreamId = 'child-cascade-test' as StreamTabId;
    const grandchildStreamId = 'grandchild-cascade-test' as StreamTabId;
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-child-cascade-test',
          parentStreamId: rootStreamId,
          childStreamId,
        },
        childInterrupt,
      );
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-grandchild-cascade-test',
          parentStreamId: childStreamId,
          childStreamId: grandchildStreamId,
        },
        grandchildInterrupt,
        { agentName: 'test-grandchild' },
      );

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
    const { events, streamStatus, registry } = createRegistry();
    const recorded = recordSessionEvents(events, { scope: 'session' });
    const rootStreamId = 'root-detach-kill-test' as StreamTabId;
    const childStreamId = 'child-detach-kill-test' as StreamTabId;
    const grandchildStreamId = 'grandchild-detach-kill-test' as StreamTabId;
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-child-detach-kill-test',
          parentStreamId: rootStreamId,
          childStreamId,
        },
        childInterrupt,
      );
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-grandchild-detach-kill-test',
          parentStreamId: childStreamId,
          childStreamId: grandchildStreamId,
        },
        grandchildInterrupt,
        { agentName: 'test-grandchild' },
      );

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
    const { events, streamStatus, registry } = createRegistry();
    const recorded = recordSessionEvents(events, { scope: 'session' });
    const rootStreamId = 'root-detach-stop-policy-test' as StreamTabId;
    const childStreamId = 'child-detach-stop-policy-test' as StreamTabId;
    const grandchildStreamId =
      'grandchild-detach-stop-policy-test' as StreamTabId;
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-root-detach-stop-policy-test',
          parentStreamId: rootStreamId,
          childStreamId: rootStreamId,
        },
        rootInterrupt,
        { agentName: 'test-root' },
      );
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-child-detach-stop-policy-test',
          parentStreamId: rootStreamId,
          childStreamId,
        },
        childInterrupt,
      );
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-grandchild-detach-stop-policy-test',
          parentStreamId: childStreamId,
          childStreamId: grandchildStreamId,
        },
        grandchildInterrupt,
        { agentName: 'test-grandchild' },
      );

      registry.stopAgentStream(rootStreamId, {
        detachActiveChildren: true,
      });

      expect(rootInterrupt).toHaveBeenCalledOnce();
      expect(childInterrupt).not.toHaveBeenCalled();
      expect(grandchildInterrupt).not.toHaveBeenCalled();
      expect(registry.getActiveChildren(rootStreamId)).toHaveLength(0);
      expect(
        registry.getAgentHandleByStream(childStreamId)?.parentStreamId,
      ).toBe(childStreamId);
      expect(
        registry.getAgentHandleByStream(grandchildStreamId)?.parentStreamId,
      ).toBe(childStreamId);
      expect(registry.getActiveChildren(childStreamId)).toEqual([
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

  it('stops one child while preserving its owner, sibling, and agent descendants', () => {
    const { streamStatus, registry } = createRegistry();
    const rootStreamId = 'root-focused-stop-test' as StreamTabId;
    const childStreamId = 'child-focused-stop-test' as StreamTabId;
    const siblingStreamId = 'sibling-focused-stop-test' as StreamTabId;
    const descendantStreamId = 'descendant-focused-stop-test' as StreamTabId;
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();
    const siblingInterrupt = vi.fn();
    const descendantInterrupt = vi.fn();

    try {
      const rootHandle = trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-root-focused-stop-test',
          parentStreamId: rootStreamId,
          childStreamId: rootStreamId,
        },
        rootInterrupt,
        { agentName: 'test-root' },
      );
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-child-focused-stop-test',
          parentStreamId: rootStreamId,
          childStreamId,
        },
        childInterrupt,
      );
      const siblingHandle = trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-sibling-focused-stop-test',
          parentStreamId: rootStreamId,
          childStreamId: siblingStreamId,
        },
        siblingInterrupt,
      );
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-descendant-focused-stop-test',
          parentStreamId: childStreamId,
          childStreamId: descendantStreamId,
        },
        descendantInterrupt,
      );

      registry.stopAgentStream(childStreamId, {
        detachActiveChildren: true,
      });

      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(rootInterrupt).not.toHaveBeenCalled();
      expect(siblingInterrupt).not.toHaveBeenCalled();
      expect(descendantInterrupt).not.toHaveBeenCalled();
      expect(registry.getAgentHandleByStream(rootStreamId)).toBe(rootHandle);
      expect(registry.getAgentHandleByStream(siblingStreamId)).toBe(
        siblingHandle,
      );
      expect(
        registry.getAgentHandleByStream(descendantStreamId)?.parentStreamId,
      ).toBe(descendantStreamId);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(streamStatus.get(rootStreamId)).toBeUndefined();
      expect(streamStatus.get(siblingStreamId)).toBeUndefined();
      expect(streamStatus.get(descendantStreamId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('cancels an ownerless stream', () => {
    const { events, streamStatus, registry } = createRegistry();
    const recorded = recordSessionEvents(events, { scope: 'session' });
    const streamId = 'ownerless-stop-policy-test' as StreamTabId;

    try {
      registry.stopAgentStream(streamId);

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(
        sessionFactsOfType(recorded.events, 'status').at(-1),
      ).toMatchObject({
        phase: STREAM_PHASE.CANCELLED,
      });
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('leaves an already-terminal stream phase untouched', () => {
    const { streamStatus, registry } = createRegistry();
    const streamId = 'terminal-stop-policy-test' as StreamTabId;

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.COMPLETED,
      });

      registry.stopAgentStream(streamId);

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      registry.dispose();
    }
  });

  it('reports agent status from its stream-status owner', () => {
    const { streamStatus, registry } = createRegistry();
    const parentStreamId = 'parent-owned-status-test' as StreamTabId;
    const childStreamId = 'child-owned-status-test' as StreamTabId;
    const executionId = 'exec-owned-status-test';

    try {
      seedStreamStatusForTest(streamStatus, childStreamId, {
        phase: STREAM_PHASE.WAITING,
      });
      registry.track(createHandle(executionId, parentStreamId, childStreamId));

      expect(registry.getActiveChildren(parentStreamId)).toEqual([
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
    const { streamStatus, registry } = createRegistry();
    const parentStreamId = 'parent-track-agent-status-test' as StreamTabId;
    const childStreamId = 'child-track-agent-status-test' as StreamTabId;
    const executionId = 'exec-track-agent-status-test';

    try {
      registry.trackAgentExecution(
        createHandle(executionId, parentStreamId, childStreamId),
        { status: STREAM_STATUS.RUNNING },
      );

      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.RUNNING);
      expect(registry.getActiveChildren(parentStreamId)).toEqual([
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
    const { streamStatus, registry } = createRegistry();
    const parentStreamId = 'parent-update-agent-status-test' as StreamTabId;
    const childStreamId = 'child-update-agent-status-test' as StreamTabId;
    const executionId = 'exec-update-agent-status-test';
    const handle = createHandle(executionId, parentStreamId, childStreamId);

    try {
      registry.trackAgentExecution(handle, { status: STREAM_STATUS.RUNNING });

      expect(
        registry.updateAgentExecutionStatus(handle, STREAM_STATUS.WAITING),
      ).toBe(true);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.WAITING);

      seedStreamStatusForTest(streamStatus, childStreamId, {
        phase: STREAM_PHASE.CANCELLED,
      });
      expect(registry.getActiveChildren(parentStreamId)).toEqual([
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
      seedStreamStatusForTest(streamStatus, childStreamId, {
        phase: STREAM_PHASE.WAITING,
      });
      expect(
        registry.updateAgentExecutionStatus(handle, STREAM_STATUS.RUNNING),
      ).toBe(false);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.WAITING);
    } finally {
      registry.dispose();
    }
  });

  it('detaches children of an ownerless stream and cancels it', () => {
    const { events, streamStatus, registry } = createRegistry();
    const recorded = recordSessionEvents(events, { scope: 'session' });
    const parentStreamId = 'parent-ownerless-detach-test' as StreamTabId;
    const childStreamId = 'child-ownerless-detach-test' as StreamTabId;
    const childInterrupt = vi.fn();

    try {
      // No root handle owns `parentStreamId` — only a tracked child does.
      trackInterruptibleHandle(
        registry,
        {
          executionId: 'exec-child-ownerless-detach-test',
          parentStreamId,
          childStreamId,
        },
        childInterrupt,
      );

      registry.stopAgentStream(parentStreamId, {
        detachActiveChildren: true,
      });

      expect(childInterrupt).not.toHaveBeenCalled();
      expect(
        registry.getAgentHandleByStream(childStreamId)?.parentStreamId,
      ).toBe(childStreamId);
      expect(
        sessionFactPayloads(recorded.events, 'setParentStream'),
      ).toContainEqual({
        childStreamId,
        parentStreamId: null,
      });
      expect(streamStatus.get(parentStreamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(streamStatus.get(childStreamId)).toBeUndefined();
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('projects handle updates from session events', () => {
    const { events, registry } = createRegistry();
    const recorded = recordSessionEvents(events);
    const executionId = 'exec-handle-runtime-host-test';
    const parentStreamId = 'parent-handle-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-handle-runtime-host-test' as StreamTabId;

    try {
      const handle = createHandle(executionId, parentStreamId, childStreamId);

      registry.track(handle);
      registry.untrack(executionId);

      const childActivity = runEventsOfType(recorded.events, 'child.activity');
      expect(childActivity[0]).toMatchObject({
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
        parentStreamId,
        items: [],
      });
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('publishes parent links through the attached session event hub', () => {
    const { events, registry } = createRegistry();
    const seen: SessionEvent[] = [];
    const detach = events.subscribe((event) => seen.push(event));
    const executionId = 'exec-session-parent-link-test';
    const parentStreamId = 'parent-session-parent-link-test' as StreamTabId;
    const childStreamId = 'child-session-parent-link-test' as StreamTabId;

    try {
      const handle = createHandle(executionId, parentStreamId, childStreamId);

      registry.track(handle);

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
    const { registry } = createRegistry();
    const executionId = 'exec-live-flow-context-test';
    const streamId = 'stream-live-flow-context-test' as StreamTabId;
    const context: LiveToolUseFlowContext = {
      session: {
        appendFollowUp: vi.fn(),
      },
      modelHandler: {
        supportsManualCompaction: true,
      },
      requestImmediateCompaction: vi.fn(),
      modelSwitchDisabledReason: vi.fn(),
      switchModel: vi.fn(),
      interrupt: vi.fn(),
    };

    try {
      const handle = createHandle(executionId, streamId, streamId, {
        agentName: 'test-tool-use',
      });

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
    const { registry } = createRegistry();
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
        { agentName: 'test-tool-use' },
      );
      handle.attachToolUseFlow(context);
      registry.track(handle);

      const unsupportedHandle = createHandle(
        'exec-manual-compaction-unsupported-test',
        unsupportedStreamId,
        unsupportedStreamId,
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
    const { streamStatus, registry } = createRegistry();
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
        { agentName: 'test-tool-use' },
      );
      activeHandle.attachToolUseFlow(context);
      registry.track(activeHandle);
      seedStreamStatusForTest(streamStatus, activeStreamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      expect(registry.getToolUseFollowUpTarget(activeStreamId)).toEqual({
        kind: 'active',
        context,
      });

      seedStreamStatusForTest(streamStatus, resumingStreamId, {
        phase: STREAM_PHASE.RUNNING,
        substate: STREAM_SUBSTATE.RESUMING,
      });
      expect(registry.getToolUseFollowUpTarget(resumingStreamId)).toEqual({
        kind: 'queue',
        reason: 'resuming',
      });

      seedStreamStatusForTest(streamStatus, waitingStreamId, {
        phase: STREAM_PHASE.WAITING,
      });
      expect(registry.getToolUseFollowUpTarget(waitingStreamId)).toEqual({
        kind: 'queue',
        reason: 'waiting',
      });

      seedStreamStatusForTest(streamStatus, stoppedStreamId, {
        phase: STREAM_PHASE.CANCELLED,
      });
      expect(registry.getToolUseFollowUpTarget(stoppedStreamId)).toEqual({
        kind: 'no_session',
        streamStatus: STREAM_PHASE.CANCELLED,
      });

      seedStreamStatusForTest(streamStatus, parentStreamId, {
        phase: STREAM_PHASE.CANCELLED,
      });
      registry.track(
        createHandle(
          'exec-follow-up-child-test',
          parentStreamId,
          childStreamId,
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
    const { events, registry } = createRegistry();
    const recorded = recordSessionEvents(events);
    const executionId = 'exec-detach-runtime-host-test';
    const parentStreamId = 'parent-detach-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-detach-runtime-host-test' as StreamTabId;

    try {
      const handle = createHandle(executionId, parentStreamId, childStreamId);

      registry.track(handle);
      recorded.events.length = 0;
      expect(handle.deliveryTargetStreamId).toBe(parentStreamId);
      registry.detachActiveChildren(parentStreamId);
      expect(handle.deliveryTargetStreamId).toBeUndefined();

      expect(recorded.events.map(({ event }) => event.type)).toEqual([
        'child.activity',
        'setParentStream',
      ]);

      expect(
        sessionFactPayloads(recorded.events, 'setParentStream'),
      ).toContainEqual({
        childStreamId,
        parentStreamId: null,
      });
      expect(
        runEventsOfType(recorded.events, 'child.activity').at(-1),
      ).toMatchObject({
        parentStreamId,
        items: [],
      });
    } finally {
      registry.dispose();
      recorded.detach();
    }
  });

  it('preserves child approvals when detaching it from its parent', () => {
    const approvals = createSessionApprovals();
    const { registry } = createRegistry({ approvals });
    const parentStreamId = 'parent-detach-approvals' as StreamTabId;
    const childStreamId = 'child-detach-approvals' as StreamTabId;
    const handle = createHandle(
      'exec-detach-approvals',
      parentStreamId,
      childStreamId,
    );

    try {
      approvals.toolEdit.bypass.setBypass(parentStreamId, true);
      approvals.registerStreamParent(childStreamId, parentStreamId, [
        'toolEdit',
      ]);
      registry.track(handle);

      registry.detachActiveChildren(parentStreamId);
      approvals.toolEdit.bypass.setBypass(parentStreamId, false);

      expect(approvals.toolEdit.bypass.isBypassed(childStreamId)).toBe(true);
      expect(handle.deliveryTargetStreamId).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('publishes detach parent links through the attached session event hub', () => {
    const { events, registry } = createRegistry();
    const seen: SessionEvent[] = [];
    const detach = events.subscribe((event) => seen.push(event));
    const executionId = 'exec-detach-session-parent-link-test';
    const parentStreamId =
      'parent-detach-session-parent-link-test' as StreamTabId;
    const childStreamId =
      'child-detach-session-parent-link-test' as StreamTabId;

    try {
      const handle = createHandle(executionId, parentStreamId, childStreamId);

      registry.track(handle);
      registry.detachActiveChildren(parentStreamId);

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

  it('detaches its stream-status subscription when disposed', () => {
    const { events, streamStatus, registry } = createRegistry();
    const executionId = 'exec-dispose-status-subscription';
    const parentStreamId = 'parent-dispose-status-subscription' as StreamTabId;
    const childStreamId = 'child-dispose-status-subscription' as StreamTabId;

    registry.track(createHandle(executionId, parentStreamId, childStreamId));
    registry.dispose();
    const recorded = recordSessionEvents(events);

    try {
      streamStatus.transition(
        childStreamId,
        STREAM_PHASE.WAITING,
        'restart-repair',
      );

      // Only the status machine's own fact remains; the registry contributes
      // no roster emission once its subscription is gone.
      expect(runEventsOfType(recorded.events, 'child.activity')).toEqual([]);
      expect(sessionFactsOfType(recorded.events, 'status')).toHaveLength(1);
    } finally {
      recorded.detach();
    }
  });
});
