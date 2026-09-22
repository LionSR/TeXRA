import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';

import { beforeEach, describe, expect, vi, type Mock } from 'vitest';

import { noopTrace, TraceEmitter } from '@agent/trace';
import type { FinalizeRunResult } from '@agent/storage/runLifecycle';
import { RunHandle } from '@agent/runtime/RunHandle';
import { Runs } from '@agent/runtime/runRegistry';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  finalizeRunTerminal,
  runFlowWithLifecycle,
} from '@agent/runtime/AgentRunLifecycle';
import {
  type ToolUseFlowResult,
  type WaitingToolUseFlowResult,
  type WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  agentKey,
  AgentCategory,
} from '@shared/schemas';
import type { RunId, RunOutcome } from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  fakeProcessServices,
  installPlatform,
  installedHost,
} from '@test/support/setupPlatform';
import { generateRunId } from '@utils/core';

import { eventsOfType, recordSessionEvents } from '../progressTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  // Echoes the requested outcome, as the real finalizer does whenever there
  // is no existing outcome to retain.
  finalizeRun: vi.fn(
    (
      _session: unknown,
      input: {
        outcome: RunOutcome;
      },
    ): Effect.Effect<FinalizeRunResult> =>
      Effect.succeed({
        ok: true,
        outcome: input.outcome,
      }),
  ),
}));

const channelTraceMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

// AgentRunLifecycle deep-imports finalizeRun from runLifecycle
// (not the `@agent/storage` barrel). Spy only that leaf to avoid re-export
// recursion through a dual mock.
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/runLifecycle')>()),
  finalizeRun: storageMocks.finalizeRun,
}));
vi.mock('@agent/storage', () => ({
  finalizeRun: storageMocks.finalizeRun,
}));

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

beforeEach(() => {
  storageMocks.finalizeRun.mockClear();
  channelTraceMocks.warn.mockClear();
});

async function initLifecycleTestPlatform(firstRunDone: boolean) {
  await installPlatform({
    globalState: {
      [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: firstRunDone,
    },
  });
  return installedHost().roots;
}

let lifecycleFixtureCounter = 0;

function lifecycleFixture(
  agent = 'test-agent',
  category: AgentCategory = AgentCategory.ToolUse,
): {
  runId: RunId;
  ctx: AgentLaunchContext;
} {
  const runId =
    `e${(lifecycleFixtureCounter++).toString(16).padStart(5, '0')}` as RunId;
  return {
    runId,
    ctx: createTestLaunchContext({ runId, agent, category }),
  };
}

/** The launching run a subagent fixture names as its parent edge. */
const PARENT_RUN_ID = 'aa0001' as RunId;

/** What a tool-use run that produced no output ends with on its `run.end`. */
const EMPTY_TOOL_USE_OUTPUT = {
  category: 'toolUse',
  response: '',
  files: [],
} as const;

function toolUseResult(runId: RunId, outcome: RunOutcome): ToolUseFlowResult {
  return { outcome, runId, output: { ...EMPTY_TOOL_USE_OUTPUT, files: [] } };
}

function workflowResult(runId: RunId, outcome: RunOutcome): WorkflowFlowResult {
  return {
    outcome,
    runId,
    output: {
      category: 'workflow',
      outputs: [],
      compileFailures: [],
      diffs: [],
    },
  };
}

function waitingResult(runId: RunId): WaitingToolUseFlowResult {
  return {
    outcome: RUN_PHASE.WAITING,
    runId,
    output: { ...EMPTY_TOOL_USE_OUTPUT, files: [] },
  };
}

/**
 * Returns the suspended handle for a run that reported WAITING.
 *
 * The fake runners below report the WAITING outcome without writing the
 * loop's own `flow.step` park, so the folded phase never reaches WAITING
 * here — which is the point: the handle's own suspension is what makes a
 * stop tear the run down.
 */
function takeWaitingHandle(runId: RunId): RunHandle {
  const handle = testDefaultSession().runs.getHandle(runId);
  expect(handle).toBeInstanceOf(RunHandle);
  if (!(handle instanceof RunHandle)) {
    throw new Error('Expected a suspended agent run handle.');
  }
  return handle;
}

/** Gate the next finalizeRun call on an explicit release. */
const parkNextFinalize = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  storageMocks.finalizeRun.mockImplementationOnce((_session, input) =>
    Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.as<FinalizeRunResult>({ ok: true, outcome: input.outcome }),
    ),
  );
  return { started, release };
});

/** Publish the run and open stage that a suspended teardown must close. */
function seedOpenRunGroup(ctx: AgentLaunchContext, runId: RunId): string {
  const parentStageId = ctx.parentStage.id;
  if (!parentStageId)
    throw new Error('The fixture parent stage must carry an id.');
  const session = ctx.session;
  publishTestRunStart(session, runId);
  session.publishRunEvent(runId, {
    type: 'stage.start',
    id: parentStageId,
    label: 'run',
    kind: 'run',
  });
  return parentStageId;
}

/**
 * The lifecycle program over the fake host's process services. The suite runs
 * it on the default runtime rather than a process runtime, so the services it
 * requires are provided here.
 */
function runFlow(...args: Parameters<typeof runFlowWithLifecycle<never>>) {
  return runFlowWithLifecycle(...args).pipe(
    Effect.provide(fakeProcessServices()),
    Effect.provideService(Runs, args[0].session.runs),
  );
}

describe('runFlowWithLifecycle', () => {
  // The run's category reaches the handle and the terminal `result` through
  // the one descriptor the lifecycle builds, so a workflow run reports
  // `workflow` on both without either side re-deriving the string.

  it.effect(
    'does not stop the Lean servers when a tool-use run parks at WAITING',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        const stopSessionsForRun = vi.fn((_runId: RunId) => Effect.void);

        const result = yield* runFlow(
          ctx,
          () => Effect.succeed(waitingResult(runId)),
          { onRunEnd: stopSessionsForRun },
        );

        // WAITING is a suspension, not a terminal run end: the server must
        // survive the parked run so a resume reuses it instead of paying a cold
        // spawn.
        expect(result.outcome).toBe(RUN_PHASE.WAITING);
        expect(stopSessionsForRun).not.toHaveBeenCalled();
      }),
  );

  // A completed session marks first-run onboarding done, except for the
  // built-in setup agent, which must leave the flag untouched.
  const onboardingCases = [
    {
      label:
        'does not complete first-run onboarding for qualified setup sessions',
      agent: agentKey('builtInToolUse', SETUP_AGENT_NAME),
      expectedDone: false,
    },
    {
      label: 'completes first-run onboarding for non-setup completed sessions',
      agent: 'assistant',
      expectedDone: true,
    },
  ] as const;

  for (const { label, agent, expectedDone } of onboardingCases) {
    it.effect(label, () =>
      Effect.gen(function* () {
        const fake = yield* Effect.promise(() =>
          initLifecycleTestPlatform(false),
        );
        const { runId, ctx } = lifecycleFixture(agent);

        yield* runFlow(ctx, () =>
          Effect.succeed(toolUseResult(runId, RUN_OUTCOME.COMPLETED)),
        );

        expect(
          yield* fake.globalState.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE),
        ).toBe(expectedDone);
      }),
    );
  }

  it.effect('delivers subagent aborts through the terminal callback', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();
      ctx.attachedMemoryMisses.push({
        path: '/memories/missing.md',
        reason: 'not found',
      });
      const onError = vi.fn();

      const result = yield* runFlow(
        ctx,
        () => Effect.fail(new DOMException('Request aborted', 'AbortError')),
        { parentRunId: PARENT_RUN_ID, onError },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(result.memoryMisses).toEqual(ctx.attachedMemoryMisses);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][1]).toEqual(result);
    }),
  );

  it.effect(
    'keeps subagent errors registered until terminal delivery runs',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => testDefaultSession().runs.untrack(runId)),
        );
        const onError = vi.fn(() => {
          expect(testDefaultSession().runs.getHandle(runId)).toBeDefined();
        });

        const result = yield* runFlow(
          ctx,
          () => Effect.fail(new Error('subagent failed')),
          {
            parentRunId: PARENT_RUN_ID,
            onError,
          },
        );

        expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
        expect(onError).toHaveBeenCalledOnce();
        expect(testDefaultSession().runs.getHandle(runId)).toBeUndefined();
      }),
  );

  it.effect(
    'keeps native subagent WAITING results registered and nonterminal',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => testDefaultSession().runs.untrack(runId)),
        );
        const onError = vi.fn();

        const result = yield* runFlow(
          ctx,
          () => Effect.sync(() => waitingResult(runId)),
          {
            parentRunId: PARENT_RUN_ID,
            onError,
          },
        );

        expect(result.outcome).toBe(RUN_PHASE.WAITING);
        expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(testDefaultSession().runs.getHandle(runId)).toBeDefined();
      }),
  );

  it.effect(
    'does not let a stop abandon a run that completes without suspending',
    () =>
      Effect.gen(function* () {
        // The window a stop could once fall into: the run has returned, its live
        // interrupt context is detached, and its own finalize is parked at the
        // persist await with the handle still tracked. Only the WAITING branch
        // parks a handle, so there is no suspension for the stop to find and
        // nothing the exit has to remember to clear.
        const { runId, ctx } = lifecycleFixture();
        const parked = yield* parkNextFinalize;

        try {
          const running = yield* Effect.forkChild(
            runFlow(
              ctx,
              () => Effect.succeed(toolUseResult(runId, RUN_OUTCOME.COMPLETED)),
              { parentRunId: PARENT_RUN_ID },
            ),
          );
          // The run reached its own persist and parked there, which is the
          // window the stop below has to land in.
          yield* Deferred.await(parked.started);
          expect(storageMocks.finalizeRun).toHaveBeenCalledOnce();

          const stop = testDefaultSession().runs.kill(runId);

          expect(stop.accepted()).toBe(false);

          yield* stop.settlement;

          yield* Deferred.succeed(parked.release, undefined);
          const result = yield* Fiber.join(running);
          expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
          expect(testDefaultSession().runs.getHandle(runId)).toBeUndefined();
        } finally {
          testDefaultSession().runs.untrack(runId);
        }
      }),
  );

  it.effect('carries a stop requested by onRun into the run stop', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();

      // A live handle's kill settles to nothing, so the settlement is driven
      // here rather than inside the `onRun` seam.
      let stop: ReturnType<SessionHandle['runs']['kill']> | undefined;
      const result = yield* runFlow(
        ctx,
        (handle) =>
          Effect.sync(() => {
            expect(handle.stopRequested).toBe(true);
            expect(Deferred.isDoneUnsafe(ctx.stopped)).toBe(true);
            return toolUseResult(runId, RUN_OUTCOME.CANCELLED);
          }),
        {
          onRun: () =>
            Effect.sync(() => {
              stop = testDefaultSession().runs.kill(runId);
              expect(stop.accepted()).toBe(true);
            }),
        },
      );
      if (!stop) throw new Error('onRun never ran');
      yield* stop.settlement;

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    }),
  );

  // A stop that beat run start is this run's outcome: the run never runs a
  // turn, and the only fact it leaves is the cancelled terminal row.
  it.effect(
    'writes the cancelled terminal fact when the stop beat run start',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        publishTestRunStart(ctx.session, runId);
        const recorded = recordSessionEvents(ctx.session, {
          aggregateId: qualifyAggregateId('run', runId),
        });

        // A live handle's kill settles to nothing, so the settlement is driven
        // here rather than inside the `onRun` seam.
        let stop: ReturnType<SessionHandle['runs']['kill']> | undefined;
        const result = yield* runFlow(
          ctx,
          () => Effect.fail(new DOMException('Request aborted', 'AbortError')),
          {
            onRun: () =>
              Effect.sync(() => {
                stop = testDefaultSession().runs.kill(runId);
                expect(stop.accepted()).toBe(true);
              }),
          },
        );
        if (!stop) throw new Error('onRun never ran');
        yield* stop.settlement;

        expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
        yield* ctx.session.settlePublications();
        // A run that never ran a turn writes no step of its own: `run.end` is
        // the whole of what it says.
        expect(
          eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'flow.step',
          ),
        ).toEqual([]);
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          testDefaultSession(),
          {
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            error: {
              kind: 'abort',
              message: 'Request aborted',
              userRetryable: false,
            },
            usage: undefined,
            output: EMPTY_TOOL_USE_OUTPUT,
          },
        );
      }),
  );

  // The stop latch owns the outcome: a run a stop reached ends cancelled,
  // even when its own report reached completion first.
  it.effect('relabels a stopped run whose report says completed', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();

      const result = yield* runFlow(ctx, (handle) =>
        Effect.gen(function* () {
          const stop = testDefaultSession().runs.kill(runId);
          expect(stop.accepted()).toBe(true);
          yield* stop.settlement;
          expect(handle.stopRequested).toBe(true);
          return toolUseResult(runId, RUN_OUTCOME.COMPLETED);
        }),
      );

      // The caller receives the same verdict persistence carries: the stop
      // won on the run, so the flow's COMPLETED report is relabeled.
      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledExactlyOnceWith(
        testDefaultSession(),
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
        }),
      );
    }),
  );

  // The parent's delivery is a projection of the same terminal fact as the
  // persisted history, so a stopped child never arrives formatted as a failure.
  it.effect(
    'delivers a stopped subagent as cancelled when its flow reports a failure',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        const onError = vi.fn();

        const result = yield* runFlow(
          ctx,
          () =>
            Effect.gen(function* () {
              const stop = testDefaultSession().runs.kill(runId);
              expect(stop.accepted()).toBe(true);
              yield* stop.settlement;
              return yield* Effect.fail(
                new Error('child exited with code 143'),
              );
            }),
          { parentRunId: PARENT_RUN_ID, onError },
        );

        expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          testDefaultSession(),
          expect.objectContaining({
            outcome: RUN_OUTCOME.CANCELLED,
          }),
        );
        expect(onError).toHaveBeenCalledOnce();
        expect(onError.mock.calls[0][1]).toEqual(result);
      }),
  );

  it.effect(
    'lets a stop/kill tear down a subagent suspended at WAITING (issue #7287)',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        const parentStageId = seedOpenRunGroup(ctx, runId);
        const recorded = recordSessionEvents(ctx.session, {
          aggregateId: qualifyAggregateId('run', runId),
        });
        const followUpsTerminalize = vi.spyOn(
          ctx.session.followUps,
          'terminalize',
        );

        try {
          const result = yield* runFlow(
            ctx,
            () => Effect.succeed(waitingResult(runId)),
            { parentRunId: PARENT_RUN_ID },
          );

          expect(result.outcome).toBe(RUN_PHASE.WAITING);
          expect(testDefaultSession().runs.getHandle(runId)).toBeDefined();
          expect(followUpsTerminalize).not.toHaveBeenCalled();
          expect(storageMocks.finalizeRun).not.toHaveBeenCalled();

          takeWaitingHandle(runId);

          // The tool-use loop's finally detaches this run's interrupt handler but
          // preserves the follow-up queue for WAITING — it does not dispose the
          // session — by the time a native subagent suspends at WAITING (not
          // reproduced by this fake runner, but true in production — see
          // loop/toolUse.ts). With no interrupt target left, `runs.kill()`
          // falls back to the teardown the WAITING branch parked and tears the
          // run down.
          const stop = testDefaultSession().runs.kill(runId);
          expect(stop.accepted()).toBe(true);
          yield* stop.settlement;

          expect(testDefaultSession().runs.getHandle(runId)).toBeUndefined();
          expect(followUpsTerminalize).toHaveBeenCalledWith(runId);
          // The bypassed runFlowWithLifecycle can't write the terminal row, so
          // terminateWaitingHandle must — session subscribers would otherwise
          // miss the stop entirely. The settlement runs that write in this fiber,
          // so the call is a fact as soon as it returns.
          expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
            testDefaultSession(),
            {
              runId,
              outcome: RUN_OUTCOME.CANCELLED,
              output: EMPTY_TOOL_USE_OUTPUT,
            },
          );
          // The detached trace cannot publish this close. The suspended owner
          // must append it to the same session event stream before releasing.
          yield* ctx.session.settlePublications();
          expect(
            eventsOfType(
              yield* Effect.promise(() => recorded.read()),
              'stage.end',
            ),
          ).toContainEqual(
            expect.objectContaining({
              id: parentStageId,
              status: RUN_OUTCOME.CANCELLED,
            }),
          );
        } finally {
          testDefaultSession().runs.untrack(runId);
        }
      }),
  );

  it.effect('runs run-end cleanup when waiting stage publication fails', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();
      const stopSessionsForRun = vi.fn((_runId: RunId) => Effect.void);
      seedOpenRunGroup(ctx, runId);
      yield* ctx.session.settlePublications();
      vi.spyOn(ctx.session, 'commitRunEvent').mockReturnValueOnce(
        Effect.fail(
          new DatabaseWriteFailed({
            path: 'session.db',
            cause: new Error('stage publication failed'),
          }),
        ),
      );

      try {
        const result = yield* runFlow(
          ctx,
          () => Effect.succeed(waitingResult(runId)),
          { onRunEnd: stopSessionsForRun },
        );
        expect(result.outcome).toBe(RUN_PHASE.WAITING);
        takeWaitingHandle(runId);

        const stop = testDefaultSession().runs.kill(runId);

        expect(stop.accepted()).toBe(true);

        yield* stop.settlement;

        expect(stopSessionsForRun).toHaveBeenCalledWith(runId);
        // The stage close and the terminal row are independent durable facts:
        // a lost close must not cost the row a stopped run is read by.
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          testDefaultSession(),
          {
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            output: EMPTY_TOOL_USE_OUTPUT,
          },
        );
      } finally {
        testDefaultSession().runs.untrack(runId);
      }
    }),
  );

  it.effect(
    'projects returned outcomes to the terminal row and stage end',
    () =>
      Effect.gen(function* () {
        const cases = [
          RUN_OUTCOME.COMPLETED,
          RUN_OUTCOME.CANCELLED,
          RUN_OUTCOME.FAILED,
        ] as const;

        for (const outcome of cases) {
          const { runId, ctx } = lifecycleFixture();
          const stageEnd = vi.spyOn(ctx.parentStage, 'end');

          const result = yield* runFlow(ctx, () =>
            Effect.succeed(toolUseResult(runId, outcome)),
          );

          expect(result.outcome).toBe(outcome);
          expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
            testDefaultSession(),
            {
              runId,
              outcome,
              output: EMPTY_TOOL_USE_OUTPUT,
            },
          );
          expect(stageEnd).toHaveBeenCalledWith(outcome);
        }
      }),
  );

  it.effect(
    'finalizes an outcome-only failure without fabricating provider error facts',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => testDefaultSession().runs.untrack(runId)),
        );
        const stageEnd = vi.spyOn(ctx.parentStage, 'end');
        const onError = vi.fn();

        const carriedResult = toolUseResult(runId, RUN_OUTCOME.FAILED);
        const result = yield* runFlow(
          ctx,
          () => Effect.succeed(carriedResult),
          {
            parentRunId: PARENT_RUN_ID,
            onError,
          },
        );

        expect(result).toEqual(carriedResult);
        // `run.end` is not a trace arm: the storage finalizer is its one
        // writer, so the absent error facts are read off that input.
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          testDefaultSession(),
          {
            runId,
            outcome: RUN_OUTCOME.FAILED,
            error: undefined,
            usage: undefined,
            output: carriedResult.output,
          },
        );
        expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
        expect(onError).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'projects a thrown abort as cancelled on its own stage outcome',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        const stageEnd = vi.spyOn(ctx.parentStage, 'end');

        const result = yield* runFlow(ctx, () =>
          Effect.fail(new DOMException('Request aborted', 'AbortError')),
        );

        expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          testDefaultSession(),
          {
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            error: {
              kind: 'abort',
              message: 'Request aborted',
              userRetryable: false,
            },
            usage: undefined,
            output: EMPTY_TOOL_USE_OUTPUT,
          },
        );
        expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.CANCELLED);
      }),
  );

  it.effect('projects an unexpected throw as failed', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();
      const stageEnd = vi.spyOn(ctx.parentStage, 'end');

      const error = yield* Effect.flip(
        runFlow(ctx, () => Effect.fail(new Error('model exploded'))),
      );
      expect(error.message).toContain('model exploded');

      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
        testDefaultSession(),
        {
          runId,
          outcome: RUN_OUTCOME.FAILED,
          error: {
            kind: 'unexpected',
            message: 'Error executing agent test-agent: model exploded',
            userRetryable: true,
          },
          usage: undefined,
          output: EMPTY_TOOL_USE_OUTPUT,
        },
      );
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
    }),
  );

  it.effect(
    'passes flow-carried terminal results to subagent error delivery',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => testDefaultSession().runs.untrack(runId)),
        );
        const carriedResult = {
          outcome: RUN_OUTCOME.FAILED,
          runId,
          output: { category: 'toolUse' as const, response: '', files: [] },
          error: { message: 'subagent failed', userRetryable: false },
        };
        const onError = vi.fn();

        const result = yield* runFlow(
          ctx,
          () => Effect.succeed(carriedResult),
          {
            parentRunId: PARENT_RUN_ID,
            onError,
          },
        );

        expect(result).toEqual(carriedResult);
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'subagent failed' }),
          carriedResult,
        );
      }),
  );

  it.effect(
    'publishes the structured error facts a flow carried out on its result',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        const stageEnd = vi.spyOn(ctx.parentStage, 'end');

        try {
          const error = yield* Effect.flip(
            runFlow(ctx, () =>
              Effect.succeed({
                outcome: RUN_OUTCOME.FAILED,
                runId,
                output: {
                  category: 'toolUse' as const,
                  response: 'partial answer',
                  files: [],
                },
                error: {
                  message: 'provider exploded',
                  userRetryable: true,
                  statusCode: 503,
                },
              }),
            ),
          );
          expect(error.message).toContain('provider exploded');

          // A carried failure is exactly as loud as a thrown one: same terminal
          // status, same stage outcome, same classified error on the `run.end`
          // row the storage finalizer writes.
          expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
            testDefaultSession(),
            expect.objectContaining({
              runId,
              outcome: RUN_OUTCOME.FAILED,
              error: expect.objectContaining({
                kind: 'unexpected',
                statusCode: 503,
                userRetryable: true,
              }),
            }),
          );
          expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
        } finally {
          testDefaultSession().runs.untrack(runId);
        }
      }),
  );

  it.effect(
    'classifies a carried missing-api-key failure through the canonical discriminant',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();

        try {
          const error = yield* Effect.flip(
            runFlow(ctx, () =>
              Effect.succeed({
                outcome: RUN_OUTCOME.FAILED,
                runId,
                output: {
                  category: 'toolUse' as const,
                  response: '',
                  files: [],
                },
                // The retry-state flatten drops the Error and its Symbol marker;
                // the canonical classification keeps the kind reachable here.
                error: {
                  message: 'Missing OpenRouter API key.',
                  userRetryable: false,
                  classification: { kind: 'missing-api-key' as const },
                },
              }),
            ),
          );
          expect(error.message).toContain('Missing OpenRouter API key.');

          expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
            testDefaultSession(),
            expect.objectContaining({
              outcome: RUN_OUTCOME.FAILED,
              error: expect.objectContaining({ kind: 'missing-api-key' }),
            }),
          );
        } finally {
          testDefaultSession().runs.untrack(runId);
        }
      }),
  );
});

/** The session fake, handle, and spies every finalize test drives. */
function finalizeFixture(): {
  runId: RunId;
  session: SessionHandle;
  handle: ReturnType<typeof testRunHandle>;
  untrackIfCurrent: Mock<(handle: RunHandle) => boolean>;
  settlePublications: Mock<(runId?: RunId) => Effect.Effect<void, Error>>;
} {
  const runId =
    `f${(finalizeFixtureCounter++).toString(16).padStart(5, '0')}` as RunId;
  const untrackIfCurrent = vi.fn<(handle: RunHandle) => boolean>(() => true);
  const settlePublications = vi.fn(
    (_runId?: RunId): Effect.Effect<void, Error> => Effect.void,
  );
  return {
    runId,
    session: {
      runs: { untrackIfCurrent },
      settlePublications,
    } as unknown as SessionHandle,
    untrackIfCurrent,
    settlePublications,
    handle: testRunHandle({
      runId,
      parent: PARENT_RUN_ID,
      agent: 'test-agent',
      trace: noopTrace,
    }),
  };
}

let finalizeFixtureCounter = 0;

/** The terminal finalizer on the fixture session's runs. */
function finalize(params: Parameters<typeof finalizeRunTerminal>[0]) {
  return finalizeRunTerminal(params).pipe(
    Effect.provideService(Runs, params.session.runs),
  );
}

describe('finalizeRunTerminal', () => {
  // The exactly-once guard must be an atomic, synchronous claim — not a
  // check-then-await on the settled flag. Two finalizers racing across the
  // persist await (e.g. a lifecycle arm vs a concurrent finalize of the same
  // handle) would otherwise both pass the check before the first settles and
  // double-publish persist/emit/settle/untrack.
  it.effect(
    'finalizes exactly once when two callers race across the persist await',
    () =>
      Effect.gen(function* () {
        const { runId, session, handle, untrackIfCurrent } = finalizeFixture();
        // Park the first caller at its persist await so the second caller arrives
        // while the first has not yet emitted or settled anything.
        const parked = yield* parkNextFinalize;

        const params = {
          session,
          handle,
          outcome: RUN_OUTCOME.COMPLETED,
        } as const;

        const first = yield* Effect.forkChild(finalize(params), {
          startImmediately: true,
        });
        const second = yield* Effect.forkChild(finalize(params), {
          startImmediately: true,
        });

        // The winner reaches the persist first; only then is the loser's early
        // return proof that it never waited on it.
        yield* Deferred.await(parked.started);
        // The loser no-ops without waiting on (or duplicating) the persist.
        expect(yield* Fiber.join(second)).toBeUndefined();
        expect(yield* Deferred.isDone(parked.started)).toBe(true);
        yield* Deferred.succeed(parked.release, undefined);
        const event = yield* Fiber.join(first);

        expect(event).toMatchObject({
          event: {
            type: 'run.end',
            outcome: RUN_OUTCOME.COMPLETED,
            runId,
          },
        });
        // `run.end` is not a trace arm: the storage finalizer is its one
        // writer, so writing it once is what "exactly once" means here.
        expect(storageMocks.finalizeRun).toHaveBeenCalledTimes(1);
        expect(untrackIfCurrent).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect('flushes display artifacts before publishing and untracking', () =>
    Effect.gen(function* () {
      const { session, handle, untrackIfCurrent, settlePublications } =
        finalizeFixture();
      const flushStarted = yield* Deferred.make<void>();
      const releaseFlush = yield* Deferred.make<void>();
      settlePublications.mockImplementation(() =>
        Deferred.succeed(flushStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFlush)),
        ),
      );
      const finalization = yield* Effect.forkChild(
        finalize({
          session,
          handle,
          outcome: RUN_OUTCOME.COMPLETED,
        }),
      );

      yield* Deferred.await(flushStarted);
      expect(settlePublications).toHaveBeenCalledOnce();
      expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
      expect(untrackIfCurrent).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseFlush, undefined);
      yield* Fiber.join(finalization);

      expect(storageMocks.finalizeRun).toHaveBeenCalledOnce();
      expect(untrackIfCurrent).toHaveBeenCalledExactlyOnceWith(handle);
    }),
  );

  it.effect('ends the transcript stage inside the drain that attests it', () =>
    Effect.gen(function* () {
      const { session, handle, settlePublications } = finalizeFixture();
      const stage = { end: vi.fn() };

      yield* finalize({
        session,
        handle,
        outcome: RUN_OUTCOME.COMPLETED,
        stage,
      });

      // `stage.end` queues one more publication, so a row that calls itself the
      // post-drain fact has to be written after a drain that already has it.
      expect(stage.end).toHaveBeenCalledExactlyOnceWith(RUN_OUTCOME.COMPLETED);
      expect(stage.end.mock.invocationCallOrder[0]).toBeLessThan(
        settlePublications.mock.invocationCallOrder[0] ?? 0,
      );
    }),
  );

  it.effect("attests the facts this run queued and no other run's", () =>
    Effect.gen(function* () {
      const { runId, session, handle, settlePublications } = finalizeFixture();

      yield* finalize({ session, handle, outcome: RUN_OUTCOME.COMPLETED });

      // Another run's rolled-back fact is that run's terminal outcome, so the
      // drain this row is the post-drain fact of answers for this run alone.
      expect(settlePublications).toHaveBeenCalledExactlyOnceWith(runId);
    }),
  );

  it.effect('records a failed drain as the terminal outcome', () =>
    Effect.gen(function* () {
      const { runId, session, handle, untrackIfCurrent, settlePublications } =
        finalizeFixture();
      settlePublications.mockReturnValueOnce(
        Effect.fail(new Error('artifact flush failed')),
      );

      const finalization = yield* finalize({
        session,
        handle,
        outcome: RUN_OUTCOME.COMPLETED,
      });

      // The row is the post-drain fact: the facts this run queued rolled back,
      // so no later reader — the workflow attempt probe above all — may read it
      // as durably completed. The `artifact-drain` kind is what carries that to
      // a reader with no access to the in-process drain error: a run whose
      // queued facts are gone is not a run whose model call failed.
      expect(finalization?.event.outcome).toBe(RUN_OUTCOME.FAILED);
      expect(finalization?.event.error?.kind).toBe('artifact-drain');
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          runId,
          outcome: RUN_OUTCOME.FAILED,
          error: expect.objectContaining({
            kind: 'artifact-drain',
            message: expect.stringContaining('did not commit'),
          }),
        }),
      );
      expect(untrackIfCurrent).toHaveBeenCalledExactlyOnceWith(handle);
    }),
  );

  // A plane whose consumer stopped cannot settle at all: that is a lost drain
  // like any other, so the run still ends on an `artifact-drain` row.
  it.effect('records a dead plane as a failed drain', () =>
    Effect.gen(function* () {
      const { session, handle } = finalizeFixture();
      Object.assign(session, {
        graph: {
          settle: Effect.die(
            new Error('Session committed-event consumer stopped'),
          ),
        },
        publications: new Set(),
        settlePublications: SessionHandle.prototype.settlePublications,
      });

      const finalization = yield* finalize({
        session,
        handle,
        outcome: RUN_OUTCOME.COMPLETED,
      });

      expect(finalization?.event.error?.kind).toBe('artifact-drain');
    }),
  );

  it.effect(
    'settles and untracks once while reporting terminal metadata failure',
    () =>
      Effect.gen(function* () {
        const { runId, session, handle, untrackIfCurrent } = finalizeFixture();
        const durabilityError = new Error('metadata disk write failed');
        storageMocks.finalizeRun.mockReturnValueOnce(
          Effect.succeed({
            ok: false,
            outcomePersisted: false,
            error: durabilityError,
          }),
        );

        const event = yield* finalize({
          session,
          handle,
          outcome: RUN_OUTCOME.FAILED,
        });

        expect(event).toMatchObject({
          event: {
            type: 'run.end',
            outcome: RUN_OUTCOME.FAILED,
            runId,
          },
        });
        expect(untrackIfCurrent).toHaveBeenCalledExactlyOnceWith(handle);
        expect(channelTraceMocks.warn).toHaveBeenCalledExactlyOnceWith(
          'Failed to finalize durable run state',
          {
            data: {
              agentIdentifier: 'test-agent',
              runId,
              outcomePersisted: false,
              error: durabilityError,
            },
          },
        );
      }),
  );

  // The handle's stop latch is the single owner of a run's terminal outcome.
  // A stop/kill trips the latch behind the run's back, and the run it killed
  // then reports its own non-zero exit as a failure — so the latch, not the
  // report, has to decide, and no caller may cross-check it for itself.
  it.effect(
    'resolves the terminal outcome from a stop that reached the handle',
    () =>
      Effect.gen(function* () {
        const { runId, session, handle } = finalizeFixture();
        const stage = { end: vi.fn() };

        handle.interrupt();

        const finalized = yield* finalize({
          session,
          handle,
          outcome: RUN_OUTCOME.FAILED,
          error: { kind: 'unexpected', message: 'exited with code 143' },
          stage,
        });

        expect(finalized?.event).toMatchObject({
          type: 'run.end',
          outcome: RUN_OUTCOME.CANCELLED,
          runId,
        });
        // Error facts classified for a failure that the stop says never
        // happened must not ride the cancelled result.
        expect(finalized?.event.error).toBeUndefined();
        expect(stage.end).toHaveBeenCalledExactlyOnceWith(
          RUN_OUTCOME.CANCELLED,
        );
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          session,
          expect.objectContaining({
            outcome: RUN_OUTCOME.CANCELLED,
          }),
        );
        expect(channelTraceMocks.warn).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'keeps the drain marker on the row a stop resolved as cancelled',
    () =>
      Effect.gen(function* () {
        const { runId, session, handle, settlePublications } =
          finalizeFixture();
        settlePublications.mockReturnValueOnce(
          Effect.fail(new Error('artifact flush failed')),
        );

        handle.interrupt();

        const finalized = yield* finalize({
          session,
          handle,
          outcome: RUN_OUTCOME.COMPLETED,
        });

        // The stop still owns the outcome, but a lost drain is not a fact about
        // how the run ended: the queued facts are gone either way, so the marker
        // rides the cancelled row and keeps the attempt non-repeatable for the
        // in-band caller and the workflow attempt probe alike.
        expect(finalized?.event.outcome).toBe(RUN_OUTCOME.CANCELLED);
        expect(finalized?.event.error?.kind).toBe('artifact-drain');
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          session,
          expect.objectContaining({
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            error: expect.objectContaining({ kind: 'artifact-drain' }),
          }),
        );
      }),
  );
});
