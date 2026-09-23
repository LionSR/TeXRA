import { Deferred, Effect, Fiber } from 'effect';
import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { RunInput } from '@agent/followUp/RunInput';
import type { ToolUseFlowResult } from '@agent/runtime/AgentFlowResult';
import type { ResumeToolUseFromResumeDataOptions } from '@agent/runtime/executeAgent';
import { resumeRun, resumeClaimedRun } from '@agent/runtime/resumeRun';
import type { RunId } from '@shared/schemas';
import { AgentCategory, aggregateId, RUN_OUTCOME } from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import { runHeldMessage } from '@shared/runs/runStatusDisplay';
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

// The refusal path re-reads the durable facts, which the fixtures below do
// not seed: every other reader on the records double answers empty.
const classifyRunMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/runClassification', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/runClassification')>()),
  classifyRun: (...args: unknown[]) =>
    Effect.promise(() => classifyRunMock(...args)),
}));

const RUN = 'aabbcc' as RunId;
const completed: ToolUseFlowResult = {
  outcome: RUN_OUTCOME.COMPLETED,
  runId: RUN,
  output: { category: 'toolUse', response: 'done', files: [] },
};

function snapshot() {
  return createToolUseResumeData({ runId: RUN });
}

const seedRecoverable = Effect.fn('test.seedRecoverable')(function* (
  session: ReturnType<typeof createTestSession>,
  ...texts: string[]
) {
  const flow = session.followUps.claimLive(RUN, 'flow')!;
  for (const text of texts) {
    yield* session.followUps.submit(RUN, { text }, 'live_owner');
  }
  session.followUps.release(flow, 'recoverable');
});

/** The text of each follow-up the run's rows still queue. */
const queuedTexts = (session: ReturnType<typeof createTestSession>) =>
  Effect.map(queuedFollowUps(session, RUN), (followUps) =>
    followUps.map((followUp) => followUp.text),
  );

/** What each resumed generation took from its queue, in order. */
const taken: string[] = [];

/**
 * The resumed flow's side of the queue: attach to the recovery owner's
 * queue, seed it from the rows, and take what is queued.
 */
const resumedFlowTakes = (session: ReturnType<typeof createTestSession>) =>
  Effect.gen(function* () {
    const pending = (yield* queuedFollowUps(session, RUN)).map((followUp) => ({
      followUpId: followUp.followUpId,
      content: { text: followUp.text, origin: 'user' as const },
    }));
    const input = session.followUps.attachInput(RUN, yield* RunInput.make)!;
    input.seed(pending);
    const batch = input.hasQueued() ? yield* input.take : null;
    if (batch !== null && !batch.synthetic) {
      taken.push(...batch.followUps.map((followUp) => followUp.content.text));
      // What the loop's consume commits: the rows stop queueing the batch.
      yield* session.commit(
        batch.followUps.map((followUp) => ({
          type: 'followup.consumed' as const,
          aggregateId: aggregateId('run', RUN),
          followUpId: followUp.followUpId,
        })),
      );
    }
  });

const sessions: ReturnType<typeof createTestSession>[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await Effect.runPromise(session.dispose());
  }
});

/** A session holding the run, its `run.start` landed. */
const createSession = Effect.fn('test.createSession')(function* () {
  const session = createTestSession();
  publishTestRunStart(session, RUN);
  sessions.push(session);
  yield* session.settlePublications();
  return session;
});

/**
 * The two resume programs over the fake host's process services: the suite
 * runs them on the default runtime rather than a process runtime, so the
 * services they require are provided here.
 */
function resumeOne(...args: Parameters<typeof resumeRun>) {
  return Effect.provide(resumeRun(...args), fakeProcessServices());
}

function resumeClaimedOne(...args: Parameters<typeof resumeClaimedRun>) {
  return Effect.provide(resumeClaimedRun(...args), fakeProcessServices());
}

const executeWorkflow = vi.fn(() =>
  Effect.fail(new Error('tool-use fixtures never launch a workflow')),
);

describe('resumeRun tool-use queue ownership', () => {
  beforeEach(() => {
    readConfigMock
      .mockReset()
      .mockReturnValue(Effect.succeed(snapshot().agentConfig));
    runExistsMock.mockReset().mockReturnValue(Effect.succeed(true));
    retrieveSessionResumeDataMock.mockReset().mockResolvedValue(snapshot());
    classifyRunMock.mockReset().mockResolvedValue({ kind: 'finished' });
    resumeToolUseFromResumeDataMock.mockReset();
    taken.length = 0;
    resumeToolUseFromResumeDataMock.mockImplementation(
      (
        _resume: unknown,
        options: ResumeToolUseFromResumeDataOptions & {
          session: ReturnType<typeof createTestSession>;
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
        expect(
          yield* Effect.flip(resumeOne(RUN, { session, executeWorkflow })),
        ).toBe(failure);
        expect(retrieveSessionResumeDataMock).not.toHaveBeenCalled();
        expect(yield* queuedTexts(session)).toEqual(['Keep this input.']);
      }),
  );

  it.effect(
    'claims run recovery before reading the committed run records',
    () =>
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

        const resumed = yield* Effect.forkChild(
          resumeClaimedOne(RUN, { session, executeWorkflow }),
        );
        yield* Deferred.await(configRead);
        expect(
          yield* session.followUps.submit(
            RUN,
            { text: 'raced' },
            'recoverable',
          ),
        ).toEqual({ kind: 'queued' });

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

      const resumed = yield* Effect.forkChild(
        resumeClaimedOne(RUN, { session, executeWorkflow }),
      );
      yield* Deferred.await(existsRead);
      expect(
        yield* session.followUps.submit(RUN, { text: 'raced' }, 'recoverable'),
      ).toEqual({ kind: 'queued' });

      yield* Deferred.succeed(exists, false);
      expect(yield* Fiber.join(resumed)).toEqual({ failed: 'not_resumable' });
      expect(yield* queuedTexts(session)).toEqual(['raced']);
    }),
  );

  it.effect(
    'claims recovery before draining and preserves ordered raced input',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        yield* seedRecoverable(session, 'first');

        expect(
          yield* resumeOne(RUN, {
            session,
            executeWorkflow,
            onResumeResolved: () =>
              Effect.gen(function* () {
                expect(
                  yield* session.followUps.submit(
                    RUN,
                    { text: 'second' },
                    'recoverable',
                  ),
                ).toEqual({ kind: 'queued' });
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

  it.effect('rejects a competing recovery consumer deterministically', () =>
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

      const first = yield* Effect.forkChild(
        resumeOne(RUN, { session, executeWorkflow }),
      );
      yield* Deferred.await(entered);
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
      expect(yield* resumeOne(RUN, { session, executeWorkflow })).toEqual({
        failed: 'not_resumable',
      });
      yield* Deferred.succeed(barrier, undefined);
      yield* Fiber.join(first);
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
    }),
  );

  it.effect('refuses a recovery lease invalidated during storage reads', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      const submission = yield* session.followUps.submit(
        RUN,
        { text: 'stale' },
        'recoverable',
      );
      expect(submission).toMatchObject({ kind: 'queued' });
      if (submission.kind !== 'queued' || !submission.lease) {
        throw new Error('recovery not claimed');
      }
      const config =
        yield* Deferred.make<ReturnType<typeof snapshot>['agentConfig']>();
      const configRead = yield* Deferred.make<void>();
      readConfigMock.mockImplementationOnce(() =>
        Deferred.succeed(configRead, undefined).pipe(
          Effect.andThen(Deferred.await(config)),
        ),
      );

      const resumed = yield* Effect.forkChild(
        resumeOne(RUN, {
          session,
          recovery: submission.lease,
          executeWorkflow,
        }),
      );
      yield* Deferred.await(configRead);
      session.followUps.terminalize(RUN);
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
        (yield* Effect.flip(resumeOne(RUN, { session, executeWorkflow })))
          .message,
      ).toContain('failed');
      expect(yield* queuedTexts(session)).toEqual(['keep me']);
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

        const resuming = yield* Effect.forkChild(
          resumeOne(RUN, { session, executeWorkflow }),
        );
        yield* Deferred.await(entered);
        expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();

        expect(
          yield* session.followUps.submit(
            RUN,
            { text: 'completed child', origin: 'subagent_result' },
            'recoverable',
          ),
        ).toEqual({ kind: 'queued' });
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

  it.effect('adopts the exact recovery generation claimed by submission', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      const submission = yield* session.followUps.submit(
        RUN,
        { text: 'claimed' },
        'recoverable',
      );
      expect(submission).toMatchObject({ kind: 'queued' });
      if (submission.kind !== 'queued' || !submission.lease) {
        throw new Error('recovery not claimed');
      }
      const recovery = submission.lease;

      const result = yield* resumeOne(RUN, {
        session,
        recovery,
        executeWorkflow,
      });
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
    'keeps caller-supplied input recoverable for workflow records',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        const submission = yield* session.followUps.submit(
          RUN,
          { text: 'workflow input' },
          'recoverable',
        );
        expect(submission).toMatchObject({ kind: 'queued' });
        if (submission.kind !== 'queued' || !submission.lease) {
          throw new Error('recovery not claimed');
        }
        readConfigMock.mockReturnValueOnce(
          Effect.succeed({
            ...snapshot().agentConfig,
            agentCategory: AgentCategory.Workflow,
          }),
        );
        retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

        expect(
          yield* resumeOne(RUN, {
            session,
            recovery: submission.lease,
            executeWorkflow,
          }),
        ).toEqual({ failed: 'finished' });
        expect(yield* queuedTexts(session)).toEqual(['workflow input']);
      }),
  );

  it.effect('refuses with `finished` when no checkpoint remains', () =>
    Effect.gen(function* () {
      const session = yield* createSession();
      const markUnreadable = vi.spyOn(session, 'markUnreadable');
      retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

      expect(yield* resumeOne(RUN, { session, executeWorkflow })).toEqual({
        failed: 'finished',
      });
      expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
      expect(markUnreadable).not.toHaveBeenCalled();
    }),
  );

  // An empty retrieval is also what a torn read of the owner's rewrite looks
  // like, so the refusal is decided from the claim: a run another process is
  // executing keeps its hold instead of being reported finished.
  it.effect(
    'refuses an empty retrieval held elsewhere as owned elsewhere',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        const markUnreadable = vi.spyOn(session, 'markUnreadable');
        retrieveSessionResumeDataMock.mockResolvedValueOnce(null);
        classifyRunMock.mockResolvedValueOnce({
          kind: 'held_elsewhere',
          owner: JSON.stringify(['other-host', 4321, null]),
        });

        expect(yield* resumeOne(RUN, { session, executeWorkflow })).toEqual({
          failed: 'owned_elsewhere',
        });
        expect(markUnreadable).toHaveBeenCalledWith(
          RUN,
          expect.stringContaining('4321'),
        );
      }),
  );

  // The fold that continues a run is the one reader of its rows, so an
  // aggregate that does not fold is refused as unusable state at the launch
  // that folded it. Telling that user the run "has finished", or throwing the
  // launch's internal wording at them, are the two ways this used to go wrong.
  it.effect(
    'refuses an aggregate the ledger cannot fold as unusable state',
    () =>
      Effect.gen(function* () {
        const session = yield* createSession();
        resumeToolUseFromResumeDataMock.mockReturnValueOnce(
          Effect.fail(
            new Error('Failed to launch the resumed run', {
              cause: new RunLedgerRefused({
                reason: 'inconsistent',
                runId: RUN,
                detail: 'unsupported-record',
              }),
            }),
          ),
        );

        expect(yield* resumeOne(RUN, { session, executeWorkflow })).toEqual({
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
          (yield* Effect.flip(resumeOne(RUN, { session, executeWorkflow })))
            .message,
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
        const markUnreadable = vi.spyOn(session, 'markUnreadable');
        const ownerId = JSON.stringify(['other-host', 4321, 'start-1']);
        vi.spyOn(session, 'claimOwner').mockReturnValue(
          Effect.succeed({ ownerId, liveness: 'alive' }),
        );
        const onResumeResolved = vi.fn(() => Effect.void);

        expect(
          yield* resumeOne(RUN, {
            session,
            executeWorkflow,
            onResumeResolved,
          }),
        ).toEqual({ failed: 'owned_elsewhere' });
        expect(onResumeResolved).not.toHaveBeenCalled();
        expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
        expect(markUnreadable).toHaveBeenCalledWith(RUN, runHeldMessage(4321));
      }),
  );
});
