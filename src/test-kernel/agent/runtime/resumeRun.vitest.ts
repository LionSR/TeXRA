import { Deferred, Effect, Fiber } from 'effect';
import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { RunEndResult } from '@agent/runtime/RunEndResult';
import type { ResumeToolUseFromResumeDataOptions } from '@agent/runtime/executeAgent';
import { resumeRun } from '@agent/runtime/resumeRun';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { aggregateId, RUN_OUTCOME } from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { RunHistoryRefused } from '@shared/session/runHistory';
import { closeSessionOf } from '@test/support/sessionEnd';
import { createFakeRunRecords } from '@test/support/FakeRunRecords';
import {
  createTestSession,
  publishTestRunStart,
  queuedFollowUps,
} from '@test/support/sessionTestUtils';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ensureError } from '@utils/errors/errorMessage';

const resumeToolUseFromResumeDataMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/executeAgent', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/executeAgent')>()),
  resumeToolUseFromResumeData: resumeToolUseFromResumeDataMock,
}));

// These runs' agents are not in a catalog: nothing blocks their resume.
vi.mock('@agent/runtime/resumeBlocker', () => ({
  resumeBlocker: () => Effect.succeed(null),
}));

const retrieveSessionResumeDataMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => retrieveSessionResumeDataMock(...args),
      catch: ensureError,
    }),
}));

// The two record reads the resume programs make: `readConfig()` is the run's
// committed config row, `exists()` answers "the log still lists this run".
const readConfigMock = vi.hoisted(() => vi.fn());
const runExistsMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/storage/runRecords', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/runRecords')>()),
  getRunRecords: () =>
    createFakeRunRecords({
      readConfig: () => readConfigMock(),
      exists: () => runExistsMock(),
    }),
}));

const RUN = 'aabbcc' as RunId;
const completed: RunEndResult = {
  outcome: RUN_OUTCOME.COMPLETED,
  runId: RUN,
  output: { response: 'done', files: [] },
};

function snapshot() {
  return createToolUseResumeData({ runId: RUN });
}

const seedRecoverable = Effect.fn('test.seedRecoverable')(function* (
  session: SessionHandle,
  ...texts: string[]
) {
  for (const text of texts) {
    yield* session.followUps.send(RUN, {
      from: { kind: 'user' as const },
      text,
    });
  }
});

/** The text of each follow-up the run's rows still queue. */
const queuedTexts = (session: SessionHandle) =>
  Effect.map(queuedFollowUps(session, RUN), (followUps) =>
    followUps.map((followUp) => followUp.text),
  );

/** What each resumed generation took from its queue, in order. */
const taken: string[] = [];

/**
 * The resumed flow's side of the queue: open its own reader and take what
 * the rows still queue.
 */
const resumedFlowTakes = (session: SessionHandle) =>
  Effect.gen(function* () {
    const input = yield* session.followUps.open(RUN);
    const batch = (yield* input.hasQueued) ? yield* input.take : null;
    if (batch?.kind === 'followUps') {
      taken.push(...batch.followUps.map((followUp) => followUp.content.text));
      // What the loop's consume commits: the rows stop queueing the batch.
      yield* session.log.transact(
        batch.followUps.map((followUp) => ({
          type: 'followup.consumed' as const,
          aggregateId: aggregateId('run', RUN),
          followUpId: followUp.followUpId,
        })),
      );
    }
  }).pipe(Effect.scoped);

const sessions: SessionHandle[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await Effect.runPromise(closeSessionOf(session));
  }
});

/** A session holding the run, its `run.start` landed. */
const createSession = Effect.fn('test.createSession')(function* () {
  const session = yield* createTestSession();
  publishTestRunStart(session, RUN);
  sessions.push(session);
  yield* session.log.settled;
  return session;
});

/**
 * The resume program over the fake host's process services: the suite runs
 * it on the default runtime rather than a process runtime, so the services
 * it requires are provided here.
 */
function resumeOne(...args: Parameters<typeof resumeRun>) {
  return Effect.provide(resumeRun(...args), fakeProcessServices());
}

describe('resumeRun tool-use queue ownership', () => {
  beforeEach(() => {
    readConfigMock
      .mockReset()
      .mockReturnValue(Effect.succeed(snapshot().agentConfig));
    runExistsMock.mockReset().mockReturnValue(Effect.succeed(true));
    retrieveSessionResumeDataMock.mockReset().mockResolvedValue(snapshot());
    resumeToolUseFromResumeDataMock.mockReset();
    taken.length = 0;
    resumeToolUseFromResumeDataMock.mockImplementation(
      (
        _resume: unknown,
        options: ResumeToolUseFromResumeDataOptions & {
          session: SessionHandle;
        },
      ) => resumedFlowTakes(options.session).pipe(Effect.as(completed)),
    );
  });

  it.effect(
    'reads the durable records before retrieval and retains input when they fail',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        yield* seedRecoverable(session, 'Keep this input.');
        const failure = new DatabaseReadFailed({
          path: ':memory:',
          cause: new Error('Corrupt record'),
        });
        runExistsMock.mockReturnValueOnce(Effect.fail(failure));
        expect(yield* Effect.flip(resumeOne(RUN, { session }))).toBe(failure);
        expect(retrieveSessionResumeDataMock).not.toHaveBeenCalled();
        expect(yield* queuedTexts(session)).toEqual(['Keep this input.']);
      }),
  );

  it.effect('hands input sent during its record reads to the resumed run', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      const config =
        yield* Deferred.make<ReturnType<typeof snapshot>['agentConfig']>();
      const configRead = yield* Deferred.make<void>();
      readConfigMock.mockImplementationOnce(() =>
        Deferred.succeed(configRead, undefined).pipe(
          Effect.andThen(Deferred.await(config)),
        ),
      );

      const resumed = yield* Effect.forkChild(resumeOne(RUN, { session }));
      yield* Deferred.await(configRead);
      expect(
        yield* session.followUps.send(
          RUN,
          { from: { kind: 'user' as const }, text: 'raced' },
          { wake: true },
        ),
      ).toEqual({ kind: 'queued', read: false, wake: false });

      yield* Deferred.succeed(config, snapshot().agentConfig);
      expect(yield* Fiber.join(resumed)).toMatchObject({
        started: true,
        delivered: true,
        outcome: RUN_OUTCOME.COMPLETED,
      });
      expect(taken).toEqual(['raced']);
    }),
  );

  it.effect('preserves raced input when the run has no persisted record', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      const exists = yield* Deferred.make<boolean>();
      const existsRead = yield* Deferred.make<void>();
      runExistsMock.mockImplementationOnce(() =>
        Deferred.succeed(existsRead, undefined).pipe(
          Effect.andThen(Deferred.await(exists)),
        ),
      );

      const resumed = yield* Effect.forkChild(resumeOne(RUN, { session }));
      yield* Deferred.await(existsRead);
      expect(
        yield* session.followUps.send(
          RUN,
          { from: { kind: 'user' as const }, text: 'raced' },
          { wake: true },
        ),
      ).toEqual({ kind: 'queued', read: false, wake: false });

      yield* Deferred.succeed(exists, false);
      yield* session.log.settled;
      expect(yield* Fiber.join(resumed)).toEqual({ failed: 'not_resumable' });
      expect(yield* queuedTexts(session)).toEqual(['raced']);
    }),
  );

  it.effect('preserves ordered input sent while it resumes', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      yield* seedRecoverable(session, 'first');

      expect(
        yield* resumeOne(RUN, {
          session,
          onResumeResolved: () =>
            Effect.gen(function* () {
              expect(
                yield* session.followUps.send(
                  RUN,
                  { from: { kind: 'user' as const }, text: 'second' },
                  { wake: true },
                ),
              ).toEqual({ kind: 'queued', read: false, wake: false });
            }),
        }),
      ).toMatchObject({
        started: true,
        delivered: true,
        outcome: RUN_OUTCOME.COMPLETED,
      });

      expect(taken).toEqual(['first', 'second']);
    }),
  );

  it.effect('joins a competing resume to the one in flight', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      yield* seedRecoverable(session, 'once');
      const entered = yield* Deferred.make<void>();
      const barrier = yield* Deferred.make<void>();
      resumeToolUseFromResumeDataMock.mockReturnValueOnce(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(barrier)),
          Effect.as(completed),
        ),
      );

      const first = yield* Effect.forkChild(resumeOne(RUN, { session }));
      yield* Deferred.await(entered);
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
      // The second resume signals as it reaches the resume in flight.
      const joining = yield* Deferred.make<void>();
      const resumeOnce = session.followUps.resumeOnce.bind(session.followUps);
      vi.spyOn(session.followUps, 'resumeOnce').mockImplementationOnce(
        (runId, resume) =>
          Deferred.succeed(joining, undefined).pipe(
            Effect.andThen(resumeOnce(runId, resume)),
          ),
      );
      const second = yield* Effect.forkChild(resumeOne(RUN, { session }));
      yield* Deferred.await(joining);
      // Its join is already queued behind the signal: one turn of the event
      // loop lets it run before the first resume is released.
      yield* Effect.promise(() => new Promise((done) => setImmediate(done)));
      yield* Deferred.succeed(barrier, undefined);
      expect(yield* Fiber.join(second)).toEqual(yield* Fiber.join(first));
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
    }),
  );

  it.effect('refuses a run whose input closed during storage reads', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      const config =
        yield* Deferred.make<ReturnType<typeof snapshot>['agentConfig']>();
      const configRead = yield* Deferred.make<void>();
      readConfigMock.mockImplementationOnce(() =>
        Deferred.succeed(configRead, undefined).pipe(
          Effect.andThen(Deferred.await(config)),
        ),
      );

      const resumed = yield* Effect.forkChild(resumeOne(RUN, { session }));
      yield* Deferred.await(configRead);
      session.followUps.closeInput(RUN);
      yield* session.log.settled;
      yield* Deferred.succeed(config, snapshot().agentConfig);

      expect(yield* Fiber.join(resumed)).toEqual({ failed: 'not_resumable' });
      expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
    }),
  );

  it.effect('keeps an untaken batch queued after resume failure', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      yield* seedRecoverable(session, 'keep me');
      resumeToolUseFromResumeDataMock.mockReturnValueOnce(
        Effect.fail(new Error('failed')),
      );

      expect(
        (yield* Effect.flip(resumeOne(RUN, { session }))).message,
      ).toContain('failed');
      expect(yield* queuedTexts(session)).toEqual(['keep me']);
      // Nothing here holds the run: the next resume may take it.
      expect(session.runs.isLive(RUN)).toBe(false);
    }),
  );

  it.effect(
    'replays a completed-child result that races a failed recovery',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        yield* seedRecoverable(session, 'original');
        const entered = yield* Deferred.make<void>();
        const failing = yield* Deferred.make<never, Error>();
        resumeToolUseFromResumeDataMock.mockReturnValueOnce(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(failing)),
          ),
        );

        const resuming = yield* Effect.forkChild(resumeOne(RUN, { session }));
        yield* Deferred.await(entered);
        expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();

        expect(
          yield* session.followUps.send(
            RUN,
            {
              text: 'completed child',
              from: { kind: 'run' as const, runId: 'c41dc41dc41d' as RunId },
            },
            { wake: true },
          ),
        ).toEqual({ kind: 'queued', read: false, wake: false });
        yield* Deferred.fail(failing, new Error('resume failed'));

        expect((yield* Effect.flip(Fiber.join(resuming))).message).toContain(
          'resume failed',
        );
        expect(yield* queuedTexts(session)).toEqual([
          'original',
          'completed child',
        ]);
      }),
  );

  it.effect('resumes the run a send owed a wake', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      expect(
        yield* session.followUps.send(
          RUN,
          { from: { kind: 'user' as const }, text: 'claimed' },
          { wake: true },
        ),
      ).toEqual({ kind: 'queued', read: false, wake: true });

      const result = yield* resumeOne(RUN, { session });
      expect(result).toMatchObject({
        started: true,
        delivered: true,
        outcome: RUN_OUTCOME.COMPLETED,
      });
      // A root's lifetime is the caller's to await past the acknowledgement.
      if (!('started' in result)) throw new Error('resume refused');
      expect(yield* result.completion!).toBe(RUN_OUTCOME.COMPLETED);
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    'keeps a woken input on the rows when nothing remains to resume',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        expect(
          yield* session.followUps.send(
            RUN,
            { from: { kind: 'user' as const }, text: 'workflow input' },
            { wake: true },
          ),
        ).toEqual({ kind: 'queued', read: false, wake: true });
        retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

        expect(yield* resumeOne(RUN, { session })).toEqual({
          failed: 'finished',
        });
        expect(yield* queuedTexts(session)).toEqual(['workflow input']);
      }),
  );

  it.effect('refuses with `finished` when no checkpoint remains', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

      expect(yield* resumeOne(RUN, { session })).toEqual({
        failed: 'finished',
      });
      expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
    }),
  );

  // The fold that continues a run is the one reader of its rows, so an
  // aggregate that does not fold is refused as unusable state at the launch
  // that folded it. Telling that user the run "has finished", or throwing the
  // launch's internal wording at them, are the two ways this used to go wrong.
  it.effect(
    'refuses an aggregate the run history cannot fold as unusable state',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        resumeToolUseFromResumeDataMock.mockReturnValueOnce(
          Effect.fail(
            new Error('Failed to launch the resumed run', {
              cause: new RunHistoryRefused({
                reason: 'inconsistent',
                runId: RUN,
                detail: 'unsupported-record',
              }),
            }),
          ),
        );

        expect(yield* resumeOne(RUN, { session })).toEqual({
          failed: 'unusable_checkpoint',
        });
      }),
  );

  // Only a cause that names the checkpoint refuses as unusable state. A
  // transient storage failure is the operational error it has always been, so
  // the host words it with the cause instead of telling the user to delete a
  // run whose saved state may be fine.
  it.effect(
    'propagates a transient retrieval failure over a run the log still lists',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        retrieveSessionResumeDataMock.mockRejectedValueOnce(
          new Error('record read timeout'),
        );

        expect(
          (yield* Effect.flip(resumeOne(RUN, { session }))).message,
        ).toContain('record read timeout');
      }),
  );

  // The launch's own claim acquisition would refuse only after the host
  // cleared its window and switched onto the resumed stream.
  it.effect(
    'refuses a run a live foreign owner holds before the host rearranges',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        const ownerId = JSON.stringify(['other-host', 4321, 'start-1']);
        // The claim the host's resume takes is refused by its live owner.
        vi.spyOn(session.log, 'hold').mockReturnValue(
          Effect.fail(
            new DatabaseWriteFailed({
              path: ':memory:',
              cause: new DatabaseClaimRefused({ ownerId, verdict: 'alive' }),
            }),
          ),
        );
        const onResumeResolved = vi.fn(() => Effect.void);

        expect(
          yield* resumeOne(RUN, {
            session,
            onResumeResolved,
          }),
        ).toEqual({ failed: 'owned_elsewhere' });
        expect(onResumeResolved).not.toHaveBeenCalled();
        expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
      }),
  );
});
