// Test composition imports
import * as os from 'node:os';

import '@test/support/defaultSessionTestSetup';

// E2E fixtures for the promoted "one loop, N strategies" child-run driver.
// These exercise the loop's own mechanics (queue acquire/drain, one
// run-handle interrupt target for the child's whole lifetime, per-turn delivery, terminal
// finalize) against a minimal fake strategy — the same contract every real
// strategy (codex, claude, native subagent, workflow-script) implements.
// Identical assertions apply regardless of which strategy is plugged in,
// since delivery/interrupt/terminal choreography all live in the loop.

import { Effect, Fiber } from 'effect';
import pDefer, { type DeferredPromise } from 'p-defer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  finalizeRun: vi.fn(),
  deliverChildRunFollowUp: vi.fn(),
  releaseRunLeaseAfterArtifacts: vi.fn(
    async (_session: unknown, _runId: RunId) => {},
  ),
  assertOwnedRunLease: vi.fn((_runId: RunId) => undefined),
}));

// Turn-state persistence runs against the real (memfs-backed) run store:
// the loop writes it best-effort and no assertion here depends on it.
vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  finalizeRun: mocks.finalizeRun,
}));
// The registry deep-imports finalizeRun from runLifecycle.
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/runLifecycle')>()),
  finalizeRun: mocks.finalizeRun,
}));

vi.mock('@agent/storage/runLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/runLease')>()),
  assertOwnedRunLease: mocks.assertOwnedRunLease,
}));

vi.mock('@agent/followUp/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
}));

import { getRunRecords, getRunStore } from '@agent/storage';
import type { WorkflowJournalEntry } from '@agent/workflowScript';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import {
  startChildRunLoop,
  type ChildRunLoopParams,
  type ChildRunPorts,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { resolveChildRunConcurrencyBudget } from '@agent/runtime/childRunBudget';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  type RunPhase,
  AgentCategory,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
} from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { seedRunStatusForTest } from '@test/support/runStatusTestUtils';
import { AgentCliSessionRegistry } from '@tools/agentCliSessionRegistry';
import {
  claudeAgentSessionsFor,
  codexThreadsFor,
} from '@tools/agentCliSessionStores';
import { createChildRun } from '@tools/delegation/childRun';
import { createWorkflowAttemptCostTracker } from '@tools/delegation/workflowScriptRun';
import { generateRunId } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

let session: SessionHandle;
const trackedRunIds = new Set<RunId>();

const childRunConfig = {
  agentCategory: AgentCategory.ToolUse,
  model: 'test-model',
  agent: 'fake-cli',
} as unknown as AgentConfig;

const PARENT_RUN_ID = 'ffff01' as RunId;

/** The run id a fixture drives, with its `run.start` already committed. */
function loopRunId(): RunId {
  const runId = generateRunId();
  publishTestRunStart(session, runId);
  return runId;
}

function trackChildHandle(
  runId: RunId,
  parentRunId: RunId,
  status: RunPhase = RUN_PHASE.RUNNING,
): RunHandle {
  const handle = testRunHandle({
    runId,
    parent: parentRunId,
    agent: 'fake',
    trace: { emit: vi.fn() } as never,
  });
  session.runs.trackAgentRun(handle, { status });
  trackedRunIds.add(runId);
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
    launch: () => Effect.tryPromise({ try: runTurn, catch: ensureError }),
    runTurn: () => Effect.tryPromise({ try: runTurn, catch: ensureError }),
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
  launch: (
    ports: ChildRunPorts,
    signal: AbortSignal,
  ) => Promise<FakeTurn> = async () => ({
    kind: 'terminal',
    value: 'done',
  }),
  formatDelivery: ChildRunStrategy<FakeTurn>['formatDelivery'] = (turn) =>
    `delivered:${turn.value}`,
): ChildRunStrategy<FakeTurn> {
  return {
    stageLabel,
    launch: (ports, signal) =>
      Effect.tryPromise({
        try: () => launch(ports, signal),
        catch: ensureError,
      }),
    isTerminal: () => true,
    formatDelivery,
    formatError: () => 'error',
  };
}

/** Start the loop with the fixture defaults; extras override any param. */
function startLoop(
  runId: RunId,
  strategy: ChildRunStrategy<FakeTurn>,
  extras: Partial<ChildRunLoopParams<FakeTurn>> = {},
): Promise<void> {
  return Effect.runPromise(
    startChildRunLoop({
      session,
      runId,
      parentRunId: PARENT_RUN_ID,
      agentName: 'fake',
      strategy,
      ...extras,
    }).pipe(Effect.flatMap(Fiber.join)),
  );
}

async function waitForLiveOwner(runId: RunId): Promise<void> {
  await vi.waitFor(() =>
    expect(session.followUps.hasLiveOwner(runId)).toBe(true),
  );
}

async function waitForLoopEnd(runId: RunId): Promise<void> {
  await vi.waitFor(() =>
    expect(session.followUps.hasLiveOwner(runId)).toBe(false),
  );
}

beforeEach(async () => {
  session = createProcessSession();
  publishTestRunStart(session, PARENT_RUN_ID);
  await session.settlePublications();
  vi.clearAllMocks();
  // The loop's terminal drain is the session's one exit choreography; the
  // suite observes it through the same (session, runId) spy as before.
  vi.spyOn(session, 'releaseRunLease').mockImplementation((runId) =>
    Effect.promise(() => mocks.releaseRunLeaseAfterArtifacts(session, runId)),
  );
  mocks.finalizeRun.mockReturnValue(Effect.succeed({ ok: true }));
  mocks.deliverChildRunFollowUp.mockReturnValue(
    Effect.succeed({ kind: 'delivered' }),
  );
});

afterEach(() => {
  for (const runId of trackedRunIds) {
    session.runs.untrack(runId);
  }
  trackedRunIds.clear();
});

describe('childRunLoop E2E fixtures', () => {
  it('validates the captured lease before registering loop resources', async () => {
    const runId = loopRunId();
    const { strategy, callCount } = createFakeStrategy();
    mocks.assertOwnedRunLease.mockImplementationOnce(() => {
      throw new Error('lease generation lost');
    });

    await expect(startLoop(runId, strategy)).rejects.toThrow(
      'lease generation lost',
    );

    expect(session.followUps.hasLiveOwner(runId)).toBe(false);
    expect(callCount()).toBe(0);
  });

  it('revalidates the lease when claiming a new queue generation', async () => {
    const runId = loopRunId();
    const { strategy, callCount } = createFakeStrategy();
    const claimChildRun = vi.spyOn(session.followUps, 'claimChildRun');
    mocks.assertOwnedRunLease
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('lease generation lost during setup');
      });

    await expect(startLoop(runId, strategy)).rejects.toThrow(
      'lease generation lost during setup',
    );

    expect(claimChildRun).not.toHaveBeenCalled();
    expect(session.followUps.hasLiveOwner(runId)).toBe(false);
    expect(callCount()).toBe(0);
  });

  it('unwinds provider ownership and loop resources when synchronous setup fails', async () => {
    const runId = loopRunId();
    const registry = new AgentCliSessionRegistry(
      'test_session_id',
      session.runs,
    );
    const releaseSessionOwnership = vi.fn(() => registry.releaseByRunId(runId));
    const handle = trackChildHandle(runId, PARENT_RUN_ID);
    const interruptHandle = vi.spyOn(handle, 'interrupt');
    const registerLoop = vi
      .spyOn(session.followUps, 'claimChildRun')
      .mockImplementationOnce(() => {
        throw new Error('loop registration failed');
      });
    const { strategy } = createFakeStrategy();

    try {
      await expect(
        startLoop(
          runId,
          {
            ...strategy,
            onLoopStart: () => {
              registry.trackInFlight({ runId });
            },
            releaseSessionOwnership,
          },
          { agentName: 'fake-cli' },
        ),
      ).rejects.toThrow('loop registration failed');

      expect(releaseSessionOwnership).toHaveBeenCalledOnce();
      expect(session.followUps.hasLiveOwner(runId)).toBe(false);
      expect(handle.interrupt()).toBe(false);
      interruptHandle.mockClear();
      registry.interruptAll();
      expect(interruptHandle).not.toHaveBeenCalled();
      expect(session.followUps.getAll(runId)).toEqual([]);
    } finally {
      registerLoop.mockRestore();
      interruptHandle.mockRestore();
      registry.releaseByRunId(runId);
    }
  });

  it.each([
    {
      name: 'CodexThreads',
      track: (runId: RunId, runSession: SessionHandle) =>
        codexThreadsFor(runSession).trackInFlight({ runId }),
      interruptAll: () => codexThreadsFor(session).interruptAll(),
      release: (runId: RunId) => codexThreadsFor(session).releaseByRunId(runId),
    },
    {
      name: 'ClaudeAgentSessions',
      track: (runId: RunId, runSession: SessionHandle) =>
        claudeAgentSessionsFor(runSession).trackInFlight({ runId }),
      interruptAll: () => claudeAgentSessionsFor(session).interruptAll(),
      release: (runId: RunId) =>
        claudeAgentSessionsFor(session).releaseByRunId(runId),
    },
  ])(
    '$name interrupts a real initial-turn loop and releases ownership once',
    async ({ name, track, interruptAll, release }) => {
      const runId = loopRunId();
      const events: string[] = [];
      const aborted = vi.fn();
      const releaseSessionOwnership = vi.fn(() => release(runId));
      trackChildHandle(runId, PARENT_RUN_ID);

      const strategy: ChildRunStrategy<FakeTurn> = {
        stageLabel: `${name} session`,
        launch: (_ports, signal) => {
          events.push('launch');
          return Effect.tryPromise({
            try: () =>
              new Promise((_resolve, reject) => {
                const rejectAbort = () => {
                  aborted();
                  reject(createAbortError());
                };
                if (signal.aborted) rejectAbort();
                else {
                  signal.addEventListener('abort', rejectAbort, { once: true });
                }
              }),
            catch: ensureError,
          });
        },
        isTerminal: () => false,
        formatDelivery: () => 'unexpected delivery',
        formatError: () => 'unexpected error',
        onLoopStart: (runSession) => {
          events.push('registered');
          track(runId, runSession);
        },
        releaseSessionOwnership,
      };

      try {
        startLoop(runId, strategy, {
          agentName: name,
        });

        expect(events).toEqual(['registered']);
        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        // The loop body is a generation on the run's lane: it starts
        // once the lane admits it, not inside `startChildRunLoop`.
        await vi.waitFor(() =>
          expect(events).toEqual(['registered', 'launch']),
        );
        interruptAll();

        await vi.waitFor(() => {
          expect(aborted).toHaveBeenCalledOnce();
          expect(session.followUps.hasLiveOwner(runId)).toBe(false);
        });
        expect(releaseSessionOwnership).toHaveBeenCalledOnce();
        expect(session.runs.getHandle(runId)).toBeUndefined();
      } finally {
        release(runId);
      }
    },
  );

  it('drains accepted-turn attribution before releasing the run lease', async () => {
    const runId = loopRunId();
    const { strategy, rejectTurn } = createFakeStrategy();
    const writeBarrier = pDefer<void>();
    const writeStarted = pDefer<void>();
    const store = getRunStore(runId);
    const writeTurnState = vi
      .spyOn(store, 'writeTurnState')
      .mockImplementationOnce(async () => {
        writeStarted.resolve();
        await writeBarrier.promise;
      });

    try {
      const completion = startLoop(runId, strategy);
      await writeStarted.promise;
      // Interrupt the loop through its parent lineage: no turn handle is
      // tracked in this fixture, so the stop reaches the loop via its
      // child activation.
      const stopSettlement = Effect.runPromise(
        session.runs.stopAgentRun(PARENT_RUN_ID),
      );
      await rejectTurn(1, createAbortError());
      await stopSettlement;

      await vi.waitFor(() =>
        expect(session.followUps.hasLiveOwner(runId)).toBe(true),
      );
      expect(mocks.releaseRunLeaseAfterArtifacts).not.toHaveBeenCalled();

      writeBarrier.resolve();
      await completion;
      expect(writeTurnState).toHaveBeenCalledOnce();
      expect(mocks.releaseRunLeaseAfterArtifacts).toHaveBeenCalledWith(
        session,
        runId,
      );
    } finally {
      writeBarrier.resolve();
      writeTurnState.mockRestore();
    }
  });

  it('keeps follow-up ownership distinct across child-stream and native child lifecycles', async () => {
    const runId = generateRunId();
    const turn = pDefer<FakeTurn>();
    const launchStarted = pDefer<void>();
    const formatStarted = pDefer<void>();
    const formattedDelivery = pDefer<string>();
    let notifyProgress: ChildRunPorts['notify'] = () => {};
    const strategy = createTerminalStrategy(
      'Follow-up ownership',
      (ports) => {
        notifyProgress = ports.notify;
        launchStarted.resolve();
        return turn.promise;
      },
      () => {
        formatStarted.resolve();
        return formattedDelivery.promise;
      },
    );
    publishTestRunStart(session, runId);
    const childRun = await Effect.runPromise(
      createChildRun(session, runId, PARENT_RUN_ID, {
        run: { kind: 'agent', agent: 'fake-cli', tool: 'codex' },
        userFollowUpSupport: 'terminalBacked',
        description: 'Keep a background child running',
        config: childRunConfig,
      }),
    );
    trackedRunIds.add(runId);
    const completion = startLoop(runId, strategy, {
      childRun,
    });
    const tryResumeRun = vi.fn(async () => false);
    const resumePort = { tryResumeRun };
    await launchStarted.promise;

    try {
      seedRunStatusForTest(session.status, PARENT_RUN_ID, {
        phase: RUN_PHASE.RUNNING,
      });
      await expect(
        Effect.runPromise(
          submitFollowUp(PARENT_RUN_ID, 'active parent', {
            session,
            resumePort,
          }),
        ),
      ).resolves.toEqual({ status: 'queued', wake: 'failed' });

      seedRunStatusForTest(session.status, PARENT_RUN_ID, {
        phase: RUN_PHASE.COMPLETED,
      });
      const userAdmission = vi.fn();
      await expect(
        Effect.runPromise(
          submitFollowUp(PARENT_RUN_ID, 'restore me', {
            session,
            resumePort,
            onAdmitted: userAdmission,
          }),
        ),
      ).resolves.toMatchObject({ status: 'failed' });
      expect(userAdmission).toHaveBeenCalledWith(false);
      await expect(
        Effect.runPromise(
          submitFollowUp(
            PARENT_RUN_ID,
            { text: 'late child result', origin: 'subagent_result' },
            { session, resumePort, mode: 'child_delivery' },
          ),
        ),
      ).resolves.toMatchObject({ status: 'failed' });
      expect(session.followUps.getAll(PARENT_RUN_ID)).toEqual([
        'active parent',
      ]);

      const releaseNativeChild = session.runs.reserveChildActivation({
        runId: 'da7a01' as RunId,
        parentRunId: PARENT_RUN_ID,
        interrupt: vi.fn(),
        detach: vi.fn(),
        isDetached: () => false,
      });
      try {
        await expect(
          Effect.runPromise(
            submitFollowUp(PARENT_RUN_ID, 'native child result', {
              session,
              resumePort,
              mode: 'child_delivery',
            }),
          ),
        ).resolves.toEqual({ status: 'queued', wake: 'failed' });
      } finally {
        releaseNativeChild();
      }

      const terminalQueue = session.followUps.getAll(PARENT_RUN_ID);
      notifyProgress({ kind: 'started' });
      expect(session.followUps.getAll(PARENT_RUN_ID)).toEqual(terminalQueue);

      seedRunStatusForTest(session.status, PARENT_RUN_ID, {
        phase: RUN_PHASE.RUNNING,
      });
      notifyProgress({ kind: 'started' });
      const progressQueue = session.followUps.getAll(PARENT_RUN_ID);
      expect(progressQueue).toHaveLength(terminalQueue.length + 1);

      turn.resolve({ kind: 'terminal', value: 'done' });
      await formatStarted.promise;
      session.runs.detachActiveChildren(PARENT_RUN_ID);
      notifyProgress({ kind: 'started' });
      formattedDelivery.resolve('delivered:done');
      await completion;

      expect(session.followUps.getAll(PARENT_RUN_ID)).toEqual(progressQueue);
      expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
    } finally {
      session.followUps.terminalize(PARENT_RUN_ID);
      session.runs.detachActiveChildren(PARENT_RUN_ID);
      turn.resolve({ kind: 'terminal', value: 'done' });
      formattedDelivery.resolve('delivered:done');
      await completion;
    }
  });

  it('persists without parent delivery in persist-only mode', async () => {
    const runId = loopRunId();
    const { strategy, resolveTurn } = createFakeStrategy();

    const completion = startLoop(
      runId,
      { ...strategy, deliveryMode: 'persistOnly' },
      { parentRunId: 'headless-parent' as RunId },
    );
    await resolveTurn(1, { kind: 'terminal', value: 'saved' });
    await completion;

    expect(
      await Effect.runPromise(getRunRecords(session, runId).readReport()),
    ).toBe('delivered:saved');
    expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
  });

  it('reuses a terminal child stream for a separately authorized retry', async () => {
    const retryRunId = loopRunId();
    const parentLease = session.followUps.claimLive(PARENT_RUN_ID, 'flow')!;
    const admissions: string[] = [];
    mocks.deliverChildRunFollowUp.mockImplementation((delivery) =>
      Effect.tryPromise({
        try: async () => {
          const admission = delivery.session.followUps.submit(
            delivery.targetRunId,
            delivery.followUp,
            'live_owner',
            delivery.expectedGenerationId,
          );
          admissions.push(admission.kind);
          return admission.kind === 'duplicate' || admission.kind === 'refused'
            ? { kind: 'dropped' as const }
            : { kind: 'delivered' as const };
        },
        catch: (error) => error,
      }),
    );

    try {
      await startLoop(retryRunId, createTerminalStrategy('First attempt'));
      expect(session.followUps.hasLiveOwner(retryRunId)).toBe(false);

      await expect(
        startLoop(retryRunId, createTerminalStrategy('Retry attempt')),
      ).resolves.toBeUndefined();
      expect(admissions).toEqual(['delivered_live', 'delivered_live']);
      const delivered = session.followUps.queue(parentLease).drainItems();
      expect(delivered.map((item) => item.text)).toEqual([
        'delivered:done',
        'delivered:done',
      ]);
      expect(delivered[0]?.deliveryId).toBeDefined();
      expect(delivered[1]?.deliveryId).toBeDefined();
      expect(delivered[1]?.deliveryId).not.toBe(delivered[0]?.deliveryId);
      expect(session.followUps.hasLiveOwner(retryRunId)).toBe(false);
    } finally {
      session.followUps.release(parentLease, 'recoverable');
    }
  });

  it('releases session ownership before delivering a failed turn', async () => {
    const runId = loopRunId();
    const { strategy, rejectTurn } = createFakeStrategy();
    const releaseSessionOwnership = vi.fn();
    mocks.deliverChildRunFollowUp.mockImplementation(() =>
      Effect.tryPromise({
        try: async () => {
          expect(releaseSessionOwnership).toHaveBeenCalledOnce();
          return { kind: 'delivered' };
        },
        catch: (error) => error,
      }),
    );

    startLoop(
      runId,
      { ...strategy, releaseSessionOwnership },
      { agentName: 'fake-cli' },
    );

    await waitForLiveOwner(runId);
    await rejectTurn(1, new Error('initial turn failed'));
    await waitForLoopEnd(runId);
    expect(releaseSessionOwnership).toHaveBeenCalledOnce();
  });

  it('delegate → interrupt mid-run: an interrupt during the first turn ends the run without a terminal delivery for that turn', async () => {
    const runId = loopRunId();
    const { strategy, rejectTurn, callCount } = createFakeStrategy();
    const handle = trackChildHandle(runId, PARENT_RUN_ID);

    const completion = startLoop(runId, strategy);

    await waitForLiveOwner(runId);
    await vi.waitFor(() => expect(callCount()).toBe(1));

    expect(handle.interrupt()).toBe(true);
    // Simulate the in-flight call rejecting with an AbortError-shaped
    // rejection, matching what a real strategy's abortController produces.
    await rejectTurn(1, createAbortError());

    await completion;
    expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
    expect(session.runs.getHandle(runId)).toBeUndefined();
  });

  it('delegate → complete → follow-up delivery: an interim turn delivers, then the loop picks up a queued follow-up for the next turn', async () => {
    const runId = loopRunId();
    const { strategy, callCount, resolveTurn } = createFakeStrategy();
    const onLoopStart = vi.fn();
    const onTurnSuccess = vi.fn();
    const parentWake = vi.fn();
    const deliveryCompleted = pDefer<{ kind: 'delivered' }>();
    mocks.deliverChildRunFollowUp.mockImplementation(() =>
      Effect.tryPromise({
        try: async () => {
          parentWake();
          return deliveryCompleted.promise;
        },
        catch: (error) => error,
      }),
    );

    startLoop(runId, { ...strategy, onLoopStart, onTurnSuccess });

    expect(onLoopStart).toHaveBeenCalledOnce();
    expect(onLoopStart).toHaveBeenCalledWith(session);
    await waitForLiveOwner(runId);
    await resolveTurn(1, { kind: 'interim', value: 'first' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRunId: PARENT_RUN_ID,
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
        runId,
        { text: 'keep going', origin: 'user' },
        'live_owner',
      ),
    ).toEqual({ kind: 'queued' });
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
    await waitForLoopEnd(runId);
  });

  it('late result after parent stop: a turn that resolves after interruption is persisted but not delivered', async () => {
    const runId = loopRunId();
    const { strategy, resolveTurn, callCount } = createFakeStrategy();
    const handle = trackChildHandle(runId, PARENT_RUN_ID);
    const releaseSessionOwnership = vi.fn();
    startLoop(runId, { ...strategy, releaseSessionOwnership });

    await waitForLiveOwner(runId);
    await vi.waitFor(() => expect(callCount()).toBe(1));
    // Interrupt the loop, then let the in-flight turn resolve normally
    // (not aborted) — mirrors a turn that was already past its own
    // interruption checkpoints when the stop landed.
    expect(handle.interrupt()).toBe(true);
    await resolveTurn(1, { kind: 'terminal', value: 'late' });

    await waitForLoopEnd(runId);
    expect(
      await Effect.runPromise(getRunRecords(session, runId).readReport()),
    ).toBe('delivered:late');
    expect(releaseSessionOwnership).toHaveBeenCalledOnce();
    expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
  });

  it('kill during WAITING: interrupting the loop while it is blocked between turns ends the run without a hang', async () => {
    const runId = loopRunId();
    const { strategy, resolveTurn } = createFakeStrategy();
    const handle = trackChildHandle(runId, PARENT_RUN_ID);

    startLoop(runId, strategy);

    await waitForLiveOwner(runId);
    await resolveTurn(1, { kind: 'interim', value: 'first' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalled();
    });
    // The loop is now blocked in queue.waitAndDrainAll; the loop's handler on
    // the run handle is the live stop target.
    expect(handle.interrupt()).toBe(true);

    await waitForLoopEnd(runId);
    // Only the one interim delivery — the kill did not spawn another turn.
    expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1);
  });

  it('stop between turns settles the ghost handle when terminal metadata fails', async () => {
    // Regression: for a native strategy (no ChildRun — each turn owns its
    // own RunHandle via runFlowWithLifecycle, not the loop), a
    // stop landing BETWEEN turns interrupts the loop through the run handle
    // and transitions the stream to CANCELLED — but assumes a live flow will
    // notice and self-finalize.
    // Nothing is running here (the loop is just blocked on a queue wait), so
    // without the loop's own finalize-on-interrupt fallback, the most
    // recently tracked handle for this stream — still WAITING, still
    // resumable-looking — would never settle or untrack.
    const runId = loopRunId();
    const { strategy, resolveTurn } = createFakeStrategy();
    mocks.finalizeRun.mockReturnValueOnce(
      Effect.succeed({
        ok: false,
        error: new Error('metadata disk full'),
        outcomePersisted: false,
      }),
    );

    startLoop(runId, strategy);

    await waitForLiveOwner(runId);

    // Mirrors what a real native turn's runFlowWithLifecycle does: track a
    // fresh handle for this runId/runId, WAITING, once the
    // turn suspends.
    const handle = trackChildHandle(runId, PARENT_RUN_ID, RUN_PHASE.WAITING);

    await resolveTurn(1, { kind: 'interim', value: 'first' });
    await vi.waitFor(() =>
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
    );

    // Loop is now between turns. Interrupt it through the run handle.
    expect(handle.interrupt()).toBe(true);

    await waitForLoopEnd(runId);

    // Settled: handle.result resolves instead of hanging forever.
    await expect(Effect.runPromise(handle.result)).resolves.toMatchObject({
      outcome: 'cancelled',
      runId,
    });
    // Untracked: no longer resumable — a later delegate_agent(execution_id=…)
    // would correctly report "not found" instead of finding a ghost handle.
    expect(session.runs.getHandle(runId)).toBeUndefined();
    // The loop routes the cancellation through the durable outcome's only
    // writer; the interim result envelope is left exactly as its turn wrote
    // it, and reads project the durable outcome onto it.
    expect(mocks.finalizeRun).toHaveBeenCalledWith(session, {
      runId,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
    });
  });

  it('leaves no interruptible child continuation while terminal delivery is in flight', async () => {
    // Terminal delivery (persist report / persist manifest / deliver
    // follow-up) runs after child finalization and lease release, so a
    // stop/kill landing in that window finds nothing left to interrupt. The
    // test inspects the run handle while delivery is deliberately held open.
    const runId = loopRunId();
    const handle = trackChildHandle(runId, PARENT_RUN_ID);
    let deliveryGate: DeferredPromise<void> | undefined;
    mocks.deliverChildRunFollowUp.mockImplementation(() =>
      Effect.tryPromise({
        try: async () => {
          deliveryGate = pDefer<void>();
          await deliveryGate.promise;
          return { kind: 'delivered' };
        },
        catch: (error) => error,
      }),
    );

    const strategy = createTerminalStrategy('Reregister test');

    startLoop(runId, strategy);

    // Poll until delivery is mid-flight (blocked on our gate).
    await vi.waitFor(() => expect(deliveryGate).toBeDefined());

    expect(handle.interrupt()).toBe(false);

    deliveryGate?.resolve();
    await waitForLoopEnd(runId);
  });

  it('#8093 regression: a terminal turn finalizes this child before its wake step is even reached, so a resumed parent never self-stalls waiting on it', async () => {
    // Regression: parent continuation submission can await the ENTIRE resumed
    // turn (`agentResume.tryResumeRun` → … → `resumeToolUseFromResumeData`).
    // Before #8093, the loop awaited split enqueue/wake work inline in the
    // turn loop, and only finalized this child (untracking its run
    // handle) afterward in the outer `finally` — so a resumed parent that
    // immediately calls `executions` with action=wait on this same run
    // could find it still RUNNING and block on itself for the whole wait
    // budget. Prove the fixed ordering: by the moment the wake step is even
    // reached, this run is already untracked (terminal in the registry)
    // — a resumed parent's wait would resolve immediately instead of racing
    // its own wake.
    const runId = loopRunId();
    trackChildHandle(runId, PARENT_RUN_ID);

    let releaseWake: (() => void) | undefined;
    let handleAtWakeTime: unknown;
    mocks.deliverChildRunFollowUp.mockImplementation(() =>
      Effect.tryPromise({
        try: async () => {
          // Snapshot registry state the instant the wake step is reached. The
          // same moment a resumed parent's own turn would begin running.
          handleAtWakeTime = session.runs.getHandle(runId);
          await new Promise<void>((resolve) => {
            releaseWake = resolve;
          });
          return { kind: 'delivered' };
        },
        catch: (error) => error,
      }),
    );

    const strategy = createTerminalStrategy('Finalize-before-wake test');

    startLoop(runId, strategy);

    await vi.waitFor(() => expect(releaseWake).toBeDefined());
    expect(handleAtWakeTime).toBeUndefined();
    expect(session.runs.getHandle(runId)).toBeUndefined();

    releaseWake?.();
    await waitForLoopEnd(runId);
  });

  it('preserves #7491: a failed runTurn (thrown, not a value) delivers formatError to the parent', async () => {
    const runId = loopRunId();
    const { strategy, resolveTurn, rejectTurn, errors } = createFakeStrategy();

    startLoop(runId, strategy);

    await waitForLiveOwner(runId);
    await resolveTurn(1, { kind: 'interim', value: 'first' });
    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1);
    });

    expect(
      session.followUps.submit(
        runId,
        { text: 'resume please', origin: 'user' },
        'live_owner',
      ),
    ).toEqual({ kind: 'queued' });

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
    await waitForLoopEnd(runId);
  });

  it('an application-level failure (isTurnError, not thrown) also delivers formatError and stops the run', async () => {
    const runId = loopRunId();
    const { strategy, resolveTurn } = createFakeStrategy();

    startLoop(runId, strategy);

    await waitForLiveOwner(runId);
    await resolveTurn(1, { kind: 'error-turn', value: 'oops' });

    await vi.waitFor(() => {
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          followUp: expect.objectContaining({ text: 'error:oops' }),
        }),
      );
    });
    await waitForLoopEnd(runId);
  });

  it('finalizes a dangling native handle with non-null error metadata after a non-throwing turn failure', async () => {
    const runId = loopRunId();
    const { strategy, resolveTurn } = createFakeStrategy();

    startLoop(runId, strategy);

    await waitForLiveOwner(runId);

    const handle = trackChildHandle(runId, PARENT_RUN_ID, RUN_PHASE.WAITING);

    await resolveTurn(1, { kind: 'error-turn', value: 'oops' });

    await waitForLoopEnd(runId);
    await expect(Effect.runPromise(handle.result)).resolves.toMatchObject({
      outcome: 'failed',
      runId,
      error: expect.objectContaining({
        message: expect.stringContaining('reported a failed turn'),
      }),
    });
    expect(session.runs.getHandle(runId)).toBeUndefined();
  });

  it('keeps the failing turn diagnosis when an interrupt lands after the failure', async () => {
    const runId = 'fa11ed01' as RunId;
    publishTestRunStart(session, runId);
    const childRun = await Effect.runPromise(
      createChildRun(session, runId, PARENT_RUN_ID, {
        run: { kind: 'agent', agent: 'fake-cli', tool: 'codex' },
        userFollowUpSupport: 'terminalBacked',
        description: 'Fail a turn, then take an interrupt',
        config: childRunConfig,
      }),
    );
    trackedRunIds.add(runId);
    const handle = session.runs.getHandle(runId);
    const { strategy, rejectTurn } = createFakeStrategy();
    // Fires between the turn failure landing FAILED on the stream phase and
    // the loop's finalize, so the loop reports an interrupted run for a stream
    // whose phase already carries the failure.
    const stopSettlements: Promise<void>[] = [];
    const interruptAfterFailure = vi.fn(() => {
      stopSettlements.push(
        Effect.runPromise(session.runs.kill(runId).settlement),
      );
    });

    startLoop(runId, strategy, {
      childRun,
      agentName: 'fake-cli',
      recordCost: interruptAfterFailure,
    });

    await waitForLiveOwner(runId);
    await rejectTurn(1, new Error('turn blew up'));
    await waitForLoopEnd(runId);

    await Promise.all(stopSettlements);
    expect(interruptAfterFailure).toHaveBeenCalledOnce();
    expect(session.status.get(runId)).toBe(RUN_PHASE.FAILED);
    await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
      outcome: 'failed',
      runId,
      error: expect.objectContaining({
        message: expect.stringContaining('turn blew up'),
      }),
    });
    expect(mocks.finalizeRun).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ outcome: RUN_OUTCOME.FAILED }),
    );
  });

  it('sizes the child-run budget to the machine when the setting is auto', () => {
    const config = workspaceRoots().config as FakeConfigProvider;
    try {
      config.set(
        CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
        CHILD_RUN_CONCURRENCY_BUDGET_SETTING.auto,
      );
      expect(resolveChildRunConcurrencyBudget()).toBe(
        Math.min(
          CHILD_RUN_CONCURRENCY_BUDGET_SETTING.max,
          Math.max(1, os.availableParallelism()),
        ),
      );
      config.set(CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY, 7);
      expect(resolveChildRunConcurrencyBudget()).toBe(7);
    } finally {
      config.set(
        CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
        CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue,
      );
    }
  });

  it('gates budgeted child turns through the session child-run budget', async () => {
    const config = workspaceRoots().config as FakeConfigProvider;
    config.set(CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY, 1);
    try {
      const first = loopRunId();
      const second = loopRunId();
      const started: string[] = [];
      let releaseFirst: ((turn: FakeTurn) => void) | undefined;

      const firstStrategy = createTerminalStrategy(
        'Budgeted first child',
        () =>
          new Promise<FakeTurn>((resolve) => {
            started.push('first');
            releaseFirst = resolve;
          }),
      );
      const secondStrategy = createTerminalStrategy(
        'Budgeted second child',
        async () => {
          started.push('second');
          return { kind: 'terminal', value: 'done' };
        },
      );

      startLoop(first, firstStrategy, { budgeted: true });
      startLoop(second, secondStrategy, { budgeted: true });

      await vi.waitFor(() => expect(started).toEqual(['first']));
      // One slot: the second child's turn must not start while the first
      // holds it — even after its loop has acquired its queue lease.
      await waitForLiveOwner(second);
      expect(started).toEqual(['first']);

      releaseFirst?.({ kind: 'terminal', value: 'done' });
      await waitForLoopEnd(second);
      expect(started).toEqual(['first', 'second']);
    } finally {
      config.set(
        CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
        CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue,
      );
    }
  });

  it('recordCost commits exactly once with the greatest observed value', async () => {
    const runId = loopRunId();
    const firstTurn = pDefer<FakeTurn>();
    const nextTurn = pDefer<FakeTurn>();
    const recordCost = vi.fn();

    const strategy: ChildRunStrategy<FakeTurn> = {
      stageLabel: 'Fake cost-tracking run',
      launch: (ports: ChildRunPorts) =>
        Effect.gen(function* () {
          const turn = yield* Effect.promise(() => firstTurn.promise);
          ports.recordCost(0.2);
          return turn;
        }),
      runTurn: (_items, ports: ChildRunPorts) =>
        Effect.gen(function* () {
          const turn = yield* Effect.promise(() => nextTurn.promise);
          ports.recordCost(undefined);
          ports.recordCost(0.1);
          return turn;
        }),
      isTerminal: (turn) => turn.kind === 'terminal',
      formatDelivery: (turn) => `delivered:${turn.value}`,
      formatError: (turn) => `error:${turn?.value ?? 'thrown'}`,
    };

    startLoop(runId, strategy, { recordCost });

    await waitForLiveOwner(runId);
    firstTurn.resolve({ kind: 'interim', value: 'first' });
    await vi.waitFor(() =>
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
    );

    expect(
      session.followUps.submit(
        runId,
        { text: 'go on', origin: 'user' },
        'live_owner',
      ),
    ).toEqual({ kind: 'queued' });
    nextTurn.resolve({ kind: 'terminal', value: 'final' });

    await waitForLoopEnd(runId);
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

    const completion = startLoop(loopRunId(), strategy, {
      recordCost,
    });

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

      const completion = startLoop(loopRunId(), strategy, { recordCost });

      await expect(completion).resolves.toBeUndefined();
      await vi.waitFor(() => expect(recordCost).toHaveBeenCalledOnce());
      expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledOnce();
    },
  );
});
