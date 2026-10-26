// Test composition imports

// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';
import { Runs } from '@agent/runtime/runRegistry';

// Local imports
import { getRunRecords } from '@agent/storage/runRecords';
import type { ProcessChildStrategy } from '@agent/runtime/childRunLoop';
import {
  AgentConfigSchema,
  aggregateTarget,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { seedReport } from '@test/support/runRecordSeeds';
import { launchProcessChild } from '@tools/delegation/detachedChildRun';

const parentRunId = 'c11112' as RunId;
const config = Schema.decodeUnknownSync(AgentConfigSchema)({
  model: 'test-model',
  agent: 'test-agent',
});

/** A launch strategy for the cancelled-admission test: the loop never starts,
 *  so none of these run. */
const neverRunStrategy: ProcessChildStrategy<void> = {
  stageLabel: 'unreachable',
  launch: () => Effect.void,
  formatDelivery: () => Effect.succeed('unreachable'),
  formatError: () => 'unreachable',
};

describe('child run progress events', () => {
  beforeEach(async () => {
    const session = await Effect.runPromise(createProcessSession());
    publishTestRunStart(session, parentRunId);
    await Effect.runPromise(session.log.settled);
  });

  it.effect(
    'cancels committed admission before launching detached work and releases both claims',
    () =>
      Effect.gen(function* () {
        const session = testDefaultSession();
        const committed = yield* Deferred.make<RunId>();
        const releasePublication = yield* Deferred.make<void>();
        // The registration's transaction is the one whose rows hold the
        // child's `run.start`: it commits, then waits for the release.
        const transact = session.log.transact.bind(session.log) as (
          work: unknown,
        ) => Effect.Effect<unknown, unknown>;
        const publication = vi
          .spyOn(session.log, 'transact')
          .mockImplementation(((work: unknown) =>
            transact(work).pipe(
              Effect.tap((value) => {
                const start = Array.isArray(value)
                  ? (value as readonly SessionEvent[]).find(
                      (row) => row.type === 'run.start',
                    )
                  : undefined;
                if (start === undefined) return Effect.void;
                // The run is its own aggregate: the birth fact carries no
                // second copy of the id.
                const target = aggregateTarget(start.aggregateId);
                if (target.kind !== 'run') {
                  throw new Error('expected a run aggregate for run.start');
                }
                return Deferred.succeed(committed, target.id).pipe(
                  Effect.andThen(Deferred.await(releasePublication)),
                );
              }),
            )) as unknown as typeof session.log.transact);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => publication.mockRestore()),
        );
        const buildLaunch = vi.fn(() => Effect.succeed(neverRunStrategy));
        const launching = yield* Effect.forkChild(
          launchProcessChild(session, parentRunId, {
            identity: { kind: 'agent', agent: 'codex', tool: 'codex' },
            description: 'Cancelled admission',
            config,
            buildLaunch,
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
        expect(yield* session.log.owns(id)).toBe(false);
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
        let childLogger: unknown;
        let childRunId: RunId | undefined;
        let visibleBeforeLoop = true;

        // The launch dies with the loop's throw, so flip the defect back
        // into the error channel.
        const defect = yield* Effect.flip(
          launchProcessChild(testDefaultSession(), parentRunId, {
            identity: { kind: 'agent', agent: 'codex', tool: 'codex' },
            description: 'Fail during synchronous loop setup',
            config,
            buildLaunch: (context) => {
              childLogger = context.logger;
              childRunId = context.runId;
              // Before the loop reserves its stop target, no stop can find
              // the handle: a stop never reaches a run it cannot interrupt.
              visibleBeforeLoop =
                session.runs.get(context.runId)?.handle !== undefined;
              throw setupError;
            },
          }).pipe(
            Effect.provideService(Runs, session.runs),
            Effect.catchDefect((cause) => Effect.fail(cause)),
          ),
        );
        expect(defect).toBe(setupError);
        expect(visibleBeforeLoop).toBe(false);

        expect(childLogger).toBeDefined();
        expect(childRunId).toBeDefined();
        if (!childLogger || !childRunId) {
          throw new Error('expected the failed child launch to be captured');
        }
        expect(session.runs.get(childRunId)?.handle).toBeUndefined();
        expect(session.view.run(childRunId)?.status).toBe(RUN_PHASE.FAILED);
        expect(
          yield* getRunRecords(session, childRunId).readRunEnd(),
        ).toMatchObject({ outcome: 'failed' });
      }),
  );
});
