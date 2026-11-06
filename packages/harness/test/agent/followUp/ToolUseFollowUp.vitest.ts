import { it } from '@effect/vitest';
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Scheduler,
  Semaphore,
  Context,
} from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import {
  generateRunId,
  qualifyAggregateId,
  RunIdSchema,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@texra-ai/harness/schemas';
import { DatabaseWriteFailed } from '@texra-ai/harness/host';
import * as resumability from '@agent/storage/resumability';
import { Inbox, SessionInbox, type InboxPort } from '@agent/followUp/Inbox';
import { RunInput } from '@agent/followUp/RunInput';
import { REFUSED, submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { Interactions } from '@agent/runtime/HostInteractions';
import * as resumeRunModule from '@agent/runtime/resumeRun';
import { Runs } from '@agent/runtime/runRegistry';
import type { RunsShape } from '@agent/runtime/runs';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import type { Append } from '@shared/session/sessionEvents';
import {
  runStateAppend,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { RUN_ROW_READS, runRowsFrom } from '@shared/session/runRowReads';
import type { CommitOrdinal } from '@texra-ai/harness/transcript';

/** Let a forked submission reach its parked resume Promise. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

/** What a log transaction's job receives (its last `transact` overload). */
type Transaction = Parameters<
  Parameters<SessionLog['Service']['transact']>[0]
>[0];

/** What the resume a wake asks answers. */
type TryResume = (
  runId: RunId,
) => Effect.Effect<resumeRunModule.ResumeHandOff, Error>;

/** The case's answer to the resume a wake reaches (`resumeRun`), served in
 *  its place: the fake session holds no run records to resume from. */
let tryResume: TryResume = () => Effect.succeed(REFUSED);

/** The answer of a resume that activated the run. */
// cast: the fake resume commits at the first ordinal.
const ACTIVATED = { activation: 1 as CommitOrdinal } as const;

const withResumePort =
  (resume: TryResume) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      tryResume = resume;
      return effect;
    });

/**
 * The admission boundary over a recorded session plane: one serializer (a
 * one-permit semaphore standing in for the publisher) and the rows it
 * appended. `queued(runId)` is the text of every
 * `followup.queued` row written for the run, in order; what a reader takes
 * is what the rows still queue, as the publisher's pending set holds it.
 * `live` is the runs a generation holds here (the run registry's answer).
 * `failWrites` refuses that many appends.
 */
function recordedFollowUps(options: { failWrites?: number } = {}) {
  const rows: SessionEvent[] = [];
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
          // cast: a committed draft is the event the log would return.
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
  // cast: the fake log serves only what a follow-up reads.
  const log = {
    transact: <A, E>(
      work:
        | readonly SessionEventDraft[]
        | ((tx: Transaction) => Effect.Effect<A, E>),
    ) =>
      typeof work === 'function'
        ? publisher.withPermits(1)(work({ append }))
        : publisher.withPermits(1)(runStateAppend(append)(work)),
    runRows: (id, read) =>
      Effect.sync(() => {
        const kinds: readonly string[] = RUN_ROW_READS[read];
        return runRowsFrom(
          rows.filter(
            (row) => row.aggregateId === id && kinds.includes(row.type),
          ),
        );
      }),
    history: (id, _from, types = []) =>
      Effect.sync(() =>
        rows.filter(
          (row) => row.aggregateId === id && types.includes(row.type),
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
    hold: () => Effect.void,
    settled: Effect.void,
  } as InboxPort['log'];
  const followUps = new SessionInbox({
    log,
    detach: (job) => {
      Effect.runFork(publisher.withPermits(1)(job(append)));
    },
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

function fakeSession(state: RunState): Context.Context<SessionServices> {
  if (state === 'idle')
    vi.spyOn(resumability, 'checkpointRefusal').mockReturnValue(
      Effect.succeed(null),
    );
  // The resume a wake asks is the case's answer, whichever fiber asks it.
  vi.spyOn(resumeRunModule, 'resumeRun').mockImplementation((runId) =>
    tryResume(runId),
  );
  recorded = recordedFollowUps();
  const { followUps } = recorded;
  // cast: the fake view knows every run, with no fields.
  const view = { run: () => ({}) } as unknown as SessionViewAccess['Service'];
  // cast: the fake log serves only what a wake reads.
  const log = {
    records: () => Effect.succeed([]),
  } as unknown as SessionLog['Service'];
  // cast: a send reads only which runs a loop here drives: every one in
  // the `live` case, with a loop that reads messages.
  const runs = {
    get: (runId: RunId) =>
      state === 'live'
        ? {
            runId,
            controls: undefined,
            readsMessages: true,
            drained: Effect.void,
          }
        : undefined,
  } as unknown as RunsShape;
  // cast: a wake and a send read only these owners of the session.
  const session = Context.make(Runs, runs).pipe(
    Context.add(SessionViewAccess, view),
    Context.add(SessionLog, log),
    // cast: a follow-up only emits interactions.
    Context.add(Interactions, {
      emit: () => Effect.void,
    } as unknown as Interactions['Service']),
    Context.add(Inbox, followUps),
  ) as unknown as Context.Context<SessionServices>;
  return session;
}

const user = (text: string) => ({ text, from: { kind: 'user' as const } });

const childResult = (deliveryId: string) => ({
  text: 'child result',
  from: { kind: 'run' as const, runId: RunIdSchema.make('c41dc41dc41d') },
  deliveryId,
});

describe('submitFollowUp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.live(
    'orders concurrent submissions to an idle run, their fibers yielding every few steps',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession('idle');

        const fibers = [];
        for (const text of ['one', 'two', 'three']) {
          fibers.push(
            yield* Effect.forkChild(
              submitFollowUp(runId, user(text), {}).pipe(
                withResumePort(() => Effect.succeed(ACTIVATED)),
                Effect.provide(session),
              ),
            ),
          );
        }
        // Each send commits in call order, whatever the interleaving: the
        // run's send lane holds a later send until the earlier one's row.
        for (const fiber of fibers)
          expect(yield* Fiber.join(fiber)).toEqual({ status: 'queued' });
        expect(recorded.queued(runId)).toEqual(['one', 'two', 'three']);
      }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)),
  );

  it.effect(
    'keeps the input queued when the submitting fiber is interrupted mid-wake',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession('idle');
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          submitFollowUp(runId, user('keep this input'), {}).pipe(
            Effect.provide(session),
            withResumePort(() => {
              Deferred.doneUnsafe(started, Effect.void);
              return Effect.never;
            }),
          ),
        );
        // The interrupt below lands on a wake already in flight.
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);

        // The send is durable before its wake: the input is the run's row,
        // whichever reader takes it next.
        expect(recorded.queued(runId)).toEqual(['keep this input']);
      }),
  );

  it.effect('admits a replayed child delivery at most once', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession('live');
      const tryResumeRun = () => Effect.succeed(ACTIVATED);
      const delivery = childResult('exec-1:turn:1:delivery');

      expect(
        yield* submitFollowUp(runId, delivery, {}).pipe(
          withResumePort(tryResumeRun),
          Effect.provide(session),
        ),
      ).toEqual({ status: 'queued' });

      // A producer repeating the same logical result must not append
      // another parent message; the live generation reads the one row.
      for (let replay = 0; replay < 100; replay++) {
        expect(
          yield* submitFollowUp(runId, delivery, {}).pipe(
            withResumePort(tryResumeRun),
            Effect.provide(session),
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
        yield* followUps.owesResume(id);

        const input = yield* followUps.open(id);
        expect(yield* taken(input)).toEqual([
          'during the first generation',
          'between generations',
        ]);
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
          reason: 'notResumable',
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
