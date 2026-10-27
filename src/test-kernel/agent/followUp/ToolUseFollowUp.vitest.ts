import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Semaphore } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import * as resumability from '@agent/storage/resumability';
import { Inbox, type InboxPort } from '@agent/followUp/Inbox';
import { RunInput } from '@agent/followUp/RunInput';
import {
  startFollowUpWake,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import type {
  SessionHandle,
  SessionTransaction,
} from '@agent/runtime/SessionHandle';
import {
  qualifyAggregateId,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseWriteFailed,
} from '@shared/session/database';
import type { Append } from '@shared/session/sessionEvents';
import { runStateAppend } from '@shared/session/runHistory';
import { createDeferred } from '@test/support/asyncTestUtils';
import { generateRunId } from '@utils/core';

/** Let a forked submission reach its parked resume Promise. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

type TryResume = (runId: RunId) => Effect.Effect<boolean, Error>;

/** The case's answer to the one resume a wake reaches: whether the run took
 *  it. The fake session's runs serve it as their resume. */
let tryResume: TryResume = () => Effect.succeed(false);

const withResumePort =
  (resume: TryResume) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      tryResume = resume;
      return effect;
    });

/**
 * The admission boundary over a recorded session plane: one serializer (a
 * one-permit semaphore standing in for the publisher), the rows it appended,
 * and the runs it claimed. `queued(runId)` is the text of every
 * `followup.queued` row written for the run, in order; what a reader takes
 * is what the rows still queue, as the publisher's pending set holds it.
 * `live` is the runs a generation holds here (the run registry's answer).
 * `claimRefused` answers each claim the way a live foreign owner does;
 * `failWrites` refuses that many appends.
 */
function recordedFollowUps(
  options: {
    claimRefused?: boolean;
    failWrites?: number;
    /** The port's resume; the default succeeds. */
    resume?: (runId: RunId) => Effect.Effect<Effect.Effect<void>>;
  } = {},
) {
  const rows: SessionEvent[] = [];
  const claims: RunId[] = [];
  const live = new Set<RunId>();
  let failWrites = options.failWrites ?? 0;
  const publisher = Semaphore.makeUnsafe(1);
  const append: Append = (events) =>
    Effect.suspend(() => {
      if (failWrites > 0) {
        failWrites -= 1;
        return Effect.fail(
          new DatabaseWriteFailed({
            path: ':memory:',
            cause: new Error('disk full'),
          }),
        );
      }
      const committed = events.map(
        (event) =>
          ({
            ...event,
            seq: rows.length + 1,
            commit: rows.length + 1,
            origin: null,
            at: 0,
          }) as SessionEvent,
      );
      rows.push(...committed);
      return Effect.succeed(committed);
    });
  const log = {
    transact: <A, E>(
      work:
        | readonly SessionEventDraft[]
        | ((tx: SessionTransaction) => Effect.Effect<A, E>),
    ) =>
      typeof work === 'function'
        ? publisher.withPermits(1)(work({ append, claim: () => Effect.void }))
        : publisher.withPermits(1)(runStateAppend(append)(work)),
    rows: (id, types) =>
      Effect.sync(() =>
        rows.filter(
          (row) =>
            row.aggregateId === id &&
            (types === undefined || types.includes(row.type)),
        ),
      ),
    blobs: () => Effect.succeed(new Map<string, string>()),
    // A run's record rows: what a parent-only send reads its edge from.
    records: (runId: RunId) =>
      Effect.sync(() =>
        rows.filter(
          (row) => row.aggregateId === qualifyAggregateId('run', runId),
        ),
      ),
    hold: (runId) =>
      Effect.suspend(() => {
        claims.push(runId);
        return options.claimRefused
          ? Effect.fail(
              new DatabaseClaimRefused({
                ownerId: JSON.stringify(['other-host', 4321, null]),
                verdict: 'alive',
              }),
            )
          : Effect.void;
      }),
    settled: Effect.void,
  } as InboxPort['log'];
  const followUps = new Inbox({
    log,
    detach: (job) => {
      Effect.runFork(publisher.withPermits(1)(job(append)));
    },
    run: () => undefined,
    resume: options.resume ?? (() => Effect.succeed(Effect.void)),
  });
  const queuedRows = (runId: RunId) =>
    rows.flatMap((row) =>
      row.type === 'followup.queued' &&
      row.aggregateId === qualifyAggregateId('run', runId)
        ? [row]
        : [],
    );
  return {
    followUps,
    claims,
    live,
    queuedRows,
    queued: (runId: RunId) => queuedRows(runId).map((row) => row.content.text),
  };
}

/** What `input` takes now without blocking (nothing is consumed). */
const taken = (input: RunInput) =>
  Effect.gen(function* () {
    const batch = (yield* input.hasPending('idle'))
      ? yield* input.next('idle')
      : null;
    return batch?.kind !== 'followUps'
      ? []
      : batch.followUps.map((followUp) => followUp.content.text);
  });

let recorded = recordedFollowUps();

/**
 * The run the admission meets: a generation `live` here (no resume is owed
 * and nothing is read from disk), or one `idle` with no generation here whose
 * rows allow a resume.
 */
type RunState = 'live' | 'idle';

function fakeSession(state: RunState): SessionHandle {
  if (state === 'idle')
    vi.spyOn(resumability, 'deriveResumability').mockReturnValue(
      Effect.succeed({ kind: 'checkpoint' }),
    );
  // The port's resume is the session's own wake, as the session layer wires it.
  recorded = recordedFollowUps({
    resume: (runId) => startFollowUpWake(runId, session),
  });
  const { followUps, live } = recorded;
  /** The session's resume, as `resumeRun` runs it: one in flight per run,
   *  and a run that took it is live here from then on. */
  const resume = (runId: RunId) =>
    followUps.resumes
      .once(
        runId,
        Effect.map(tryResume(runId), (resumed) => {
          if (!resumed) return { failed: 'not_resumable' as const };
          live.add(runId);
          return { started: true as const, delivered: true };
        }),
      )
      .pipe(Effect.map(({ result }) => result));
  const session = {
    runs: {
      resume,
      get: (runId: RunId) =>
        state === 'live' || live.has(runId)
          ? { runId, live: true, readsMessages: true }
          : undefined,
      // The session's fork: the attempt outlives the fiber that asked.
      fork: (program: Effect.Effect<unknown, unknown>) =>
        Effect.forkDetach(program, { startImmediately: true }),
    },
    view: { run: () => ({}) },
    interactions: { emit: () => Effect.void },
    log: {
      records: () => Effect.succeed([]),
      owner: () => Effect.succeed({ ownerId: null, liveness: null }),
    },
    followUps,
  } as unknown as SessionHandle;
  return session;
}

const user = (text: string) => ({ text, from: { kind: 'user' as const } });

const childResult = (deliveryId: string) => ({
  text: 'child result',
  from: { kind: 'run' as const, runId: 'c41dc41dc41d' as RunId },
  deliveryId,
});

describe('submitFollowUp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect('wakes a run once and orders concurrent submissions', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession('idle');
      const barrier = createDeferred<boolean>();
      const tryResumeRun = vi.fn(() => Effect.promise(() => barrier.promise));

      const fibers = [];
      for (const text of ['one', 'two', 'three']) {
        fibers.push(
          yield* Effect.forkChild(
            submitFollowUp(runId, user(text), { session }).pipe(
              withResumePort(tryResumeRun),
            ),
          ),
        );
      }

      yield* settle;
      expect(recorded.queued(runId)).toEqual(['one', 'two', 'three']);

      barrier.resolve(true);
      for (const fiber of fibers)
        expect(yield* Fiber.join(fiber)).toEqual({ status: 'queued' });
      expect(tryResumeRun).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect(
    'keeps the input queued when the submitting fiber is interrupted mid-wake',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession('idle');
        const resumed = createDeferred<boolean>();
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          submitFollowUp(runId, user('keep this input'), { session }).pipe(
            withResumePort(() => {
              Deferred.doneUnsafe(started, Effect.void);
              return Effect.promise(() => resumed.promise);
            }),
          ),
        );
        // The interrupt below lands on a wake already in flight.
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        resumed.resolve(false);
        // The wake runs on the session's fork: it answers the decline even
        // though the fiber that dispatched it is gone.
        yield* settle;

        // The input is the run's row, whichever reader takes it next.
        expect(recorded.queued(runId)).toEqual(['keep this input']);
      }),
  );

  it.effect('admits a replayed child delivery at most once', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession('live');
      const tryResumeRun = () => Effect.succeed(true);
      const delivery = childResult('exec-1:turn:1:delivery');

      expect(
        yield* submitFollowUp(runId, delivery, { session }).pipe(
          withResumePort(tryResumeRun),
        ),
      ).toEqual({ status: 'queued' });

      // A producer repeating the same logical result must not append
      // another parent message; the live generation reads the one row.
      for (let replay = 0; replay < 100; replay++) {
        expect(
          yield* submitFollowUp(runId, delivery, { session }).pipe(
            withResumePort(tryResumeRun),
          ),
        ).toEqual({ status: 'sent' });
      }
      expect(recorded.queuedRows(runId)).toMatchObject([
        {
          followUpId: delivery.deliveryId,
          content: { text: 'child result' },
        },
      ]);
    }),
  );
});

describe('Inbox readers', () => {
  it.effect(
    'delivers a successor reader every row still queued, in commit order',
    () =>
      Effect.gen(function* () {
        const { followUps } = recordedFollowUps();
        const id = generateRunId();
        yield* Effect.scoped(
          Effect.andThen(
            followUps.open(id),
            followUps.send(id, user('during the first generation')),
          ),
        );
        yield* followUps.send(id, user('between generations'));
        yield* followUps.wake(id);

        const input = yield* followUps.open(id);
        expect(yield* taken(input)).toEqual([
          'during the first generation',
          'between generations',
        ]);
      }),
  );

  it.effect('refuses a run another process holds, writing nothing', () =>
    Effect.gen(function* () {
      const { followUps, queued, claims } = recordedFollowUps({
        claimRefused: true,
      });
      const id = generateRunId();
      const delivery = childResult('d-held');

      for (let attempt = 0; attempt < 2; attempt++) {
        // Not remembered as admitted: a retry is tried again, not
        // reported as a duplicate.
        expect(yield* followUps.send(id, delivery)).toEqual({
          kind: 'refused',
          reason: 'owned_elsewhere',
        });
      }
      expect(claims).toEqual([id, id]);
      expect(queued(id)).toEqual([]);
    }),
  );
});

describe('Inbox delivery identity (#9531)', () => {
  it.effect(
    'judges a concurrent duplicate against the first write, never before it settles',
    () =>
      Effect.gen(function* () {
        // The first write fails: the second send of the same delivery must
        // not have been told `duplicate` for a row that never landed.
        const { followUps, queued } = recordedFollowUps({ failWrites: 1 });
        const id = generateRunId();
        yield* followUps.open(id);
        const delivery = childResult('exec-2:turn:1:delivery');

        const [first, second] = yield* Effect.all(
          [
            Effect.exit(followUps.send(id, delivery)),
            Effect.exit(followUps.send(id, delivery)),
          ],
          { concurrency: 'unbounded' },
        );

        expect(Exit.isFailure(first)).toBe(true);
        expect(second).toEqual(Exit.succeed({ kind: 'queued', read: true }));
        expect(queued(id)).toEqual(['child result']);
      }),
  );
});

describe('Inbox closed input', () => {
  it.effect(
    'a closed run refuses senders from its rows until a reader opens here',
    () =>
      Effect.gen(function* () {
        // The close is the run's `followup.closed` row, not an in-memory
        // mark: the fixture's port reads only the rows.
        const { followUps, queued } = recordedFollowUps();
        const closed = generateRunId();
        const open = generateRunId();
        yield* followUps.closeInput(closed);
        yield* settle;

        expect(yield* followUps.send(closed, user('still closed'))).toEqual({
          kind: 'refused',
          reason: 'not_resumable',
        });
        expect(queued(closed)).toEqual([]);
        expect(yield* followUps.send(open, user('never closed'))).toMatchObject(
          { kind: 'queued' },
        );

        // The generation that reactivates it reads its input again.
        yield* followUps.open(closed);
        expect(yield* followUps.send(closed, user('reopened'))).toMatchObject({
          kind: 'queued',
          read: true,
        });
      }),
  );
});
