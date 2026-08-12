// Test composition imports
import '@test/support/defaultSessionTestSetup';

// E2E fixtures for the promoted "one loop, N strategies" child-run driver.
// These exercise the loop's own mechanics (queue acquire/drain, one
// run-handle interrupt target for the child's whole lifetime, per-turn delivery, terminal
// finalize) against a minimal fake strategy — the same contract every real
// strategy (codex, claude, native subagent, workflow-script) implements.
// Identical assertions apply regardless of which strategy is plugged in,
// since delivery/interrupt/terminal choreography all live in the loop.

import pDefer, { type DeferredPromise } from 'p-defer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn(),
  persistChildRunReport: vi.fn(),
  persistChildRunResultMeta: vi.fn(),
  deliverChildRunFollowUp: vi.fn(),
  runWithOwnedExecutionLease: vi.fn(
    (_executionId: ExecutionId, operation: () => unknown) => operation(),
  ),
  leaseLossListener: undefined as (() => void) | undefined,
}));

// Turn-state persistence runs against the real (memfs-backed) execution store:
// the loop writes it best-effort and no assertion here depends on it.
vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  finalizeExecution: mocks.finalizeExecution,
}));
// terminalPersistence deep-imports finalizeExecution from executionLifecycle.
vi.mock('@agent/storage/executionLifecycle', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@agent/storage/executionLifecycle')
  >()),
  finalizeExecution: mocks.finalizeExecution,
}));

vi.mock('@agent/storage/executionLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/executionLease')>()),
  markOwnedExecutionLeaseUndurable: vi.fn(),
  runWithOwnedExecutionLease: mocks.runWithOwnedExecutionLease,
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

vi.mock('@agent/storage/childRunPersistence', () => ({
  persistChildRunReport: mocks.persistChildRunReport,
  persistChildRunResultMeta: mocks.persistChildRunResultMeta,
}));

vi.mock('@agent/followUp/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
}));

import type { WorkflowJournalEntry } from '@agent/workflowScript';
import {
  startChildRunLoop,
  type ChildRunLoopHandle,
  type ChildRunLoopParams,
  type ChildRunPorts,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamPhase,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { AgentCliSessionRegistry } from '@tools/agentCliSessionRegistry';
import {
  ClaudeAgentSessions,
  CodexThreads,
} from '@tools/agentCliSessionStores';
import { createChildStream } from '@tools/delegation/childStream';
import { createWorkflowAttemptCostTracker } from '@tools/delegation/workflowScriptRun';

let session: SessionHandle;
const trackedExecutionIds = new Set<string>();

const childStreamConfig = {
  agentCategory: AgentCategory.ToolUse,
  model: 'test-model',
  agent: 'fake-cli',
} as unknown as AgentConfig;

const PARENT_STREAM_ID = 'parent' as StreamTabId;

function uniqueStreamId(label: string): StreamTabId {
  return `${label}-${Math.random().toString(36).slice(2)}` as StreamTabId;
}

/** The stream/execution ids a fixture uses, both derived from its label. */
function loopIds(label: string): {
  childStreamId: StreamTabId;
  executionId: ExecutionId;
} {
  return {
    childStreamId: uniqueStreamId(label),
    executionId: `exec-${label}` as ExecutionId,
  };
}

function trackChildHandle(
  executionId: ExecutionId,
  parentStreamId: StreamTabId,
  childStreamId: StreamTabId,
  status: StreamPhase = STREAM_PHASE.RUNNING,
): AgentExecutionHandle {
  const handle = testExecutionHandle({
    executionId,
    parentStreamId,
    childStreamId,
    agent: 'fake',
    trace: { emit: vi.fn() } as never,
  });
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

/** The AbortError shape a real strategy's abortController rejection carries. */
function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** A strategy whose very first turn is already terminal. */
function createTerminalStrategy(
  stageLabel: string,
  launch: ChildRunStrategy<FakeTurn>['launch'] = async () => ({
    kind: 'terminal',
    value: 'done',
  }),
  formatDelivery: ChildRunStrategy<FakeTurn>['formatDelivery'] = (turn) =>
    `delivered:${turn.value}`,
): ChildRunStrategy<FakeTurn> {
  return {
    stageLabel,
    launch,
    isTerminal: () => true,
    formatDelivery,
    formatError: () => 'error',
  };
}

/** Start the loop with the fixture defaults; extras override any param. */
function startLoop(
  ids: { childStreamId: StreamTabId; executionId: ExecutionId },
  strategy: ChildRunStrategy<FakeTurn>,
  extras: Partial<ChildRunLoopParams<FakeTurn>> = {},
): ChildRunLoopHandle {
  return startChildRunLoop({
    ...ids,
    parentStreamId: PARENT_STREAM_ID,
    agentName: 'fake',
    strategy,
    ...extras,
  });
}

async function waitForLiveOwner(childStreamId: StreamTabId): Promise<void> {
  await vi.waitFor(() =>
    expect(session.followUps.hasLiveOwner(childStreamId)).toBe(true),
  );
}

async function waitForLoopEnd(childStreamId: StreamTabId): Promise<void> {
  await vi.waitFor(() =>
    expect(session.followUps.hasLiveOwner(childStreamId)).toBe(false),
  );
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
  mocks.persistChildRunReport.mockImplementation(async (_id, msg: string) => {
    return { kind: 'persisted' as const, msg };
  });
  mocks.persistChildRunResultMeta.mockResolvedValue({ kind: 'skipped' });
  mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
});

afterEach(() => {
  for (const executionId of trackedExecutionIds) {
    session.executions.untrack(executionId);
  }
  trackedExecutionIds.clear();
});

describe('childRunLoop E2E fixtures', () => {
  it('validates the captured lease before registering loop resources', () => {
    const { childStreamId, executionId } = loopIds('lost-before-setup');
    const { strategy, callCount } = createFakeStrategy();
    mocks.runWithOwnedExecutionLease.mockImplementationOnce(() => {
      throw new Error('lease generation lost');
    });

    expect(() => startLoop({ childStreamId, executionId }, strategy)).toThrow(
      'lease generation lost',
    );

    expect(session.followUps.hasLiveOwner(childStreamId)).toBe(false);
    expect(mocks.leaseLossListener).toBeUndefined();
    expect(callCount()).toBe(0);
  });

  it('unwinds provider ownership and loop resources when synchronous setup fails', () => {
    const { childStreamId, executionId } = loopIds('setup-failure');
    const registry = new AgentCliSessionRegistry('test_session_id');
    const releaseSessionOwnership = vi.fn(() =>
      registry.releaseByExecutionId(executionId),
    );
    const handle = trackChildHandle(
      executionId,
      PARENT_STREAM_ID,
      childStreamId,
    );
    const interruptHandle = vi.spyOn(handle, 'interrupt');
    const registerLoop = vi
      .spyOn(session.followUps, 'claimLive')
      .mockImplementationOnce(() => {
        throw new Error('loop registration failed');
      });
    const { strategy } = createFakeStrategy();

    try {
      expect(() =>
        startLoop(
          { childStreamId, executionId },
          {
            ...strategy,
            onLoopStart: (runSession) => {
              registry.trackInFlight({
                childStreamId,
                executionId,
                executions: runSession.executions,
              });
            },
            releaseSessionOwnership,
          },
          { agentName: 'fake-cli' },
        ),
      ).toThrow('loop registration failed');

      expect(releaseSessionOwnership).toHaveBeenCalledOnce();
      expect(session.followUps.hasLiveOwner(childStreamId)).toBe(false);
      expect(mocks.leaseLossListener).toBeUndefined();
      expect(handle.interrupt()).toBe(false);
      interruptHandle.mockClear();
      registry.interruptAll();
      expect(interruptHandle).not.toHaveBeenCalled();
      expect(session.followUps.getAll(childStreamId)).toEqual([]);
    } finally {
      registerLoop.mockRestore();
      interruptHandle.mockRestore();
      registry.releaseByExecutionId(executionId);
    }
  });

  it.each([
    {
      name: 'CodexThreads',
      track: (
        childStreamId: StreamTabId,
        executionId: ExecutionId,
        runSession: SessionHandle,
      ) =>
        CodexThreads.trackInFlight({
          thread: {} as never,
          childStreamId,
          executionId,
          executions: runSession.executions,
        }),
      interruptAll: () => CodexThreads.interruptAll(),
      release: (executionId: ExecutionId) =>
        CodexThreads.releaseByExecutionId(executionId),
    },
    {
      name: 'ClaudeAgentSessions',
      track: (
        childStreamId: StreamTabId,
        executionId: ExecutionId,
        runSession: SessionHandle,
      ) =>
        ClaudeAgentSessions.trackInFlight({
          childStreamId,
          executionId,
          executions: runSession.executions,
          model: 'claude-sonnet-4-6',
          permissionMode: 'acceptEdits',
          effort: 'high',
        }),
      interruptAll: () => ClaudeAgentSessions.interruptAll(),
      release: (executionId: ExecutionId) =>
        ClaudeAgentSessions.releaseByExecutionId(executionId),
    },
  ])(
    '$name interrupts a real initial-turn loop and releases ownership once',
    async ({ name, track, interruptAll, release }) => {
      const { childStreamId, executionId } = loopIds(`${name}-initial-turn`);
      const events: string[] = [];
      const aborted = vi.fn();
      const releaseSessionOwnership = vi.fn(() => release(executionId));
      trackChildHandle(executionId, PARENT_STREAM_ID, childStreamId);

      const strategy: ChildRunStrategy<FakeTurn> = {
        stageLabel: `${name} session`,
        launch: (_ports, abortController) => {
          events.push('launch');
          return new Promise((_resolve, reject) => {
            const rejectAbort = () => {
              aborted();
              reject(createAbortError());
            };
            if (abortController.signal.aborted) rejectAbort();
            else {
              abortController.signal.addEventListener('abort', rejectAbort, {
                once: true,
              });
            }
          });
        },
        isTerminal: () => false,
        formatDelivery: () => 'unexpected delivery',
        formatError: () => 'unexpected error',
        onLoopStart: (runSession) => {
          events.push('registered');
          track(childStreamId, executionId, runSession);
        },
        releaseSessionOwnership,
      };

      try {
        startLoop({ childStreamId, executionId }, strategy, {
          agentName: name,
        });

        expect(events).toEqual(['registered', 'launch']);
        expect(session.followUps.hasLiveOwner(childStreamId)).toBe(true);
        interruptAll();

        await vi.waitFor(() => {
          expect(aborted).toHaveBeenCalledOnce();
          expect(session.followUps.hasLiveOwner(childStreamId)).toBe(false);
        });
        expect(releaseSessionOwnership).toHaveBeenCalledOnce();
        expect(session.executions.getHandle(executionId)).toBeUndefined();
      } finally {
        release(executionId);
      }
    },
  );

  it('interrupts an in-flight child when its execution lease is lost', async () => {
    const { childStreamId, executionId } = loopIds('lease-loss');
    const { strategy, rejectTurn } = createFakeStrategy();

    startLoop({ childStreamId, executionId }, strategy);
    expect(mocks.runWithOwnedExecutionLease).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(mocks.leaseLossListener).toBeDefined());

    mocks.leaseLossListener?.();
    await rejectTurn(1, createAbortError());

    await waitForLoopEnd(childStreamId);
    expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
  });

  it('persists without parent delivery in persist-only mode', async () => {
    const { childStreamId, executionId } = loopIds('persist-only');
    const { strategy, resolveTurn } = createFakeStrategy();

    const handle = startLoop(
      { childStreamId, executionId },
      { ...strategy, deliveryMode: 'persistOnly' },
      { parentStreamId: 'headless-parent' as StreamTabId },
    );
    await resolveTurn(1, { kind: 'terminal', value: 'saved' });
    await handle.completion;

    expect(mocks.persistChildRunReport).toHaveBeenCalledWith(
      executionId,
      'delivered:saved',
    );
    expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
  });

  it('releases session ownership before delivering a failed turn', async () => {
    const { childStreamId, executionId } = loopIds('failed-turn-release');
    const { strategy, rejectTurn } = createFakeStrategy();
    const releaseSessionOwnership = vi.fn();
    mocks.deliverChildRunFollowUp.mockImplementation(async () => {
      expect(releaseSessionOwnership).toHaveBeenCalledOnce();
      return { kind: 'delivered' };
    });

    startLoop(
      { childStreamId, executionId },
      { ...strategy, releaseSessionOwnership },
      { agentName: 'fake-cli' },
    );

    await waitForLiveOwner(childStreamId);
    await rejectTurn(1, new Error('initial turn failed'));
    await waitForLoopEnd(childStreamId);
    expect(releaseSessionOwnership).toHaveBeenCalledOnce();
  });

  it('delegate → interrupt mid-run: an interrupt during the first turn ends the run without a terminal delivery for that turn', async () => {
    const { childStreamId, executionId } = loopIds('interrupt-mid-run');
    const { strategy, rejectTurn } = createFakeStrategy();
    const handle = trackChildHandle(
      executionId,
      PARENT_STREAM_ID,
      childStreamId,
    );

    startLoop({ childStreamId, executionId }, strategy);

    // Give the loop's async IIFE a tick to attach its interrupt handler and
    // call launch().
    await waitForLiveOwner(childStreamId);

    expect(handle.interrupt()).toBe(true);
    // Simulate the in-flight call rejecting with an AbortError-shaped
    // rejection, matching what a real strategy's abortController produces.
    await rejectTurn(1, createAbortError());

    await waitForLoopEnd(childStreamId);
    expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
    expect(session.executions.getHandle(executionId)).toBeUndefined();
  });

  it('delegate → complete → follow-up delivery: an interim turn delivers, then the loop picks up a queued follow-up for the next turn', async () => {
    const { childStreamId, executionId } = loopIds('complete-followup');
    const { strategy, callCount, resolveTurn } = createFakeStrategy();
    const onLoopStart = vi.fn();
    const onTurnSuccess = vi.fn();
    const parentWake = vi.fn();
    const deliveryCompleted = pDefer<{ kind: 'delivered' }>();
    mocks.deliverChildRunFollowUp.mockImplementation(async () => {
      parentWake();
      return deliveryCompleted.promise;
    });

    startLoop(
      { childStreamId, executionId },
      { ...strategy, onLoopStart, onTurnSuccess },
    );

    expect(onLoopStart).toHaveBeenCalledOnce();
    expect(onLoopStart).toHaveBeenCalledWith(session);
    await waitForLiveOwner(childStreamId);
    await resolveTurn(1, { kind: 'interim', value: 'first' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          targetStreamId: PARENT_STREAM_ID,
          followUp: expect.objectContaining({ text: 'delivered:first' }),
        }),
      );
    });
    // The loop starts delivery for turn N before reading the queue for turn
    // N+1. Even input already queued during delivery must not begin another
    // model turn until the parent has received this result.
    expect(onTurnSuccess).toHaveBeenCalledOnce();
    expect(onTurnSuccess.mock.invocationCallOrder[0]).toBeLessThan(
      parentWake.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    // Enqueue a follow-up on the same queue the loop is now blocked on.
    expect(
      session.followUps.submit(
        childStreamId,
        { text: 'keep going', origin: 'user' },
        'live_owner',
      ),
    ).toEqual({ kind: 'live' });
    expect(callCount()).toBe(1);

    deliveryCompleted.resolve({ kind: 'delivered' });
    await vi.waitFor(() => expect(callCount()).toBe(2));

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
    await waitForLoopEnd(childStreamId);
  });

  it('late result after parent stop: a turn that resolves after interruption is persisted but not delivered', async () => {
    const { childStreamId, executionId } = loopIds('late-result');
    const { strategy, resolveTurn } = createFakeStrategy();
    const handle = trackChildHandle(
      executionId,
      PARENT_STREAM_ID,
      childStreamId,
    );
    const releaseSessionOwnership = vi.fn();
    startLoop(
      { childStreamId, executionId },
      { ...strategy, releaseSessionOwnership },
    );

    await waitForLiveOwner(childStreamId);
    // Interrupt the loop, then let the in-flight turn resolve normally
    // (not aborted) — mirrors a turn that was already past its own
    // interruption checkpoints when the stop landed.
    expect(handle.interrupt()).toBe(true);
    await resolveTurn(1, { kind: 'terminal', value: 'late' });

    await waitForLoopEnd(childStreamId);
    expect(mocks.persistChildRunReport).toHaveBeenCalledWith(
      executionId,
      'delivered:late',
    );
    expect(releaseSessionOwnership).toHaveBeenCalledOnce();
    expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
  });

  it('kill during WAITING: interrupting the loop while it is blocked between turns ends the run without a hang', async () => {
    const { childStreamId, executionId } = loopIds('kill-during-waiting');
    const { strategy, resolveTurn } = createFakeStrategy();
    const handle = trackChildHandle(
      executionId,
      PARENT_STREAM_ID,
      childStreamId,
    );

    startLoop({ childStreamId, executionId }, strategy);

    await waitForLiveOwner(childStreamId);
    await resolveTurn(1, { kind: 'interim', value: 'first' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalled();
    });
    // The loop is now blocked in queue.waitAndDrainAll; the loop's handler on
    // the run handle is the live stop target.
    expect(handle.interrupt()).toBe(true);

    await waitForLoopEnd(childStreamId);
    // Only the one interim delivery — the kill did not spawn another turn.
    expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1);
  });

  it('stop between turns settles the ghost handle when terminal metadata fails', async () => {
    // Regression: for a native strategy (no ChildStream — each turn owns its
    // own AgentExecutionHandle via runFlowWithLifecycle, not the loop), a
    // stop landing BETWEEN turns interrupts the loop through the run handle
    // and transitions the stream to CANCELLED — but assumes a live flow will
    // notice and self-finalize.
    // Nothing is running here (the loop is just blocked on a queue wait), so
    // without the loop's own finalize-on-interrupt fallback, the most
    // recently tracked handle for this stream — still WAITING, still
    // resumable-looking — would never settle or untrack.
    const { childStreamId, executionId } = loopIds('ghost-handle-stop');
    const { strategy, resolveTurn } = createFakeStrategy();
    mocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      error: new Error('metadata disk full'),
      stage: 'terminal-status',
      terminalStatusPersisted: false,
    });

    startLoop({ childStreamId, executionId }, strategy);

    await waitForLiveOwner(childStreamId);

    // Mirrors what a real native turn's runFlowWithLifecycle does: track a
    // fresh handle for this executionId/childStreamId, WAITING, once the
    // turn suspends.
    const handle = trackChildHandle(
      executionId,
      PARENT_STREAM_ID,
      childStreamId,
      STREAM_PHASE.WAITING,
    );

    await resolveTurn(1, { kind: 'interim', value: 'first' });
    await vi.waitFor(() =>
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
    );

    // Loop is now between turns. Interrupt it through the run handle.
    expect(handle.interrupt()).toBe(true);

    await waitForLoopEnd(childStreamId);

    // Settled: handle.result resolves instead of hanging forever.
    await expect(handle.result).resolves.toMatchObject({
      outcome: 'cancelled',
      executionId,
    });
    // Untracked: no longer resumable — a later delegate_agent(execution_id=…)
    // would correctly report "not found" instead of finding a ghost handle.
    expect(session.executions.getHandle(executionId)).toBeUndefined();
    // The loop routes the cancellation through the durable outcome's only
    // writer; the interim result envelope is left exactly as its turn wrote
    // it, and reads project the durable outcome onto it.
    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      executionId,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
    });
  });

  it('leaves no interruptible child continuation while terminal delivery is in flight', async () => {
    // Terminal delivery (persist report / persist manifest / deliver
    // follow-up) runs after child finalization and lease release, so a
    // stop/kill landing in that window finds nothing left to interrupt. The
    // test inspects the run handle while delivery is deliberately held open.
    const { childStreamId, executionId } = loopIds(
      'reregister-before-delivery',
    );
    const handle = trackChildHandle(
      executionId,
      PARENT_STREAM_ID,
      childStreamId,
    );
    let deliveryGate: DeferredPromise<void> | undefined;
    mocks.deliverChildRunFollowUp.mockImplementation(async () => {
      deliveryGate = pDefer<void>();
      await deliveryGate.promise;
      return { kind: 'delivered' };
    });

    const strategy = createTerminalStrategy('Reregister test');

    startLoop({ childStreamId, executionId }, strategy);

    // Poll until delivery is mid-flight (blocked on our gate).
    await vi.waitFor(() => expect(deliveryGate).toBeDefined());

    expect(handle.interrupt()).toBe(false);

    deliveryGate?.resolve();
    await waitForLoopEnd(childStreamId);
  });

  it('#8093 regression: a terminal turn finalizes this child before its wake step is even reached, so a resumed parent never self-stalls waiting on it', async () => {
    // Regression: parent continuation submission can await the ENTIRE resumed
    // turn (`agentResume.tryResumeStream` → … → `resumeToolUseFromResumeData`).
    // Before #8093, the loop awaited split enqueue/wake work inline in the
    // turn loop, and only finalized this child (untracking its execution
    // handle) afterward in the outer `finally` — so a resumed parent that
    // immediately calls `executions` with action=wait on this same execution
    // could find it still RUNNING and block on itself for the whole wait
    // budget. Prove the fixed ordering: by the moment the wake step is even
    // reached, this execution is already untracked (terminal in the registry)
    // — a resumed parent's wait would resolve immediately instead of racing
    // its own wake.
    const { childStreamId, executionId } = loopIds('finalize-before-wake');
    trackChildHandle(executionId, PARENT_STREAM_ID, childStreamId);

    let releaseWake: (() => void) | undefined;
    let handleAtWakeTime: unknown;
    mocks.deliverChildRunFollowUp.mockImplementation(async () => {
      // Snapshot registry state the instant the wake step is reached — the
      // same moment a resumed parent's own turn would begin running.
      handleAtWakeTime = session.executions.getHandle(executionId);
      await new Promise<void>((resolve) => {
        releaseWake = resolve;
      });
      return { kind: 'delivered' };
    });

    const strategy = createTerminalStrategy('Finalize-before-wake test');

    startLoop({ childStreamId, executionId }, strategy);

    await vi.waitFor(() => expect(releaseWake).toBeDefined());
    expect(handleAtWakeTime).toBeUndefined();
    expect(session.executions.getHandle(executionId)).toBeUndefined();

    releaseWake?.();
    await waitForLoopEnd(childStreamId);
  });

  it('preserves #7491: a failed runTurn (thrown, not a value) delivers formatError to the parent', async () => {
    const { childStreamId, executionId } = loopIds('failed-run-turn');
    const { strategy, resolveTurn, rejectTurn, errors } = createFakeStrategy();

    startLoop({ childStreamId, executionId }, strategy);

    await waitForLiveOwner(childStreamId);
    await resolveTurn(1, { kind: 'interim', value: 'first' });
    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1);
    });

    expect(
      session.followUps.submit(
        childStreamId,
        { text: 'resume please', origin: 'user' },
        'live_owner',
      ),
    ).toEqual({ kind: 'live' });

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
    await waitForLoopEnd(childStreamId);
  });

  it('an application-level failure (isTurnError, not thrown) also delivers formatError and stops the run', async () => {
    const { childStreamId, executionId } = loopIds('turn-error');
    const { strategy, resolveTurn } = createFakeStrategy();

    startLoop({ childStreamId, executionId }, strategy);

    await waitForLiveOwner(childStreamId);
    await resolveTurn(1, { kind: 'error-turn', value: 'oops' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          followUp: expect.objectContaining({ text: 'error:oops' }),
        }),
      );
    });
    await waitForLoopEnd(childStreamId);
  });

  it('finalizes a dangling native handle with non-null error metadata after a non-throwing turn failure', async () => {
    const { childStreamId, executionId } = loopIds('turn-error-finalize');
    const { strategy, resolveTurn } = createFakeStrategy();

    startLoop({ childStreamId, executionId }, strategy);

    await waitForLiveOwner(childStreamId);

    const handle = trackChildHandle(
      executionId,
      PARENT_STREAM_ID,
      childStreamId,
      STREAM_PHASE.WAITING,
    );

    await resolveTurn(1, { kind: 'error-turn', value: 'oops' });

    await waitForLoopEnd(childStreamId);
    await expect(handle.result).resolves.toMatchObject({
      outcome: 'failed',
      executionId,
      error: expect.objectContaining({
        message: expect.stringContaining('reported a failed turn'),
      }),
    });
    expect(session.executions.getHandle(executionId)).toBeUndefined();
  });

  it('keeps the failing turn diagnosis when an interrupt lands after the failure', async () => {
    const executionId = 'fa11ed01' as ExecutionId;
    const parentStreamId = 'parent' as StreamTabId;
    const childStream = createChildStream(executionId, parentStreamId, {
      streamPrefix: 'codex',
      run: { kind: 'agent', agent: 'fake-cli', tool: 'codex' },
      description: 'Fail a turn, then take an interrupt',
      config: childStreamConfig,
    });
    trackedExecutionIds.add(executionId);
    const childStreamId = childStream.childStreamId;
    const handle = session.executions.getAgentHandleByStream(childStreamId);
    const { strategy, rejectTurn } = createFakeStrategy();
    // Fires between the turn failure landing FAILED on the stream phase and
    // the loop's finalize, so the loop reports an interrupted run for a stream
    // whose phase already carries the failure.
    const interruptAfterFailure = vi.fn(() => {
      mocks.leaseLossListener?.();
    });

    startChildRunLoop({
      childStream,
      childStreamId,
      parentStreamId,
      executionId,
      agentName: 'fake-cli',
      strategy,
      recordCost: interruptAfterFailure,
    });

    await waitForLiveOwner(childStreamId);
    await rejectTurn(1, new Error('turn blew up'));
    await waitForLoopEnd(childStreamId);

    expect(interruptAfterFailure).toHaveBeenCalledOnce();
    expect(session.status.get(childStreamId)).toBe(STREAM_PHASE.FAILED);
    await expect(handle?.result).resolves.toMatchObject({
      outcome: 'failed',
      executionId,
      error: expect.objectContaining({
        message: expect.stringContaining('turn blew up'),
      }),
    });
    expect(mocks.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: RUN_OUTCOME.FAILED }),
    );
  });

  it('recordCost commits exactly once with the greatest observed value', async () => {
    const { childStreamId, executionId } = loopIds('record-cost');
    let launchResolve: ((turn: FakeTurn) => void) | undefined;
    let runTurnResolve: ((turn: FakeTurn) => void) | undefined;
    let calls = 0;
    const recordCost = vi.fn();

    const strategy: ChildRunStrategy<FakeTurn> = {
      stageLabel: 'Fake cost-tracking run',
      launch: (ports: ChildRunPorts) =>
        new Promise<FakeTurn>((resolve) => {
          launchResolve = (turn) => {
            ports.recordCost(0.2);
            resolve(turn);
          };
        }),
      runTurn: (_items, ports: ChildRunPorts) =>
        new Promise<FakeTurn>((resolve) => {
          calls += 1;
          runTurnResolve = (turn) => {
            ports.recordCost(undefined);
            ports.recordCost(0.1);
            resolve(turn);
          };
        }),
      isTerminal: (turn) => turn.kind === 'terminal',
      formatDelivery: (turn) => `delivered:${turn.value}`,
      formatError: (turn) => `error:${turn?.value ?? 'thrown'}`,
    };

    startLoop({ childStreamId, executionId }, strategy, { recordCost });

    await waitForLiveOwner(childStreamId);
    launchResolve?.({ kind: 'interim', value: 'first' });
    await vi.waitFor(() =>
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
    );

    expect(
      session.followUps.submit(
        childStreamId,
        { text: 'go on', origin: 'user' },
        'live_owner',
      ),
    ).toEqual({ kind: 'live' });
    // Waits for the loop to have actually invoked runTurn (calls increments
    // synchronously inside it) — not for the queue to read empty, which can
    // happen before the loop's own continuation runs (see the "delegate →
    // complete → follow-up delivery" fixture's comment for why).
    await vi.waitFor(() => expect(calls).toBe(1));
    runTurnResolve?.({ kind: 'terminal', value: 'final' });

    await waitForLoopEnd(childStreamId);
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(0.2);
  });

  it('settles mixed workflow attempt spend to the parent once', async () => {
    const entry = (
      index: number,
      key: string,
      cost: number,
    ): WorkflowJournalEntry => ({
      index,
      key,
      result: {
        category: 'workflow',
        outcome: 'completed',
        outputs: [],
        compileFailures: [],
        diffs: [],
        cost,
      },
    });
    const historical = entry(0, 'historical', 0.8);
    const completed = entry(1, 'completed', 0.5);
    const recovered = entry(2, 'recovered', 0.5);
    const tracker = createWorkflowAttemptCostTracker();
    const recordCost = vi.fn();
    const strategy = createTerminalStrategy(
      'Workflow attempt cost',
      async (ports) => {
        ports.recordCost(tracker.record(completed, 0.1));
        ports.recordCost(tracker.record(completed, 0));
        ports.recordCost(tracker.record({ index: 3, key: 'skipped' }, 0.2));
        ports.recordCost(tracker.record({ index: 4, key: 'failed' }, 0.15));
        ports.recordCost(tracker.total([historical, completed, recovered]));
        return { kind: 'terminal', value: 'done' };
      },
      () => 'delivered',
    );

    const { completion } = startLoop(
      loopIds('workflow-attempt-cost'),
      strategy,
      { recordCost },
    );

    await expect(completion).resolves.toBeUndefined();
    expect(recordCost).toHaveBeenCalledOnce();
    expect(recordCost.mock.calls[0]?.[0]).toBeCloseTo(0.95);
  });

  it.each([
    {
      failure: 'throws',
      recordCost: () => {
        throw new Error('observer failed');
      },
    },
    {
      failure: 'rejects',
      recordCost: () => Promise.reject(new Error('observer failed')),
    },
  ])(
    'finalizes and wakes when the parent cost observer $failure',
    async ({ failure, recordCost: observe }) => {
      const strategy = createTerminalStrategy(
        `${failure} cost observer`,
        async (ports) => {
          ports.recordCost(0.4);
          return { kind: 'terminal', value: 'done' };
        },
        () => 'delivered',
      );
      const recordCost = vi.fn(observe);

      const { completion } = startLoop(
        loopIds(`${failure}-cost-observer`),
        strategy,
        { recordCost },
      );

      await expect(completion).resolves.toBeUndefined();
      await vi.waitFor(() => expect(recordCost).toHaveBeenCalledOnce());
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledOnce();
    },
  );
});
