// Test composition imports
import '@test/support/defaultSessionTestSetup';

// E2E fixtures for the promoted "one loop, N strategies" child-run driver.
// These exercise the loop's own mechanics (queue acquire/drain, one
// run-handle interrupt target for the child's whole lifetime, per-turn delivery, terminal
// finalize) against a minimal fake strategy — the same contract every real
// strategy (codex, claude, native tool-use, native workflow) implements.
// Identical assertions apply regardless of which strategy is plugged in,
// since delivery/interrupt/terminal choreography all live in the loop.

import pDefer, { type DeferredPromise } from 'p-defer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn(),
  synchronizeAgentResultOutcome: vi.fn(),
  persistChildRunReport: vi.fn(),
  persistChildRunResultMeta: vi.fn(),
  enqueueChildRunFollowUp: vi.fn(),
  wakeChildRunFollowUp: vi.fn(),
  leaseLossListener: undefined as (() => void) | undefined,
}));

vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  finalizeExecution: mocks.finalizeExecution,
  synchronizeAgentResultOutcome: mocks.synchronizeAgentResultOutcome,
}));

vi.mock('@agent/storage/executionLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/executionLease')>()),
  markOwnedExecutionLeaseUndurable: vi.fn(),
  onOwnedExecutionLeaseLost: vi.fn(
    (_executionId: ExecutionId, listener: () => void) => {
      mocks.leaseLossListener = listener;
      return () => {
        if (mocks.leaseLossListener === listener) {
          mocks.leaseLossListener = undefined;
        }
      };
    },
  ),
}));

vi.mock('@agent/runtime/executionOwnership', () => ({
  releaseExecutionLeaseAfterArtifacts: vi.fn(async () => {}),
}));

vi.mock('@tools/childRunDelivery', () => ({
  persistChildRunReport: mocks.persistChildRunReport,
  persistChildRunResultMeta: mocks.persistChildRunResultMeta,
  enqueueChildRunFollowUp: mocks.enqueueChildRunFollowUp,
  wakeChildRunFollowUp: mocks.wakeChildRunFollowUp,
}));

import {
  startChildRunLoop,
  isChildRunLoopActive,
  type ChildRunPorts,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';

let session: SessionHandle;
const trackedExecutionIds = new Set<string>();

function uniqueStreamId(label: string): StreamTabId {
  return `${label}-${Math.random().toString(36).slice(2)}` as StreamTabId;
}

function trackChildHandle(
  executionId: ExecutionId,
  parentStreamId: StreamTabId,
  childStreamId: StreamTabId,
  status: StreamPhase = STREAM_PHASE.RUNNING,
): AgentExecutionHandle {
  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    'fake',
    'toolUse',
    { emit: vi.fn() } as never,
  );
  session.executions.trackAgentExecution(handle, { status });
  trackedExecutionIds.add(executionId);
  return handle;
}

/** A turn the fake strategy can produce: interim (loop continues) or terminal. */
interface FakeTurn {
  readonly kind: 'interim' | 'terminal' | 'error-turn';
  readonly value: string;
}

interface FakeStrategyHandle {
  readonly strategy: ChildRunStrategy<FakeTurn>;
  /** Number of launch/runTurn calls made so far. */
  callCount: () => number;
  /** Resolve the Nth (1-indexed) launch/runTurn call — waits for it to have started. */
  resolveTurn: (callIndex: number, turn: FakeTurn) => Promise<void>;
  /** Reject the Nth (1-indexed) launch/runTurn call — waits for it to have started. */
  rejectTurn: (callIndex: number, err: unknown) => Promise<void>;
  readonly errors: unknown[];
}

/**
 * A minimal strategy whose `launch`/`runTurn` are both driven by externally-
 * resolved deferreds, one per call, indexed 1-based by call order — lets a
 * test control exactly when a specific turn "completes" (not just
 * "whichever turn is currently pending", which races against the loop
 * re-invoking runTurn) and observe every delivery.
 */
function createFakeStrategy(): FakeStrategyHandle {
  const pendings: DeferredPromise<FakeTurn>[] = [];
  const errors: unknown[] = [];

  const runTurn = (): Promise<FakeTurn> => {
    const deferred = pDefer<FakeTurn>();
    pendings.push(deferred);
    return deferred.promise;
  };

  const strategy: ChildRunStrategy<FakeTurn> = {
    stageLabel: 'Fake child run',
    launch: () => runTurn(),
    runTurn: () => runTurn(),
    isTerminal: (turn) => turn.kind === 'terminal',
    isTurnError: (turn) => turn.kind === 'error-turn',
    formatDelivery: (turn) => `delivered:${turn.value}`,
    formatError: (turn, err) => {
      errors.push(err);
      return `error:${turn?.value ?? 'thrown'}`;
    },
  };

  const waitForCall = async (callIndex: number): Promise<void> => {
    await vi.waitFor(() =>
      expect(pendings.length).toBeGreaterThanOrEqual(callIndex),
    );
  };

  return {
    strategy,
    callCount: () => pendings.length,
    resolveTurn: async (callIndex, turn) => {
      await waitForCall(callIndex);
      pendings[callIndex - 1]?.resolve(turn);
    },
    rejectTurn: async (callIndex, err) => {
      await waitForCall(callIndex);
      pendings[callIndex - 1]?.reject(err);
    },
    errors,
  };
}

beforeEach(() => {
  session = defaultSession();
  vi.clearAllMocks();
  mocks.leaseLossListener = undefined;
  mocks.finalizeExecution.mockResolvedValue({
    status: 'durable',
    terminalStatusPersisted: true,
    flowRecord: 'deleted',
  });
  mocks.synchronizeAgentResultOutcome.mockResolvedValue(undefined);
  mocks.persistChildRunReport.mockImplementation(async (_id, msg: string) => {
    return { kind: 'persisted' as const, msg };
  });
  mocks.persistChildRunResultMeta.mockResolvedValue({ kind: 'skipped' });
  mocks.enqueueChildRunFollowUp.mockResolvedValue({
    kind: 'enqueued',
    sendResult: { status: 'sent' },
  });
  mocks.wakeChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
});

afterEach(() => {
  for (const executionId of trackedExecutionIds) {
    session.executions.untrack(executionId);
  }
  trackedExecutionIds.clear();
});

describe('childRunLoop E2E fixtures', () => {
  it('interrupts an in-flight child when its execution lease is lost', async () => {
    const childStreamId = uniqueStreamId('lease-loss');
    const parentStreamId = 'parent' as StreamTabId;
    const { strategy, rejectTurn } = createFakeStrategy();

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-lease-loss' as ExecutionId,
      agentName: 'fake',
      strategy,
    });
    await vi.waitFor(() => expect(mocks.leaseLossListener).toBeDefined());

    mocks.leaseLossListener?.();
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    await rejectTurn(1, abortError);

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
    expect(mocks.enqueueChildRunFollowUp).not.toHaveBeenCalled();
  });

  it('releases session ownership before delivering a failed turn', async () => {
    const childStreamId = uniqueStreamId('failed-turn-release');
    const parentStreamId = 'parent' as StreamTabId;
    const { strategy, rejectTurn } = createFakeStrategy();
    const releaseSessionOwnership = vi.fn();
    mocks.enqueueChildRunFollowUp.mockImplementation(async () => {
      expect(releaseSessionOwnership).toHaveBeenCalledOnce();
      return { kind: 'enqueued', sendResult: { status: 'sent' } };
    });

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-failed-turn-release' as ExecutionId,
      agentName: 'fake-cli',
      strategy: { ...strategy, releaseSessionOwnership },
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    await rejectTurn(1, new Error('initial turn failed'));
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
    expect(releaseSessionOwnership).toHaveBeenCalledOnce();
  });

  it('delegate → interrupt mid-run: an interrupt during the first turn ends the run without a terminal delivery for that turn', async () => {
    const childStreamId = uniqueStreamId('interrupt-mid-run');
    const parentStreamId = 'parent' as StreamTabId;
    const executionId = 'exec-interrupt-mid-run' as ExecutionId;
    const { strategy, rejectTurn } = createFakeStrategy();
    const handle = trackChildHandle(executionId, parentStreamId, childStreamId);

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId,
      agentName: 'fake',
      strategy,
    });

    // Give the loop's async IIFE a tick to attach its interrupt handler and
    // call launch().
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );

    expect(handle.interrupt()).toBe(true);
    // Simulate the in-flight call rejecting with an AbortError-shaped
    // rejection, matching what a real strategy's abortController produces.
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    await rejectTurn(1, abortError);

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
    expect(mocks.enqueueChildRunFollowUp).not.toHaveBeenCalled();
    expect(mocks.wakeChildRunFollowUp).not.toHaveBeenCalled();
    expect(session.executions.getHandle(executionId)).toBeUndefined();
  });

  it('delegate → complete → follow-up delivery: an interim turn delivers, then the loop picks up a queued follow-up for the next turn', async () => {
    const childStreamId = uniqueStreamId('complete-followup');
    const parentStreamId = 'parent' as StreamTabId;
    const { strategy, callCount, resolveTurn } = createFakeStrategy();
    const onTurnSuccess = vi.fn();
    const parentWake = vi.fn();
    const deliveryCompleted = pDefer<{ kind: 'delivered' }>();
    mocks.wakeChildRunFollowUp.mockImplementation(async () => {
      parentWake();
      return deliveryCompleted.promise;
    });

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-complete-followup' as ExecutionId,
      agentName: 'fake',
      strategy: { ...strategy, onTurnSuccess },
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    await resolveTurn(1, { kind: 'interim', value: 'first' });

    await vi.waitFor(() => {
      expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          targetStreamId: parentStreamId,
          followUp: expect.objectContaining({ text: 'delivered:first' }),
        }),
      );
    });
    // The loop starts delivery for turn N before reading the queue for turn
    // N+1. Even input already queued during delivery must not begin another
    // model turn until the parent has received this result.
    await vi.waitFor(() =>
      expect(mocks.wakeChildRunFollowUp).toHaveBeenCalled(),
    );
    expect(onTurnSuccess).toHaveBeenCalledOnce();
    expect(onTurnSuccess.mock.invocationCallOrder[0]).toBeLessThan(
      parentWake.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    // Enqueue a follow-up on the same queue the loop is now blocked on.
    session.followUps
      .acquire(childStreamId)
      .enqueue({ text: 'keep going', origin: 'user' });
    expect(callCount()).toBe(1);

    deliveryCompleted.resolve({ kind: 'delivered' });
    await vi.waitFor(() => expect(callCount()).toBe(2));

    // Waits for the loop to have actually invoked runTurn a second time —
    // NOT for the queue to read empty, which can happen synchronously on
    // enqueue (the fast "someone is already waiting" path never pushes to
    // the backing array at all) well before the loop's own continuation runs.
    await resolveTurn(2, { kind: 'terminal', value: 'final' });

    await vi.waitFor(() => {
      expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          followUp: expect.objectContaining({ text: 'delivered:final' }),
        }),
      );
    });
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
  });

  it('late result after parent stop: a turn that resolves after interruption is persisted but not delivered', async () => {
    const childStreamId = uniqueStreamId('late-result');
    const parentStreamId = 'parent' as StreamTabId;
    const executionId = 'exec-late-result' as ExecutionId;
    const { strategy, resolveTurn } = createFakeStrategy();
    const handle = trackChildHandle(executionId, parentStreamId, childStreamId);
    const releaseSessionOwnership = vi.fn();
    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId,
      agentName: 'fake',
      strategy: { ...strategy, releaseSessionOwnership },
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    // Interrupt the loop, then let the in-flight turn resolve normally
    // (not aborted) — mirrors a turn that was already past its own
    // interruption checkpoints when the stop landed.
    expect(handle.interrupt()).toBe(true);
    await resolveTurn(1, { kind: 'terminal', value: 'late' });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
    expect(mocks.persistChildRunReport).toHaveBeenCalledWith(
      executionId,
      'delivered:late',
    );
    expect(releaseSessionOwnership).toHaveBeenCalledOnce();
    expect(mocks.enqueueChildRunFollowUp).not.toHaveBeenCalled();
    expect(mocks.wakeChildRunFollowUp).not.toHaveBeenCalled();
  });

  it('kill during WAITING: interrupting the loop while it is blocked between turns ends the run without a hang', async () => {
    const childStreamId = uniqueStreamId('kill-during-waiting');
    const parentStreamId = 'parent' as StreamTabId;
    const executionId = 'exec-kill-during-waiting' as ExecutionId;
    const { strategy, resolveTurn } = createFakeStrategy();
    const handle = trackChildHandle(executionId, parentStreamId, childStreamId);

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId,
      agentName: 'fake',
      strategy,
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    await resolveTurn(1, { kind: 'interim', value: 'first' });

    await vi.waitFor(() => {
      expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalled();
    });
    // The loop is now blocked in queue.waitAndDrainAll; the loop's handler on
    // the run handle is the live stop target.
    expect(handle.interrupt()).toBe(true);

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
    // Only the one interim delivery — the kill did not spawn another turn.
    expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledTimes(1);
  });

  it('stop between turns settles without result sync when terminal metadata fails', async () => {
    // Regression: for a native strategy (no ChildStream — each turn owns its
    // own AgentExecutionHandle via runFlowWithLifecycle, not the loop), a
    // stop landing BETWEEN turns interrupts the loop through the run handle
    // and transitions the stream to CANCELLED — but assumes a live flow will
    // notice and self-finalize.
    // Nothing is running here (the loop is just blocked on a queue wait), so
    // without the loop's own finalize-on-interrupt fallback, the most
    // recently tracked handle for this stream — still WAITING, still
    // resumable-looking — would never settle or untrack.
    const childStreamId = uniqueStreamId('ghost-handle-stop');
    const parentStreamId = 'parent' as StreamTabId;
    const executionId = 'exec-ghost-handle-stop' as ExecutionId;
    const { strategy, resolveTurn } = createFakeStrategy();
    mocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      error: new Error('metadata disk full'),
      stage: 'terminal-status',
      terminalStatusPersisted: false,
    });

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId,
      agentName: 'fake',
      strategy,
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );

    // Mirrors what a real native turn's runFlowWithLifecycle does: track a
    // fresh handle for this executionId/childStreamId, WAITING, once the
    // turn suspends.
    const handle = trackChildHandle(
      executionId,
      parentStreamId,
      childStreamId,
      STREAM_PHASE.WAITING,
    );

    await resolveTurn(1, { kind: 'interim', value: 'first' });
    await vi.waitFor(() =>
      expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledTimes(1),
    );

    // Loop is now between turns. Interrupt it through the run handle.
    expect(handle.interrupt()).toBe(true);

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );

    // Settled: handle.result resolves instead of hanging forever.
    await expect(handle.result).resolves.toMatchObject({
      outcome: 'cancelled',
      executionId,
    });
    // Untracked: no longer resumable — a later delegate_agent(execution_id=…)
    // would correctly report "not found" instead of finding a ghost handle.
    expect(session.executions.getHandle(executionId)).toBeUndefined();
    expect(mocks.synchronizeAgentResultOutcome).not.toHaveBeenCalled();
  });

  it('reattaches the loop interrupt handler immediately when a turn settles, before delivery (Copilot review: no interrupt gap during delivery)', async () => {
    // Regression: if the loop attached its own interrupt handler only AFTER
    // awaiting deliverTurn (persist report / persist manifest / deliver
    // follow-up), a stop/kill landing during that delivery window would find
    // only the now-detached per-turn flow context. The test inspects the run
    // handle while delivery is deliberately held open.
    const childStreamId = uniqueStreamId('reregister-before-delivery');
    const parentStreamId = 'parent' as StreamTabId;
    const executionId = 'exec-reregister-before-delivery' as ExecutionId;
    const handle = trackChildHandle(executionId, parentStreamId, childStreamId);
    let deliveryGate: DeferredPromise<void> | undefined;
    mocks.enqueueChildRunFollowUp.mockImplementation(async () => {
      deliveryGate = pDefer<void>();
      await deliveryGate.promise;
      return { kind: 'enqueued', sendResult: { status: 'sent' } };
    });

    const strategy: ChildRunStrategy<FakeTurn> = {
      stageLabel: 'Reregister test',
      launch: async () => ({ kind: 'terminal', value: 'done' }),
      isTerminal: () => true,
      formatDelivery: (turn) => `delivered:${turn.value}`,
      formatError: () => 'error',
    };

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId,
      agentName: 'fake',
      strategy,
    });

    // Poll until delivery is mid-flight (blocked on our gate) — the exact
    // window the review flagged as unprotected.
    await vi.waitFor(() => expect(deliveryGate).toBeDefined());

    // The loop's own interrupt handler must already be back in place here,
    // even though delivery has not finished.
    expect(handle.interrupt()).toBe(true);

    deliveryGate?.resolve();
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
  });

  it('#8093 regression: a terminal turn finalizes this child before its wake step is even reached, so a resumed parent never self-stalls waiting on it', async () => {
    // Regression: `wakeChildRunFollowUp` can await the ENTIRE resumed parent
    // turn (`agentResume.tryResumeStream` → … → `resumeToolUseFromResumeData`).
    // Before #8093, the loop awaited enqueue-and-wake together, inline in the
    // turn loop, and only finalized this child (untracking its execution
    // handle) afterward in the outer `finally` — so a resumed parent that
    // immediately calls `executions` with action=wait on this same execution
    // could find it still RUNNING and block on itself for the whole wait
    // budget. Prove the fixed ordering: by the moment the wake step is even
    // reached, this execution is already untracked (terminal in the registry)
    // — a resumed parent's wait would resolve immediately instead of racing
    // its own wake.
    const childStreamId = uniqueStreamId('finalize-before-wake');
    const parentStreamId = 'parent' as StreamTabId;
    const executionId = 'exec-finalize-before-wake' as ExecutionId;
    trackChildHandle(executionId, parentStreamId, childStreamId);

    let releaseWake: (() => void) | undefined;
    let handleAtWakeTime: unknown;
    mocks.wakeChildRunFollowUp.mockImplementation(async () => {
      // Snapshot registry state the instant the wake step is reached — the
      // same moment a resumed parent's own turn would begin running.
      handleAtWakeTime = session.executions.getHandle(executionId);
      await new Promise<void>((resolve) => {
        releaseWake = resolve;
      });
      return { kind: 'delivered' };
    });

    const strategy: ChildRunStrategy<FakeTurn> = {
      stageLabel: 'Finalize-before-wake test',
      launch: async () => ({ kind: 'terminal', value: 'done' }),
      isTerminal: () => true,
      formatDelivery: (turn) => `delivered:${turn.value}`,
      formatError: () => 'error',
    };

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId,
      agentName: 'fake',
      strategy,
    });

    await vi.waitFor(() => expect(releaseWake).toBeDefined());
    expect(handleAtWakeTime).toBeUndefined();
    expect(session.executions.getHandle(executionId)).toBeUndefined();

    releaseWake?.();
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
  });

  it('preserves #7491: a failed runTurn (thrown, not a value) delivers formatError to the parent', async () => {
    const childStreamId = uniqueStreamId('failed-run-turn');
    const parentStreamId = 'parent' as StreamTabId;
    const { strategy, resolveTurn, rejectTurn, errors } = createFakeStrategy();

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-failed-run-turn' as ExecutionId,
      agentName: 'fake',
      strategy,
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    await resolveTurn(1, { kind: 'interim', value: 'first' });
    await vi.waitFor(() => {
      expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledTimes(1);
    });

    session.followUps
      .acquire(childStreamId)
      .enqueue({ text: 'resume please', origin: 'user' });

    const resumeFailure = new Error('resume storage unreadable');
    await rejectTurn(2, resumeFailure);

    await vi.waitFor(() => {
      expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          followUp: expect.objectContaining({ text: 'error:thrown' }),
        }),
      );
    });
    expect(errors).toContain(resumeFailure);
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
  });

  it('an application-level failure (isTurnError, not thrown) also delivers formatError and stops the run', async () => {
    const childStreamId = uniqueStreamId('turn-error');
    const parentStreamId = 'parent' as StreamTabId;
    const { strategy, resolveTurn } = createFakeStrategy();

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-turn-error' as ExecutionId,
      agentName: 'fake',
      strategy,
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    await resolveTurn(1, { kind: 'error-turn', value: 'oops' });

    await vi.waitFor(() => {
      expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          followUp: expect.objectContaining({ text: 'error:oops' }),
        }),
      );
    });
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
  });

  it('finalizes a dangling native handle with non-null error metadata after a non-throwing turn failure', async () => {
    const childStreamId = uniqueStreamId('turn-error-finalize');
    const parentStreamId = 'parent' as StreamTabId;
    const executionId = 'exec-turn-error-finalize' as ExecutionId;
    const { strategy, resolveTurn } = createFakeStrategy();

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId,
      agentName: 'fake',
      strategy,
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );

    const handle = trackChildHandle(
      executionId,
      parentStreamId,
      childStreamId,
      STREAM_PHASE.WAITING,
    );

    await resolveTurn(1, { kind: 'error-turn', value: 'oops' });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
    await expect(handle.result).resolves.toMatchObject({
      outcome: 'failed',
      executionId,
      error: expect.objectContaining({
        message: expect.stringContaining('reported a failed turn'),
      }),
    });
    expect(session.executions.getHandle(executionId)).toBeUndefined();
  });

  it('recordCost commits exactly once, with the last observed value, when the run ends', async () => {
    const childStreamId = uniqueStreamId('record-cost');
    const parentStreamId = 'parent' as StreamTabId;
    let launchResolve: ((turn: FakeTurn) => void) | undefined;
    let runTurnResolve: ((turn: FakeTurn) => void) | undefined;
    let calls = 0;
    const recordCost = vi.fn();

    const strategy: ChildRunStrategy<FakeTurn> = {
      stageLabel: 'Fake cost-tracking run',
      launch: (ports: ChildRunPorts) =>
        new Promise<FakeTurn>((resolve) => {
          launchResolve = (turn) => {
            ports.recordCost(0.1);
            resolve(turn);
          };
        }),
      runTurn: (_items, ports: ChildRunPorts) =>
        new Promise<FakeTurn>((resolve) => {
          calls += 1;
          runTurnResolve = (turn) => {
            ports.recordCost(0.2);
            resolve(turn);
          };
        }),
      isTerminal: (turn) => turn.kind === 'terminal',
      formatDelivery: (turn) => `delivered:${turn.value}`,
      formatError: (turn) => `error:${turn?.value ?? 'thrown'}`,
    };

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-record-cost' as ExecutionId,
      agentName: 'fake',
      strategy,
      recordCost,
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    launchResolve?.({ kind: 'interim', value: 'first' });
    await vi.waitFor(() =>
      expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledTimes(1),
    );

    session.followUps
      .acquire(childStreamId)
      .enqueue({ text: 'go on', origin: 'user' });
    // Waits for the loop to have actually invoked runTurn (calls increments
    // synchronously inside it) — not for the queue to read empty, which can
    // happen before the loop's own continuation runs (see the "delegate →
    // complete → follow-up delivery" fixture's comment for why).
    await vi.waitFor(() => expect(calls).toBe(1));
    runTurnResolve?.({ kind: 'terminal', value: 'final' });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(0.2);
  });
});
