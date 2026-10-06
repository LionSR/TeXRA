import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Semaphore } from 'effect';
import { afterEach, describe, expect, vi, type Mock } from 'vitest';

import * as resumability from '@agent/storage/resumability';
import { Inbox, type InboxClosed, type InboxPort } from '@agent/followUp/Inbox';
import { RunInput } from '@agent/followUp/RunInput';
import {
  presentFollowUpResult,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import type { ToolUseFollowUpTarget } from '@agent/runtime/runRegistry';
import { AgentEngine } from '@agent/runtime/AgentEngine';
import type {
  SessionHandle,
  SessionTransaction,
} from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DatabaseWriteFailed,
  heldElsewhereBy,
} from '@shared/session/database';
import { runRelation } from '@shared/session/runRelation';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { Append } from '@shared/session/sessionEvents';
import { createDeferred } from '@test/support/asyncTestUtils';
import { generateRunId } from '@utils/core';

/** Let a forked submission reach its parked resume Promise. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

function mockTryResume(): Mock<() => Effect.Effect<boolean, Error>> {
  return vi.fn(() => Effect.succeed(true));
}

type TryResume = (runId: RunId) => Effect.Effect<boolean, Error>;

/** The case's answer to the one resume a wake reaches: whether the run took
 *  it. The fake session's fork serves it as the engine's resume. */
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
  const followUps = new Inbox({
    log: {
      transact: <A, E>(
        work:
          | readonly SessionEventDraft[]
          | ((tx: SessionTransaction) => Effect.Effect<A, E>),
      ) =>
        typeof work === 'function'
          ? publisher.withPermits(1)(work({ append, claim: () => Effect.void }))
          : publisher.withPermits(1)(append(work)),
      rows: (id, types) =>
        Effect.sync(() =>
          rows.filter(
            (row) =>
              row.aggregateId === id &&
              (types === undefined || types.includes(row.type)),
          ),
        ),
      hold: (runId) =>
        Effect.suspend(() => {
          claims.push(runId);
          return options.claimRefused
            ? Effect.fail(
                new DatabaseWriteFailed({
                  path: ':memory:',
                  cause: new DatabaseClaimRefused({
                    ownerId: JSON.stringify(['other-host', 4321, null]),
                    verdict: 'alive',
                  }),
                }),
              )
            : Effect.void;
        }),
    } as InboxPort['log'],
    detach: (job) => {
      Effect.runFork(publisher.withPermits(1)(job(append)));
    },
    parentOf: () => undefined,
    live: (runId) => live.has(runId),
  });
  const queuedRows = (runId: RunId) =>
    rows.flatMap((row) =>
      row.type === 'followup.queued' &&
      row.aggregateId === aggregateId('run', runId)
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
    const batch = (yield* input.hasQueued) ? yield* input.take : null;
    return batch?.kind !== 'followUps'
      ? []
      : batch.followUps.map((followUp) => followUp.content.text);
  });

let recorded = recordedFollowUps();

function fakeSession(target: ToolUseFollowUpTarget): SessionHandle {
  recorded = recordedFollowUps();
  const { followUps, live } = recorded;
  /** The engine's resume, as `resumeRun` runs it: one in flight per run,
   *  and a run that took it is live here from then on. */
  const engine = {
    resumeRun: (runId: RunId) =>
      followUps
        .resumeOnce(
          runId,
          Effect.map(tryResume(runId), (resumed) => {
            if (!resumed) return { failed: 'not_resumable' as const };
            live.add(runId);
            return { started: true as const, delivered: true };
          }),
        )
        .pipe(Effect.map(({ result }) => result)),
  } as unknown as AgentEngine['Service'];
  return {
    runs: {
      getToolUseFollowUpTarget: () => target,
      isLive: (runId: RunId) => live.has(runId),
      // The session's fork: the attempt outlives the fiber that asked.
      fork: (program: Effect.Effect<unknown, unknown, AgentEngine>) =>
        Effect.forkDetach(Effect.provideService(program, AgentEngine, engine), {
          startImmediately: true,
        }),
    },
    view: { run: () => ({}) },
    interactions: { emit: () => Effect.void },
    log: {
      records: () => Effect.succeed([]),
      // No database behind this fixture: a claim read fails, a transient
      // refusal that says nothing about the run.
      owner: () => Effect.fail(new Error('claim store unavailable')),
    },
    followUps,
  } as unknown as SessionHandle;
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

  it.effect(
    "queues for the run's own reader while waiting, between turns, and during a turn",
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'queue' });
        const input = yield* session.followUps.open(runId);
        const tryResumeRun = mockTryResume();

        for (const text of ['while waiting', 'between turns', 'during turn']) {
          expect(
            yield* submitFollowUp(runId, user(text), { session }).pipe(
              withResumePort(tryResumeRun),
            ),
          ).toEqual({ status: 'queued' });
        }

        expect(tryResumeRun).not.toHaveBeenCalled();
        expect(yield* taken(input)).toEqual([
          'while waiting',
          'between turns',
          'during turn',
        ]);
      }),
  );

  it.effect('reports input admitted by a running loop as sent', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession({ kind: 'active' });
      const input = yield* session.followUps.open(runId);
      const tryResumeRun = mockTryResume();

      expect(
        yield* submitFollowUp(runId, user('during active turn'), {
          session,
        }).pipe(withResumePort(tryResumeRun)),
      ).toEqual({ status: 'sent' });

      expect(tryResumeRun).not.toHaveBeenCalled();
      expect(yield* taken(input)).toEqual(['during active turn']);
    }),
  );

  it.effect(
    'does not report an automatic live-flow notification as user input',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'active' });
        const input = yield* session.followUps.open(runId);

        expect(
          yield* submitFollowUp(runId, user('child progress'), {
            session,
            mode: 'live_notification',
          }).pipe(withResumePort(mockTryResume())),
        ).toEqual({ status: 'queued' });
        expect(yield* taken(input)).toEqual(['child progress']);
      }),
  );

  it.effect(
    'queues a live notification for a waiting run without waking it',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'queue' });
        const tryResumeRun = mockTryResume();

        expect(
          yield* submitFollowUp(runId, user('child progress'), {
            session,
            mode: 'live_notification',
          }).pipe(withResumePort(tryResumeRun)),
        ).toEqual({ status: 'queued' });
        expect(tryResumeRun).not.toHaveBeenCalled();
        expect(recorded.queued(runId)).toEqual(['child progress']);
      }),
  );

  it.effect('wakes a run once and orders concurrent submissions', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession({ kind: 'queue' });
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
      expect(tryResumeRun).toHaveBeenCalledTimes(1);
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
        const session = fakeSession({ kind: 'queue' });
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
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        resumed.resolve(false);
        // The wake runs on the session's fork: it answers the decline even
        // though the fiber that dispatched it is gone.
        yield* settle;

        // The input is the run's row, whichever reader takes it next.
        expect(recorded.queued(runId)).toEqual(['keep this input']);
      }),
  );

  it.effect('answers a faulted resume as a failed wake', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession({ kind: 'queue' });
      expect(
        yield* submitFollowUp(runId, user('keep this input'), {
          session,
        }).pipe(
          withResumePort(() => Effect.fail(new Error('resume prep failed'))),
        ),
      ).toEqual({ status: 'queued', wake: 'failed' });
      expect(recorded.queued(runId)).toEqual(['keep this input']);
    }),
  );

  it.effect('wakes a run whose generation has ended', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession({ kind: 'queue' });
      yield* Effect.scoped(session.followUps.open(runId));
      const tryResumeRun = mockTryResume();

      expect(
        yield* submitFollowUp(runId, user('continue'), { session }).pipe(
          withResumePort(tryResumeRun),
        ),
      ).toEqual({ status: 'queued' });
      expect(tryResumeRun).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect(
    'admits a child delivery to the retained queue after the parent completes',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'queue' });
        const deriveSpy = vi.spyOn(resumability, 'deriveResumability');

        expect(
          yield* submitFollowUp(
            runId,
            {
              text: 'retained child result',
              from: { kind: 'run' as const, runId: 'c41dc41dc41d' as RunId },
            },
            { session },
          ).pipe(withResumePort(mockTryResume())),
        ).toEqual({ status: 'queued' });

        expect(deriveSpy).not.toHaveBeenCalled();
        expect(recorded.queued(runId)).toEqual(['retained child result']);
      }),
  );

  it.effect('refuses child delivery to a parent with no session', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession({
        kind: 'no_session',
        runStatus: 'completed',
      });
      const tryResumeRun = mockTryResume();

      expect(
        yield* submitFollowUp(runId, childResult('late'), { session }).pipe(
          withResumePort(tryResumeRun),
        ),
      ).toEqual({ status: 'failed', reason: 'read_failed' });
      expect(tryResumeRun).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'admits a replayed child delivery at most once and wakes at most once',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'queue' });
        const tryResumeRun = mockTryResume();
        const delivery = childResult('exec-1:turn:1:delivery');

        expect(
          yield* submitFollowUp(runId, delivery, { session }).pipe(
            withResumePort(tryResumeRun),
          ),
        ).toEqual({ status: 'queued' });
        expect(tryResumeRun).toHaveBeenCalledTimes(1);

        // A producer repeating the same logical result must not append
        // another parent message nor trigger another parent wake.
        for (let replay = 0; replay < 100; replay++) {
          expect(
            yield* submitFollowUp(runId, delivery, { session }).pipe(
              withResumePort(tryResumeRun),
            ),
          ).toEqual({ status: 'sent' });
        }
        expect(tryResumeRun).toHaveBeenCalledTimes(1);
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
  it.effect('opens one reader per run: a second is a defect', () =>
    Effect.gen(function* () {
      const { followUps } = recordedFollowUps();
      const id = generateRunId();
      yield* followUps.open(id);
      const second = yield* Effect.exit(Effect.scoped(followUps.open(id)));
      expect(Exit.isFailure(second) && !Exit.hasInterrupts(second)).toBe(true);
    }),
  );

  it.effect(
    'delivers a successor reader every row still queued, in commit order',
    () =>
      Effect.gen(function* () {
        const { followUps, queued } = recordedFollowUps();
        const id = generateRunId();
        yield* Effect.scoped(
          Effect.andThen(
            followUps.open(id),
            followUps.send(id, user('before handoff')),
          ),
        );
        expect(
          yield* followUps.send(id, user('between generations'), {
            wake: true,
          }),
        ).toEqual({ kind: 'queued', read: false, wake: true });

        expect(queued(id)).toEqual(['before handoff', 'between generations']);
        const input = yield* followUps.open(id);
        expect(yield* taken(input)).toEqual([
          'before handoff',
          'between generations',
        ]);
      }),
  );

  it.effect('owes no wake to a run a generation here holds', () =>
    Effect.gen(function* () {
      const { followUps, live } = recordedFollowUps();
      const id = generateRunId();
      live.add(id);
      expect(
        yield* followUps.send(id, user('queued for it'), { wake: true }),
      ).toEqual({ kind: 'queued', read: false, wake: false });
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
        expect(yield* followUps.send(id, delivery, { wake: true })).toEqual({
          kind: 'refused',
          reason: 'owned_elsewhere',
        });
      }
      expect(claims).toEqual([id, id]);
      expect(queued(id)).toEqual([]);
    }),
  );

  it('counts only a live holder as held elsewhere', () => {
    const owner = JSON.stringify(['other-host', 4321, null]);
    const notOwner = (ownerId: string | null, closed: boolean) =>
      new DatabaseNotOwner({
        aggregateId: aggregateId('run', generateRunId()),
        ownerId,
        closed,
      });
    const refused = new DatabaseWriteFailed({
      path: ':memory:',
      cause: new DatabaseClaimRefused({ ownerId: owner, verdict: 'alive' }),
    });
    expect(heldElsewhereBy(refused)).toBe(owner);
    expect(heldElsewhereBy(notOwner(owner, false))).toBe(owner);
    // A closed aggregate is finished, an ownerless one free: neither refuses
    // as another process's run.
    expect(heldElsewhereBy(notOwner(owner, true))).toBeNull();
    expect(heldElsewhereBy(notOwner(null, false))).toBeNull();
  });

  it.effect("ends a deleted run's reader and tells the observers", () =>
    Effect.gen(function* () {
      const { followUps } = recordedFollowUps();
      const id = generateRunId();
      const closed: InboxClosed[] = [];
      followUps.onClosed((event) => closed.push(event));
      const input = yield* followUps.open(id);

      followUps.forget(id);
      expect(yield* input.take).toBeNull();
      expect(closed).toEqual([{ kind: 'run', runId: id }]);
    }),
  );

  it.effect(
    'tells the observers of a terminal end, not a recoverable one',
    () =>
      Effect.gen(function* () {
        const { followUps } = recordedFollowUps();
        const closed: InboxClosed[] = [];
        followUps.onClosed((event) => closed.push(event));
        const parked = generateRunId();
        const done = generateRunId();
        yield* Effect.scoped(followUps.open(parked));
        const input = yield* followUps.open(done);
        followUps.release(done, input, true);
        expect(closed).toEqual([{ kind: 'run', runId: done }]);
      }),
  );

  it.effect('refuses every send after dispose', () =>
    Effect.gen(function* () {
      const { followUps } = recordedFollowUps();
      const id = generateRunId();
      const closed: InboxClosed[] = [];
      followUps.onClosed((event) => closed.push(event));
      const input = yield* followUps.open(id);
      followUps.dispose();

      // Per-session observers (subscription pollers) let the session go.
      expect(closed).toEqual([{ kind: 'session' }]);
      expect(yield* input.take).toBeNull();
      expect(yield* followUps.send(id, user('late'), { wake: true })).toEqual({
        kind: 'refused',
      });
      const reopened = yield* followUps.open(generateRunId());
      expect(yield* reopened.take).toBeNull();
    }),
  );

  it.effect('wakes for a /compact alone, never in a batch with messages', () =>
    Effect.gen(function* () {
      const followUp = (text: string) => ({
        followUpId: text,
        content: { text, from: { kind: 'user' as const } },
      });
      const pending: QueuedFollowUp[] = [
        { ...followUp('/compact'), control: { kind: 'compact' } },
      ];
      const input = new RunInput(Effect.sync(() => pending));

      expect(yield* input.take).toMatchObject({
        kind: 'synthetic',
        text: expect.stringContaining('immediate context compaction'),
      });
      pending.push(followUp('first'), followUp('second'));
      input.notify();
      // Messages first; the request stays queued for the boundary.
      expect(yield* input.take).toEqual({
        kind: 'followUps',
        followUps: [followUp('first'), followUp('second')],
      });
      expect(yield* input.controls).toHaveLength(1);
      input.end();
      expect(yield* input.take).toBeNull();
    }),
  );
});

describe('Inbox delivery identity (#9531)', () => {
  it.effect(
    'suppresses a replayed delivery id instead of queueing it again',
    () =>
      Effect.gen(function* () {
        const { followUps, queued } = recordedFollowUps();
        const id = generateRunId();
        yield* followUps.open(id);
        const delivery = childResult('exec-1:turn:1:delivery');

        expect(yield* followUps.send(id, delivery)).toEqual({
          kind: 'queued',
          read: true,
          wake: false,
        });
        for (let replay = 0; replay < 100; replay++) {
          expect(yield* followUps.send(id, delivery)).toEqual({
            kind: 'duplicate',
          });
        }
        expect(queued(id)).toEqual(['child result']);
      }),
  );

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
        expect(second).toEqual(
          Exit.succeed({ kind: 'queued', read: true, wake: false }),
        );
        expect(queued(id)).toEqual(['child result']);
      }),
  );

  it.effect(
    'keeps distinct delivery ids distinct even with identical text',
    () =>
      Effect.gen(function* () {
        const { followUps, queuedRows } = recordedFollowUps();
        const id = generateRunId();
        for (const deliveryId of ['d1', 'd2'])
          yield* followUps.send(id, childResult(deliveryId));
        expect(queuedRows(id).map((row) => row.followUpId)).toEqual([
          'd1',
          'd2',
        ]);
      }),
  );

  it.effect(
    'finds a replayed id still queued, writing nothing, and owes the wake again',
    () =>
      Effect.gen(function* () {
        const { followUps, queued } = recordedFollowUps();
        const id = generateRunId();
        const delivery = childResult('d1');
        yield* followUps.send(id, delivery);

        expect(yield* followUps.send(id, delivery, { wake: true })).toEqual({
          kind: 'queued',
          read: false,
          wake: true,
        });
        expect(queued(id)).toEqual(['child result']);
      }),
  );

  it.effect('never suppresses input that carries no delivery id', () =>
    Effect.gen(function* () {
      const { followUps, queuedRows } = recordedFollowUps();
      const id = generateRunId();
      yield* followUps.send(id, user('repeat me'));
      yield* followUps.send(id, user('repeat me'));

      const rows = queuedRows(id);
      expect(rows.map((row) => row.content.text)).toEqual([
        'repeat me',
        'repeat me',
      ]);
      expect(rows[0]!.followUpId).not.toBe(rows[1]!.followUpId);
    }),
  );
});

describe('Inbox visibility held on the row', () => {
  it.effect(
    'reads a pause notice only beside an instruction, and wakes nobody for it',
    () =>
      Effect.gen(function* () {
        const { followUps } = recordedFollowUps();
        const id = generateRunId();
        const notice = { ...childResult('paused'), text: 'child paused' };
        expect(
          yield* followUps.send(id, notice, {
            hold: 'instruction',
            wake: true,
          }),
        ).toEqual({ kind: 'queued', read: false, wake: false });
        const input = yield* followUps.open(id);
        expect(yield* input.hasQueued).toBe(false);

        yield* followUps.send(id, user('go on'));
        expect(yield* taken(input)).toEqual(['child paused', 'go on']);
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
        followUps.closeInput(closed);
        yield* settle;

        expect(
          yield* followUps.send(closed, user('still closed'), { wake: true }),
        ).toEqual({ kind: 'refused' });
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

  it.effect('keeps a run with queued input open', () =>
    Effect.gen(function* () {
      const { followUps, queued } = recordedFollowUps();
      const id = generateRunId();
      yield* followUps.send(id, user('raced'));
      followUps.closeInput(id);
      yield* settle;

      expect(yield* followUps.send(id, user('later'))).toMatchObject({
        kind: 'queued',
      });
      expect(queued(id)).toEqual(['raced', 'later']);
    }),
  );
});

describe('presentFollowUpResult', () => {
  it('words only refusals, with a failed wake as information', () => {
    expect(presentFollowUpResult({ status: 'sent' })).toEqual({
      severity: 'none',
    });
    expect(presentFollowUpResult({ status: 'queued' })).toEqual({
      severity: 'none',
    });
    expect(
      presentFollowUpResult({ status: 'queued', wake: 'failed' }),
    ).toMatchObject({ severity: 'info' });
    expect(
      presentFollowUpResult({ status: 'failed', reason: 'owned_elsewhere' }),
    ).toMatchObject({
      severity: 'warning',
      message: expect.stringContaining('another TeXRA window'),
    });
  });
});

// The relation admission stamps on a run sender is read from lineage alone.
describe('run relation', () => {
  const root = 'a0a000000001' as RunId;
  const parent = 'ba5e00000001' as RunId;
  const child = 'c41d00000001' as RunId;
  const sibling = '51b100000001' as RunId;
  const peer = '9ee900000001' as RunId;
  const parents = new Map<RunId, RunId>([
    [parent, root],
    [child, parent],
    [sibling, parent],
  ]);
  const relationOf = (from: RunId, to: RunId) =>
    runRelation(from, to, (runId) => parents.get(runId) ?? null);

  it('reads each relation from lineage', () => {
    expect(relationOf(parent, child)).toBe('parent');
    expect(relationOf(child, parent)).toBe('child');
    expect(relationOf(root, child)).toBe('ancestor');
    expect(relationOf(child, root)).toBe('descendant');
    expect(relationOf(sibling, child)).toBe('sibling');
    expect(relationOf(peer, child)).toBe('peer');
  });
});
