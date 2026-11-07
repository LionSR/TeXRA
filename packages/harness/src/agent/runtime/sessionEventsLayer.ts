/**
 * The session event plane over its root's SQLite database. Each job commits
 * one transaction, then publishes the rows it wrote, from memory, to the
 * session's subscribers in commit order. Listing and aggregate reads are
 * finite; a tail reads what it starts behind from the store and follows the
 * publisher's batches after.
 */
// Third-party imports
import {
  Array as Arr,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Stream,
  SubscriptionRef,
  type Take,
} from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { writeLogLine } from '@logger/logSink';
import {
  isDisplayRow,
  type AggregateId,
  type CommitOrdinal,
  type DisplayRow,
  type SessionRow,
} from '@shared/schemas';
import {
  Database,
  type DatabaseReadFailed,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import { closesRunWindow } from '@shared/session/runRowReads';
import {
  InPublisherJob,
  SessionEvents,
  type Append,
  type CommittedBatch,
  type OpenWork,
  type SessionEventsShape,
} from '@shared/session/sessionEvents';

const CHANNEL = 'sessionEvents';

/** The budget one session close spends waiting for its runs to end before it
 *  reports the ones still live abandoned (`SessionOwner.close`). A hung run
 *  must not wedge desktop quit, eat the extension's ~5s deactivate budget, or
 *  stall a CLI SIGTERM indefinitely. The closes of a process's sessions start
 *  together, so they finish under one deadline for the process, not one each. */
export const SESSION_CLOSE_DEADLINE_MS = 5_000;

/** What the publisher keeps per aggregate: its open work, so closing it at
 *  a park, an end or a host exit reads no rows. Streams close at a phase
 *  move that rests or ends the run, stages only on their own rows. An
 *  earlier process's work is not here: its streams close at that same move,
 *  and a stage it left open closes on the run's outcome when the view's
 *  transcript applies its `run.end`. */
type OpenWorkByAggregate = Map<AggregateId, Map<string, OpenWork>>;

/** One unit of the publisher's work, bound to its append and built when
 *  the publisher runs it: an awaited one settles the deferred its enqueuer
 *  waits on with the job's own exit. `refuse` is what the close does with
 *  a job it will not run (past the close deadline). */
interface PublicationJob {
  readonly run: Effect.Effect<void>;
  readonly refuse: Effect.Effect<void>;
}

/** Why the close settled a publication it did not finish: never run, or
 *  cut at the deadline (it may have committed before the cut). */
const refusal = (cut: boolean): Error =>
  new Error(
    cut
      ? 'Session publication cut at the close deadline; whether it committed is unknown'
      : 'Session publication refused: the plane has closed',
  );

/** What the publisher keeps open per aggregate, from the rows it commits:
 *  `track` folds a committed batch in, `openWork` reads one aggregate's. */
function openWorkTracker(): {
  readonly track: (rows: readonly SessionRow[]) => void;
  readonly openWork: SessionEventsShape['openWork'];
} {
  const aggregates: OpenWorkByAggregate = new Map();
  const track = (rows: readonly SessionRow[]) => {
    for (const row of rows) {
      if (row.type === 'run.removed') {
        aggregates.delete(row.aggregateId);
        continue;
      }
      const work = aggregates.get(row.aggregateId) ?? new Map();
      const close = (kind: OpenWork['kind'], id: string) => {
        if (work.get(id)?.kind === kind) work.delete(id);
      };
      if (closesRunWindow(row)) {
        for (const [id, { kind }] of work) {
          if (kind === 'stream') work.delete(id);
        }
      } else if (row.type === 'stream.start' || row.type === 'stage.start') {
        const kind = row.type === 'stream.start' ? 'stream' : 'stage';
        work.set(row.id, { kind, id: row.id });
      } else if (row.type === 'stream.end') {
        close('stream', row.id);
      } else if (row.type === 'stage.end') {
        close('stage', row.id);
      } else {
        continue;
      }
      if (work.size > 0) aggregates.set(row.aggregateId, work);
      else aggregates.delete(row.aggregateId);
    }
  };
  return {
    track,
    openWork: (id) => [...(aggregates.get(id)?.values() ?? [])],
  };
}

/** Run `job` and complete `done` with however it ended; one the close cut
 *  short, or never ran, is refused. */
function settling<A, E>(
  job: Effect.Effect<A, E>,
  done: Deferred.Deferred<A, E>,
): PublicationJob {
  const refuse = (cut: boolean) =>
    Effect.asVoid(Deferred.die(done, refusal(cut)));
  return {
    run: job.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.hasInterrupts(exit) ? refuse(true) : Deferred.done(done, exit),
      ),
      Effect.onInterrupt(() => refuse(true)),
      Effect.asVoid,
    ),
    refuse: refuse(false),
  };
}

/** An ordering job's `append`: it writes no row. */
const ordering: Append = () =>
  Effect.die(new Error('An ordering job appends nothing'));

/** A job that waits on its own publisher would wait forever. */
const reentered = Effect.die(
  new Error(
    'A publisher job waited on its own publisher: append through the job instead',
  ),
);

/**
 * The publisher and public event readers over the root's database. Each
 * reader supplies its own starting position.
 *
 * Publication is one inbox and one consumer fiber: every job, awaited
 * or detached, runs in the order it was enqueued as one SQLite transaction
 * (`Database.job`), and the table's commit order is that order. A job
 * stays interruptible: one cut before its commit rolls back whole, and
 * what the publisher tracks of its rows moves only once they committed.
 * Closing the plane ({@link SessionEventsShape.drain}) ends the inbox and
 * drains it inside one deadline; at the deadline the running job is cut
 * and every queued one refused. A job enqueued after that is refused too:
 * a detached one is logged and dropped, an awaited one is the caller's
 * defect, as is a job that waits on its own publisher.
 */
export const sessionEventsLayer = Layer.effect(
  SessionEvents,
  Effect.gen(function* () {
    const log = yield* Database;
    const { track, openWork } = openWorkTracker();
    const committed = yield* PubSub.unbounded<Take.Take<CommittedBatch>>();
    let head = yield* log.currentCommit;
    /** What a committed job wrote, tracked and published in commit order:
     *  `head` moves first, so a reader that subscribes between the two
     *  steps reads the batch from the store and drops its copy. */
    const publish = (rows: readonly SessionRow[]) =>
      Effect.suspend(() => {
        const last = rows.at(-1);
        if (last === undefined) return Effect.void;
        track(rows);
        head = last.commit;
        return PubSub.publish(committed, [
          { rows: log.displayRows(rows), through: last.commit },
        ]);
      });
    /** One job: one transaction (`Database.job`), or in its place with
     *  none (`order`). What it wrote is published once the transaction
     *  committed, so a rolled-back job publishes nothing, and a commit is
     *  never left unpublished by an interrupt. */
    const inTransaction = <A, E>(
      job: (append: Append, appended: SessionRow[]) => Effect.Effect<A, E>,
      order = false,
    ): Effect.Effect<A, E | DatabaseWriteFailed> => {
      if (order) return job(ordering, []);
      const appended: SessionRow[] = [];
      // Both of `appendAll`'s rejections (a closed aggregate, a failed
      // write) pass through typed, not as defects.
      const append: Append = (events) =>
        Effect.tap(log.appendAll(events), (rows) =>
          Effect.sync(() => appended.push(...rows)),
        );
      return Effect.uninterruptibleMask((restore) =>
        restore(log.job(Effect.suspend(() => job(append, appended)))).pipe(
          Effect.tap(() => publish(appended)),
        ),
      );
    };
    const inbox = yield* Queue.unbounded<PublicationJob, Cause.Done>();
    // One job per take, never a batch: a job the close refuses is one the
    // consumer never took. It ends when the ended inbox runs dry.
    const consumer = yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(Queue.take(inbox), (job) => job.run),
        { disableYield: true },
      ).pipe(Effect.catchIf(Cause.isDone, () => Effect.void)),
    );
    // Cached: the session's close and the publisher's scope both run it,
    // and only the first waits.
    const drain: SessionEventsShape['drain'] = yield* Effect.cached(
      Effect.gen(function* () {
        yield* Queue.end(inbox);
        // Interruptible inside the close's uninterruptible region, so the
        // deadline can cut the wait.
        const ended = yield* Fiber.await(consumer).pipe(
          Effect.interruptible,
          Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
        );
        // At the deadline the running job is cut; its transaction rolls back
        // unless it had committed.
        if (Option.isNone(ended)) {
          // A detached job cut here, whose write then fails, is heard by
          // nobody: say the cut happened.
          yield* Effect.logWarning(
            'Session publisher cut at the close deadline; a job it was running may not have been written',
          ).pipe(withLogChannel(CHANNEL));
          yield* Fiber.interrupt(consumer);
        } else if (
          Exit.isFailure(ended.value) &&
          !Cause.hasInterruptsOnly(ended.value.cause)
        ) {
          yield* Effect.logWarning(
            'Session publisher ended abnormally on close',
          ).pipe(
            Effect.annotateLogs({ data: Cause.squash(ended.value.cause) }),
            withLogChannel(CHANNEL),
          );
        }
        // Whatever the consumer never ran (the deadline cut it, or it died)
        // is refused, never left for its awaiter to wait on.
        const refused = yield* Queue.clear(inbox).pipe(Effect.orDie);
        yield* Effect.forEach(refused, (job) => job.refuse, { discard: true });
        if (refused.length > 0)
          yield* Effect.logWarning(
            `Session publisher closed; ${refused.length} queued publications refused`,
          ).pipe(withLogChannel(CHANNEL));
      }),
    );
    // The tails end once the inbox has run dry.
    yield* Effect.addFinalizer(() =>
      Effect.andThen(drain, PubSub.end(committed, Exit.void)),
    );
    const enqueue = (job: PublicationJob): boolean =>
      Queue.offerUnsafe(inbox, job);
    /** Enqueue `job` and wait for its exit. */
    const awaited = Effect.fn('awaited')(function* <A, E>(
      job: Effect.Effect<A, E | DatabaseWriteFailed>,
    ): Effect.fn.Return<A, E | DatabaseWriteFailed> {
      if (yield* InPublisherJob) return yield* reentered;
      const done = yield* Deferred.make<A, E | DatabaseWriteFailed>();
      if (!enqueue(settling(job, done))) {
        return yield* Effect.die(
          new Error('Session publication after the plane closed'),
        );
      }
      return yield* Deferred.await(done);
    });
    const transact: SessionEventsShape['transact'] = (job, options = {}) =>
      awaited(inTransaction(job, options.order));
    const removeRun: SessionEventsShape['removeRun'] = (
      id,
      expectedStartCommit,
    ) =>
      awaited(
        inTransaction((_, appended) =>
          Effect.tap(log.runRemoval(id, expectedStartCommit), (rows) =>
            Effect.sync(() => appended.push(...rows)),
          ),
        ),
      );
    const detach: SessionEventsShape['detach'] = (job, options = {}) => {
      const admitted = enqueue({
        run: inTransaction(job, options.order).pipe(
          Effect.catchCause((cause) =>
            Effect.logError('Session publication failed').pipe(
              Effect.annotateLogs({ data: Cause.squash(cause) }),
              withLogChannel(CHANNEL),
              Effect.andThen(
                Effect.sync(() => options.failed?.(Cause.squash(cause))),
              ),
            ),
          ),
        ),
        refuse: Effect.void,
      });
      // Direct sink write: `detach` is the synchronous door for producers
      // with no fiber, and the refusing plane's publisher fiber has ended.
      if (!admitted)
        writeLogLine(
          CHANNEL,
          'Session publication dropped: the plane has closed',
        );
    };
    return {
      transact,
      detach,
      removeRun,
      drain,
      openWork,
      head: () => head,
      subscribe: PubSub.subscribe(committed),
      listing: () =>
        Stream.fromIterableEffect(log.readListing()).pipe(
          Stream.filter(isDisplayRow),
        ),
      all: (fromCommit, drained) =>
        Stream.unwrap(
          Effect.map(PubSub.subscribe(committed), (subscription) => {
            // Read after subscribing: every batch past it reaches the
            // subscription.
            const published = head;
            return released(
              Stream.concat(
                fromCommit < published
                  ? readThrough(log.readDisplay, fromCommit, published)
                  : Stream.empty,
                Stream.flattenTake(Stream.fromSubscription(subscription)),
              ),
              fromCommit,
              drained,
            );
          }),
        ),
    };
  }),
);

/** One read of the rows above `fromCommit` through `upTo`, never past it,
 *  as batches: a page at a time, then the whole range, rows the store no
 *  longer held included. */
const readThrough = (
  read: (
    fromCommit: CommitOrdinal,
  ) => Stream.Stream<DisplayRow, DatabaseReadFailed>,
  fromCommit: CommitOrdinal,
  upTo: CommitOrdinal,
): Stream.Stream<CommittedBatch, DatabaseReadFailed> =>
  Stream.concat(
    read(fromCommit).pipe(
      Stream.takeWhile((event) => event.commit <= upTo),
      Stream.mapArray((rows) => [
        { rows, through: Arr.lastNonEmpty(rows).commit },
      ]),
    ),
    Stream.succeed({ rows: [], through: Math.max(fromCommit, upTo) }),
  );

/** The rows of `batches` above `fromCommit`, each once. `drained`, when
 *  given, receives the commit each batch covered, rows the store no longer
 *  held included, only once its rows have reached the reader (as the reader
 *  pulls past them). A row the store no longer holds emits nothing, so a
 *  reader that must know the tail passed an ordinal (the NDJSON detach
 *  drain) waits on this coordinate, never on the events alone. */
const released = <E>(
  batches: Stream.Stream<CommittedBatch, E>,
  fromCommit: CommitOrdinal,
  drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
): Stream.Stream<DisplayRow, E> =>
  Stream.suspend(() => {
    let at = fromCommit;
    return Stream.flatMap(batches, ({ rows, through }) => {
      const fresh = Stream.fromIterable(rows.filter((row) => row.commit > at));
      at = Math.max(at, through);
      if (drained === undefined) return fresh;
      const covered = Stream.fromEffect(SubscriptionRef.set(drained, at));
      return Stream.concat(fresh, Stream.drain(covered));
    });
  });
