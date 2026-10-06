// Test composition imports

// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { getRunRecords, registerRun } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type {
  ChildRunPort,
  ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import { Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { seedReport } from '@test/support/runRecordSeeds';
import { launchAgentCliSession } from '@texra/tools/agentCliShared';
import { createChildRun } from '@tools/delegation/childRun';

// Local file imports
import {
  createRecordingHost,
  eventsOfType,
  recordSessionEvents,
} from '../progressTestUtils';

const runId = 'c11111' as RunId;
const parentRunId = 'c11112' as RunId;
const stoppedRunId = 'c11114' as RunId;
const failedRunId = 'c11116' as RunId;
const unformattableRunId = 'c11117' as RunId;
const workflowRelaunchRunId = 'c11119' as RunId;
const config = AgentConfigSchema.parse({
  model: 'test-model',
  agent: 'test-agent',
});

const createRegisteredChildRun = Effect.fn('createRegisteredChildRun')(
  function* (
    session: SessionHandle,
    runId: RunId,
    parentRunId: RunId,
    options: Parameters<typeof createChildRun>[3] & {
      readonly config: typeof config;
      readonly userFollowUpSupport: UserFollowUpSupport;
      readonly description: string;
    },
  ) {
    yield* registerRun(session, runId, options.config, {
      identity: options.run,
      userFollowUpSupport: options.userFollowUpSupport,
      parentRunId,
      description: options.description,
    });
    const child = yield* createChildRun(session, runId, parentRunId, {
      run: options.run,
    }).pipe(Effect.provideService(Runs, session.runs));
    // What the child loop does once its stop target is reserved.
    child.track();
    return {
      ...child,
      finalize: (
        input: Parameters<ChildRunPort['finalize']>[0],
      ): Effect.Effect<void, Error> =>
        child.finalize(input).pipe(Effect.provideService(Runs, session.runs)),
    };
  },
);

function startBashChild(runId: RunId) {
  return Effect.runPromise(
    createRegisteredChildRun(testDefaultSession(), runId, parentRunId, {
      run: { kind: 'process', tool: 'bash' },
      userFollowUpSupport: 'unsupported',
      description: 'Run a background bash command',
      config,
    }),
  );
}

/** A launch strategy for the cancelled-admission test: the loop never starts,
 *  so none of these run. */
const neverRunStrategy: ChildRunStrategy<void> = {
  stageLabel: 'unreachable',
  launch: () => Effect.void,
  isTerminal: () => true,
  formatDelivery: () => Effect.succeed('unreachable'),
  formatError: () => 'unreachable',
};

function startCodexChild(runId: RunId, description: string) {
  return Effect.runPromise(
    createRegisteredChildRun(testDefaultSession(), runId, parentRunId, {
      run: { kind: 'agent', agent: 'codex', tool: 'codex' },
      userFollowUpSupport: 'terminalBacked',
      description,
      config,
    }),
  );
}

describe('child run progress events', () => {
  beforeEach(async () => {
    const session = await Effect.runPromise(createProcessSession());
    publishTestRunStart(session, parentRunId);
    await Effect.runPromise(session.settled);
  });

  it.effect(
    'publishes child run lifecycle events through the session hub',
    () =>
      Effect.gen(function* () {
        const recorded = recordSessionEvents(testDefaultSession());

        const childRun = yield* Effect.promise(() => startBashChild(runId));

        yield* childRun.finalize({
          outcome: RUN_OUTCOME.COMPLETED,
        });

        expect(
          eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'run.start',
          ),
        ).toContainEqual(
          expect.objectContaining({
            aggregateId: qualifyAggregateId('run', runId),
            identity: { kind: 'process', tool: 'bash' },
            // The whole parent edge, stamped on the birth fact.
            parent: expect.objectContaining({ id: parentRunId }),
          }),
        );
        // The activation beside the existence fact.
        expect(
          eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'run.activate',
          ),
        ).toMatchObject([
          {
            type: 'run.activate',
            aggregateId: qualifyAggregateId('run', runId),
          },
        ]);
        expect(
          eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'run.config',
          ),
        ).toContainEqual(
          expect.objectContaining({
            aggregateId: qualifyAggregateId('run', runId),
          }),
        );
        expect(
          eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'run.description',
          ),
        ).toContainEqual(
          expect.objectContaining({
            aggregateId: qualifyAggregateId('run', runId),
            description: 'Run a background bash command',
          }),
        );
        // The terminal phase is `run.end`'s alone.
        expect(
          eventsOfType(yield* Effect.promise(() => recorded.read()), 'run.end'),
        ).toEqual([
          expect.objectContaining({
            aggregateId: qualifyAggregateId('run', runId),
            outcome: RUN_OUTCOME.COMPLETED,
          }),
        ]);
        expect(
          eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'run.removed',
          ),
        ).toEqual([]);
      }),
  );

  it.effect('marks a deterministic child-run relaunch as running', () =>
    Effect.gen(function* () {
      const firstRun = yield* createRegisteredChildRun(
        testDefaultSession(),
        workflowRelaunchRunId,
        parentRunId,
        {
          run: { kind: 'script', title: 'draft-sections' },
          userFollowUpSupport: 'unsupported',
          description: 'Run a named child task',
          config,
        },
      );
      yield* firstRun.finalize({ outcome: RUN_OUTCOME.COMPLETED });
      expect(testDefaultSession().runView(workflowRelaunchRunId)?.status).toBe(
        RUN_PHASE.COMPLETED,
      );

      const recorded = recordSessionEvents(testDefaultSession());
      const relaunched = yield* createRegisteredChildRun(
        testDefaultSession(),
        workflowRelaunchRunId,
        parentRunId,
        {
          run: { kind: 'script', title: 'draft-sections' },
          userFollowUpSupport: 'unsupported',
          description: 'Resume the named child task',
          config,
        },
      );
      yield* Effect.addFinalizer(() =>
        relaunched
          .finalize({ outcome: RUN_OUTCOME.COMPLETED })
          .pipe(Effect.orDie),
      );

      expect(testDefaultSession().runView(workflowRelaunchRunId)?.status).toBe(
        RUN_PHASE.RUNNING,
      );
      expect(testDefaultSession().runs.hasActiveChildren(parentRunId)).toBe(
        true,
      );
      // The relaunch is a second activation on the same run: that row is
      // what carries the run out of its terminal phase.
      expect(
        eventsOfType(
          yield* Effect.promise(() => recorded.read()),
          'run.activate',
        ),
      ).toEqual([
        expect.objectContaining({
          aggregateId: qualifyAggregateId('run', workflowRelaunchRunId),
        }),
      ]);
    }),
  );

  it.effect('emits script identity independently of its worker config', () =>
    Effect.gen(function* () {
      const recorded = recordSessionEvents(testDefaultSession());
      const workerConfig = {
        ...config,
        agent: 'generic',
      };

      const childRun = yield* createRegisteredChildRun(
        testDefaultSession(),
        workflowRelaunchRunId,
        parentRunId,
        {
          run: {
            kind: 'script',
            title: 'repo-cleanup-readonly-pilot-2026-07-24',
          },
          userFollowUpSupport: 'unsupported',
          description: 'Audit the repository without editing',
          config: workerConfig,
        },
      );

      expect(
        eventsOfType(yield* Effect.promise(() => recorded.read()), 'run.start'),
      ).toContainEqual(
        expect.objectContaining({
          identity: {
            kind: 'script',
            title: 'repo-cleanup-readonly-pilot-2026-07-24',
          },
        }),
      );
      expect(
        testDefaultSession().runs.getHandle(workflowRelaunchRunId),
      ).toMatchObject({
        agentName: 'repo-cleanup-readonly-pilot-2026-07-24',
      });

      yield* childRun.finalize({ outcome: RUN_OUTCOME.COMPLETED });
    }),
  );

  it.effect(
    'publishes child run existence as a run fact without direct host emission',
    () =>
      Effect.gen(function* () {
        const active = createRecordingHost();
        const recorded = recordSessionEvents(testDefaultSession());

        const childRun = yield* Effect.promise(() => startBashChild(runId));

        expect(active.events).toEqual([]);
        expect(
          eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'run.start',
          ),
        ).toEqual([
          expect.objectContaining({
            type: 'run.start',
            aggregateId: qualifyAggregateId('run', runId),
            parent: expect.objectContaining({ id: parentRunId }),
            provenance: null,
          }),
        ]);

        yield* childRun.finalize({ outcome: RUN_OUTCOME.COMPLETED });
      }),
  );

  it.effect(
    'cancels committed admission before launching detached work and releases both claims',
    () =>
      Effect.gen(function* () {
        const session = testDefaultSession();
        const committed = yield* Deferred.make<RunId>();
        const releasePublication = yield* Deferred.make<void>();
        const commit = session.commitRegistration.bind(session);
        const publication = vi
          .spyOn(session, 'commitRegistration')
          .mockImplementationOnce((events) =>
            commit(events).pipe(
              Effect.tap((rows) => {
                const start = rows.find((row) => row.type === 'run.start');
                if (!start) throw new Error('expected a committed child birth');
                // The run is its own aggregate: the birth fact carries no
                // second copy of the id.
                const target = aggregateTarget(start.aggregateId);
                if (target.kind !== 'run') {
                  throw new Error('expected a run aggregate for run.start');
                }
                return Deferred.succeed(committed, target.id);
              }),
              Effect.tap(() => Deferred.await(releasePublication)),
            ),
          );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => publication.mockRestore()),
        );
        const buildLaunch = vi.fn(() =>
          Effect.succeed({ strategy: neverRunStrategy }),
        );
        const launching = yield* Effect.forkChild(
          launchAgentCliSession({
            session,
            parentRunId,
            agentName: 'codex',
            description: 'Cancelled admission',
            config,
            registerFailedMessage: 'registration failed',
            buildLaunch,
            summary: 'unreachable',
            launchedLine: 'unreachable',
            followUpLine: 'unreachable',
          }).pipe(Effect.provideService(Runs, session.runs)),
        );
        const id = yield* Deferred.await(committed);
        const interrupting = yield* Effect.forkChild(
          Fiber.interrupt(launching),
          {
            startImmediately: true,
          },
        );
        yield* Deferred.succeed(releasePublication, undefined);
        yield* Fiber.join(interrupting);
        const stopped = yield* Fiber.await(launching);
        expect(
          Exit.isFailure(stopped) && Cause.hasInterrupts(stopped.cause),
        ).toBe(true);
        expect(buildLaunch).not.toHaveBeenCalled();
        expect((yield* getRunRecords(session, id).readRunEnd())?.outcome).toBe(
          RUN_OUTCOME.CANCELLED,
        );
        expect(yield* session.ownsRun(id)).toBe(false);
        expect(
          Exit.isFailure(
            yield* Effect.exit(seedReport(session, id, 'unowned')),
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    'finalizes a child run when agent CLI loop setup fails synchronously',
    () =>
      Effect.gen(function* () {
        const setupError = new Error('child loop setup failed');
        const session = testDefaultSession();
        let childRun: ChildRunPort | undefined;
        let childRunId: RunId | undefined;
        let visibleBeforeLoop = true;

        // The launch dies with the loop's throw, so flip the defect back
        // into the error channel.
        const defect = yield* Effect.flip(
          launchAgentCliSession({
            session: testDefaultSession(),
            parentRunId,
            agentName: 'codex',
            description: 'Fail during synchronous loop setup',
            config,
            registerFailedMessage: 'registration failed',
            buildLaunch: (context) => {
              childRun = context.childRun;
              childRunId = context.runId;
              // Before the loop reserves its stop target, no stop can find
              // the handle: a stop never reaches a run it cannot interrupt.
              visibleBeforeLoop =
                session.runs.getHandle(context.runId) !== undefined;
              throw setupError;
            },
            summary: 'unreachable',
            launchedLine: 'unreachable',
            followUpLine: 'unreachable',
          }).pipe(
            Effect.provideService(Runs, session.runs),
            Effect.catchDefect((cause) => Effect.fail(cause)),
          ),
        );
        expect(defect).toBe(setupError);
        expect(visibleBeforeLoop).toBe(false);

        expect(childRun).toBeDefined();
        expect(childRunId).toBeDefined();
        if (!childRun || !childRunId) {
          throw new Error('expected the failed child launch to be captured');
        }
        expect(session.runs.getHandle(childRunId)).toBeUndefined();
        expect(session.runView(childRunId)?.status).toBe(RUN_PHASE.FAILED);
        expect(
          yield* getRunRecords(session, childRunId).readRunEnd(),
        ).toMatchObject({ outcome: 'failed' });
      }),
  );

  // A stopped child ends cancelled: the loop observes its own stop (its
  // signal, or the run fiber's interruption for a native child) and derives
  // the verdict BEFORE this port is called, so a stop outranks the failure
  // the child's process reported first. That precedence race is covered in
  // ChildRunLoop.vitest ('lets a stop landing after a turn failure win the
  // terminal outcome'); what lands here is the loop's derived verdict,
  // through the hub.
  it.effect(
    'settles a stopped child loop as cancelled from the stop that landed',
    () =>
      Effect.gen(function* () {
        const childRun = yield* Effect.promise(() =>
          startCodexChild(stoppedRunId, 'Run a stopped Codex child loop'),
        );
        expect(testDefaultSession().runs.getHandle(stoppedRunId)).toBeDefined();

        yield* childRun.finalize({ outcome: RUN_OUTCOME.CANCELLED });

        expect(testDefaultSession().runView(stoppedRunId)?.status).toBe(
          RUN_PHASE.CANCELLED,
        );
        expect(
          yield* getRunRecords(testDefaultSession(), stoppedRunId).readRunEnd(),
        ).toMatchObject({ outcome: 'cancelled' });
      }),
  );

  it.effect('settles failed child handle results with error details', () =>
    Effect.gen(function* () {
      const childRun = yield* Effect.promise(() =>
        startCodexChild(failedRunId, 'Run a failing Codex child loop'),
      );
      expect(testDefaultSession().runs.getHandle(failedRunId)).toBeDefined();

      yield* childRun.finalize({
        outcome: RUN_OUTCOME.FAILED,
        error: new Error('child process exited 1'),
      });

      expect(testDefaultSession().runView(failedRunId)?.status).toBe(
        RUN_PHASE.FAILED,
      );
      expect(
        yield* getRunRecords(testDefaultSession(), failedRunId).readRunEnd(),
      ).toMatchObject({
        outcome: 'failed',
        error: {
          kind: 'unexpected',
          message: 'child process exited 1',
        },
      });
    }),
  );

  // `error` is `unknown`: a value with no primitive conversion throws when
  // formatted, and the child must still settle with its `run.end` row.
  it.effect('settles a failed child whose error cannot be formatted', () =>
    Effect.gen(function* () {
      const childRun = yield* Effect.promise(() =>
        startCodexChild(unformattableRunId, 'Run an unformattable failure'),
      );

      yield* childRun.finalize({
        outcome: RUN_OUTCOME.FAILED,
        error: Object.create(null),
      });

      expect(
        testDefaultSession().runs.getHandle(unformattableRunId),
      ).toBeUndefined();
      expect(
        yield* getRunRecords(
          testDefaultSession(),
          unformattableRunId,
        ).readRunEnd(),
      ).toMatchObject({
        outcome: 'failed',
        error: { message: 'Child run finalize prologue failed' },
      });
    }),
  );
});
