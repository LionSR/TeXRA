/**
 * The session event plane over its root's SQLite database. Publication commits
 * an ordered batch before waking readers. Listing and aggregate reads are
 * finite; each tail wake captures a committed upper bound and drains that
 * prefix. Wake counters and commit ordinals are separate coordinates, so a
 * claim change can wake a reader without inventing an event.
 */
// Third-party imports
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { AgentEvent } from '@agent/trace';
import { createLog } from '@logger/logUtils';
import {
  aggregateId as qualifyAggregateId,
  isDisplaySessionEvent,
  type CommitOrdinal,
  type SessionEvent,
  type DisplaySessionEvent,
  type SessionEventDraft,
  type RunId,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import {
  SessionEvents,
  type Append,
  type SessionCursor,
  type SessionEventsShape,
} from '@shared/session/sessionEvents';
import { aggregateError } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

const logger = createLog('sessionEvents');

/** One unit of the publisher's work: a job over the log's append, and the
 *  deferred its enqueuer waits on, if any. */
interface PublicationJob {
  readonly run: (append: Append) => Effect.Effect<unknown, unknown>;
  readonly done: Deferred.Deferred<unknown, unknown>;
}

/** The log's append, reporting the last commit each call produced. */
function trackingAppend(
  append: Append,
  onCommit: (commit: CommitOrdinal) => void,
): Append {
  return (events) =>
    append(events).pipe(
      Effect.tap((rows) =>
        Effect.sync(() => {
          const last = rows.at(-1);
          if (last !== undefined) onCommit(last.commit);
        }),
      ),
    );
}

/** The tail drain (C7): read forward from the caller's position on each
 * wake, never past the committed upper bound captured for that read. A level says "there is more", not "there is one more", so a
 * burst of commits during a read collapses into one further read. A read
 * delivers up to the level it started at whether or not every row in
 * between materialized, so a row the read could not deliver is not read
 * again on every later wake.
 *
 * `drained`, when given, receives the commit each forward read covered,
 * rows the read could not materialize included, and only once every row of
 * that read has reached the reader (it is set after the read's stream
 * completes). A row the store no longer holds emits nothing, so a reader
 * that must know the tail passed an ordinal (the NDJSON detach drain) waits
 * on this coordinate, never on the events alone.
 */
export function tailFrom<A extends SessionEvent>(
  read: (fromCommit: SessionCursor) => Stream.Stream<A>,
  level: {
    readonly get: Effect.Effect<CommitOrdinal>;
    readonly changes: Stream.Stream<CommitOrdinal>;
  },
  fromCommit: SessionCursor,
  drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
): Stream.Stream<A> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const at = yield* Ref.make(fromCommit);
      const forward = Stream.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.get(at);
          const upTo = yield* level.get;
          return Stream.concat(
            read(cursor).pipe(
              Stream.takeWhile((event) => event.commit <= upTo),
              Stream.tap((event) => Ref.set(at, event.commit)),
            ),
            Stream.fromEffect(
              Effect.gen(function* () {
                const covered = yield* Ref.updateAndGet(at, (delivered) =>
                  Math.max(delivered, upTo),
                );
                if (drained) yield* SubscriptionRef.set(drained, covered);
              }),
            ).pipe(Stream.drain),
          );
        }),
      );
      return level.changes.pipe(
        Stream.flatMap(() => forward, { concurrency: 1 }),
      );
    }),
  );
}

/**
 * The publisher and public event readers over the root's database. Each
 * reader supplies its own starting position.
 *
 * Publication is one inbox and one consumer fiber (C6): every job, awaited
 * or detached, runs in the order it was enqueued, and the table's commit
 * order is that order. The fiber runs each job uninterruptibly, so closing
 * the plane ends the inbox and drains what it holds before the fiber ends;
 * a job enqueued after that is refused: a detached one is logged and
 * dropped, an awaited one is the caller's defect.
 */
export const sessionEventsLayer = Layer.effect(
  SessionEvents,
  Effect.gen(function* () {
    const log = yield* Database;
    // Both of `appendAll`'s refusals pass through typed (D6 b): a lost
    // single-owner race is the caller's fact to act on, not a defect.
    const append: Append = (events) => log.appendAll(events);
    const inbox = yield* Queue.unbounded<PublicationJob, Cause.Done>();
    const consumer = yield* Effect.forkScoped(
      Stream.fromQueue(inbox).pipe(
        Stream.runForEach((job) =>
          Effect.uninterruptible(
            job.run(append).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Deferred.done(job.done, exit)),
            ),
          ),
        ),
      ),
    );
    // Registered after the fork, so it runs before the fork's own finalizer:
    // the inbox ends, the fiber drains what is queued, and only then goes.
    yield* Effect.addFinalizer(() =>
      Queue.end(inbox).pipe(
        Effect.andThen(Fiber.join(consumer)),
        Effect.ignore,
      ),
    );
    const enqueue = (job: PublicationJob): boolean =>
      Queue.offerUnsafe(inbox, job);
    const exclusive = <A, E>(
      job: (append: Append) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<A, E>();
        const admitted = enqueue({
          run: job,
          done: done as unknown as PublicationJob['done'],
        });
        if (!admitted) {
          return yield* Effect.die(
            new Error('Session publication after the plane closed'),
          );
        }
        return yield* Deferred.await(done);
      });
    const publish = Effect.fn('SessionEvents.publish')(function* (
      events: readonly SessionEventDraft[],
    ) {
      return yield* exclusive((append) => append(events));
    });
    /** Detached jobs still running or queued: what `settle` waits for.
     *  Failures belong to those deferreds, not to a session-wide leftover
     *  array a later settler would drain. Each completes with the last
     *  commit its job appended, so a settler waits for exactly its cohort. */
    const pending = new Set<Deferred.Deferred<CommitOrdinal | null, unknown>>();
    const detach: SessionEventsShape['detach'] = (job) => {
      const done = Deferred.makeUnsafe<CommitOrdinal | null, unknown>();
      pending.add(done);
      let committed: CommitOrdinal | null = null;
      const admitted = enqueue({
        run: (append) =>
          job(
            trackingAppend(append, (commit) => {
              committed = commit;
            }),
          ).pipe(
            Effect.map(() => committed),
            Effect.tapCause((cause) =>
              Effect.sync(() => {
                logger.error('Session publication failed', { data: cause });
              }),
            ),
            Effect.onExit(() => Effect.sync(() => pending.delete(done))),
          ),
        done: done as unknown as PublicationJob['done'],
      });
      if (!admitted) {
        pending.delete(done);
        logger.warn('Session publication dropped: the plane has closed');
      }
    };
    const settle: Effect.Effect<CommitOrdinal | null, Error> = Effect.suspend(
      () =>
        Effect.forEach([...pending], (done) =>
          Effect.exit(Deferred.await(done)),
        ),
    ).pipe(
      Effect.flatMap((exits) => {
        const failures = exits.flatMap((exit) =>
          Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
        );
        if (failures.length > 0) {
          return Effect.fail(
            ensureError(aggregateError(failures, 'Session publication failed')),
          );
        }
        let highest: CommitOrdinal | null = null;
        for (const exit of exits) {
          if (Exit.isSuccess(exit) && exit.value !== null) {
            highest =
              highest === null ? exit.value : Math.max(highest, exit.value);
          }
        }
        return Effect.succeed(highest);
      }),
    );
    // THE tail (C7): the drain woken by the log's level.
    const all = (
      fromCommit: SessionCursor,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ): Stream.Stream<DisplaySessionEvent> =>
      tailFrom(
        (from) =>
          Stream.fromIterableEffect(log.readAll(from).pipe(Effect.orDie)).pipe(
            Stream.filter(isDisplaySessionEvent),
          ),
        {
          get: log.currentCommit.pipe(Effect.orDie),
          changes: SubscriptionRef.changes(log.level),
        },
        fromCommit,
        drained,
      );
    return {
      publish,
      exclusive,
      detach,
      settle,
      listing: () =>
        Stream.fromIterableEffect(log.readListing().pipe(Effect.orDie)).pipe(
          Stream.filter(isDisplaySessionEvent),
        ),
      all,
      aggregate: (aggregateId, fromSeq) =>
        Stream.fromIterableEffect(
          log.readAggregate(aggregateId, fromSeq).pipe(Effect.orDie),
        ).pipe(Stream.filter(isDisplaySessionEvent)),
    };
  }),
);

/** A source trace fact on its run aggregate. Streaming chunks remain transient. */
export function runEventDraft(
  runId: RunId,
  event: AgentEvent,
): SessionEventDraft | null {
  if (event.type === 'stream.chunk') return null;
  const aggregateId = qualifyAggregateId('run', runId);
  if (event.type === 'run.config') {
    // The aggregate is the run: the row carries no second copy of its id.
    const { runId: _runId, ...body } = event;
    return { ...body, aggregateId };
  }
  return { ...event, aggregateId };
}
