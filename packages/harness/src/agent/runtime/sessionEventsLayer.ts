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
  Effect,
  Exit,
  FiberSet,
  Layer,
  PubSub,
  Scheduler,
  Stream,
  SubscriptionRef,
  type Take,
} from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { writeLogLine } from '@logger/logSink';
import {
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
  type SessionEventsShape,
} from '@shared/session/sessionEvents';

const CHANNEL = 'sessionEvents';

/** The budget one session close spends waiting for its runs to end before it
 *  reports the ones still live abandoned (`SessionOwner.close`). A hung run
 *  must not wedge desktop quit, eat the extension's ~5s deactivate budget, or
 *  stall a CLI SIGTERM indefinitely. The closes of a process's sessions start
 *  together, so they finish under one deadline for the process, not one each. */
export const SESSION_CLOSE_DEADLINE_MS = 5_000;

/** What the publisher keeps per aggregate: its open streams, so closing
 *  them at a park, an end or a host exit reads no rows. They close at a
 *  phase move that rests or ends the run. An earlier process's streams are
 *  not here: they close at that same move. A stage is no work of the
 *  publisher's: one left open closes on the run's outcome when the view's
 *  transcript applies its `run.end`. */
type OpenWorkByAggregate = Map<AggregateId, Set<string>>;

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
      const work = aggregates.get(row.aggregateId) ?? new Set();
      if (closesRunWindow(row)) {
        work.clear();
      } else if (row.type === 'stream.start') {
        work.add(row.id);
      } else if (row.type === 'stream.end') {
        work.delete(row.id);
      } else {
        continue;
      }
      if (work.size > 0) aggregates.set(row.aggregateId, work);
      else aggregates.delete(row.aggregateId);
    }
  };
  return {
    track,
    openWork: (id) => [...(aggregates.get(id) ?? [])],
  };
}

/** A job that opened another would publish the inner one's rows before its
 *  own transaction committed. */
const reentered = Effect.die(
  new Error(
    'A publisher job opened another publication: append through the job instead',
  ),
);

/**
 * The publisher and public event readers over the root's database. Each
 * reader supplies its own starting position.
 *
 * A publication is one SQLite transaction (`Database.job`) and the
 * publication of its rows, run where it is called as one uninterrupted
 * turn: the driver is synchronous, a job awaits nothing, and the scheduler
 * does not take the fiber off in between. So the table's commit order and
 * the order subscribers see are the order of the calls, whichever fiber
 * made them, and no publication waits behind another. A job that fails
 * rolls back whole and publishes nothing. After {@link SessionEventsShape.close}
 * an awaited publication is the caller's defect and a detached one is
 * logged and dropped, as is a job that opens another.
 */
export const sessionEventsLayer = Layer.effect(
  SessionEvents,
  Effect.gen(function* () {
    const log = yield* Database;
    const { track, openWork } = openWorkTracker();
    const committed = yield* PubSub.unbounded<Take.Take<CommittedBatch>>();
    let head = yield* log.currentCommit;
    let closed = false;
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
    /** One job: its transaction, then the publication of what it wrote, in
     *  one turn. A rolled-back job publishes nothing, and a commit is never
     *  left unpublished by an interrupt. */
    const commit = <A, E>(
      job: (append: Append, appended: SessionRow[]) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | DatabaseWriteFailed> =>
      Effect.suspend(() => {
        const appended: SessionRow[] = [];
        // Both of `appendAll`'s rejections (a closed aggregate, a failed
        // write) pass through typed, not as defects.
        const append: Append = (events) =>
          Effect.tap(log.appendAll(events), (rows) =>
            Effect.sync(() => appended.push(...rows)),
          );
        return log
          .job(
            Effect.suspend(() => {
              // A transaction run again starts from no rows.
              appended.length = 0;
              return job(append, appended);
            }),
          )
          .pipe(
            Effect.tap(() => publish(appended)),
            Effect.uninterruptible,
            Effect.provideService(Scheduler.PreventSchedulerYield, true),
          );
      });
    /** `work`, unless the plane has closed or a job is asking. */
    const awaited = Effect.fn('awaited')(function* <A, E>(
      work: Effect.Effect<A, E>,
    ): Effect.fn.Return<A, E> {
      if (closed) {
        return yield* Effect.die(
          new Error('Session publication after the plane closed'),
        );
      }
      if (yield* InPublisherJob) return yield* reentered;
      return yield* work;
    });
    // The tails end with the plane.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closed = true;
        return PubSub.end(committed, Exit.void);
      }),
    );
    // How the synchronous door runs a job: the fiber starts in the call and,
    // awaiting nothing, has finished when the call returns.
    const run = yield* FiberSet.makeRuntime<never>();
    const transact: SessionEventsShape['transact'] = (job) =>
      awaited(
        commit((append, appended) =>
          Effect.map(job(append), (value) => ({
            value,
            through: appended.at(-1)?.commit ?? null,
          })),
        ),
      );
    const removeRun: SessionEventsShape['removeRun'] = (
      id,
      expectedStartCommit,
    ) =>
      awaited(
        commit((_, appended) =>
          Effect.tap(log.runRemoval(id, expectedStartCommit), (rows) =>
            Effect.sync(() => appended.push(...rows)),
          ),
        ),
      );
    const detach: SessionEventsShape['detach'] = (job, options = {}) => {
      // Direct sink write: `detach` is the synchronous door for producers
      // with no fiber.
      if (closed) {
        writeLogLine(
          CHANNEL,
          'Session publication dropped: the plane has closed',
        );
        return;
      }
      const fiber = run(
        commit(job).pipe(
          Effect.catchCause((cause) =>
            Effect.logError('Session publication failed').pipe(
              Effect.annotateLogs({ data: cause }),
              withLogChannel(CHANNEL),
              Effect.andThen(
                Effect.sync(() => options.failed?.(Cause.squash(cause))),
              ),
            ),
          ),
        ),
      );
      // A job that awaited something is still running: its row will land
      // after whatever is published next, and nothing else would say so.
      if (fiber.pollUnsafe() === undefined)
        writeLogLine(
          CHANNEL,
          'A detached session publication did not finish in its call; its row may land out of order',
        );
    };
    return {
      transact,
      detach,
      removeRun,
      close: Effect.sync(() => {
        closed = true;
      }),
      openWork,
      head: () => head,
      subscribe: PubSub.subscribe(committed),
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
