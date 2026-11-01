// Test composition imports

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Schema, Context } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import {
  AgentConfigSchema,
  RUN_OUTCOME,
  type RunId,
  type SessionEvent,
} from '@texra-ai/harness/schemas';
import { getRunRecords } from '@agent/storage/runRecords';
import { Runs } from '@agent/runtime/runRegistry';
import { launchProcessChild } from '@agent/runtime/delegation/detachedChildRun';
import { aggregateTarget } from '@shared/schemas';
import { SessionLog } from '@shared/session/runHistory';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { seedReport } from '@test/support/runRecordSeeds';
import type { ProcessChildStrategy } from '@texra-ai/harness/plugins';

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
    await Effect.runPromise(Context.get(session, SessionLog).settled);
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
        const log = Context.get(session, SessionLog);
        const transact = log.transact.bind(log) as (
          work: unknown,
        ) => Effect.Effect<unknown, unknown>;
        const publication = vi.spyOn(log, 'transact').mockImplementation(((
          work: unknown,
        ) =>
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
          )) as unknown as SessionLog['Service']['transact']);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => publication.mockRestore()),
        );
        const buildLaunch = vi.fn(() => Effect.succeed(neverRunStrategy));
        const launching = yield* Effect.forkChild(
          launchProcessChild(parentRunId, {
            identity: { kind: 'agent', agent: 'codex', tool: 'codex' },
            description: 'Cancelled admission',
            config,
            buildLaunch,
          })
            .pipe(Effect.provideService(Runs, Context.get(session, Runs)))
            .pipe(Effect.provide(session)),
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
        yield* Fiber.await(launching);
        expect(buildLaunch).not.toHaveBeenCalled();
        expect(
          (yield* getRunRecords(id).readRunEnd().pipe(Effect.provide(session)))
            ?.outcome,
        ).toBe(RUN_OUTCOME.CANCELLED);
        expect(yield* Context.get(session, SessionLog).owns(id)).toBe(false);
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
        let childRunId: RunId | undefined;
        let visibleBeforeLoop = true;

        // The launch dies with the loop's throw, so flip the defect back
        // into the error channel.
        const defect = yield* Effect.flip(
          launchProcessChild(parentRunId, {
            identity: { kind: 'agent', agent: 'codex', tool: 'codex' },
            description: 'Fail during synchronous loop setup',
            config,
            buildLaunch: (context) => {
              childRunId = context.runId;
              // Before the loop reserves its stop target, no stop can find
              // the run: a stop never reaches a run it cannot interrupt.
              visibleBeforeLoop =
                Context.get(session, Runs).get(context.runId) !== undefined;
              throw setupError;
            },
          })
            .pipe(
              Effect.provideService(Runs, Context.get(session, Runs)),
              Effect.catchDefect((cause) => Effect.fail(cause)),
            )
            .pipe(Effect.provide(testDefaultSession())),
        );
        expect(defect).toBe(setupError);
        expect(visibleBeforeLoop).toBe(false);
        if (!childRunId) throw new Error('the child launch was never built');
        expect(
          yield* getRunRecords(childRunId)
            .readRunEnd()
            .pipe(Effect.provide(session)),
        ).toMatchObject({ outcome: 'failed' });
      }),
  );
});
