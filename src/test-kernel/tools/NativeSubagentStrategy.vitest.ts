// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedAgentDefinition } from '@agent/runtime/AgentLaunchContext';

// Local imports
import {
  startChildRunLoop as startNativeChildRunLoop,
  type ChildRunLoopParams,
} from '@agent/runtime/childRunLoop';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  RUN_PHASE,
  RunIdSchema,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
} from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  deliverChildRunFollowUp: vi.fn(),
  executeAgent: vi.fn(),
  finalizeRun: vi.fn(),
  persistChildRunDelivery: vi.fn(),
  readConfig: vi.fn(),
  writeTurnState: vi.fn(),
  resumeToolUseTurn: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  throwDeliveryFormatting: false,
  throwErrorFormatting: false,
}));

vi.mock('@tools/delegation/subagentResults', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@tools/delegation/subagentResults')>();
  return {
    ...original,
    formatSubagentDelivery: (
      ...args: Parameters<typeof original.formatSubagentDelivery>
    ) => {
      if (mocks.throwDeliveryFormatting) {
        throw new Error('delivery formatting failed');
      }
      return original.formatSubagentDelivery(...args);
    },
    formatSubagentError: (
      ...args: Parameters<typeof original.formatSubagentError>
    ) => {
      if (mocks.throwErrorFormatting) {
        throw new Error('error formatting failed');
      }
      return original.formatSubagentError(...args);
    },
  };
});

vi.mock('@agent/storage', () => ({
  finalizeRun: mocks.finalizeRun,
  getRunRecords: vi.fn(() => ({
    readConfig: mocks.readConfig,
  })),
  getRunStore: vi.fn(() => ({
    writeTurnState: mocks.writeTurnState,
  })),
}));

vi.mock('@agent/storage/childRunDeliveryPersistence', () => ({
  persistChildRunDelivery: mocks.persistChildRunDelivery,
}));

vi.mock('@agent/storage/runLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/runLease')>()),
  assertOwnedRunLease: vi.fn(),
  validateOwnedRunLease: vi.fn(async () => {}),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@agent/followUp/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
}));

import { testRunHandle } from '@test/support/runHandleFixtures';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  createNativeSubagentStrategy,
  provideAgentEngine,
} from '@tools/delegation/nativeSubagentStrategy';
import { ensureError } from '@utils/errors/errorMessage';

/** Drive and join the native child at the test entry point. */
function startChildRunLoop<TTurn>(input: ChildRunLoopParams<TTurn>) {
  return Effect.runPromise(
    startNativeChildRunLoop(input).pipe(Effect.flatMap(Fiber.join)),
  );
}

const ownedSessions = new Set<SessionHandle>();

const CHILD_RUN_ID = RunIdSchema.parse('c41d00000001');

function fakePorts() {
  return { notify: vi.fn(), recordCost: vi.fn() };
}

/** A tool-use turn result on the shared child run, for launch/resume mocks. */
function toolUseTurnResult(
  outcome: string,
  runId: RunId,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    category: 'toolUse',
    outcome,
    runId,
    ...extras,
  };
}

/**
 * Stubs the next `executeAgent` so it publishes `handle` through `onRun` and
 * settles with a terminal tool-use turn. `afterRun` runs while the launch is
 * still in flight.
 */
function mockLaunchPublishing(
  handle: unknown,
  outcome: 'cancelled' | 'completed',
  afterRun?: () => void,
): void {
  mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
    options.onRun?.(handle);
    afterRun?.();
    return toolUseTurnResult(outcome, CHILD_RUN_ID);
  });
}

function baseParams(
  parentSession = createTestSession(),
  agentCategory: 'toolUse' | 'workflow' = 'toolUse',
) {
  if (parentSession !== defaultSession()) ownedSessions.add(parentSession);
  return {
    definition: {
      config: AgentConfigSchema.parse({
        agent: 'review',
        model: 'gpt5',
        agentCategory,
      }),
    } as PreparedAgentDefinition,
    runId: CHILD_RUN_ID,
    agentName: 'review',
    parentRunId: RunIdSchema.parse('0acc00000001'),
    session: parentSession,
    startedAt: Date.now(),
    onStreamResolved: vi.fn(),
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
  };
}

type BaseParams = ReturnType<typeof baseParams>;
type Strategy = ReturnType<typeof createNativeSubagentStrategy>;

/**
 * Launch a WAITING turn, then publish the live handle by hand: `launch()` only
 * resolves the turn — the `deliveryTarget`/`runId` handle shape
 * the strategy reads arrives through the `onRun` callback.
 */
async function launchWaitingTurn(
  params: BaseParams,
  strategy: Strategy,
): Promise<void> {
  mocks.executeAgent.mockResolvedValueOnce(
    toolUseTurnResult(RUN_PHASE.WAITING, params.runId),
  );
  await Effect.runPromise(
    strategy.launch(fakePorts(), new AbortController().signal),
  );
  mocks.executeAgent.mock.calls.at(-1)?.[2].onRun?.({
    runId: CHILD_RUN_ID,
    deliveryTarget: params.parentRunId,
  });
}

describe('NativeSubagentStrategy', () => {
  let restoreAgentEngine = (): void => {};

  beforeEach(() => {
    vi.resetAllMocks();
    restoreAgentEngine = provideAgentEngine({
      executeAgent: (...args) =>
        Effect.tryPromise({
          try: () => mocks.executeAgent(...args),
          catch: ensureError,
        }),
      resumeToolUseTurn: (...args) =>
        Effect.tryPromise({
          try: () => mocks.resumeToolUseTurn(...args),
          catch: ensureError,
        }),
    });
    mocks.throwDeliveryFormatting = false;
    mocks.throwErrorFormatting = false;
    mocks.deliverChildRunFollowUp.mockReturnValue(
      Effect.succeed({ kind: 'delivered' }),
    );
    mocks.persistChildRunDelivery.mockReturnValue(Effect.void);
    mocks.writeTurnState.mockResolvedValue(undefined);
    mocks.finalizeRun.mockReturnValue(Effect.succeed({ ok: true }));
  });

  afterEach(() => {
    restoreAgentEngine();
    for (const session of ownedSessions) session.dispose();
    ownedSessions.clear();
  });

  it('resolveDeliveryTarget follows the live run handle, including after detach', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);

    // Before any turn ran, falls back to the static orchestrator run.
    expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentRunId);

    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.({
        runId: CHILD_RUN_ID,
        deliveryTarget: params.parentRunId,
      });
      return toolUseTurnResult(RUN_PHASE.WAITING, params.runId);
    });

    await Effect.runPromise(
      strategy.launch(fakePorts(), new AbortController().signal),
    );
    expect(mocks.executeAgent).toHaveBeenLastCalledWith(
      params.definition,
      params.runId,
      expect.objectContaining({ parentRunId: params.parentRunId }),
    );
    expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentRunId);

    // Detach: the same handle object's deliveryTarget flips to
    // undefined (RunHandle.detach) — the strategy must track the
    // LIVE handle, not a stale copy, so it observes this without a new turn.
    const liveHandle = {
      runId: CHILD_RUN_ID,
      deliveryTarget: params.parentRunId as RunId | undefined,
    };
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.(liveHandle);
      return toolUseTurnResult(RUN_PHASE.WAITING, params.runId);
    });
    await Effect.runPromise(
      strategy.launch(fakePorts(), new AbortController().signal),
    );
    expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentRunId);
    liveHandle.deliveryTarget = undefined;
    expect(strategy.resolveDeliveryTarget?.()).toBeUndefined();
  });

  it('uses the same launch primitive in durable single-cycle mode', async () => {
    const params = {
      ...baseParams(),
      runMode: 'single-cycle' as const,
      workflowPhase: 'review',
    };
    const strategy = createNativeSubagentStrategy(params);
    const ports = fakePorts();
    const progress = { message: 'Reading proof' };

    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onStreamResolved?.(CHILD_RUN_ID);
      options.onProgress?.(progress);
      return toolUseTurnResult('completed', params.runId, {
        totalCostUsd: 0.17,
      });
    });

    await Effect.runPromise(
      strategy.launch(ports, new AbortController().signal),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      params.definition,
      params.runId,
      expect.objectContaining({
        parentRunId: params.parentRunId,
        stopAfterCycle: true,
        workflowPhase: 'review',
      }),
    );
    expect(params.onStreamResolved).toHaveBeenCalledWith(CHILD_RUN_ID);
    expect(ports.notify).toHaveBeenCalledWith(progress);
    expect(ports.recordCost).toHaveBeenCalledWith(0.17);
  });

  it('records a failed turn cost once through interactive loop settlement', async () => {
    const params = baseParams();
    const recordCost = vi.fn();
    mocks.executeAgent.mockResolvedValueOnce(
      toolUseTurnResult('failed', params.runId, {
        totalCostUsd: 0.29,
        error: { message: 'provider failed', userRetryable: false },
      }),
    );

    const completion = startChildRunLoop({
      session: params.session,
      parentRunId: params.parentRunId,
      runId: params.runId,
      agentName: params.agentName,
      strategy: createNativeSubagentStrategy(params),
      recordCost,
    });
    await completion;

    expect(recordCost).toHaveBeenCalledOnce();
    expect(recordCost).toHaveBeenCalledWith(0.29);
    expect(mocks.persistChildRunDelivery).toHaveBeenCalledWith(
      params.session,
      params.runId,
      expect.any(String),
      expect.objectContaining({
        result: expect.objectContaining({ cost: 0.29, outcome: 'failed' }),
      }),
    );
  });

  it('persists a typed result-only failure without formatting error prose', async () => {
    const params = { ...baseParams(), resultOnly: true };
    const failure = new Error('provider failed');
    mocks.throwErrorFormatting = true;
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRunError?.(failure);
      return toolUseTurnResult('failed', params.runId, {
        error: { message: failure.message, userRetryable: false },
      });
    });

    const completion = startChildRunLoop({
      session: params.session,
      parentRunId: params.parentRunId,
      runId: params.runId,
      agentName: params.agentName,
      strategy: createNativeSubagentStrategy(params),
    });
    await completion;

    expect(mocks.persistChildRunDelivery).toHaveBeenCalledWith(
      params.session,
      params.runId,
      expect.any(String),
      expect.objectContaining({
        producer: 'subagent',
        result: expect.objectContaining({
          outcome: 'failed',
          error: expect.objectContaining({ message: 'provider failed' }),
        }),
      }),
    );
  });

  it('interrupts when the turn aborts before launch publishes its handle', async () => {
    const turn = new AbortController();
    turn.abort();
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy(baseParams());
    mockLaunchPublishing({ interrupt }, 'cancelled');

    await Effect.runPromise(strategy.launch(fakePorts(), turn.signal));

    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('interrupts once for an already-aborted external signal', async () => {
    const external = new AbortController();
    external.abort();
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy({
      ...baseParams(),
      signal: external.signal,
    });
    mockLaunchPublishing({ interrupt }, 'cancelled');

    await Effect.runPromise(
      strategy.launch(fakePorts(), new AbortController().signal),
    );

    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('deduplicates the same external and per-turn abort signal', async () => {
    const controller = new AbortController();
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy({
      ...baseParams(),
      signal: controller.signal,
    });
    mockLaunchPublishing({ interrupt }, 'cancelled', () => controller.abort());

    await Effect.runPromise(strategy.launch(fakePorts(), controller.signal));

    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('detaches from the run signal after launch and ignores later aborts', async () => {
    const controller = new AbortController();
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy(baseParams());
    mockLaunchPublishing({ interrupt }, 'completed');

    await Effect.runPromise(strategy.launch(fakePorts(), controller.signal));
    controller.abort();

    expect(interrupt).not.toHaveBeenCalled();
  });

  it('binds resumed-turn cancellation and policy options to the replacement run', async () => {
    const params = {
      ...baseParams(),
      approvalPromptsUnavailable: true,
      runtimeUnavailableTools: ['bash'],
    };
    const initialHandle = {
      runId: CHILD_RUN_ID,
      deliveryTarget: params.parentRunId,
      interrupt: vi.fn(),
    };
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.(initialHandle as never);
      return toolUseTurnResult(RUN_PHASE.WAITING, params.runId);
    });
    const strategy = createNativeSubagentStrategy(params);
    await Effect.runPromise(
      strategy.launch(fakePorts(), new AbortController().signal),
    );

    mocks.readConfig.mockReturnValue(
      Effect.succeed({ agentCategory: 'toolUse' }),
    );
    mocks.retrieveSessionResumeData.mockReturnValue(
      Effect.succeed(createToolUseResumeData({ runId: params.runId })),
    );
    const turn = new AbortController();
    const replacementInterrupt = vi.fn();
    let replacementReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      replacementReady = resolve;
    });
    mocks.resumeToolUseTurn.mockImplementationOnce(async (_resume, options) => {
      options.onRun?.({
        runId: CHILD_RUN_ID,
        deliveryTarget: params.parentRunId,
        interrupt: replacementInterrupt,
      } as never);
      replacementReady();
      await new Promise<void>((resolve) =>
        turn.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      return toolUseTurnResult('cancelled', params.runId);
    });

    const resumed = Effect.runPromise(
      strategy.runTurn!([], fakePorts(), turn.signal),
    );
    await ready;
    expect(mocks.resumeToolUseTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        approvalPromptsUnavailable: true,
        runtimeUnavailableTools: ['bash'],
      }),
    );
    turn.abort();
    await resumed;

    expect(initialHandle.interrupt).not.toHaveBeenCalled();
    expect(replacementInterrupt).toHaveBeenCalledOnce();
  });

  it('formatDelivery folds a WAITING turn into a completed-shaped delivery', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);

    const waitingTurn = {
      category: 'toolUse' as const,
      outcome: RUN_PHASE.WAITING,
      response: 'The proof holds.',
      files: ['main.tex'],
      runId: params.runId,
    };

    const msg = await strategy.formatDelivery(waitingTurn, 1000);
    expect(msg).toContain('<response>');
    expect(msg).toContain('The proof holds.');
    expect(msg).toContain('status="completed"');
  });

  it('builds the durable result before fallible delivery formatting', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);
    const turn = toolUseTurnResult('completed', params.runId) as never;

    const built = await Effect.runPromise(
      strategy.buildResultMeta!(turn, false, 1000),
    );
    mocks.throwDeliveryFormatting = true;

    await expect(strategy.formatDelivery(turn, 1000)).rejects.toThrow(
      'delivery formatting failed',
    );
    await expect(
      Effect.runPromise(strategy.buildResultMeta!(turn, false, 1000)),
    ).resolves.toBe(built);
  });

  it('does not format prose for a typed-result-only child', async () => {
    const params = { ...baseParams(), resultOnly: true };
    const strategy = createNativeSubagentStrategy(params);
    const turn = toolUseTurnResult('completed', params.runId) as never;
    mocks.throwDeliveryFormatting = true;

    await expect(strategy.formatDelivery(turn, 1000)).resolves.toBe('');
    await expect(
      Effect.runPromise(strategy.buildResultMeta!(turn, false, 1000)),
    ).resolves.toBeDefined();
  });

  it('reports a non-throwing subagent failure via isTurnError, captured from onRunError', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);
    const failure = new Error('model overloaded');

    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRunError?.(failure);
      return toolUseTurnResult('failed', params.runId);
    });

    const turn = await Effect.runPromise(
      strategy.launch(fakePorts(), new AbortController().signal),
    );
    expect(strategy.isTurnError?.(turn)).toBe(true);

    const errMsg = await strategy.formatError(turn, null);
    expect(errMsg).toContain('model overloaded');
  });

  it('persists a typed tool-use failure when no flow result exists', async () => {
    const strategy = createNativeSubagentStrategy(baseParams());

    await expect(
      Effect.runPromise(strategy.buildResultMeta!(null, true, 10)),
    ).resolves.toMatchObject({
      producer: 'subagent',
      agentName: 'review',
      result: {
        category: 'toolUse',
        outcome: 'failed',
        response: '',
        files: [],
        cost: 0,
      },
    });
  });

  it('preserves #7491: a failed direct resume throws for child-loop error delivery', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);

    await launchWaitingTurn(params, strategy);

    mocks.readConfig.mockReturnValue(
      Effect.succeed({ agentCategory: 'toolUse' }),
    );
    mocks.retrieveSessionResumeData.mockReturnValue(
      Effect.succeed(createToolUseResumeData({ runId: params.runId })),
    );
    const resumeError = new Error('resume storage unreadable');
    mocks.resumeToolUseTurn.mockRejectedValueOnce(resumeError);

    await expect(
      Effect.runPromise(
        strategy.runTurn!([], fakePorts(), new AbortController().signal),
      ),
    ).rejects.toBe(resumeError);
  });

  it('keeps a second child follow-up available after two resumed WAITING turns', async () => {
    const session = defaultSession();
    const parentRunId = RunIdSchema.parse('fa110002');
    const childRunId = RunIdSchema.parse('fa110001');
    publishTestRunStart(session, childRunId);
    await session.settlePublications();
    const interactions = { emit: vi.fn() } as never;
    const handle = testRunHandle({
      runId: childRunId,
      parent: parentRunId,
      agent: 'review',
    });
    const params = {
      ...baseParams(session),
      runId: childRunId,
      parentRunId,
      interactions,
    };
    const waitingTurn = (response: string) => ({
      category: 'toolUse' as const,
      outcome: RUN_PHASE.WAITING,
      response,
      runId: childRunId,
    });

    mocks.executeAgent.mockImplementationOnce(
      async (_config, _runId, options) => {
        session.status.transition(childRunId, RUN_PHASE.RUNNING, 'lifecycle');
        session.runs.trackAgentRun(handle, {
          status: RUN_PHASE.RUNNING,
        });
        options.onStreamResolved?.(childRunId);
        options.onRun?.(handle);
        session.status.transitionToWaiting(childRunId, 'wait');
        return waitingTurn('initial response');
      },
    );
    const config = AgentConfigSchema.parse({
      agent: 'review',
      model: 'gpt5',
      agentCategory: 'toolUse',
    });
    const resume = createToolUseResumeData({
      agentConfig: config,
      runId: childRunId,
    });
    mocks.readConfig.mockReturnValue(Effect.succeed(config));
    mocks.retrieveSessionResumeData.mockReturnValue(Effect.succeed(resume));
    mocks.resumeToolUseTurn.mockImplementation(async (_snapshot, options) => {
      options.onRun?.(handle);
      session.status.transitionToWaiting(childRunId, 'wait');
      return waitingTurn(
        `follow-up response ${mocks.resumeToolUseTurn.mock.calls.length}`,
      );
    });

    const strategy = createNativeSubagentStrategy(params);
    const completion = startChildRunLoop({
      session: params.session,
      parentRunId,
      runId: childRunId,
      agentName: params.agentName,
      strategy,
    });
    try {
      await vi.waitFor(() =>
        expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
      );

      expect(
        session.followUps.submit(
          childRunId,
          {
            text: 'Also state exactly where finiteness is used.',
            origin: 'user',
          },
          'live_owner',
        ),
      ).toEqual({ kind: 'queued' });

      await vi.waitFor(() =>
        expect(mocks.resumeToolUseTurn).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() =>
        expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(2),
      );

      expect(
        session.followUps.submit(
          childRunId,
          {
            text: 'Now give the shortest equivalent statement.',
            origin: 'user',
          },
          'live_owner',
        ),
      ).toEqual({ kind: 'queued' });

      await vi.waitFor(() =>
        expect(mocks.resumeToolUseTurn).toHaveBeenCalledTimes(2),
      );
      await vi.waitFor(() =>
        expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(3),
      );

      expect(mocks.resumeToolUseTurn).toHaveBeenCalledTimes(2);
      expect(mocks.resumeToolUseTurn.mock.calls.map((call) => call[0])).toEqual(
        [resume, resume],
      );
      expect(
        mocks.resumeToolUseTurn.mock.calls.map(
          (call) => call[1].drainedFollowUps,
        ),
      ).toEqual([
        [
          {
            text: 'Also state exactly where finiteness is used.',
            displayText: undefined,
            mediaFiles: undefined,
            origin: 'user',
          },
        ],
        [
          {
            text: 'Now give the shortest equivalent statement.',
            displayText: undefined,
            mediaFiles: undefined,
            origin: 'user',
          },
        ],
      ]);
      expect(session.followUps.getAll(childRunId)).toEqual([]);
      expect(session.status.get(childRunId)).toBe(RUN_PHASE.WAITING);
      const resumedDeliveries = mocks.deliverChildRunFollowUp.mock.calls.filter(
        ([delivery]) => delivery.followUp.text.includes('follow-up response'),
      );
      expect(resumedDeliveries).toHaveLength(2);
    } finally {
      // The test handle has no provider. Release it and interrupt the real
      // child activation, then join the loop before clearing its session.
      session.runs.untrack(childRunId);
      await Effect.runPromise(session.runs.kill(childRunId).settlement);
      await completion;
      session.followUps.terminalize(childRunId);
      session.status.clearRun(childRunId);
    }
  });

  it('records the run cumulative cost via ports.recordCost on every turn', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);
    const ports = fakePorts();

    mocks.executeAgent.mockResolvedValueOnce(
      toolUseTurnResult(RUN_PHASE.WAITING, params.runId, {
        totalCostUsd: 0.42,
      }),
    );

    await Effect.runPromise(
      strategy.launch(ports, new AbortController().signal),
    );
    expect(ports.recordCost).toHaveBeenCalledWith(0.42);
  });

  it('derives stageLabel/isTerminal/buildResultMeta from a workflow-category config', async () => {
    const params = baseParams(createTestSession(), 'workflow');
    const strategy = createNativeSubagentStrategy(params);

    expect(strategy.stageLabel).toBe('Native workflow subagent');

    const completedWorkflowTurn = {
      category: 'workflow' as const,
      outcome: 'completed' as const,
      outputs: [],
      compileFailures: [],
      runId: params.runId,
    };
    // A workflow flow never produces a WAITING result, so every turn is
    // terminal — `isWaitingFlowResult` requires `category === 'toolUse'`.
    expect(strategy.isTerminal(completedWorkflowTurn)).toBe(true);

    await expect(
      Effect.runPromise(strategy.buildResultMeta!(null, true, 10)),
    ).resolves.toMatchObject({
      producer: 'subagent',
      agentName: 'review',
      result: {
        category: 'workflow',
        outcome: 'failed',
      },
    });
  });

  it('never reaches runTurn for a workflow child — the loop breaks on the first terminal turn', async () => {
    const session = defaultSession();
    const parentRunId = RunIdSchema.parse('f10a00000002');
    const childRunId = RunIdSchema.parse('f10a00000001');
    const interactions = { emit: vi.fn() } as never;
    const params = {
      ...baseParams(session, 'workflow'),
      runId: childRunId,
      parentRunId,
      interactions,
    };

    mocks.executeAgent.mockResolvedValueOnce({
      category: 'workflow',
      outcome: 'completed',
      outputs: [],
      compileFailures: [],
      runId: childRunId,
    });

    const strategy = createNativeSubagentStrategy(params);
    // `runTurn` is present on the merged strategy (unlike workflow-script's
    // strategy), but the loop must never call it for a workflow child: the
    // first turn is always terminal, and `childRunLoop.ts` breaks on a
    // terminal turn before ever consulting `runTurn`.
    expect(strategy.runTurn).toBeDefined();

    try {
      await startChildRunLoop({
        session: params.session,
        parentRunId,
        runId: childRunId,
        agentName: params.agentName,
        strategy,
      });

      await vi.waitFor(() =>
        expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() =>
        expect(session.followUps.hasLiveOwner(childRunId)).toBe(false),
      );

      expect(mocks.resumeToolUseTurn).not.toHaveBeenCalled();
      expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
    } finally {
      session.followUps.terminalize(childRunId);
      session.status.clearRun(childRunId);
    }
  });
});
