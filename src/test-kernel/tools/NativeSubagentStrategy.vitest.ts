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
  aggregateId,
  RUN_PHASE,
  RunIdSchema,
  RunUsageTotalsSchema,
  USER_FOLLOW_UP_SUPPORT,
  type FlowStep,
  type RunId,
} from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  submitFollowUp: vi.fn(),
  executeAgent: vi.fn(),
  finalizeRun: vi.fn(),
  persistChildRunDelivery: vi.fn(),
  readConfig: vi.fn(),
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

vi.mock('@agent/followUp/ToolUseFollowUp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/followUp/ToolUseFollowUp')>()),
  submitFollowUp: mocks.submitFollowUp,
}));

import { testRunHandle } from '@test/support/runHandleFixtures';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  fakeProcessServices,
  type FakeProcessServices,
} from '@test/support/setupPlatform';
import {
  createNativeSubagentStrategy,
  provideAgentEngine,
} from '@tools/delegation/nativeSubagentStrategy';
import { ensureError } from '@utils/errors/errorMessage';

/** Drive and join the native child at the test entry point. */
function startChildRunLoop<TTurn>(
  input: ChildRunLoopParams<TTurn, FakeProcessServices>,
) {
  return startNativeChildRunLoop(input).pipe(
    Effect.flatMap(Fiber.join),
    Effect.provide(fakeProcessServices()),
  );
}

/** Run one strategy turn on the fake host's process services. */
function runOnFakeHost<A, E>(
  turn: Effect.Effect<A, E, FakeProcessServices>,
): Effect.Effect<A, E> {
  return Effect.provide(turn, fakeProcessServices());
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
    outcome,
    runId,
    output: { category: 'toolUse', response: '', files: [] },
    ...extras,
  };
}

/**
 * Move a child's phase the way its loop does: a `flow.step` row, the one fact
 * the fold derives a live phase from (one run model, 3.3). `waiting` parks the
 * run, any other step runs it.
 */
function publishFlowStep(
  session: SessionHandle,
  runId: RunId,
  step: FlowStep,
): void {
  session.publish([
    {
      type: 'flow.step',
      aggregateId: aggregateId('run', runId),
      payload: { family: 'toolUse', step },
    },
  ]);
}

/** The run-cumulative usage totals a turn reports, keyed by its spend. */
function turnUsage(totalCost: number): Record<string, unknown> {
  return RunUsageTotalsSchema.parse({ totalCost });
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
    onRunResolved: vi.fn(),
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
function launchWaitingTurn(params: BaseParams, strategy: Strategy) {
  return Effect.gen(function* () {
    mocks.executeAgent.mockResolvedValueOnce(
      toolUseTurnResult(RUN_PHASE.WAITING, params.runId),
    );
    yield* runOnFakeHost(
      strategy.launch(fakePorts(), new AbortController().signal),
    );
    mocks.executeAgent.mock.calls.at(-1)?.[2].onRun?.({
      runId: CHILD_RUN_ID,
      deliveryTarget: params.parentRunId,
    });
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
    mocks.submitFollowUp.mockReturnValue(Effect.succeed({ status: 'sent' }));
    mocks.persistChildRunDelivery.mockReturnValue(Effect.void);
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

        // Before any turn ran, falls back to the static orchestrator run.
        expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentRunId);

        mocks.executeAgent.mockImplementationOnce(
          async (_config, _id, options) => {
            options.onRun?.({
              runId: CHILD_RUN_ID,
              deliveryTarget: params.parentRunId,
            });
            return toolUseTurnResult(RUN_PHASE.WAITING, params.runId);
          },
        );

        yield* runOnFakeHost(
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
        mocks.executeAgent.mockImplementationOnce(
          async (_config, _id, options) => {
            options.onRun?.(liveHandle);
            return toolUseTurnResult(RUN_PHASE.WAITING, params.runId);
          },
        );
        yield* runOnFakeHost(
          strategy.launch(fakePorts(), new AbortController().signal),
        );
        expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentRunId);
        liveHandle.deliveryTarget = undefined;
        expect(strategy.resolveDeliveryTarget?.()).toBeUndefined();
      }),
  );

  it.effect('uses the same launch primitive in durable single-cycle mode', () =>
    Effect.gen(function* () {
      const params = {
        ...baseParams(),
        runMode: 'single-cycle' as const,
        workflowPhase: 'review',
      };
      const strategy = createNativeSubagentStrategy(params);
      const ports = fakePorts();
      const progress = { message: 'Reading proof' };

      mocks.executeAgent.mockImplementationOnce(
        async (_config, _id, options) => {
          options.onRunResolved?.(CHILD_RUN_ID);
          options.onProgress?.(progress);
          return toolUseTurnResult('completed', params.runId, {
            usage: turnUsage(0.17),
          });
        },
      );

      yield* runOnFakeHost(
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
      expect(params.onRunResolved).toHaveBeenCalledWith(CHILD_RUN_ID);
      expect(ports.notify).toHaveBeenCalledWith(progress);
      expect(ports.recordCost).toHaveBeenCalledWith(0.17);
    }),
  );

  it.effect(
    'records a failed turn cost once through interactive loop settlement',
    () =>
      Effect.gen(function* () {
        const params = baseParams();
        // The loop commits the child's `child.turn` rows, which its aggregate
        // refuses until the run has begun.
        publishTestRunStart(params.session, params.runId);
        const recordCost = vi.fn();
        mocks.executeAgent.mockResolvedValueOnce(
          toolUseTurnResult('failed', params.runId, {
            usage: turnUsage(0.29),
            error: { message: 'provider failed', userRetryable: false },
          }),
        );

        yield* startChildRunLoop({
          session: params.session,
          parentRunId: params.parentRunId,
          runId: params.runId,
          agentName: params.agentName,
          strategy: createNativeSubagentStrategy(params),
          recordCost,
        });

        expect(recordCost).toHaveBeenCalledOnce();
        expect(recordCost).toHaveBeenCalledWith(0.29);
        expect(mocks.persistChildRunDelivery).toHaveBeenCalledWith(
          params.session,
          params.runId,
          expect.any(String),
          expect.objectContaining({
            producer: 'subagent',
            output: expect.objectContaining({ category: 'toolUse' }),
          }),
        );
      }),
  );

  it.effect(
    'persists a typed result-only failure without formatting error prose',
    () =>
      Effect.gen(function* () {
        const params = { ...baseParams(), resultOnly: true };
        publishTestRunStart(params.session, params.runId);
        const failure = new Error('provider failed');
        mocks.throwErrorFormatting = true;
        mocks.executeAgent.mockImplementationOnce(
          async (_config, _id, options) => {
            options.onRunError?.(failure);
            return toolUseTurnResult('failed', params.runId, {
              error: { message: failure.message, userRetryable: false },
            });
          },
        );

        yield* startChildRunLoop({
          session: params.session,
          parentRunId: params.parentRunId,
          runId: params.runId,
          agentName: params.agentName,
          strategy: createNativeSubagentStrategy(params),
        });

        expect(mocks.persistChildRunDelivery).toHaveBeenCalledWith(
          params.session,
          params.runId,
          expect.any(String),
          expect.objectContaining({
            producer: 'subagent',
            output: expect.objectContaining({ category: 'toolUse' }),
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

        yield* runOnFakeHost(strategy.launch(fakePorts(), turn.signal));

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

      yield* runOnFakeHost(
        strategy.launch(fakePorts(), new AbortController().signal),
      );

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

      yield* runOnFakeHost(strategy.launch(fakePorts(), controller.signal));

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

        yield* runOnFakeHost(strategy.launch(fakePorts(), controller.signal));
        controller.abort();

        expect(interrupt).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'binds resumed-turn cancellation and policy options to the replacement run',
    () =>
      Effect.gen(function* () {
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
        mocks.executeAgent.mockImplementationOnce(
          async (_config, _id, options) => {
            options.onRun?.(initialHandle as never);
            return toolUseTurnResult(RUN_PHASE.WAITING, params.runId);
          },
        );
        const strategy = createNativeSubagentStrategy(params);
        yield* runOnFakeHost(
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
        mocks.resumeToolUseTurn.mockImplementationOnce(
          async (_resume, options) => {
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
          },
        );

        const resumed = yield* runOnFakeHost(
          strategy.runTurn!([], fakePorts(), turn.signal),
        ).pipe(Effect.forkChild);
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

  it.effect(
    'formatDelivery folds a WAITING turn into a completed-shaped delivery',
    () =>
      Effect.gen(function* () {
        const params = baseParams();
        const strategy = createNativeSubagentStrategy(params);

        const waitingTurn = {
          outcome: RUN_PHASE.WAITING,
          runId: params.runId,
          output: {
            category: 'toolUse' as const,
            response: 'The proof holds.',
            files: ['main.tex'],
          },
        };

        const msg = yield* Effect.promise(() =>
          Promise.resolve(strategy.formatDelivery(waitingTurn, 1000)),
        );
        expect(msg).toContain('<response>');
        expect(msg).toContain('The proof holds.');
        expect(msg).toContain('status="completed"');
      }),
  );

  it.effect(
    'builds the durable result before fallible delivery formatting',
    () =>
      Effect.gen(function* () {
        const params = baseParams();
        const strategy = createNativeSubagentStrategy(params);
        const turn = toolUseTurnResult('completed', params.runId) as never;

        const built = yield* strategy.buildResultMeta!(turn, false, 1000);
        mocks.throwDeliveryFormatting = true;

        const deliveryError = yield* Effect.flip(
          Effect.tryPromise({
            try: () => Promise.resolve(strategy.formatDelivery(turn, 1000)),
            catch: ensureError,
          }),
        );
        expect(deliveryError.message).toContain('delivery formatting failed');
        expect(yield* strategy.buildResultMeta!(turn, false, 1000)).toBe(built);
      }),
  );

  it.effect('does not format prose for a typed-result-only child', () =>
    Effect.gen(function* () {
      const params = { ...baseParams(), resultOnly: true };
      const strategy = createNativeSubagentStrategy(params);
      const turn = toolUseTurnResult('completed', params.runId) as never;
      mocks.throwDeliveryFormatting = true;

      expect(
        yield* Effect.promise(() =>
          Promise.resolve(strategy.formatDelivery(turn, 1000)),
        ),
      ).toBe('');
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
            return toolUseTurnResult('failed', params.runId);
          },
        );

        const turn = yield* runOnFakeHost(
          strategy.launch(fakePorts(), new AbortController().signal),
        );
        expect(strategy.isTurnError?.(turn)).toBe(true);

        const errMsg = yield* Effect.promise(() =>
          Promise.resolve(strategy.formatError(turn, null)),
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
          output: { category: 'toolUse', response: '', files: [] },
        });
      }),
  );

  it.effect(
    'preserves #7491: a failed direct resume throws for child-loop error delivery',
    () =>
      Effect.gen(function* () {
        const params = baseParams();
        const strategy = createNativeSubagentStrategy(params);

        yield* launchWaitingTurn(params, strategy);

        mocks.readConfig.mockReturnValue(
          Effect.succeed({ agentCategory: 'toolUse' }),
        );
        mocks.retrieveSessionResumeData.mockReturnValue(
          Effect.succeed(createToolUseResumeData({ runId: params.runId })),
        );
        const resumeError = new Error('resume storage unreadable');
        mocks.resumeToolUseTurn.mockRejectedValueOnce(resumeError);

        const error = yield* Effect.flip(
          runOnFakeHost(
            strategy.runTurn!([], fakePorts(), new AbortController().signal),
          ),
        );
        expect(error).toBe(resumeError);
      }),
  );

  it.live(
    'keeps a second child follow-up available after two resumed WAITING turns',
    () =>
      Effect.gen(function* () {
        const session = defaultSession();
        const parentRunId = RunIdSchema.parse('fa110002');
        const childRunId = RunIdSchema.parse('fa110001');
        publishTestRunStart(session, childRunId);
        yield* Effect.promise(() => session.settlePublications());
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
          outcome: RUN_PHASE.WAITING,
          runId: childRunId,
          output: { category: 'toolUse' as const, response, files: [] },
        });

        mocks.executeAgent.mockImplementationOnce(
          async (_config, _runId, options) => {
            publishFlowStep(session, childRunId, 'turn.begin');
            session.runs.track(handle);
            options.onRunResolved?.(childRunId);
            options.onRun?.(handle);
            publishFlowStep(session, childRunId, 'waiting');
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
        mocks.resumeToolUseTurn.mockImplementation(
          async (_snapshot, options) => {
            options.onRun?.(handle);
            publishFlowStep(session, childRunId, 'waiting');
            return waitingTurn(
              `follow-up response ${mocks.resumeToolUseTurn.mock.calls.length}`,
            );
          },
        );

        const strategy = createNativeSubagentStrategy(params);
        const completion = yield* startChildRunLoop({
          session: params.session,
          parentRunId,
          runId: childRunId,
          agentName: params.agentName,
          strategy,
        }).pipe(Effect.forkChild);
        try {
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(mocks.submitFollowUp).toHaveBeenCalledTimes(1),
            ),
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

          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(mocks.resumeToolUseTurn).toHaveBeenCalledTimes(1),
            ),
          );
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(mocks.submitFollowUp).toHaveBeenCalledTimes(2),
            ),
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

          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(mocks.resumeToolUseTurn).toHaveBeenCalledTimes(2),
            ),
          );
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(mocks.submitFollowUp).toHaveBeenCalledTimes(3),
            ),
          );

          expect(mocks.resumeToolUseTurn).toHaveBeenCalledTimes(2);
          expect(
            mocks.resumeToolUseTurn.mock.calls.map((call) => call[0]),
          ).toEqual([resume, resume]);
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
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(session.runView(childRunId)?.status).toBe(
                RUN_PHASE.WAITING,
              ),
            ),
          );
          const resumedDeliveries = mocks.submitFollowUp.mock.calls.filter(
            ([, followUp]) => followUp.text.includes('follow-up response'),
          );
          expect(resumedDeliveries).toHaveLength(2);
        } finally {
          // The test handle has no provider. Release it and interrupt the real
          // child activation, then join the loop before clearing its session.
          session.runs.untrack(childRunId);
          yield* session.runs.kill(childRunId).settlement;
          yield* Fiber.join(completion);
          session.followUps.terminalize(childRunId);
        }
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
          outcome: 'completed' as const,
          runId: params.runId,
          output: {
            category: 'workflow' as const,
            outputs: [],
            compileFailures: [],
            diffs: [],
          },
        };
        // A workflow flow never produces a WAITING result, so every turn is
        // terminal — `isWaitingFlowResult` requires `category === 'toolUse'`.
        expect(strategy.isTerminal(completedWorkflowTurn)).toBe(true);

        expect(yield* strategy.buildResultMeta!(null, true, 10)).toMatchObject({
          producer: 'subagent',
          agentName: 'review',
          output: { category: 'workflow' },
        });
      }),
  );

  it.live(
    'never reaches runTurn for a workflow child — the loop breaks on the first terminal turn',
    () =>
      Effect.gen(function* () {
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
        publishTestRunStart(session, childRunId);

        mocks.executeAgent.mockResolvedValueOnce({
          outcome: 'completed',
          runId: childRunId,
          output: {
            category: 'workflow',
            outputs: [],
            compileFailures: [],
            diffs: [],
          },
        });

        const strategy = createNativeSubagentStrategy(params);
        // `runTurn` is present on the merged strategy (unlike workflow-script's
        // strategy), but the loop must never call it for a workflow child: the
        // first turn is always terminal, and `childRunLoop.ts` breaks on a
        // terminal turn before ever consulting `runTurn`.
        expect(strategy.runTurn).toBeDefined();

        try {
          yield* startChildRunLoop({
            session: params.session,
            parentRunId,
            runId: childRunId,
            agentName: params.agentName,
            strategy,
          });

          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(mocks.submitFollowUp).toHaveBeenCalledTimes(1),
            ),
          );
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(session.followUps.hasLiveOwner(childRunId)).toBe(false),
            ),
          );

          expect(mocks.resumeToolUseTurn).not.toHaveBeenCalled();
          expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
        } finally {
          session.followUps.terminalize(childRunId);
        }
      }),
  );
});
