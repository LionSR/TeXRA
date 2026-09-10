// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import type { PreparedAgentDefinition } from '@agent/runtime/AgentLaunchContext';

// Local imports
import {
  startChildRunLoop as startNativeChildRunLoop,
  type ChildRunLoopParams,
} from '@agent/runtime/childRunLoop';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type StreamTabId,
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
  getExecutionRecords: vi.fn(() => ({
    readConfig: mocks.readConfig,
  })),
  getExecutionStore: vi.fn(() => ({
    writeTurnState: mocks.writeTurnState,
  })),
}));

vi.mock('@agent/storage/childRunDeliveryPersistence', () => ({
  persistChildRunDelivery: mocks.persistChildRunDelivery,
}));

vi.mock('@agent/storage/executionLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/executionLease')>()),
  assertOwnedExecutionLease: vi.fn(),
  validateOwnedExecutionLease: vi.fn(async () => {}),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@agent/followUp/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
}));

import { testExecutionHandle } from '@test/support/executionHandleFixtures';
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
function childRunLoop<TTurn>(input: ChildRunLoopParams<TTurn>) {
  return startNativeChildRunLoop(input).pipe(Effect.flatMap(Fiber.join));
}

const ownedSessions = new Set<SessionHandle>();

const CHILD_STREAM_ID = 'child-stream#exec-1' as StreamTabId;

function fakePorts() {
  return { notify: vi.fn(), recordCost: vi.fn() };
}

/** A tool-use turn result on the shared child stream, for launch/resume mocks. */
function toolUseTurnResult(
  outcome: string,
  executionId: ExecutionId,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    category: 'toolUse',
    outcome,
    executionId,
    streamId: CHILD_STREAM_ID,
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
    return toolUseTurnResult(outcome, 'exec-1' as ExecutionId);
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
    executionId: 'exec-1' as ExecutionId,
    agentName: 'review',
    parentStreamId: 'orchestrator-stream' as StreamTabId,
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
 * resolves the turn — the `deliveryTargetStreamId`/`childStreamId` handle shape
 * the strategy reads arrives through the `onRun` callback.
 */
async function launchWaitingTurn(
  params: BaseParams,
  strategy: Strategy,
): Promise<void> {
  mocks.executeAgent.mockResolvedValueOnce(
    toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId),
  );
  await Effect.runPromise(
    strategy.launch(fakePorts(), new AbortController().signal),
  );
  mocks.executeAgent.mock.calls.at(-1)?.[2].onRun?.({
    childStreamId: CHILD_STREAM_ID,
    deliveryTargetStreamId: params.parentStreamId,
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

  it.effect(
    'resolveDeliveryTarget follows the live run handle, including after detach',
    () =>
      Effect.gen(function* () {
        const params = baseParams();
        const strategy = createNativeSubagentStrategy(params);

        // Before any turn ran, falls back to the static orchestrator stream.
        expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentStreamId);

        mocks.executeAgent.mockImplementationOnce(
          async (_config, _id, options) => {
            options.onRun?.({
              childStreamId: CHILD_STREAM_ID,
              deliveryTargetStreamId: params.parentStreamId,
            });
            return toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId);
          },
        );

        yield* strategy.launch(fakePorts(), new AbortController().signal);
        expect(mocks.executeAgent).toHaveBeenLastCalledWith(
          params.definition,
          params.executionId,
          expect.objectContaining({ isSubagent: true }),
        );
        expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentStreamId);

        // Detach: the same handle object's deliveryTargetStreamId flips to
        // undefined (AgentExecutionHandle.detach) — the strategy must track the
        // LIVE handle, not a stale copy, so it observes this without a new turn.
        const liveHandle = {
          childStreamId: CHILD_STREAM_ID,
          deliveryTargetStreamId: params.parentStreamId as
            StreamTabId | undefined,
        };
        mocks.executeAgent.mockImplementationOnce(
          async (_config, _id, options) => {
            options.onRun?.(liveHandle);
            return toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId);
          },
        );
        yield* strategy.launch(fakePorts(), new AbortController().signal);
        expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentStreamId);
        liveHandle.deliveryTargetStreamId = undefined;
        expect(strategy.resolveDeliveryTarget?.()).toBeUndefined();
      }),
  );

  it.effect('uses the same launch primitive in durable single-cycle mode', () =>
    Effect.gen(function* () {
      const params = {
        ...baseParams(),
        executionMode: 'single-cycle' as const,
        workflowPhase: 'review',
      };
      const strategy = createNativeSubagentStrategy(params);
      const ports = fakePorts();
      const progress = { message: 'Reading proof' };

      mocks.executeAgent.mockImplementationOnce(
        async (_config, _id, options) => {
          options.onStreamResolved?.(CHILD_STREAM_ID);
          options.onProgress?.(progress);
          return toolUseTurnResult('completed', params.executionId, {
            totalCostUsd: 0.17,
          });
        },
      );

      yield* strategy.launch(ports, new AbortController().signal);

      expect(mocks.executeAgent).toHaveBeenCalledWith(
        params.definition,
        params.executionId,
        expect.objectContaining({
          isSubagent: true,
          parentStreamId: params.parentStreamId,
          stopAfterCycle: true,
          workflowPhase: 'review',
        }),
      );
      expect(params.onStreamResolved).toHaveBeenCalledWith(CHILD_STREAM_ID);
      expect(ports.notify).toHaveBeenCalledWith(progress);
      expect(ports.recordCost).toHaveBeenCalledWith(0.17);
    }),
  );

  it.effect(
    'records a failed turn cost once through interactive loop settlement',
    () =>
      Effect.gen(function* () {
        const params = baseParams();
        const recordCost = vi.fn();
        mocks.executeAgent.mockResolvedValueOnce(
          toolUseTurnResult('failed', params.executionId, {
            totalCostUsd: 0.29,
            error: { message: 'provider failed', userRetryable: false },
          }),
        );

        yield* childRunLoop({
          session: params.session,
          childStreamId: CHILD_STREAM_ID,
          parentStreamId: params.parentStreamId,
          executionId: params.executionId,
          agentName: params.agentName,
          strategy: createNativeSubagentStrategy(params),
          recordCost,
        });

        expect(recordCost).toHaveBeenCalledOnce();
        expect(recordCost).toHaveBeenCalledWith(0.29);
        expect(mocks.persistChildRunDelivery).toHaveBeenCalledWith(
          params.session,
          params.executionId,
          expect.any(String),
          expect.objectContaining({
            result: expect.objectContaining({ cost: 0.29, outcome: 'failed' }),
          }),
        );
      }),
  );

  it.effect(
    'persists a typed result-only failure without formatting error prose',
    () =>
      Effect.gen(function* () {
        const params = { ...baseParams(), resultOnly: true };
        const failure = new Error('provider failed');
        mocks.throwErrorFormatting = true;
        mocks.executeAgent.mockImplementationOnce(
          async (_config, _id, options) => {
            options.onRunError?.(failure);
            return toolUseTurnResult('failed', params.executionId, {
              error: { message: failure.message, userRetryable: false },
            });
          },
        );

        yield* childRunLoop({
          session: params.session,
          childStreamId: CHILD_STREAM_ID,
          parentStreamId: params.parentStreamId,
          executionId: params.executionId,
          agentName: params.agentName,
          strategy: createNativeSubagentStrategy(params),
        });

        expect(mocks.persistChildRunDelivery).toHaveBeenCalledWith(
          params.session,
          params.executionId,
          expect.any(String),
          expect.objectContaining({
            producer: 'subagent',
            result: expect.objectContaining({
              outcome: 'failed',
              error: expect.objectContaining({ message: 'provider failed' }),
            }),
          }),
        );
      }),
  );

  it.effect(
    'interrupts when the turn aborts before launch publishes its handle',
    () =>
      Effect.gen(function* () {
        const turn = new AbortController();
        turn.abort();
        const interrupt = vi.fn();
        const strategy = createNativeSubagentStrategy(baseParams());
        mockLaunchPublishing({ interrupt }, 'cancelled');

        yield* strategy.launch(fakePorts(), turn.signal);

        expect(interrupt).toHaveBeenCalledOnce();
      }),
  );

  it.effect('interrupts once for an already-aborted external signal', () =>
    Effect.gen(function* () {
      const external = new AbortController();
      external.abort();
      const interrupt = vi.fn();
      const strategy = createNativeSubagentStrategy({
        ...baseParams(),
        signal: external.signal,
      });
      mockLaunchPublishing({ interrupt }, 'cancelled');

      yield* strategy.launch(fakePorts(), new AbortController().signal);

      expect(interrupt).toHaveBeenCalledOnce();
    }),
  );

  it.effect('deduplicates the same external and per-turn abort signal', () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const interrupt = vi.fn();
      const strategy = createNativeSubagentStrategy({
        ...baseParams(),
        signal: controller.signal,
      });
      mockLaunchPublishing({ interrupt }, 'cancelled', () =>
        controller.abort(),
      );

      yield* strategy.launch(fakePorts(), controller.signal);

      expect(interrupt).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    'detaches from the run signal after launch and ignores later aborts',
    () =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const interrupt = vi.fn();
        const strategy = createNativeSubagentStrategy(baseParams());
        mockLaunchPublishing({ interrupt }, 'completed');

        yield* strategy.launch(fakePorts(), controller.signal);
        controller.abort();

        expect(interrupt).not.toHaveBeenCalled();
      }),
  );

  it.live(
    'binds resumed-turn cancellation and policy options to the replacement run',
    () =>
      Effect.gen(function* () {
        const params = {
          ...baseParams(),
          approvalPromptsUnavailable: true,
          runtimeUnavailableTools: ['bash'],
        };
        const childStreamId = CHILD_STREAM_ID;
        const initialHandle = {
          childStreamId,
          deliveryTargetStreamId: params.parentStreamId,
          interrupt: vi.fn(),
        };
        mocks.executeAgent.mockImplementationOnce(
          async (_config, _id, options) => {
            options.onRun?.(initialHandle as never);
            return toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId);
          },
        );
        const strategy = createNativeSubagentStrategy(params);
        yield* strategy.launch(fakePorts(), new AbortController().signal);

        mocks.readConfig.mockReturnValue(
          Effect.succeed({ agentCategory: 'toolUse' }),
        );
        mocks.retrieveSessionResumeData.mockReturnValue(
          Effect.succeed(
            createToolUseResumeData({ executionId: params.executionId }),
          ),
        );
        const turn = new AbortController();
        const replacementInterrupt = vi.fn();
        let replacementReady!: () => void;
        const ready = new Promise<void>((resolve) => {
          replacementReady = resolve;
        });
        mocks.resumeToolUseTurn.mockImplementationOnce(
          async (_resume, options) => {
            options.onRun?.({
              childStreamId,
              deliveryTargetStreamId: params.parentStreamId,
              interrupt: replacementInterrupt,
            } as never);
            replacementReady();
            await new Promise<void>((resolve) =>
              turn.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
            return toolUseTurnResult('cancelled', params.executionId);
          },
        );

        const resumed = yield* Effect.forkChild(
          strategy.runTurn!([], fakePorts(), turn.signal),
        );
        yield* Effect.promise(() => ready);
        expect(mocks.resumeToolUseTurn).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            approvalPromptsUnavailable: true,
            runtimeUnavailableTools: ['bash'],
          }),
        );
        turn.abort();
        yield* Fiber.join(resumed);

        expect(initialHandle.interrupt).not.toHaveBeenCalled();
        expect(replacementInterrupt).toHaveBeenCalledOnce();
      }),
  );

  it('formatDelivery folds a WAITING turn into a completed-shaped delivery', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);

    const waitingTurn = {
      category: 'toolUse' as const,
      outcome: STREAM_PHASE.WAITING,
      response: 'The proof holds.',
      files: ['main.tex'],
      executionId: params.executionId,
      streamId: CHILD_STREAM_ID,
    };

    const msg = await strategy.formatDelivery(waitingTurn, 1000);
    expect(msg).toContain('<response>');
    expect(msg).toContain('The proof holds.');
    expect(msg).toContain('status="completed"');
  });

  it.effect(
    'builds the durable result before fallible delivery formatting',
    () =>
      Effect.gen(function* () {
        const params = baseParams();
        const strategy = createNativeSubagentStrategy(params);
        const turn = toolUseTurnResult(
          'completed',
          params.executionId,
        ) as never;

        const built = yield* strategy.buildResultMeta!(turn, false, 1000);
        mocks.throwDeliveryFormatting = true;

        yield* Effect.promise(() =>
          expect(strategy.formatDelivery(turn, 1000)).rejects.toThrow(
            'delivery formatting failed',
          ),
        );
        expect(yield* strategy.buildResultMeta!(turn, false, 1000)).toBe(built);
      }),
  );

  it.effect('does not format prose for a typed-result-only child', () =>
    Effect.gen(function* () {
      const params = { ...baseParams(), resultOnly: true };
      const strategy = createNativeSubagentStrategy(params);
      const turn = toolUseTurnResult('completed', params.executionId) as never;
      mocks.throwDeliveryFormatting = true;

      yield* Effect.promise(() =>
        expect(strategy.formatDelivery(turn, 1000)).resolves.toBe(''),
      );
      expect(yield* strategy.buildResultMeta!(turn, false, 1000)).toBeDefined();
    }),
  );

  it.effect(
    'reports a non-throwing subagent failure via isTurnError, captured from onRunError',
    () =>
      Effect.gen(function* () {
        const params = baseParams();
        const strategy = createNativeSubagentStrategy(params);
        const failure = new Error('model overloaded');

        mocks.executeAgent.mockImplementationOnce(
          async (_config, _id, options) => {
            options.onRunError?.(failure);
            return toolUseTurnResult('failed', params.executionId);
          },
        );

        const turn = yield* strategy.launch(
          fakePorts(),
          new AbortController().signal,
        );
        expect(strategy.isTurnError?.(turn)).toBe(true);

        const errMsg = yield* Effect.promise(async () =>
          strategy.formatError(turn, null),
        );
        expect(errMsg).toContain('model overloaded');
      }),
  );

  it.effect(
    'persists a typed tool-use failure when no flow result exists',
    () =>
      Effect.gen(function* () {
        const strategy = createNativeSubagentStrategy(baseParams());

        expect(yield* strategy.buildResultMeta!(null, true, 10)).toMatchObject({
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
      }),
  );

  it.effect(
    'stamps parent lineage onto both success and failure manifests',
    () =>
      Effect.gen(function* () {
        const params = {
          ...baseParams(),
          parentExecutionId: 'parent-exec' as ExecutionId,
        };
        const strategy = createNativeSubagentStrategy(params);

        expect(yield* strategy.buildResultMeta!(null, true, 10)).toMatchObject({
          parentExecutionId: 'parent-exec',
        });

        expect(
          yield* strategy.buildResultMeta!(
            {
              category: 'toolUse',
              outcome: 'completed',
              response: 'done',
              executionId: params.executionId,
              streamId: CHILD_STREAM_ID,
            },
            false,
            10,
          ),
        ).toMatchObject({ parentExecutionId: 'parent-exec' });
      }),
  );

  it('preserves #7491: a failed direct resume throws for child-loop error delivery', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);

    await launchWaitingTurn(params, strategy);

    mocks.readConfig.mockReturnValue(
      Effect.succeed({ agentCategory: 'toolUse' }),
    );
    mocks.retrieveSessionResumeData.mockReturnValue(
      Effect.succeed(
        createToolUseResumeData({ executionId: params.executionId }),
      ),
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
    const childStreamId = 'native-follow-up-loop-child#fa110001' as StreamTabId;
    const parentStreamId = 'native-follow-up-loop-parent' as StreamTabId;
    const executionId = 'fa110001' as ExecutionId;
    publishTestRunStart(session, childStreamId, executionId);
    await session.settlePublications();
    const interactions = { emit: vi.fn() } as never;
    const handle = testExecutionHandle({
      executionId,
      parentStreamId,
      childStreamId,
      agent: 'review',
    });
    const params = {
      ...baseParams(session),
      executionId,
      parentStreamId,
      interactions,
    };
    const waitingTurn = (response: string) => ({
      category: 'toolUse' as const,
      outcome: STREAM_PHASE.WAITING,
      response,
      executionId,
      streamId: childStreamId,
    });

    mocks.executeAgent.mockImplementationOnce(
      async (_config, _executionId, options) => {
        session.status.transition(
          childStreamId,
          STREAM_PHASE.RUNNING,
          'lifecycle',
        );
        session.executions.trackAgentExecution(handle, {
          status: STREAM_PHASE.RUNNING,
        });
        options.onStreamResolved?.(childStreamId);
        options.onRun?.(handle);
        session.status.transitionToWaiting(childStreamId, 'wait');
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
      executionId,
      streamId: childStreamId,
    });
    mocks.readConfig.mockReturnValue(Effect.succeed(config));
    mocks.retrieveSessionResumeData.mockReturnValue(Effect.succeed(resume));
    mocks.resumeToolUseTurn.mockImplementation(async (_snapshot, options) => {
      options.onRun?.(handle);
      session.status.transitionToWaiting(childStreamId, 'wait');
      return waitingTurn(
        `follow-up response ${mocks.resumeToolUseTurn.mock.calls.length}`,
      );
    });

    const strategy = createNativeSubagentStrategy(params);
    const completion = Effect.runPromise(
      childRunLoop({
        session: params.session,
        childStreamId,
        parentStreamId,
        executionId,
        agentName: params.agentName,
        strategy,
      }),
    );
    try {
      await vi.waitFor(() =>
        expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
      );

      expect(
        session.followUps.submit(
          childStreamId,
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
          childStreamId,
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
      expect(session.followUps.getAll(childStreamId)).toEqual([]);
      expect(session.status.get(childStreamId)).toBe(STREAM_PHASE.WAITING);
      const resumedDeliveries = mocks.deliverChildRunFollowUp.mock.calls.filter(
        ([delivery]) => delivery.followUp.text.includes('follow-up response'),
      );
      expect(resumedDeliveries).toHaveLength(2);
    } finally {
      // The test handle has no provider. Release it and interrupt the real
      // child activation, then join the loop before clearing its session.
      session.executions.untrack(executionId);
      await Effect.runPromise(session.executions.kill(executionId).settlement);
      await completion;
      session.followUps.terminalize(childStreamId);
      session.status.clearStream(childStreamId);
    }
  });

  it.effect(
    'records the run cumulative cost via ports.recordCost on every turn',
    () =>
      Effect.gen(function* () {
        const params = baseParams();
        const strategy = createNativeSubagentStrategy(params);
        const ports = fakePorts();

        mocks.executeAgent.mockResolvedValueOnce(
          toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId, {
            totalCostUsd: 0.42,
          }),
        );

        yield* strategy.launch(ports, new AbortController().signal);
        expect(ports.recordCost).toHaveBeenCalledWith(0.42);
      }),
  );

  it.effect(
    'derives stageLabel/isTerminal/buildResultMeta from a workflow-category config',
    () =>
      Effect.gen(function* () {
        const params = baseParams(createTestSession(), 'workflow');
        const strategy = createNativeSubagentStrategy(params);

        expect(strategy.stageLabel).toBe('Native workflow subagent');

        const completedWorkflowTurn = {
          category: 'workflow' as const,
          outcome: 'completed' as const,
          outputs: [],
          compileFailures: [],
          executionId: params.executionId,
          streamId: CHILD_STREAM_ID,
        };
        // A workflow flow never produces a WAITING result, so every turn is
        // terminal — `isWaitingFlowResult` requires `category === 'toolUse'`.
        expect(strategy.isTerminal(completedWorkflowTurn)).toBe(true);

        expect(yield* strategy.buildResultMeta!(null, true, 10)).toMatchObject({
          producer: 'subagent',
          agentName: 'review',
          result: {
            category: 'workflow',
            outcome: 'failed',
          },
        });
      }),
  );

  it.live(
    'never reaches runTurn for a workflow child — the loop breaks on the first terminal turn',
    () =>
      Effect.gen(function* () {
        const session = defaultSession();
        const childStreamId =
          'native-workflow-loop-child#native-workflow-loop-exec' as StreamTabId;
        const parentStreamId = 'native-workflow-loop-parent' as StreamTabId;
        const executionId = 'native-workflow-loop-exec' as ExecutionId;
        const interactions = { emit: vi.fn() } as never;
        const params = {
          ...baseParams(session, 'workflow'),
          executionId,
          parentStreamId,
          interactions,
        };

        mocks.executeAgent.mockResolvedValueOnce({
          category: 'workflow',
          outcome: 'completed',
          outputs: [],
          compileFailures: [],
          executionId,
          streamId: childStreamId,
        });

        const strategy = createNativeSubagentStrategy(params);
        // `runTurn` is present on the merged strategy (unlike workflow-script's
        // strategy), but the loop must never call it for a workflow child: the
        // first turn is always terminal, and `childRunLoop.ts` breaks on a
        // terminal turn before ever consulting `runTurn`.
        expect(strategy.runTurn).toBeDefined();

        try {
          yield* childRunLoop({
            session: params.session,
            childStreamId,
            parentStreamId,
            executionId,
            agentName: params.agentName,
            strategy,
          });

          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
            ),
          );
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(session.followUps.hasLiveOwner(childStreamId)).toBe(false),
            ),
          );

          expect(mocks.resumeToolUseTurn).not.toHaveBeenCalled();
          expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
        } finally {
          session.followUps.terminalize(childStreamId);
          session.status.clearStream(childStreamId);
        }
      }),
  );
});
