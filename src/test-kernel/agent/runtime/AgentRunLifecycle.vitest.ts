import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';

import { afterEach, describe, expect, vi } from 'vitest';

import { Runs } from '@agent/runtime/runRegistry';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  finalizeRunTerminal,
  runWithLifecycle,
} from '@agent/runtime/AgentRunLifecycle';
import { type RunEndResult } from '@agent/runtime/RunEndResult';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { attachProviderError } from '@common/errors/sdkError/errorMetadata';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  agentKey,
} from '@shared/schemas';
import type { RunId, RunOutcome } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { untrackRun } from '@test/support/sessionEnd';
import { noopTrace } from '@test/support/noopTrace';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  fakeProcessServices,
  installPlatform,
  installedHost,
} from '@test/support/setupPlatform';

import { eventsOfType, recordSessionEvents } from '../progressTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

/** The run's committed `run.end` rows, once the session's writes settled:
 *  what the lifecycle's one terminal writer (`finalizeRun`) said. */
const runEnds = (session: SessionHandle, runId: RunId) =>
  Effect.andThen(
    session.log.settled,
    session.log.rows(qualifyAggregateId('run', runId), ['run.end']),
  );

afterEach(() => {
  setLogSink(null);
  vi.restoreAllMocks();
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

function lifecycleFixture(agent = 'test-agent'): {
  runId: RunId;
  ctx: AgentLaunchContext;
} {
  const runId =
    `e${(lifecycleFixtureCounter++).toString(16).padStart(5, '0')}` as RunId;
  const ctx = createTestLaunchContext({ runId, agent });
  // A run is registered before its lifecycle runs: an activation commits
  // onto the run's rows.
  publishTestRunStart(ctx.session, runId);
  return { runId, ctx };
}

/** The launching run a subagent fixture names as its parent edge. */
const PARENT_RUN_ID = 'aa0001' as RunId;

/** What a tool-use run that produced no output ends with on its `run.end`. */
const EMPTY_TOOL_USE_OUTPUT = {
  response: '',
  files: [],
} as const;

function toolUseResult(runId: RunId, outcome: RunOutcome): RunEndResult {
  return { outcome, runId, output: { ...EMPTY_TOOL_USE_OUTPUT, files: [] } };
}

/**
 * Park the run's terminal before its `run.end` write: its stage end, the
 * terminal's first step, enqueues a job that holds the session's publisher
 * until `release`, so the end's transaction queues behind it. `started`
 * resolves once that job holds the publisher.
 */
const parkTerminal = (ctx: AgentLaunchContext) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const endStage = ctx.parentStage.end.bind(ctx.parentStage);
    vi.spyOn(ctx.parentStage, 'end').mockImplementationOnce((outcome) => {
      Effect.runFork(
        ctx.session.log.transact(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        ),
      );
      endStage(outcome);
    });
    return { started, release };
  });

/**
 * The lifecycle program over the fake host's process services. The suite runs
 * it on the default runtime rather than a process runtime, so the services it
 * requires are provided here.
 */
function runLifecycle(...args: Parameters<typeof runWithLifecycle<never>>) {
  return runWithLifecycle(...args).pipe(
    Effect.provide(fakeProcessServices()),
    Effect.provideService(Runs, args[0].session.runs),
  );
}

describe('runWithLifecycle', () => {
  // A completed session marks first-run onboarding done, except for the
  // built-in setup agent, which must leave the flag untouched.
  const onboardingCases = [
    {
      label:
        'does not complete first-run onboarding for qualified setup sessions',
      agent: agentKey('builtIn', SETUP_AGENT_NAME),
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

        yield* runLifecycle(ctx, () =>
          Effect.succeed(toolUseResult(runId, RUN_OUTCOME.COMPLETED)),
        );

        expect(
          yield* fake.globalState.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE),
        ).toBe(expectedDone);
      }),
    );
  }

  it.effect('carries a subagent abort on its terminal result', () =>
    Effect.gen(function* () {
      const { ctx } = lifecycleFixture();
      ctx.attachedMemoryMisses.push({
        path: '/memories/missing.md',
        reason: 'not found',
      });

      const result = yield* runLifecycle(
        ctx,
        () => Effect.fail(new DOMException('Request aborted', 'AbortError')),
        { parentRunId: PARENT_RUN_ID },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(result.memoryMisses).toEqual(ctx.attachedMemoryMisses);
      expect(result.error).toMatchObject({
        message: expect.stringContaining('aborted'),
      });
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
        const parked = yield* parkTerminal(ctx);

        try {
          const running = yield* Effect.forkChild(
            runLifecycle(
              ctx,
              () => Effect.succeed(toolUseResult(runId, RUN_OUTCOME.COMPLETED)),
              { parentRunId: PARENT_RUN_ID },
            ),
          );
          // The run reached its own terminal and parked before its persist,
          // which is the window the stop below has to land in.
          yield* Deferred.await(parked.started);

          const stop = testDefaultSession().runs.stop(runId, {
            reason: 'user',
          });

          expect(stop.accepted()).toBe(false);

          yield* stop.settlement;

          yield* Deferred.succeed(parked.release, undefined);
          const result = yield* Fiber.join(running);
          expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
          expect(yield* runEnds(ctx.session, runId)).toMatchObject([
            { outcome: RUN_OUTCOME.COMPLETED },
          ]);
          expect(testDefaultSession().runs.getHandle(runId)).toBeUndefined();
        } finally {
          untrackRun(testDefaultSession().runs, runId);
        }
      }),
  );

  it.effect('interrupts a run whose stop landed before its first turn', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();

      // The run's stop is its fiber's interruption: the flow runs on the
      // registry's lane, so an interrupt by run id finds that fiber wherever
      // the run has got to — here, parked before its first turn — and the
      // run's only fact is the cancelled terminal row.
      const runnerParked = yield* Deferred.make<void>();
      const flow = runLifecycle(ctx, () =>
        Deferred.succeed(runnerParked, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
      );
      const run = yield* Effect.forkChild(
        ctx.session.runs.launchRun(runId, flow),
        { startImmediately: true },
      );
      yield* Deferred.await(runnerParked);

      expect(testDefaultSession().runs.interrupt(runId)).toBe(true);
      const exit = yield* Fiber.await(run);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
        true,
      );
      expect(yield* runEnds(ctx.session, runId)).toMatchObject([
        { outcome: RUN_OUTCOME.CANCELLED },
      ]);
    }),
  );

  // A run that aborts before its first turn is this run's outcome: the run
  // never runs a turn, and the only fact it leaves is the cancelled terminal
  // row with the abort's own error facts on it.
  it.effect(
    'writes the cancelled terminal fact when the run aborts before its first turn',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        const recorded = recordSessionEvents(ctx.session, {
          aggregateId: qualifyAggregateId('run', runId),
        });

        const result = yield* runLifecycle(ctx, () =>
          Effect.fail(new DOMException('Request aborted', 'AbortError')),
        );

        expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
        yield* ctx.session.log.settled;
        // A run that never ran a turn writes no step of its own: `run.end` is
        // the whole of what it says.
        expect(
          eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'run.position',
          ),
        ).toEqual([]);
        expect(yield* runEnds(ctx.session, runId)).toMatchObject([
          {
            outcome: RUN_OUTCOME.CANCELLED,
            error: {
              kind: 'abort',
              message: 'Request aborted',
              userRetryable: false,
            },
            output: EMPTY_TOOL_USE_OUTPUT,
          },
        ]);
      }),
  );

  // The parent's delivery is a projection of the same terminal fact as the
  // persisted history, so a delivery never contradicts the row. (A stop's
  // relabel — a failure report the stop says never happened — is now the
  // fiber interruption's verdict, asserted on the finalizer's `stopped` arm
  // below; the latch that carried it mid-report is gone.)

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

          const result = yield* runLifecycle(ctx, () =>
            Effect.succeed(toolUseResult(runId, outcome)),
          );

          expect(result.outcome).toBe(outcome);
          const [end, ...more] = yield* runEnds(ctx.session, runId);
          expect(more).toEqual([]);
          expect(end).toMatchObject({ outcome, output: EMPTY_TOOL_USE_OUTPUT });
          expect(end).not.toHaveProperty('error');
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
          Effect.sync(() => untrackRun(testDefaultSession().runs, runId)),
        );
        const stageEnd = vi.spyOn(ctx.parentStage, 'end');

        const carriedResult = toolUseResult(runId, RUN_OUTCOME.FAILED);
        const result = yield* runLifecycle(
          ctx,
          () => Effect.succeed(carriedResult),
          { parentRunId: PARENT_RUN_ID },
        );

        expect(result).toEqual(carriedResult);
        // `run.end` is not a trace arm: the storage finalizer is its one
        // writer, so the absent error facts are read off that input.
        const [end, ...more] = yield* runEnds(ctx.session, runId);
        expect(more).toEqual([]);
        expect(end).toMatchObject({
          outcome: RUN_OUTCOME.FAILED,
          output: carriedResult.output,
        });
        expect(end).not.toHaveProperty('error');
        expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
      }),
  );

  it.effect(
    'projects a thrown abort as cancelled on its own stage outcome',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        const stageEnd = vi.spyOn(ctx.parentStage, 'end');

        const result = yield* runLifecycle(ctx, () =>
          Effect.fail(new DOMException('Request aborted', 'AbortError')),
        );

        expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
        expect(yield* runEnds(ctx.session, runId)).toMatchObject([
          {
            outcome: RUN_OUTCOME.CANCELLED,
            error: {
              kind: 'abort',
              message: 'Request aborted',
              userRetryable: false,
            },
            output: EMPTY_TOOL_USE_OUTPUT,
          },
        ]);
        expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.CANCELLED);
      }),
  );

  it.effect('projects an unexpected throw as failed', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();
      const stageEnd = vi.spyOn(ctx.parentStage, 'end');

      const error = yield* Effect.flip(
        runLifecycle(ctx, () => Effect.fail(new Error('model exploded'))),
      );
      expect(error.message).toContain('model exploded');

      expect(yield* runEnds(ctx.session, runId)).toMatchObject([
        {
          outcome: RUN_OUTCOME.FAILED,
          error: {
            kind: 'unexpected',
            message: 'Error executing agent test-agent: model exploded',
            userRetryable: true,
          },
          output: EMPTY_TOOL_USE_OUTPUT,
        },
      ]);
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
    }),
  );

  // The failure prologue is fallible (here: caching recovered provider
  // metadata onto a frozen wrapper throws); it must still reach the terminal.
  it.effect('finalizes a failure whose classification threw', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();
      const cause = new Error('overloaded');
      attachProviderError(cause, {
        message: 'overloaded',
        userRetryable: true,
      });
      const frozen = Object.freeze(new Error('flow failed', { cause }));

      const error = yield* Effect.flip(
        runLifecycle(ctx, () => Effect.fail(frozen)),
      );
      expect(error.message).toContain('flow failed');
      expect(yield* runEnds(ctx.session, runId)).toMatchObject([
        {
          outcome: RUN_OUTCOME.FAILED,
          error: {
            kind: 'unexpected',
            message: 'Error executing agent test-agent: flow failed',
          },
        },
      ]);
    }),
  );

  // A runner that interrupts itself (a prompt closed under it) is a stop:
  // squashed, the cause read "All fibers interrupted without error" and the
  // run ended FAILED over the loop's own cancelled halt.
  it.effect('finalizes a self-interrupted runner as cancelled', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();

      const exit = yield* Effect.exit(
        runLifecycle(ctx, () => Effect.interrupt),
      );

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
        true,
      );
      expect(yield* runEnds(ctx.session, runId)).toMatchObject([
        { outcome: RUN_OUTCOME.CANCELLED },
      ]);
    }),
  );

  // A stop whose unwinding also fails (a finalizer that dies) is still a
  // stop: the row says cancelled and carries the failure as its detail.
  it.effect('finalizes a stop whose finalizer died as cancelled', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();
      const runner = () =>
        Effect.scoped(
          Effect.acquireRelease(Effect.void, () =>
            Effect.die(new Error('finalizer died')),
          ).pipe(Effect.andThen(Effect.interrupt)),
        );

      yield* Effect.exit(runLifecycle(ctx, runner));

      expect(yield* runEnds(ctx.session, runId)).toMatchObject([
        {
          outcome: RUN_OUTCOME.CANCELLED,
          error: { message: expect.stringContaining('finalizer died') },
        },
      ]);
    }),
  );

  it.effect('returns a flow-carried subagent failure with its error', () =>
    Effect.gen(function* () {
      const { runId, ctx } = lifecycleFixture();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => untrackRun(testDefaultSession().runs, runId)),
      );
      const carriedResult = {
        outcome: RUN_OUTCOME.FAILED,
        runId,
        output: { response: '', files: [] },
        error: { message: 'subagent failed', userRetryable: false },
      };

      const result = yield* runLifecycle(
        ctx,
        () => Effect.succeed(carriedResult),
        {
          parentRunId: PARENT_RUN_ID,
        },
      );

      expect(result).toEqual(carriedResult);
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
            runLifecycle(ctx, () =>
              Effect.succeed({
                outcome: RUN_OUTCOME.FAILED,
                runId,
                output: {
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
          expect(yield* runEnds(ctx.session, runId)).toMatchObject([
            {
              outcome: RUN_OUTCOME.FAILED,
              error: {
                kind: 'unexpected',
                statusCode: 503,
                userRetryable: true,
              },
            },
          ]);
          expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
        } finally {
          untrackRun(testDefaultSession().runs, runId);
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
            runLifecycle(ctx, () =>
              Effect.succeed({
                outcome: RUN_OUTCOME.FAILED,
                runId,
                output: {
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

          expect(yield* runEnds(ctx.session, runId)).toMatchObject([
            {
              outcome: RUN_OUTCOME.FAILED,
              error: { kind: 'missing-api-key' },
            },
          ]);
        } finally {
          untrackRun(testDefaultSession().runs, runId);
        }
      }),
  );
});

/** A registered run on the default session and its handle. */
function finalizeFixture(): {
  runId: RunId;
  session: SessionHandle;
  handle: ReturnType<typeof testRunHandle>;
} {
  const runId =
    `f${(finalizeFixtureCounter++).toString(16).padStart(5, '0')}` as RunId;
  const session = testDefaultSession();
  publishTestRunStart(session, runId);
  return {
    runId,
    session,
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
  // The stop's verdict is the single owner of a run's terminal outcome: the
  // finalizer's `stopped` arm, set by the fiber interruption's exit protocol
  // or the child loop's own stop, outranks the run's report — the run it
  // killed reports its own non-zero exit as a failure, and no caller
  // cross-checks the verdict for itself.
  it.effect(
    'resolves the terminal outcome from a stop that reached the finalizer',
    () =>
      Effect.gen(function* () {
        const logs = captureLogEntries();
        const { runId, session, handle } = finalizeFixture();
        const stage = { end: vi.fn() };

        const finalized = yield* finalize({
          session,
          handle,
          outcome: RUN_OUTCOME.FAILED,
          error: { kind: 'unexpected', message: 'exited with code 143' },
          stage,
          stopped: true,
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
        const [end, ...more] = yield* runEnds(session, runId);
        expect(more).toEqual([]);
        expect(end).toMatchObject({ outcome: RUN_OUTCOME.CANCELLED });
        expect(end).not.toHaveProperty('error');
        expect(logs.at('WARN')).toEqual([]);
      }).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
  );
});
