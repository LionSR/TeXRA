// E2E fixtures for the promoted "one loop, N strategies" child-run driver.
// These exercise the loop's own mechanics (queue acquire/drain, one
// interruptible for the child's whole lifetime, per-turn delivery, terminal
// finalize) against a minimal fake strategy — the same contract every real
// strategy (codex, claude, native tool-use, native workflow) implements.
// Identical assertions apply regardless of which strategy is plugged in,
// since delivery/interrupt/terminal choreography all live in the loop.

import pDefer, { type DeferredPromise } from 'p-defer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persistChildRunReport: vi.fn(),
  persistChildRunResultMeta: vi.fn(),
  deliverChildRunFollowUp: vi.fn(),
}));

vi.mock('@tools/childRunDelivery', () => ({
  persistChildRunReport: mocks.persistChildRunReport,
  persistChildRunResultMeta: mocks.persistChildRunResultMeta,
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
}));

import {
  startChildRunLoop,
  isChildRunLoopActive,
  type ChildRunPorts,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

const session = defaultSession();

function uniqueStreamId(label: string): StreamTabId {
  return `${label}-${Math.random().toString(36).slice(2)}` as StreamTabId;
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
  vi.clearAllMocks();
  mocks.persistChildRunReport.mockImplementation(async (_id, msg: string) => {
    return { kind: 'persisted' as const, msg };
  });
  mocks.persistChildRunResultMeta.mockResolvedValue({ kind: 'skipped' });
  mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
});

afterEach(() => {
  session.interrupts.retainOnly(new Set());
});

describe('childRunLoop E2E fixtures', () => {
  it('delegate → interrupt mid-run: an interrupt during the first turn ends the run without a terminal delivery for that turn', async () => {
    const childStreamId = uniqueStreamId('interrupt-mid-run');
    const parentStreamId = 'parent' as StreamTabId;
    const { strategy, rejectTurn } = createFakeStrategy();

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-interrupt-mid-run' as ExecutionId,
      agentName: 'fake',
      strategy,
    });

    // Give the loop's async IIFE a tick to register its interruptible and
    // call launch().
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );

    const interruptible = session.interrupts.get(childStreamId);
    expect(interruptible).toBeDefined();
    interruptible?.interrupt();
    // Simulate the in-flight call rejecting with an AbortError-shaped
    // rejection, matching what a real strategy's abortController produces.
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    await rejectTurn(1, abortError);

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
    expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
    expect(session.interrupts.get(childStreamId)).toBeUndefined();
  });

  it('delegate → complete → follow-up delivery: an interim turn delivers, then the loop picks up a queued follow-up for the next turn', async () => {
    const childStreamId = uniqueStreamId('complete-followup');
    const parentStreamId = 'parent' as StreamTabId;
    const { strategy, resolveTurn } = createFakeStrategy();

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-complete-followup' as ExecutionId,
      agentName: 'fake',
      strategy,
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    await resolveTurn(1, { kind: 'interim', value: 'first' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          targetStreamId: parentStreamId,
          followUp: expect.objectContaining({ text: 'delivered:first' }),
          wake: true,
        }),
      );
    });

    // Enqueue a follow-up on the same queue the loop is now blocked on.
    session.followUps
      .acquire(childStreamId)
      .enqueue({ text: 'keep going', origin: 'user' });

    // Waits for the loop to have actually invoked runTurn a second time —
    // NOT for the queue to read empty, which can happen synchronously on
    // enqueue (the fast "someone is already waiting" path never pushes to
    // the backing array at all) well before the loop's own continuation runs.
    await resolveTurn(2, { kind: 'terminal', value: 'final' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          followUp: expect.objectContaining({ text: 'delivered:final' }),
        }),
      );
    });
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
  });

  it('late result after parent stop: a turn that resolves after the loop already interrupted still attempts best-effort delivery and does not throw', async () => {
    const childStreamId = uniqueStreamId('late-result');
    const parentStreamId = 'parent' as StreamTabId;
    const { strategy, resolveTurn } = createFakeStrategy();
    // The parent stream is gone by the time this late delivery lands.
    mocks.deliverChildRunFollowUp.mockResolvedValue({
      kind: 'no_session',
      streamStatus: 'completed',
    });

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-late-result' as ExecutionId,
      agentName: 'fake',
      strategy,
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    // Interrupt the loop, then let the in-flight turn resolve normally
    // (not aborted) — mirrors a turn that was already past its own
    // interruption checkpoints when the stop landed.
    session.interrupts.get(childStreamId)?.interrupt();
    await resolveTurn(1, { kind: 'terminal', value: 'late' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          followUp: expect.objectContaining({ text: 'delivered:late' }),
        }),
      );
    });
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
  });

  it('kill during WAITING: interrupting the loop while it is blocked between turns ends the run without a hang', async () => {
    const childStreamId = uniqueStreamId('kill-during-waiting');
    const parentStreamId = 'parent' as StreamTabId;
    const { strategy, resolveTurn } = createFakeStrategy();

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-kill-during-waiting' as ExecutionId,
      agentName: 'fake',
      strategy,
    });

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(true),
    );
    await resolveTurn(1, { kind: 'interim', value: 'first' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalled();
    });
    // The loop is now blocked in queue.waitAndDrainAll — no live per-turn
    // interruptible exists here (nothing is mid-turn); this loop's own
    // interruptible, registered for the child's whole lifetime, is the only
    // thing a kill can find.
    const interruptible = session.interrupts.get(childStreamId);
    expect(interruptible).toBeDefined();
    interruptible?.interrupt();

    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
    expect(session.interrupts.get(childStreamId)).toBeUndefined();
    // Only the one interim delivery — the kill did not spawn another turn.
    expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1);
  });

  it('stop between turns (native, no ChildStream) settles and untracks the dangling handle — no ghost subagent', async () => {
    // Regression: for a native strategy (no ChildStream — each turn owns its
    // own AgentExecutionHandle via runFlowWithLifecycle, not the loop), a
    // stop landing BETWEEN turns finds the loop's own interruptible in
    // ExecutionRegistry, calls .interrupt(), and transitions the stream to
    // CANCELLED — but assumes a live flow will notice and self-finalize.
    // Nothing is running here (the loop is just blocked on a queue wait), so
    // without the loop's own finalize-on-interrupt fallback, the most
    // recently tracked handle for this stream — still WAITING, still
    // resumable-looking — would never settle or untrack.
    const childStreamId = uniqueStreamId('ghost-handle-stop');
    const parentStreamId = 'parent' as StreamTabId;
    const executionId = 'exec-ghost-handle-stop' as ExecutionId;
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

    // Mirrors what a real native turn's runFlowWithLifecycle does: track a
    // fresh handle for this executionId/childStreamId, WAITING, once the
    // turn suspends.
    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'fake',
      'toolUse',
      { emit: vi.fn() } as never,
    );
    session.executions.trackAgentExecution(handle, {
      status: STREAM_PHASE.WAITING,
    });

    await resolveTurn(1, { kind: 'interim', value: 'first' });
    await vi.waitFor(() =>
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
    );

    // Loop is now between turns. Interrupt it — simulating
    // ExecutionRegistry.terminate() finding the loop's own interruptible.
    const interruptible = session.interrupts.get(childStreamId);
    expect(interruptible).toBeDefined();
    interruptible?.interrupt();

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
  });

  it('re-registers the loop interruptible immediately when a turn settles, before delivery (Copilot review: no interruptible-gap during delivery)', async () => {
    // Regression: a native turn's own flow-owned interruptible registers on
    // the SAME InterruptRegistry slot while it runs, then unregisters it in
    // its own `finally` the instant it returns (mirroring runToolUseFlow).
    // If the loop re-registered its own interruptible only AFTER awaiting
    // deliverTurn (persist report / persist manifest / deliver follow-up),
    // a stop/kill landing during that delivery window would find nothing
    // live. This strategy clobbers-then-unregisters the slot inside its own
    // `launch`, exactly like a real native turn, and the test inspects the
    // registry WHILE delivery is deliberately held open.
    const childStreamId = uniqueStreamId('reregister-before-delivery');
    const parentStreamId = 'parent' as StreamTabId;
    let deliveryGate: DeferredPromise<void> | undefined;
    mocks.deliverChildRunFollowUp.mockImplementation(async () => {
      deliveryGate = pDefer<void>();
      await deliveryGate.promise;
      return { kind: 'delivered' };
    });

    const strategy: ChildRunStrategy<FakeTurn> = {
      stageLabel: 'Reregister test',
      launch: async () => {
        // Simulates runToolUseFlow's own register-on-start,
        // unregister-in-finally choreography on the identical stream id.
        session.interrupts.register(childStreamId, { interrupt: () => {} });
        session.interrupts.unregister(childStreamId);
        return { kind: 'terminal', value: 'done' };
      },
      isTerminal: () => true,
      formatDelivery: (turn) => `delivered:${turn.value}`,
      formatError: () => 'error',
    };

    startChildRunLoop({
      childStreamId,
      parentStreamId,
      executionId: 'exec-reregister-before-delivery' as ExecutionId,
      agentName: 'fake',
      strategy,
    });

    // Poll until delivery is mid-flight (blocked on our gate) — the exact
    // window the review flagged as unprotected.
    await vi.waitFor(() => expect(deliveryGate).toBeDefined());

    // The loop's own interruptible must already be back in place here, even
    // though delivery has not finished.
    expect(session.interrupts.get(childStreamId)).toBeDefined();

    deliveryGate?.resolve();
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
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1);
    });

    session.followUps
      .acquire(childStreamId)
      .enqueue({ text: 'resume please', origin: 'user' });

    const resumeFailure = new Error('resume storage unreadable');
    await rejectTurn(2, resumeFailure);

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith(
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
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          followUp: expect.objectContaining({ text: 'error:oops' }),
        }),
      );
    });
    await vi.waitFor(() =>
      expect(isChildRunLoopActive(childStreamId)).toBe(false),
    );
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
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
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
